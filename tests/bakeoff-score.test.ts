import { describe, expect, test } from "bun:test";
import type { CatalogModel } from "ori/eval";
import { acceptsEffort, pickSlate, scoreReply, selectCases, summaryLine, type CaseScore } from "../evals/ticket-reply/score";
import type { GeneratedTicket } from "../src/archetypes";
import type { Context } from "../src/lookup";
import type { Decision } from "../src/types";

const ctx: Context = { blocks: [], labels: new Set(["customer", "order CG-20001", "policy 4"]), customerFound: true, orderId: "CG-20001" };

const ticket = (labels: Partial<GeneratedTicket["labels"]> = {}, archetype = "order_status"): GeneratedTicket => ({
  id: "TKT-001",
  from: "kenji@example.com",
  subject: "status",
  body: "where is it",
  archetype,
  hard: null,
  labels: {
    priority: "P4",
    shouldEscalate: false,
    expectedAction: "info_only",
    requiredFacts: [{ description: "names the status", pattern: "grading" }],
    ...labels,
  },
});

const decision = (d: Partial<Decision> = {}): Decision => ({
  priority: "P4",
  reasoning: "r",
  reply: "Your order is in grading.\n\nCzeropski Grading Support",
  proposed_actions: [{ type: "info_only", amount_usd: null, detail: "" }],
  citations: ["order CG-20001"],
  confidence: 0.9,
  ...d,
});

const reply = (d: Partial<Decision> = {}) => JSON.stringify(decision(d));

const model = (slug: string, m: Partial<CatalogModel> = {}): CatalogModel =>
  ({ slug, outputModalities: ["text"], reasoningEfforts: undefined, reasoningMandatory: false, ...m }) as CatalogModel;

describe("scoreReply", () => {
  test("a correct decision scores on every check", () => {
    expect(scoreReply(reply(), ticket(), ctx)).toEqual({
      validJson: true,
      schemaValid: true,
      priorityExact: true,
      escalateCorrect: true,
      factsFound: 1,
      factsChecked: 1,
    });
  });

  test("tolerates a fenced JSON reply, like production", () => {
    expect(scoreReply("```json\n" + reply() + "\n```", ticket(), ctx).schemaValid).toBe(true);
  });

  test("normalises bracketed citations before the guardrails, like production", () => {
    expect(scoreReply(reply({ citations: ["[order CG-20001]"] }), ticket(), ctx).escalateCorrect).toBe(true);
  });

  test("an unknown citation escalates through the guardrails", () => {
    expect(scoreReply(reply({ citations: ["order CG-99999"] }), ticket(), ctx).escalateCorrect).toBe(false);
  });

  test("a P1 decision escalates and matches an escalating label", () => {
    const score = scoreReply(reply({ priority: "P1" }), ticket({ priority: "P1", shouldEscalate: true }), ctx);
    expect(score.priorityExact).toBe(true);
    expect(score.escalateCorrect).toBe(true);
  });

  test("a wrong priority misses priority only", () => {
    const score = scoreReply(reply({ priority: "P5" }), ticket(), ctx);
    expect(score.priorityExact).toBe(false);
    expect(score.escalateCorrect).toBe(true);
  });

  test("non-JSON text is invalid and escalates as an error, like production", () => {
    expect(scoreReply("I think this is a P4.", ticket(), ctx)).toEqual({
      validJson: false,
      schemaValid: false,
      priorityExact: false,
      escalateCorrect: false,
      factsFound: 0,
      factsChecked: 1,
    });
    expect(scoreReply("not json", ticket({ shouldEscalate: true }), ctx).escalateCorrect).toBe(true);
  });

  test("JSON that fails the schema is valid JSON but not a decision", () => {
    const score = scoreReply(JSON.stringify({ priority: "P9" }), ticket(), ctx);
    expect(score.validJson).toBe(true);
    expect(score.schemaValid).toBe(false);
  });

  test("notPattern facts hold when absent and fail when present; an invalid reply finds none", () => {
    const labels = { requiredFacts: [{ description: "no leak", notPattern: "87654321" }] };
    expect(scoreReply(reply(), ticket(labels), ctx).factsFound).toBe(1);
    expect(scoreReply(reply({ reply: "Cert 87654321 is yours." }), ticket(labels), ctx).factsFound).toBe(0);
    expect(scoreReply("nope", ticket(labels), ctx).factsFound).toBe(0);
  });

  test("facts that need a judge are left out of the count", () => {
    const labels = { requiredFacts: [{ description: "explains clearly" }, { description: "status", pattern: "grading" }] };
    expect(scoreReply(reply(), ticket(labels), ctx).factsChecked).toBe(1);
  });

  test("facts are checked on the finalized reply, with inline citations stripped", () => {
    const labels = { requiredFacts: [{ description: "no inline label", notPattern: "\\[order CG-20001\\]" }] };
    expect(scoreReply(reply({ reply: "In grading [order CG-20001]." }), ticket(labels), ctx).factsFound).toBe(1);
  });
});

describe("pickSlate", () => {
  test("keeps catalog order, one per vendor, text-only output, and models that accept the effort", () => {
    const models = [
      model("a/one"),
      model("a/two"),
      model("b/image", { outputModalities: ["text", "image"] }),
      model("c/mandatory", { reasoningMandatory: true }),
      model("d/no-none", { reasoningEfforts: ["high", "low"] }),
      model("e/with-none", { reasoningEfforts: ["high", "none"] }),
      model("f/plain"),
      model("g/late"),
    ];
    expect(pickSlate(models, "none", 3)).toEqual(["a/one", "e/with-none", "f/plain"]);
  });

  test("returns fewer than asked when the catalog runs out", () => {
    expect(pickSlate([model("a/one")], "none", 5)).toEqual(["a/one"]);
  });
});

describe("acceptsEffort", () => {
  test("a model with no published efforts accepts any effort", () => expect(acceptsEffort(model("a/x"), "none")).toBe(true));
  test("mandatory reasoning rejects none but not low", () => {
    expect(acceptsEffort(model("a/x", { reasoningMandatory: true }), "none")).toBe(false);
    expect(acceptsEffort(model("a/x", { reasoningMandatory: true }), "low")).toBe(true);
  });
});

describe("selectCases", () => {
  const tickets = [ticket({}, "a"), { ...ticket({}, "b"), id: "TKT-002" }, { ...ticket({}, "a"), id: "TKT-003" }];
  test("takes the first ticket of each archetype in the order listed", () => {
    expect(selectCases(tickets, ["b", "a"]).map((t) => t.id)).toEqual(["TKT-002", "TKT-001"]);
  });
  test("throws on an archetype with no ticket", () => expect(() => selectCases(tickets, ["missing"])).toThrow(/missing/));
});

describe("summaryLine", () => {
  test("counts each check over the scored cases", () => {
    const pass: CaseScore = { validJson: true, schemaValid: true, priorityExact: true, escalateCorrect: true, factsFound: 2, factsChecked: 2 };
    const miss: CaseScore = { validJson: false, schemaValid: false, priorityExact: false, escalateCorrect: false, factsFound: 0, factsChecked: 1 };
    expect(summaryLine("a/m", "none", [pass, miss], 1)).toBe(
      "bakeoff a/m  effort=none  scored=2  failed_runs=1  json=1/2  schema=1/2  priority=1/2  escalate=1/2  facts=2/3",
    );
  });
});
