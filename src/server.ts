import type { Database } from "bun:sqlite";
import type { BunRequest } from "bun";
import { runTicket, TicketNotRunnableError } from "./agent";
import { config } from "./config";
import {
  getAttempts,
  getReviews,
  getTicket,
  insertTicket,
  insertReview,
  listTicketSummaries,
  listTickets,
  openDb,
  recoverInterruptedTickets,
  setTicketState,
  stats,
  type TicketRow,
} from "./db";
import {
  defaultJudgeBackend,
  getEvalResultDetail,
  getEvalRun,
  listEvalRuns,
  markInterruptedEvalRuns,
  startEval,
  type EvalOpts,
} from "./eval";
import { loadFixtures, type Fixtures } from "./fixtures";
import { buildContext } from "./lookup";
import { getBackend, MODEL_UNAVAILABLE_MESSAGE, ModelUnavailableError, type ModelBackend } from "./model";
import { pool } from "./pool";
import { loadSeedTickets, seedTickets } from "./seed";

export interface ServerDeps {
  db: Database;
  fx: Fixtures;
  backend: ModelBackend;
  // Backend for the eval's fact and faithfulness judges. Defaults to the Ori backend
  // (defaultJudgeBackend in src/eval.ts).
  judgeBackend?: ModelBackend;
  port?: number;
  // Server-side only, e.g. for tests to run a small fixed ticket list against a :memory: eval
  // db. POST /eval never reads these from the request: see the route below.
  evalOpts?: EvalOpts;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function stripLabels<T extends object>(row: T): Omit<T, `label_${string}`> {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith("label_")) rest[key] = value;
  }
  return rest as Omit<T, `label_${string}`>;
}

function ticketDetailView(row: TicketRow) {
  return { ...stripLabels(row), expected_priority: row.label_priority };
}

class InvalidJsonBody extends Error {}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new InvalidJsonBody();
  }
}

const INVALID_JSON_RESPONSE = () => json({ error: "invalid JSON body" }, 400);

async function serveStatic(relativePath: string, contentType: string): Promise<Response> {
  const file = Bun.file(new URL(`../web/${relativePath}`, import.meta.url));
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, { headers: { "content-type": contentType } });
}

function wrap<Req extends Request>(handler: (req: Req) => Promise<Response>): (req: Req) => Promise<Response> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (err) {
      if (err instanceof TicketNotRunnableError) return json({ error: "ticket is already running or not runnable" }, 409);
      if (err instanceof ModelUnavailableError) return json({ error: MODEL_UNAVAILABLE_MESSAGE }, 503);
      console.error(err);
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  };
}

export function createServer(deps: ServerDeps) {
  const { db, fx, backend } = deps;
  const usesDefaultJudge = deps.judgeBackend === undefined;
  const agentDeps = { db, fx, backend, judgeBackend: deps.judgeBackend ?? defaultJudgeBackend() };
  const evalOpts: EvalOpts = deps.evalOpts ?? { evalDbPath: config.evalDbPath };
  let evalRunning = false;

  return Bun.serve({
    port: deps.port ?? config.port,
    routes: {
      "/": wrap(async () => serveStatic("index.html", "text/html")),
      "/app.js": wrap(async () => serveStatic("app.js", "text/javascript")),
      "/styles.css": wrap(async () => serveStatic("styles.css", "text/css")),

      "/tickets": {
        GET: wrap(async (req: BunRequest) => {
          const url = new URL(req.url);
          const status = url.searchParams.get("status") as TicketRow["status"] | null;
          return json(listTicketSummaries(db, status ?? undefined).map(stripLabels));
        }),
        POST: wrap(async (req: BunRequest) => {
          let body: Record<string, unknown>;
          try {
            body = await readJsonBody(req);
          } catch (err) {
            if (err instanceof InvalidJsonBody) return INVALID_JSON_RESPONSE();
            throw err;
          }
          const from = body.from;
          const subject = body.subject;
          const ticketBody = body.body;
          if (typeof from !== "string" || !from || typeof subject !== "string" || !subject || typeof ticketBody !== "string" || !ticketBody) {
            return json({ error: "from, subject and body are required" }, 400);
          }
          const ticket = insertTicket(db, { sender_email: from, subject, body: ticketBody });
          const url = new URL(req.url);
          if (url.searchParams.get("run") === "true") {
            const attempt = await runTicket(agentDeps, ticket.id);
            const refreshed = getTicket(db, ticket.id)!;
            return json({ ticket: stripLabels(refreshed), attempt });
          }
          return json({ ticket: stripLabels(ticket) }, 201);
        }),
      },

      "/tickets/:id": {
        GET: wrap(async (req: BunRequest<"/tickets/:id">) => {
          const ticket = getTicket(db, req.params.id);
          if (!ticket) return json({ error: "ticket not found" }, 404);
          return json({
            ticket: ticketDetailView(ticket),
            attempts: getAttempts(db, ticket.id),
            reviews: getReviews(db, ticket.id),
            context: buildContext(fx, { from: ticket.sender_email, subject: ticket.subject, body: ticket.body }).blocks,
          });
        }),
      },

      "/tickets/:id/run": {
        POST: wrap(async (req: BunRequest<"/tickets/:id/run">) => {
          const ticket = getTicket(db, req.params.id);
          if (!ticket) return json({ error: "ticket not found" }, 404);
          const attempt = await runTicket(agentDeps, ticket.id);
          const refreshed = getTicket(db, ticket.id)!;
          return json({ ticket: stripLabels(refreshed), attempt });
        }),
      },

      "/tickets/:id/approve": {
        POST: wrap(async (req: BunRequest<"/tickets/:id/approve">) => {
          const ticket = getTicket(db, req.params.id);
          if (!ticket) return json({ error: "ticket not found" }, 404);
          if (ticket.status !== "escalated") return json({ error: "ticket is not escalated" }, 409);
          if (ticket.current_attempt_id == null) return json({ error: "ticket has no attempt to approve" }, 409);
          let body: Record<string, unknown>;
          try {
            body = await readJsonBody(req);
          } catch (err) {
            if (err instanceof InvalidJsonBody) return INVALID_JSON_RESPONSE();
            throw err;
          }
          const editedReply = typeof body.edited_reply === "string" && body.edited_reply.length > 0 ? body.edited_reply : null;
          const currentAttempt = getAttempts(db, ticket.id).find((a) => a.id === ticket.current_attempt_id);
          if (!editedReply && !currentAttempt?.reply_text) {
            return json({ error: "attempt has no reply text; provide edited_reply" }, 409);
          }
          insertReview(db, {
            ticket_id: ticket.id,
            attempt_id: ticket.current_attempt_id,
            action: editedReply ? "edit" : "approve",
            edited_reply: editedReply,
          });
          setTicketState(db, ticket.id, "resolved", ticket.current_attempt_id);
          const refreshed = getTicket(db, ticket.id)!;
          return json({ ticket: stripLabels(refreshed) });
        }),
      },

      "/tickets/:id/retry": {
        POST: wrap(async (req: BunRequest<"/tickets/:id/retry">) => {
          const ticket = getTicket(db, req.params.id);
          if (!ticket) return json({ error: "ticket not found" }, 404);
          let body: Record<string, unknown>;
          try {
            body = await readJsonBody(req);
          } catch (err) {
            if (err instanceof InvalidJsonBody) return INVALID_JSON_RESPONSE();
            throw err;
          }
          const notes = body.notes;
          if (typeof notes !== "string" || !notes.trim()) return json({ error: "notes are required" }, 400);
          const attempt = await runTicket(agentDeps, ticket.id, { notes });
          const refreshed = getTicket(db, ticket.id)!;
          return json({ ticket: stripLabels(refreshed), attempt });
        }),
      },

      // The API equivalent of the console's run-all.
      "/run-all": {
        POST: wrap(async () => {
          const newTickets = listTickets(db, "new");
          let runtimeDown = false;
          const results = await pool(newTickets, config.runConcurrency, async (t) => {
            if (runtimeDown) return null;
            try {
              return await runTicket(agentDeps, t.id);
            } catch (err) {
              // Claimed by another request since the list was read: not ours to run.
              if (err instanceof TicketNotRunnableError) return null;
              // Stop the remaining workers too; the request answers 503.
              if (err instanceof ModelUnavailableError) runtimeDown = true;
              throw err;
            }
          });
          const attempts = results.filter((a) => a !== null);
          const resolved = attempts.filter((a) => a.guardrail_result === "resolve").length;
          const escalated = attempts.length - resolved;
          return json({ ran: attempts.length, resolved, escalated });
        }),
      },

      "/stats": {
        GET: wrap(async () => json({ ...stats(db), model: config.oriModel, runConcurrency: config.runConcurrency })),
      },

      "/eval": {
        // Deliberately takes no options from the request body: an evalDbPath or tickets list
        // supplied by the caller would let any HTTP client delete an arbitrary file (via
        // freshEvalDb) or inject unvalidated tickets into the live agent loop. The eval db
        // path and ticket set are always server-side (evalOpts, defaulted from config above).
        POST: wrap(async () => {
          if (evalRunning) return json({ error: "an eval run is already in progress" }, 409);
          evalRunning = true;
          try {
            // Fail fast with a 503 rather than a 202 for a run that records every ticket as a
            // miss. An injected judge backend (tests) is taken as ready.
            if (usesDefaultJudge) await agentDeps.judgeBackend.ensureAvailable?.();
            await backend.ensureAvailable?.();
            const id = await startEval(agentDeps, evalOpts, () => {
              evalRunning = false;
            });
            return json({ id }, 202);
          } catch (err) {
            evalRunning = false;
            throw err;
          }
        }),
      },
      "/eval/runs": {
        GET: wrap(async () => json(listEvalRuns(db))),
      },
      "/eval/runs/:id": {
        GET: wrap(async (req: BunRequest<"/eval/runs/:id">) => {
          const id = Number(req.params.id);
          if (!Number.isInteger(id)) return json({ error: "invalid eval run id" }, 400);
          const run = getEvalRun(db, id);
          if (!run) return json({ error: "eval run not found" }, 404);
          return json(run);
        }),
      },
      "/eval/runs/:id/results/:ticketId": {
        GET: wrap(async (req: BunRequest<"/eval/runs/:id/results/:ticketId">) => {
          const id = Number(req.params.id);
          if (!Number.isInteger(id)) return json({ error: "invalid eval run id" }, 400);
          const detail = getEvalResultDetail(db, id, req.params.ticketId);
          if (!detail) return json({ error: "result not found" }, 404);
          return json(detail);
        }),
      },
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });
}

/**
 * Binds the port, then returns tickets left "running" to their queue and closes eval runs a
 * stopped server left open. Bun.serve throws EADDRINUSE when another server holds the port,
 * so a second server exits without touching that server's in-flight tickets or eval runs.
 */
export function startServer(deps: ServerDeps): { server: ReturnType<typeof createServer>; recoveredTickets: number; interruptedEvals: number } {
  const server = createServer(deps);
  const recoveredTickets = recoverInterruptedTickets(deps.db);
  const interruptedEvals = markInterruptedEvalRuns(deps.db, { evalDbPath: (deps.evalOpts ?? { evalDbPath: config.evalDbPath }).evalDbPath });
  return { server, recoveredTickets, interruptedEvals };
}

if (import.meta.main) {
  const db = openDb(config.dbPath);
  const fx = await loadFixtures();

  const tickets = await loadSeedTickets(new URL("../fixtures/tickets.json", import.meta.url));
  if (tickets) {
    console.log(`seeded ${seedTickets(db, tickets)} ticket(s)`);
  } else {
    console.warn("fixtures/tickets.json not found; seeding no tickets");
  }

  const backend = getBackend();
  const { server, recoveredTickets, interruptedEvals } = startServer({ db, fx, backend });
  if (recoveredTickets > 0) console.warn(`returned ${recoveredTickets} interrupted ticket run(s) to their queue`);
  if (interruptedEvals > 0) console.warn(`marked ${interruptedEvals} unfinished eval run(s) as interrupted`);
  console.log(`listening on http://localhost:${server.port}`);
}
