import { expect, test } from "bun:test";
import { config } from "../src/config";
import { getAttempts, getTicket, insertTicket, openDb } from "../src/db";
import { runTicket, TicketNotRunnableError } from "../src/agent";
import { fakeBackend, ModelUnavailableError } from "../src/model";
import { fx } from "./helpers";

const ok = (over = {}) => ({ priority: "P4", reasoning: "r", reply: "Your order is grading.", proposed_actions: [{ type: "info_only", amount_usd: null, detail: "" }], citations: ["customer"], confidence: 0.9, ...over });
const setup = () => {
  const db = openDb(":memory:");
  insertTicket(db, { id: "T1", sender_email: "kenji@example.com", subject: "status", body: "CG-20002?" });
  return db;
};

test("clean decision resolves and stores everything", async () => {
  const db = setup();
  const a = await runTicket({ db, fx, backend: fakeBackend([ok()]) }, "T1");
  expect(a.guardrail_result).toBe("resolve");
  expect(getTicket(db, "T1")!.status).toBe("resolved");
  expect(a.user_prompt).toContain("CG-20002");
  expect(a.system_prompt.length).toBeGreaterThan(100);
  expect(JSON.parse(a.context_json).length).toBeGreaterThan(0);
});

test("P1 escalates", async () => {
  const db = setup();
  await runTicket({ db, fx, backend: fakeBackend([ok({ priority: "P1" })]) }, "T1");
  expect(getTicket(db, "T1")!.status).toBe("escalated");
});

test("one bad output is retried; two escalate as error", async () => {
  const db = setup();
  const a = await runTicket({ db, fx, backend: fakeBackend(["garbage", ok()]) }, "T1");
  expect(a.guardrail_result).toBe("resolve");
  const db2 = setup();
  const b = await runTicket({ db: db2, fx, backend: fakeBackend(["garbage", "worse"]) }, "T1");
  expect(b.guardrail_result).toBe("escalate");
  expect(JSON.parse(b.guardrail_reasons_json)[0].reason).toBe("error");
});

test("the schema-retry prompt never tells the model to use a tool", async () => {
  const db = setup();
  const backend = fakeBackend(["garbage", ok()]);
  await runTicket({ db, fx, backend }, "T1");
  expect(backend.calls).toHaveLength(2);
  expect(backend.calls[1]!.user.toLowerCase()).not.toContain("tool");
  expect(backend.calls[1]!.user).toContain("Answer again with the corrected decision");
});

test("retry links to the previous attempt and carries notes into the prompt", async () => {
  const db = setup();
  const backend = fakeBackend([ok({ priority: "P1" }), ok({ priority: "P1", critique: "I over-promised" })]);
  const first = await runTicket({ db, fx, backend }, "T1");
  const second = await runTicket({ db, fx, backend }, "T1", { notes: "No replacement cards" });
  expect(second.parent_attempt_id).toBe(first.id);
  expect(second.attempt_no).toBe(2);
  expect(second.user_prompt).toContain("No replacement cards");
  expect(second.critique).toBe("I over-promised");
  expect(getAttempts(db, "T1")).toHaveLength(2);
});

test("retry after an attempt with no decision (error) runs fresh but still carries notes", async () => {
  const db = setup();
  const backend = fakeBackend(["garbage", "worse", ok()]);
  const first = await runTicket({ db, fx, backend }, "T1");
  expect(first.guardrail_result).toBe("escalate");
  expect(first.parsed_json).toBeNull();

  const second = await runTicket({ db, fx, backend }, "T1", { notes: "double-check the order" });
  expect(second.parent_attempt_id).toBe(first.id);
  expect(second.attempt_no).toBe(2);
  expect(second.guardrail_result).toBe("resolve");
  expect(second.user_prompt).toContain("double-check the order");
  expect(second.user_prompt).not.toContain("previous_attempt");
  expect(getAttempts(db, "T1")).toHaveLength(2);
});

test("inline citation brackets are stripped from the stored reply but kept in parsed_json", async () => {
  const db = setup();
  const backend = fakeBackend([ok({ reply: "The fee applies under [policy 4]." })]);
  const a = await runTicket({ db, fx, backend }, "T1");
  expect(a.reply_text).toBe("The fee applies under.\n\nCzeropski Grading Support");
  expect(JSON.parse(a.parsed_json!).reply).toBe("The fee applies under [policy 4].");
  expect(a.raw_response).toContain("[policy 4]");
});

test("bracketed and loosely-spaced citations are normalised before guardrails and storage", async () => {
  const db = setup();
  const backend = fakeBackend([ok({ citations: ["[customer]", " order CG-20002 "] })]);
  const a = await runTicket({ db, fx, backend }, "T1");
  expect(a.guardrail_result).toBe("resolve");
  expect(JSON.parse(a.guardrail_reasons_json)).toEqual([]);
  expect(JSON.parse(a.citations_json!)).toEqual(["customer", "order CG-20002"]);
});

test("the sign-off is corrected and normalized in reply_text but the original is kept in parsed_json", async () => {
  const db = setup();
  const backend = fakeBackend([ok({ reply: "Your order is grading.\n\nKczeropski Grading Support" })]);
  const a = await runTicket({ db, fx, backend }, "T1");
  expect(a.reply_text).toBe("Your order is grading.\n\nCzeropski Grading Support");
  expect(JSON.parse(a.parsed_json!).reply).toBe("Your order is grading.\n\nKczeropski Grading Support");
});

test("labels never reach the prompt", async () => {
  const db = openDb(":memory:");
  insertTicket(db, { id: "T2", sender_email: "kenji@example.com", subject: "s", body: "b",
    labels: { priority: "P3", shouldEscalate: false, expectedAction: "info_only", requiredFacts: [{ description: "SECRET-LABEL" }] } });
  const backend = fakeBackend([ok()]);
  await runTicket({ db, fx, backend }, "T2");
  expect(backend.calls[0]!.user).not.toContain("SECRET-LABEL");
  expect(backend.calls[0]!.user).not.toContain("P3");
});

test("a ticket that is not in the expected status is not run", async () => {
  const db = setup();
  const backend = fakeBackend([ok()]);
  await runTicket({ db, fx, backend }, "T1");
  await expect(runTicket({ db, fx, backend: fakeBackend([ok()]) }, "T1")).rejects.toBeInstanceOf(TicketNotRunnableError);
  // a resolved ticket can't be retried either
  await expect(runTicket({ db, fx, backend: fakeBackend([ok()]) }, "T1", { notes: "x" })).rejects.toBeInstanceOf(TicketNotRunnableError);
  expect(getAttempts(db, "T1")).toHaveLength(1);
});

test("the ticket is 'running' during the model call", async () => {
  const db = setup();
  let seenStatus: string | undefined;
  const inner = fakeBackend([ok()]);
  const backend: typeof inner = {
    ...inner,
    async decide(req) {
      seenStatus = getTicket(db, "T1")!.status;
      return inner.decide(req);
    },
  };
  await runTicket({ db, fx, backend }, "T1");
  expect(seenStatus).toBe("running");
  expect(getTicket(db, "T1")!.status).toBe("resolved");
});

test("an error thrown mid-run puts the ticket back in its prior status", async () => {
  const db = setup();
  await runTicket({ db, fx, backend: fakeBackend([ok({ priority: "P1" })]) }, "T1");
  expect(getTicket(db, "T1")!.status).toBe("escalated");
  db.exec("DROP TABLE reviews");
  await expect(runTicket({ db, fx, backend: fakeBackend([ok()]) }, "T1", { notes: "x" })).rejects.toThrow();
  expect(getTicket(db, "T1")!.status).toBe("escalated");
  // the attempt write and the review write are one transaction: no orphan attempt either
  expect(getAttempts(db, "T1")).toHaveLength(1);
});

test("a model-runtime outage records no attempt and puts the ticket back", async () => {
  const db = setup();
  const backend = { ...fakeBackend([]), decide: async () => Promise.reject(new ModelUnavailableError()) };
  await expect(runTicket({ db, fx, backend }, "T1")).rejects.toBeInstanceOf(ModelUnavailableError);
  expect(getAttempts(db, "T1")).toHaveLength(0);
  expect(getTicket(db, "T1")!.status).toBe("new");
});

test("the attempt records the model the backend reports it ran", async () => {
  const a = await runTicket({ db: setup(), fx, backend: fakeBackend([ok()]) }, "T1");
  expect(a.model).toBe("fake");
});

test("a failed model call records the configured Ori model id", async () => {
  const db = setup();
  const backend = { ...fakeBackend([]), decide: async () => Promise.reject(new Error("boom")) };
  const a = await runTicket({ db, fx, backend }, "T1");
  expect(a.model).toBe(config.oriModel);
  expect(a.latency_ms).toBeNull();
});

test("latency_ms is the model calls' own latency, summed over a schema retry", async () => {
  const db = setup();
  const a = await runTicket({ db, fx, backend: fakeBackend(["garbage", ok()]) }, "T1");
  // fakeBackend reports 1 ms per decide call
  expect(a.latency_ms).toBe(2);
});
