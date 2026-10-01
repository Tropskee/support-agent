import { afterAll, expect, test } from "bun:test";
import type { GeneratedTicket } from "../src/archetypes";
import { config } from "../src/config";
import { getTicket, insertTicket, openDb } from "../src/db";
import { getEvalRun } from "../src/eval";
import { createServer, startServer } from "../src/server";
import { fakeBackend, ModelUnavailableError } from "../src/model";
import { fx } from "./helpers";

interface TicketPublic {
  id: string;
  status: string;
  review_count?: number;
  [key: string]: unknown;
}
interface AttemptPublic {
  priority: string;
  [key: string]: unknown;
}
interface TicketResponse {
  ticket: TicketPublic;
  attempt?: AttemptPublic;
}
interface TicketDetailResponse {
  ticket: TicketPublic;
  attempts: unknown[];
  reviews: { action: string }[];
  context: unknown;
}
interface ErrorResponse {
  error: string;
}

const readJson = async <T>(res: Response): Promise<T> => (await res.json()) as T;

const ok = (p = "P4") => ({ priority: p, reasoning: "r", reply: "Hi", proposed_actions: [{ type: "info_only", amount_usd: null, detail: "" }], citations: ["customer"], confidence: 0.9 });
const db = openDb(":memory:");
// Every server here gets a fake judgeBackend: the real one would call the Ori runtime.
const noJudge = () => fakeBackend([]);
const server = createServer({ db, fx, backend: fakeBackend([ok(), ok("P1"), ok("P1"), ok("P1")]), judgeBackend: noJudge(), port: 0 });
const url = (p: string) => new URL(p, server.url).toString();
const post = (p: string, body?: unknown) => fetch(url(p), { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

// A dedicated server/db/backend for the eval routes, so their requests don't consume from (or
// race against) the fakeBackend queue and ticket ids the other tests in this file depend on.
const infoOnlyDecision = { priority: "P4", reasoning: "r", reply: "Your order is grading.", proposed_actions: [{ type: "info_only", amount_usd: null, detail: "" }], citations: ["customer"], confidence: 0.9 };
const evalTickets: GeneratedTicket[] = [
  {
    id: "TKT-srv1",
    from: "kenji@example.com",
    subject: "Order status",
    body: "What's the status of CG-20002?",
    archetype: "order_status",
    hard: null,
    labels: { priority: "P4", shouldEscalate: false, expectedAction: "info_only", requiredFacts: [{ description: "status", pattern: "grading" }] },
  },
];
const evalDb = openDb(":memory:");
const evalBackend = fakeBackend([infoOnlyDecision, infoOnlyDecision]);
const evalJudge = fakeBackend(["SUPPORTED", "SUPPORTED"]);
const evalServer = createServer({
  db: evalDb,
  fx,
  backend: evalBackend,
  judgeBackend: evalJudge,
  port: 0,
  evalOpts: { evalDbPath: ":memory:", tickets: evalTickets },
});
const evalUrl = (p: string) => new URL(p, evalServer.url).toString();
const evalPost = (p: string, body?: unknown) => fetch(evalUrl(p), { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

// A third, dedicated server for the per-ticket detail snapshot tests below, so its queue is
// sized for exactly one run: one decide response, and one faithfulness judge response.
const detailBackend = fakeBackend([infoOnlyDecision]);
const detailDb = openDb(":memory:");
const detailServer = createServer({
  db: detailDb,
  fx,
  backend: detailBackend,
  judgeBackend: fakeBackend(["SUPPORTED"]),
  port: 0,
  evalOpts: { evalDbPath: ":memory:", tickets: evalTickets },
});
const detailUrl = (p: string) => new URL(p, detailServer.url).toString();

afterAll(() => {
  server.stop(true);
  evalServer.stop(true);
  detailServer.stop(true);
});

test("create with run=true returns a decision", async () => {
  const r = await post("/tickets?run=true", { from: "kenji@example.com", subject: "status", body: "CG-20002" });
  const j = await readJson<TicketResponse>(r);
  expect(r.status).toBe(200);
  expect(j.attempt?.priority).toBe("P4");
  expect(j.ticket.status).toBe("resolved");
  // The eval label columns must never reach the API. Matched as JSON keys, because the system
  // prompt stored on the attempt legitimately names the "label_correction" action.
  expect(JSON.stringify(j)).not.toMatch(/"label_[a-z_]+":/);
});

test("missing fields are a 400", async () => {
  expect((await post("/tickets", { from: "a@b.c" })).status).toBe(400);
});

test("escalate, then retry needs notes, then approve", async () => {
  const created = await readJson<TicketResponse>(await post("/tickets?run=true", { from: "kenji@example.com", subject: "empty box", body: "CG-20001" }));
  const id = created.ticket.id;
  expect(created.ticket.status).toBe("escalated");
  expect((await post(`/tickets/${id}/retry`, { notes: "" })).status).toBe(400);
  expect((await post(`/tickets/${id}/retry`, { notes: "be specific" })).status).toBe(200);
  const approved = await post(`/tickets/${id}/approve`, { edited_reply: "Edited" });
  expect(approved.status).toBe(200);
  const detail = await readJson<TicketDetailResponse>(await fetch(url(`/tickets/${id}`)));
  expect(detail.ticket.status).toBe("resolved");
  expect(detail.attempts).toHaveLength(2);
  expect(detail.reviews.map((r) => r.action)).toEqual(["retry", "edit"]);
});

test("approving a resolved ticket is a 409", async () => {
  const created = await readJson<TicketResponse>(await post("/tickets", { from: "kenji@example.com", subject: "x", body: "y" }));
  expect((await post(`/tickets/${created.ticket.id}/approve`, {})).status).toBe(409);
});

test("approve without edited_reply on an attempt with no reply_text is a 409", async () => {
  const errDb = openDb(":memory:");
  const errServer = createServer({ db: errDb, fx, backend: fakeBackend(["garbage", "garbage"]), judgeBackend: noJudge(), port: 0 });
  const errUrl = (p: string) => new URL(p, errServer.url).toString();
  const errPost = (p: string, body?: unknown) =>
    fetch(errUrl(p), { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  try {
    const created = await readJson<TicketResponse>(
      await errPost("/tickets?run=true", { from: "kenji@example.com", subject: "x", body: "CG-20001" }),
    );
    expect(created.ticket.status).toBe("escalated");
    const id = created.ticket.id;

    const noReply = await errPost(`/tickets/${id}/approve`, {});
    expect(noReply.status).toBe(409);

    const withEdit = await errPost(`/tickets/${id}/approve`, { edited_reply: "Hand-written reply" });
    expect(withEdit.status).toBe(200);
  } finally {
    errServer.stop(true);
  }
});

test("list items include review_count for approved tickets", async () => {
  const created = await readJson<TicketResponse>(await post("/tickets?run=true", { from: "kenji@example.com", subject: "again", body: "CG-20001" }));
  const id = created.ticket.id;
  expect(created.ticket.status).toBe("escalated");
  expect((await post(`/tickets/${id}/approve`, {})).status).toBe(200);
  const list = await readJson<TicketPublic[]>(await fetch(url("/tickets?status=resolved")));
  const item = list.find((t) => t.id === id);
  expect(item?.review_count).toBeGreaterThanOrEqual(1);
});

test("malformed JSON body is a 400", async () => {
  const r = await fetch(url("/tickets"), { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  expect(r.status).toBe(400);
  const j = await readJson<ErrorResponse>(r);
  expect(j.error).toBe("invalid JSON body");
});

test("malformed JSON body on approve and retry is also a 400", async () => {
  const created = await readJson<TicketResponse>(await post("/tickets?run=true", { from: "kenji@example.com", subject: "bad json", body: "CG-20001" }));
  const id = created.ticket.id;
  expect(created.ticket.status).toBe("escalated");
  const badBody = { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" };
  expect((await fetch(url(`/tickets/${id}/approve`), badBody)).status).toBe(400);
  expect((await fetch(url(`/tickets/${id}/retry`), badBody)).status).toBe(400);
});

interface EvalRunResponse {
  id: number;
  finished_at: string | null;
  totals: { n: number } | null;
}
interface EvalRunDetailResponse {
  run: EvalRunResponse;
  totals: { n: number } | null;
  results: { ticket_id: string }[];
}

const POLL_DEADLINE_MS = 5_000;

async function pollRunUntilFinished(urlFn: (p: string) => string, id: number): Promise<EvalRunDetailResponse> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  for (;;) {
    const detail = await readJson<EvalRunDetailResponse>(await fetch(urlFn(`/eval/runs/${id}`)));
    if (detail.run.finished_at != null) return detail;
    if (Date.now() > deadline) throw new Error(`eval run ${id} did not finish within ${POLL_DEADLINE_MS} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const pollUntilFinished = (id: number) => pollRunUntilFinished(evalUrl, id);

test("POST /eval starts a run in the background and returns 202 with an id", async () => {
  const r = await evalPost("/eval");
  expect(r.status).toBe(202);
  const j = await readJson<{ id: number }>(r);
  expect(typeof j.id).toBe("number");

  const detail = await pollUntilFinished(j.id);
  expect(detail.run.finished_at).not.toBeNull();
  expect(detail.totals!.n).toBe(1);
  expect(detail.results).toHaveLength(1);
  expect(detail.results[0]!.ticket_id).toBe("TKT-srv1");
  // the faithfulness judge ran on the injected judgeBackend, not on a real Ori backend
  expect(evalJudge.calls.length).toBeGreaterThanOrEqual(1);
});

test("POST /eval ignores an evalDbPath/tickets body: the server-side config always wins", async () => {
  // A malicious or careless caller can't point the run at an arbitrary file to delete, or
  // inject its own tickets into the live agent loop - the body is never even read.
  const r = await evalPost("/eval", { evalDbPath: "/etc/passwd", tickets: [{ id: "TKT-injected", from: "attacker@example.com", subject: "x", body: "y", archetype: "x", hard: null, labels: { priority: "P1", shouldEscalate: true, expectedAction: "other", requiredFacts: [] } }] });
  expect(r.status).toBe(202);
  const j = await readJson<{ id: number }>(r);

  const detail = await pollUntilFinished(j.id);
  expect(detail.run.finished_at).not.toBeNull();
  // still the server-configured single ticket, not the injected one
  expect(detail.results).toHaveLength(1);
  expect(detail.results[0]!.ticket_id).toBe("TKT-srv1");
});

test("POST /eval returns 409 while a run is already in progress, and 202 again once it finishes", async () => {
  // A plain fakeBackend resolves synchronously, so the background run could finish before the
  // second request even reaches the server - too fast a window to reliably observe the guard.
  // Delaying decide() by a tick keeps the first run "in progress" long enough for that.
  const inner = fakeBackend([infoOnlyDecision, infoOnlyDecision]);
  const guardBackend: typeof inner = {
    ...inner,
    async decide(req) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return inner.decide(req);
    },
  };
  const guardDb = openDb(":memory:");
  const guardServer = createServer({
    db: guardDb,
    fx,
    backend: guardBackend,
    judgeBackend: noJudge(),
    port: 0,
    evalOpts: { evalDbPath: ":memory:", tickets: evalTickets },
  });
  const guardUrl = (p: string) => new URL(p, guardServer.url).toString();
  try {
    const [first, second] = await Promise.all([
      fetch(guardUrl("/eval"), { method: "POST" }),
      fetch(guardUrl("/eval"), { method: "POST" }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([202, 409]);

    const started = first.status === 202 ? first : second;
    const { id } = await readJson<{ id: number }>(started);
    await pollRunUntilFinished(guardUrl, id);

    const after = await fetch(guardUrl("/eval"), { method: "POST" });
    expect(after.status).toBe(202);
    const { id: secondId } = await readJson<{ id: number }>(after);
    await pollRunUntilFinished(guardUrl, secondId);
  } finally {
    guardServer.stop(true);
  }
});

test("GET /eval/runs lists runs with totals", async () => {
  const list = await readJson<EvalRunResponse[]>(await fetch(evalUrl("/eval/runs")));
  expect(list.length).toBeGreaterThanOrEqual(1);
  expect(list[0]).toHaveProperty("id");
});

test("GET /eval/runs/:id is a 404 for an unknown id", async () => {
  const r = await fetch(evalUrl("/eval/runs/999999"));
  expect(r.status).toBe(404);
});

interface EvalResultDetailResponse {
  ticket: { id: string; from: string; subject: string; body: string };
  labels: { priority: string };
  attempt: { priority: string | null; reply_text: string | null };
  score: { priorityExact: boolean };
}

// One run, shared by the tests below: detailBackend's queue (one decide response, one write
// response for the faithfulness judge scoreAttempt always runs) is sized for exactly one run,
// and re-running for each test would leave later calls to an empty queue.
let detailRunPromise: Promise<{ id: number; detail: EvalRunDetailResponse }> | null = null;
function sharedDetailRun(): Promise<{ id: number; detail: EvalRunDetailResponse }> {
  detailRunPromise ??= (async () => {
    const r = await fetch(detailUrl("/eval"), { method: "POST" });
    const { id } = await readJson<{ id: number }>(r);
    const detail = await pollRunUntilFinished(detailUrl, id);
    return { id, detail };
  })();
  return detailRunPromise;
}

test("GET /eval/runs/:id results include the agent's priority and guardrail_result, read from the snapshot", async () => {
  const { detail } = await sharedDetailRun();
  expect(detail.results[0]).toMatchObject({ ticket_id: "TKT-srv1", agent_priority: "P4", guardrail_result: "resolve" });
});

test("GET /eval/runs/:id/results/:ticketId returns the per-ticket snapshot", async () => {
  const { id } = await sharedDetailRun();

  const r = await fetch(detailUrl(`/eval/runs/${id}/results/TKT-srv1`));
  expect(r.status).toBe(200);
  const detail = await readJson<EvalResultDetailResponse>(r);
  expect(detail.ticket.id).toBe("TKT-srv1");
  expect(detail.labels.priority).toBe("P4");
  expect(detail.attempt.priority).toBe("P4");
  expect(detail.attempt.reply_text).toBe("Your order is grading.\n\nCzeropski Grading Support");
  expect(detail.score.priorityExact).toBe(true);
});

test("GET /eval/runs/:id/results/:ticketId is a 404 for an unknown ticket", async () => {
  const { id } = await sharedDetailRun();

  const r = await fetch(detailUrl(`/eval/runs/${id}/results/TKT-does-not-exist`));
  expect(r.status).toBe(404);
});

test("GET /eval/runs/:id/results/:ticketId is a 400 for an invalid run id", async () => {
  const r = await fetch(detailUrl("/eval/runs/not-a-number/results/TKT-srv1"));
  expect(r.status).toBe(400);
});

test("two concurrent runs of one ticket: one 200, one 409, exactly one attempt", async () => {
  const inner = fakeBackend([ok(), ok()]);
  const slowBackend: typeof inner = {
    ...inner,
    async decide(req) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return inner.decide(req);
    },
  };
  const raceDb = openDb(":memory:");
  const raceServer = createServer({ db: raceDb, fx, backend: slowBackend, judgeBackend: noJudge(), port: 0 });
  const racePost = (p: string) => fetch(new URL(p, raceServer.url).toString(), { method: "POST" });
  try {
    const created = await readJson<TicketResponse>(
      await fetch(new URL("/tickets", raceServer.url).toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "kenji@example.com", subject: "status", body: "CG-20002" }),
      }),
    );
    const id = created.ticket.id;
    const [a, b] = await Promise.all([racePost(`/tickets/${id}/run`), racePost(`/tickets/${id}/run`)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const detail = await readJson<TicketDetailResponse>(await fetch(new URL(`/tickets/${id}`, raceServer.url).toString()));
    expect(detail.attempts).toHaveLength(1);
    expect(inner.calls).toHaveLength(1);
  } finally {
    raceServer.stop(true);
  }
});

test("a ticket being run is 'running' and is left out of the status lists", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const inner = fakeBackend([ok()]);
  const gatedBackend: typeof inner = {
    ...inner,
    async decide(req) {
      await gate;
      return inner.decide(req);
    },
  };
  const runDb = openDb(":memory:");
  const runServer = createServer({ db: runDb, fx, backend: gatedBackend, judgeBackend: noJudge(), port: 0 });
  const at = (p: string) => new URL(p, runServer.url).toString();
  try {
    const created = await readJson<TicketResponse>(
      await fetch(at("/tickets"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "kenji@example.com", subject: "status", body: "CG-20002" }),
      }),
    );
    const id = created.ticket.id;
    const running = fetch(at(`/tickets/${id}/run`), { method: "POST" });
    // Let the run claim the ticket before reading the lists.
    for (let i = 0; i < 50 && inner.calls.length === 0; i++) {
      const detail = await readJson<TicketDetailResponse>(await fetch(at(`/tickets/${id}`)));
      if (detail.ticket.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const detail = await readJson<TicketDetailResponse>(await fetch(at(`/tickets/${id}`)));
    expect(detail.ticket.status).toBe("running");
    for (const status of ["new", "resolved", "escalated"]) {
      const list = await readJson<TicketPublic[]>(await fetch(at(`/tickets?status=${status}`)));
      expect(list.some((t) => t.id === id)).toBe(false);
    }
    release();
    expect((await running).status).toBe(200);
  } finally {
    release();
    runServer.stop(true);
  }
});

test("list items count approvals separately from retries", async () => {
  const listDb = openDb(":memory:");
  const listServer = createServer({ db: listDb, fx, backend: fakeBackend([ok("P1"), ok(), ok("P1")]), judgeBackend: noJudge(), port: 0 });
  const at = (p: string) => new URL(p, listServer.url).toString();
  const postAt = (p: string, body?: unknown) =>
    fetch(at(p), { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  try {
    // Escalated, then a retry the agent resolves on its own: a review row, but no approval.
    const retried = (await readJson<TicketResponse>(await postAt("/tickets?run=true", { from: "kenji@example.com", subject: "a", body: "CG-20002" }))).ticket.id;
    expect((await postAt(`/tickets/${retried}/retry`, { notes: "be specific" })).status).toBe(200);
    // Escalated, then approved by a person.
    const approved = (await readJson<TicketResponse>(await postAt("/tickets?run=true", { from: "kenji@example.com", subject: "b", body: "CG-20002" }))).ticket.id;
    expect((await postAt(`/tickets/${approved}/approve`, {})).status).toBe(200);

    const list = await readJson<(TicketPublic & { approved_count: number; priority: string | null })[]>(await fetch(at("/tickets?status=resolved")));
    const retriedItem = list.find((t) => t.id === retried)!;
    const approvedItem = list.find((t) => t.id === approved)!;
    expect(retriedItem).toMatchObject({ review_count: 1, approved_count: 0, priority: "P4" });
    expect(approvedItem).toMatchObject({ review_count: 1, approved_count: 1, priority: "P1" });
  } finally {
    listServer.stop(true);
  }
});

test("a model-runtime outage is a 503 from run, retry and create-and-run, and the ticket keeps its status", async () => {
  let down = false;
  const inner = fakeBackend([ok("P1")]);
  const flakyBackend: typeof inner = {
    ...inner,
    async decide(req) {
      if (down) throw new ModelUnavailableError();
      return inner.decide(req);
    },
  };
  const outDb = openDb(":memory:");
  const outServer = createServer({ db: outDb, fx, backend: flakyBackend, judgeBackend: noJudge(), port: 0 });
  const at = (p: string) => new URL(p, outServer.url).toString();
  const postAt = (p: string, body?: unknown) =>
    fetch(at(p), { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const expected = { error: "Model runtime unavailable: start it with `bun run up`" };
  try {
    const escalated = (await readJson<TicketResponse>(await postAt("/tickets?run=true", { from: "kenji@example.com", subject: "a", body: "CG-20002" }))).ticket;
    expect(escalated.status).toBe("escalated");
    down = true;

    const retry = await postAt(`/tickets/${escalated.id}/retry`, { notes: "try again" });
    expect(retry.status).toBe(503);
    expect(await retry.json()).toEqual(expected);
    expect((await readJson<TicketDetailResponse>(await fetch(at(`/tickets/${escalated.id}`)))).ticket.status).toBe("escalated");

    const created = await postAt("/tickets?run=true", { from: "kenji@example.com", subject: "b", body: "CG-20002" });
    expect(created.status).toBe(503);
    expect(await created.json()).toEqual(expected);
    const fresh = await readJson<TicketPublic[]>(await fetch(at("/tickets?status=new")));
    expect(fresh).toHaveLength(1);

    const run = await postAt(`/tickets/${fresh[0]!.id}/run`);
    expect(run.status).toBe(503);
    expect(await run.json()).toEqual(expected);
    const detail = await readJson<TicketDetailResponse>(await fetch(at(`/tickets/${fresh[0]!.id}`)));
    expect(detail.ticket.status).toBe("new");
    expect(detail.attempts).toHaveLength(0);
  } finally {
    outServer.stop(true);
  }
});

test("POST /eval needs the Ori bridge for the default judge backend", async () => {
  const originalFetch = global.fetch;
  let bridge = false;
  const healthChecks: string[] = [];
  // Requests to the Ori runtime are answered here; the test's own requests reach the server.
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (target.startsWith(config.oriUrl)) {
      healthChecks.push(target);
      return Response.json({ ok: true, bridge });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  const oriDb = openDb(":memory:");
  // No judgeBackend: the server judges with a real Ori backend, whose health check is mocked.
  const oriServer = createServer({ db: oriDb, fx, backend: fakeBackend([]), port: 0, evalOpts: { evalDbPath: ":memory:", tickets: [] } });
  try {
    const down = await originalFetch(new URL("/eval", oriServer.url).toString(), { method: "POST" });
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: "Model runtime unavailable: start it with `bun run up`" });
    expect(healthChecks).toEqual([`${config.oriUrl}/ticket-reply/health`]);
    expect(oriDb.query("SELECT COUNT(*) AS n FROM eval_runs").get()).toEqual({ n: 0 });

    bridge = true;
    const up = await originalFetch(new URL("/eval", oriServer.url).toString(), { method: "POST" });
    expect(up.status).toBe(202);
  } finally {
    oriServer.stop(true);
    global.fetch = originalFetch;
  }
});

test("GET /stats reports the run concurrency and the Ori model", async () => {
  const stats = await readJson<{ runConcurrency: number; model: string }>(await fetch(url("/stats")));
  expect(stats.runConcurrency).toBe(config.runConcurrency);
  expect(stats.model).toBe(config.oriModel);
});

// State a stopped server leaves behind: one ticket mid-run, one eval run with no finish.
function strandedDb() {
  const strandDb = openDb(":memory:");
  insertTicket(strandDb, { id: "TKT-001", sender_email: "a@example.com", subject: "s", body: "b" });
  strandDb.exec("UPDATE tickets SET status = 'running'");
  strandDb.exec("INSERT INTO eval_runs (id, model, prompt_version, started_at) VALUES (3, 'm', 'v', '2026-09-30T00:00:00Z')");
  return strandDb;
}

test("startServer touches no state when its port is already taken", () => {
  const holder = Bun.serve({ port: 0, fetch: () => new Response("busy") });
  const strandDb = strandedDb();
  try {
    expect(() => startServer({ db: strandDb, fx, backend: fakeBackend([]), judgeBackend: noJudge(), port: holder.port, evalOpts: { evalDbPath: ":memory:" } })).toThrow();
    expect(getTicket(strandDb, "TKT-001")!.status).toBe("running");
    expect(getEvalRun(strandDb, 3)!.run.finished_at).toBeNull();
  } finally {
    holder.stop(true);
  }
});

test("startServer returns stranded tickets and closes interrupted eval runs once it is listening", () => {
  const strandDb = strandedDb();
  const started = startServer({ db: strandDb, fx, backend: fakeBackend([]), judgeBackend: noJudge(), port: 0, evalOpts: { evalDbPath: ":memory:" } });
  try {
    expect(started.recoveredTickets).toBe(1);
    expect(started.interruptedEvals).toBe(1);
    expect(getTicket(strandDb, "TKT-001")!.status).toBe("new");
    expect(getEvalRun(strandDb, 3)!.totals!.error).toBe("interrupted: server restarted");
  } finally {
    started.server.stop(true);
  }
});
