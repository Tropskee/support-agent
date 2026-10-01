// Eval: runs every labeled ticket in fixtures/tickets.json through the agent loop and scores
// each attempt against its ground-truth label. Runs in a separate database (eval.db, or
// ":memory:" in tests) so a running eval never touches the console's live ticket queues, then
// mirrors the run and its per-ticket scores into the main database so the Eval tab has history.
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentDeps } from "./agent";
import { runTicket } from "./agent";
import type { GeneratedTicket } from "./archetypes";
import { config } from "./config";
import { insertTicket, openDb } from "./db";
import type { AttemptRow } from "./db";
import { renderBlocks } from "./lookup";
import type { ContextBlock } from "./lookup";
import { loadFixtures } from "./fixtures";
import { getBackend, oriBackend } from "./model";
import type { ModelBackend } from "./model";
import { pool } from "./pool";
import { PROMPT_VERSION } from "./prompt";
import type { Priority, RequiredFact, TicketLabels } from "./types";

export interface TicketScore {
  priorityExact: boolean;
  priorityWithinOne: boolean;
  escalateCorrect: boolean;
  actionMatch: boolean;
  factsFound: number;
  factsTotal: number;
  factResults: { description: string; pattern?: string; notPattern?: string; found: boolean; method: "regex" | "judge" }[];
  citationsValid: boolean;
  faithful: boolean | null;
  unsupportedClaims: string | null;
  costUsd: number | null;
  latencyMs: number | null;
}

export interface EvalTotals {
  n: number;
  priorityExact: number;
  priorityWithinOne: number;
  escalateAccuracy: number;
  p1Recall: number;
  p1Total: number;
  actionMatch: number;
  factsRate: number;
  citationValidity: number;
  faithfulness: number;
  faithJudged: number;
  totalCostUsd: number;
  medianLatencyMs: number;
  // Set only when the run as a whole failed or was interrupted (as opposed to an individual
  // ticket - see failedScore); the other totals then cover the tickets that completed first.
  error?: string;
}

const PRIORITY_RANK: Record<Priority, number> = { P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };

/** Parses only the judge's FIRST non-empty line - the prompt requires that line to be
 * exactly "SUPPORTED" or "UNSUPPORTED: <claim>; <claim>". This matters because the judge
 * sometimes writes an essay that reasons its way from "UNSUPPORTED" in an early paragraph
 * to "SUPPORTED" in its conclusion (or the reverse); reading the whole blob would let
 * whichever verdict happens to appear last win, or would dump the essay itself into
 * unsupportedClaims. Normalizes common variations: markdown emphasis, verdict labels,
 * bullet-pointed claims on following lines, and a SUPPORTED verdict followed by trailing
 * text (a colon/dash and an echo of the reply) - that trailing text is not a claim list,
 * so it is discarded. Anything that doesn't parse as a verdict on line one is a judge
 * failure, not a genuine verdict - it comes back as "not judged" (null) rather than being
 * counted as unfaithful. */
function parseFaithfulness(raw: string): { faithful: boolean | null; unsupportedClaims: string | null } {
  const lines = raw.split("\n");
  let firstLineIndex = -1;
  let firstLine: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.length > 0) {
      firstLineIndex = i;
      firstLine = trimmed;
      break;
    }
  }

  if (!firstLine) {
    return { faithful: null, unsupportedClaims: "judge output unparseable" };
  }

  const normalized = firstLine
    .replace(/^(?:verdict|answer):\s*/i, "")
    .replace(/[\*_`]/g, "")
    .replace(/\.$/, "")
    .trim();

  if (/^supported$/i.test(normalized)) {
    return { faithful: true, unsupportedClaims: null };
  }

  // The colon is optional; the word must be followed by a colon, whitespace, or the end.
  const unsupportedMatch = /^unsupported(?:(?::\s*|\s+)(.*))?$/i.exec(normalized);
  if (unsupportedMatch) {
    const claimsOnFirstLine = (unsupportedMatch[1] ?? "").trim();
    if (claimsOnFirstLine.length > 0) {
      return { faithful: false, unsupportedClaims: claimsOnFirstLine };
    }

    // No claims on the first line: they are on the lines after it.
    const followingLines = lines
      .slice(firstLineIndex + 1)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (followingLines.length === 0) {
      return { faithful: false, unsupportedClaims: "(none listed)" };
    }

    const claims = followingLines
      .map((line) =>
        line
          .replace(/^[-*•]\s*/, "")
          .replace(/^[0-9]+\.\s*/, "")
          .trim(),
      )
      .join("; ");

    return { faithful: false, unsupportedClaims: claims };
  }

  // SUPPORTED followed by a colon/dash and trailing text (often an echo of the reply) is
  // still a SUPPORTED verdict; the trailing text is not a claim list, so it is dropped.
  if (/^supported(?:\s*[:\-—]\s*|\s+)\S.*$/i.test(normalized)) {
    return { faithful: true, unsupportedClaims: null };
  }

  const snippet = raw
    .replace(/\n/g, " ")
    .substring(0, 200);
  return { faithful: null, unsupportedClaims: `judge output unparseable: ${snippet}` };
}

export interface TicketContext {
  from: string;
  subject: string;
  body: string;
}

/**
 * Check one required fact against a reply by its regex, the way the eval scores it.
 *
 * Parameters
 * ----------
 * fact : RequiredFact
 *     The labelled fact. `pattern` must match the reply; `notPattern` must not. Both are
 *     case-insensitive regex sources.
 * replyText : string
 *     The finalized reply text.
 *
 * Returns
 * -------
 * boolean | null
 *     Whether the fact holds, or null when the fact has no regex and needs a judge.
 */
export function checkRegexFact(fact: RequiredFact, replyText: string): boolean | null {
  if (fact.pattern) return new RegExp(fact.pattern, "i").test(replyText);
  if (fact.notPattern) return !new RegExp(fact.notPattern, "i").test(replyText);
  return null;
}

export async function scoreAttempt(
  labels: TicketLabels,
  attempt: AttemptRow,
  judge?: (fact: string, reply: string) => Promise<boolean>,
  faithJudge?: (ticket: TicketContext, context: string, reply: string) => Promise<string>,
  ticket: TicketContext = { from: "", subject: "", body: "" },
): Promise<TicketScore> {
  const priority = attempt.priority as Priority | null;
  const priorityExact = priority === labels.priority;
  const priorityWithinOne = priority != null && Math.abs(PRIORITY_RANK[priority] - PRIORITY_RANK[labels.priority]) <= 1;
  const escalateCorrect = (attempt.guardrail_result === "escalate") === labels.shouldEscalate;

  const actions = attempt.proposed_actions_json ? (JSON.parse(attempt.proposed_actions_json) as { type: string }[]) : [];
  const actionMatch = actions.some((a) => a.type === labels.expectedAction);

  const replyText = attempt.reply_text ?? "";
  const factResults: TicketScore["factResults"] = [];
  for (const fact of labels.requiredFacts) {
    const regexFound = checkRegexFact(fact, replyText);
    if (regexFound !== null) {
      const regex = fact.pattern ? { pattern: fact.pattern } : { notPattern: fact.notPattern };
      factResults.push({ description: fact.description, ...regex, found: regexFound, method: "regex" });
    } else {
      const found = judge ? await judge(fact.description, replyText) : false;
      factResults.push({ description: fact.description, found, method: "judge" });
    }
  }
  const factsFound = factResults.filter((f) => f.found).length;

  const reasons = JSON.parse(attempt.guardrail_reasons_json) as { reason: string }[];
  const citationsValid = !reasons.some((r) => r.reason === "bad_citation");

  let faithful: boolean | null = null;
  let unsupportedClaims: string | null = null;
  if (attempt.reply_text && faithJudge) {
    // A failure here (the judge backend is down, the context blob doesn't parse) shouldn't
    // sink the whole ticket the way a failed fact judge does - faithfulness is reported
    // best-effort, so it just falls back to "not judged" (null).
    try {
      const contextBlocks = JSON.parse(attempt.context_json) as ContextBlock[];
      const contextStr = renderBlocks(contextBlocks);
      const raw = await faithJudge(ticket, contextStr, replyText);
      ({ faithful, unsupportedClaims } = parseFaithfulness(raw));
    } catch {
      faithful = null;
      unsupportedClaims = null;
    }
  }

  return {
    priorityExact,
    priorityWithinOne,
    escalateCorrect,
    actionMatch,
    factsFound,
    factsTotal: factResults.length,
    factResults,
    citationsValid,
    faithful,
    unsupportedClaims,
    costUsd: attempt.cost_usd,
    latencyMs: attempt.latency_ms,
  };
}

/** A ticket that failed to run or score at all: every check counts as a miss. */
function failedScore(labels: TicketLabels): TicketScore {
  return {
    priorityExact: false,
    priorityWithinOne: false,
    escalateCorrect: false,
    actionMatch: false,
    factsFound: 0,
    factsTotal: labels.requiredFacts.length,
    factResults: labels.requiredFacts.map((f) => ({
      description: f.description,
      pattern: f.pattern,
      notPattern: f.notPattern,
      found: false,
      method: f.pattern || f.notPattern ? "regex" : "judge",
    })),
    citationsValid: false,
    faithful: null,
    unsupportedClaims: null,
    costUsd: null,
    latencyMs: null,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function summarize(scores: { ticketId: string; labelPriority: Priority; score: TicketScore }[]): EvalTotals {
  const n = scores.length;
  const rate = (pred: (s: TicketScore) => boolean) => (n === 0 ? 0 : scores.filter((s) => pred(s.score)).length / n);

  const p1 = scores.filter((s) => s.labelPriority === "P1");
  const p1Recall = p1.length === 0 ? 0 : p1.filter((s) => s.score.escalateCorrect).length / p1.length;

  const factsFound = scores.reduce((sum, s) => sum + s.score.factsFound, 0);
  const factsTotal = scores.reduce((sum, s) => sum + s.score.factsTotal, 0);

  const judged = scores.filter((s) => s.score.faithful !== null);
  const faithfulness = judged.length === 0 ? 0 : judged.filter((s) => s.score.faithful === true).length / judged.length;

  return {
    n,
    priorityExact: rate((s) => s.priorityExact),
    priorityWithinOne: rate((s) => s.priorityWithinOne),
    escalateAccuracy: rate((s) => s.escalateCorrect),
    p1Recall,
    p1Total: p1.length,
    actionMatch: rate((s) => s.actionMatch),
    factsRate: factsTotal === 0 ? 0 : factsFound / factsTotal,
    citationValidity: rate((s) => s.citationsValid),
    faithfulness,
    faithJudged: judged.length,
    totalCostUsd: scores.reduce((sum, s) => sum + (s.score.costUsd ?? 0), 0),
    medianLatencyMs: median(scores.map((s) => s.score.latencyMs).filter((v): v is number => v != null)),
  };
}

////////////////////////////
// RUN ORCHESTRATION       //
////////////////////////////

export interface EvalRunRow {
  id: number;
  model: string;
  prompt_version: string;
  started_at: string;
  finished_at: string | null;
  owner_pid: number | null;
}

export interface EvalResultItem {
  ticket_id: string;
  subject: string;
  label_priority: Priority;
}

interface StoredResult extends TicketScore {
  subject: string;
  labelPriority: Priority;
  // Present only for a ticket whose run or scoring threw; JSON.stringify drops it when
  // undefined, so a successful result's scores_json never carries the key at all.
  error?: string;
}

/**
 * Everything the Eval tab's detail pane needs for one scored ticket, persisted to
 * eval_results.detail_json. Unlike scores_json (which only records whether the attempt's
 * priority matched the label, not the value itself), this carries the attempt's own fields
 * so the console can show what the agent actually decided and saw - not just whether it was
 * right. Written to both the eval db and the main db from runOneTicket, but it's the main
 * db's copy that matters for history: the eval db is recreated fresh on every run (see
 * freshEvalDb), so only the main db's row survives past the run that wrote it.
 */
export interface EvalDetailSnapshot {
  ticket: { id: string; from: string; subject: string; body: string; archetype: string; hard: string | null };
  labels: TicketLabels;
  attempt: {
    priority: string | null;
    confidence: number | null;
    reasoning: string | null;
    reply_text: string | null;
    proposed_actions: unknown[];
    citations: unknown[];
    guardrail_result: string | null;
    guardrail_reasons: { reason: string; detail: string }[];
    context: ContextBlock[];
    input_tokens: number | null;
    output_tokens: number | null;
    cost_usd: number | null;
    latency_ms: number | null;
    error: string | null;
    critique: string | null;
  };
  score: TicketScore;
}

function buildDetailSnapshot(ticket: GeneratedTicket, attempt: AttemptRow | null, score: TicketScore, runError?: string): EvalDetailSnapshot {
  return {
    ticket: { id: ticket.id, from: ticket.from, subject: ticket.subject, body: ticket.body, archetype: ticket.archetype, hard: ticket.hard },
    labels: ticket.labels,
    attempt: {
      priority: attempt?.priority ?? null,
      confidence: attempt?.confidence ?? null,
      reasoning: attempt?.reasoning ?? null,
      reply_text: attempt?.reply_text ?? null,
      proposed_actions: attempt?.proposed_actions_json ? (JSON.parse(attempt.proposed_actions_json) as unknown[]) : [],
      citations: attempt?.citations_json ? (JSON.parse(attempt.citations_json) as unknown[]) : [],
      guardrail_result: attempt?.guardrail_result ?? null,
      guardrail_reasons: attempt?.guardrail_reasons_json ? (JSON.parse(attempt.guardrail_reasons_json) as { reason: string; detail: string }[]) : [],
      context: attempt?.context_json ? (JSON.parse(attempt.context_json) as ContextBlock[]) : [],
      input_tokens: attempt?.input_tokens ?? null,
      output_tokens: attempt?.output_tokens ?? null,
      cost_usd: attempt?.cost_usd ?? null,
      latency_ms: attempt?.latency_ms ?? null,
      error: runError ?? attempt?.error ?? null,
      critique: attempt?.critique ?? null,
    },
    score,
  };
}

function insertEvalRunRow(db: Database, r: { id?: number; model: string; prompt_version: string; started_at: string }): number {
  if (r.id != null) {
    db.query(
      `INSERT INTO eval_runs (id, model, prompt_version, started_at, finished_at, totals_json, owner_pid)
       VALUES ($id, $model, $prompt_version, $started_at, NULL, NULL, $owner_pid)`,
    ).run({ $id: r.id, $model: r.model, $prompt_version: r.prompt_version, $started_at: r.started_at, $owner_pid: process.pid });
    return r.id;
  }
  const row = db
    .query(
      `INSERT INTO eval_runs (model, prompt_version, started_at, finished_at, totals_json, owner_pid)
       VALUES ($model, $prompt_version, $started_at, NULL, NULL, $owner_pid) RETURNING id`,
    )
    .get({ $model: r.model, $prompt_version: r.prompt_version, $started_at: r.started_at, $owner_pid: process.pid }) as { id: number };
  return row.id;
}

function finishEvalRun(db: Database, id: number, finishedAt: string, totals: EvalTotals): void {
  db.query("UPDATE eval_runs SET finished_at = $finished_at, totals_json = $totals_json WHERE id = $id").run({
    $finished_at: finishedAt,
    $totals_json: JSON.stringify(totals),
    $id: id,
  });
}

function insertEvalResultRow(
  db: Database,
  r: { eval_run_id: number; ticket_id: string; attempt_id: number | null; scores_json: string; detail_json: string },
): void {
  db.query(
    `INSERT INTO eval_results (eval_run_id, ticket_id, attempt_id, scores_json, detail_json)
     VALUES ($eval_run_id, $ticket_id, $attempt_id, $scores_json, $detail_json)`,
  ).run({
    $eval_run_id: r.eval_run_id,
    $ticket_id: r.ticket_id,
    $attempt_id: r.attempt_id,
    $scores_json: r.scores_json,
    $detail_json: r.detail_json,
  });
}

function makeJudge(backend: ModelBackend): (fact: string, reply: string) => Promise<boolean> {
  return async (fact, reply) => {
    const { text } = await backend.write({
      system: "Answer only yes or no.",
      user: `Does this reply state: ${JSON.stringify(fact)}? Answer yes or no.\n\n${reply}`,
      model: config.judgeModel,
    });
    return /^yes/i.test(text.trim());
  };
}

const FAITH_JUDGE_SYSTEM =
  "You check a customer support reply for unsupported factual claims. You are given the customer's own " +
  "ticket, the context blocks the agent that wrote the reply was given, and the reply itself.\n\n" +
  "Two kinds of statement in the reply are NOT claims to check, even though they are facts:\n" +
  "1. Anything the customer already said in their own ticket (their name, what card or order they mean, " +
  "details they described) - the agent restating the customer's own words back to them is fine.\n" +
  "2. The company's own standard process, whatever the agent is instructed to always say - asking the " +
  "customer to reply to the email with photos, a sign-off, a note that a person will review the case, and " +
  "the like. These are process instructions, not claims about this customer's case.\n\n" +
  "Judge only factual claims about the order, the card, its grade, money, dates, timelines, policy, and " +
  "process against the context blocks - a claim is unsupported only when the context blocks do not back it " +
  "up and it isn't just the customer's own statement or standard process.\n\n" +
  "Reply with exactly SUPPORTED, or UNSUPPORTED: followed by the claims. Nothing else.\n\n" +
  "Each claim under about 15 words.";

function makeFaithJudge(backend: ModelBackend): (ticket: TicketContext, context: string, reply: string) => Promise<string> {
  return async (ticket, context, reply) => {
    const { text } = await backend.write({
      system: FAITH_JUDGE_SYSTEM,
      user:
        `Customer's ticket:\nFrom: ${ticket.from}\nSubject: ${ticket.subject}\n${ticket.body}\n\n` +
        `Context blocks the agent saw:\n\n${context}\n\n` +
        `Reply:\n${reply}\n\n` +
        "List any factual claim in the reply that the context blocks above do not support. " +
        "Ignore facts the customer already stated in their own ticket, and ignore standard process " +
        "instructions the agent always gives.",
      model: config.faithJudgeModel,
    });
    return text;
  };
}

async function loadTickets(tickets?: GeneratedTicket[]): Promise<GeneratedTicket[]> {
  if (tickets) return tickets;
  return (await Bun.file(new URL("../fixtures/tickets.json", import.meta.url)).json()) as GeneratedTicket[];
}

export interface EvalOpts {
  evalDbPath?: string;
  tickets?: GeneratedTicket[];
}

interface Begun {
  id: number;
  evalDb: Database;
  evalDbPath: string;
  tickets: GeneratedTicket[];
}

/**
 * The eval db file for one run: `<name>-<runId>.db` next to the configured path, so two runs
 * (say the CLI and the server) never share, or delete, each other's file.
 *
 * Parameters
 * ----------
 * configured : string
 *     The configured eval db path (config.evalDbPath), or ":memory:".
 * runId : number
 *     The run's id in the main db.
 *
 * Returns
 * -------
 * string
 *     The per-run path, or ":memory:" unchanged.
 */
export function evalDbPathForRun(configured: string, runId: number): string {
  if (configured === ":memory:") return configured;
  // Only ever derive (and later delete) something that looks like one of our own database files.
  if (!basename(configured).endsWith(".db")) {
    throw new Error(`refusing to use an eval db path that doesn't end in .db: ${configured}`);
  }
  return join(dirname(configured), `${basename(configured, ".db")}-${runId}.db`);
}

function removeEvalDbFiles(path: string): void {
  if (path === ":memory:") return;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // already gone
    }
  }
}

/** Opens an empty eval db, first removing any stale file a reset main db's run id left behind. */
async function freshEvalDb(path: string): Promise<Database> {
  removeEvalDbFiles(path);
  return openDb(path);
}

/**
 * Only reserves a run id (in both databases) and opens the eval db; seeding and running the
 * tickets happens in runEvalTickets so a failure there still has a row to record itself
 * against. The id is allocated from the MAIN db, which persists across runs, so it is unique
 * and names the run's own eval db file.
 */
async function beginEvalRun(deps: AgentDeps, opts: EvalOpts): Promise<Begun> {
  const tickets = await loadTickets(opts.tickets);
  const model = config.oriModel;
  const startedAt = new Date().toISOString();

  const id = insertEvalRunRow(deps.db, { model, prompt_version: PROMPT_VERSION, started_at: startedAt });

  let evalDb: Database;
  let evalDbPath: string;
  try {
    evalDbPath = evalDbPathForRun(opts.evalDbPath ?? "eval.db", id);
    evalDb = await freshEvalDb(evalDbPath);
    insertEvalRunRow(evalDb, { id, model, prompt_version: PROMPT_VERSION, started_at: startedAt });
  } catch (err) {
    // The main db already has this run's row (with no finished_at) - record the failure
    // there rather than leaving it stuck looking like a run that's still in progress.
    const message = err instanceof Error ? err.message : String(err);
    finishEvalRun(deps.db, id, new Date().toISOString(), { ...summarize([]), error: message });
    throw err;
  }

  return { id, evalDb, evalDbPath, tickets };
}

async function runOneTicket(
  deps: AgentDeps,
  evalDb: Database,
  id: number,
  judge: (fact: string, reply: string) => Promise<boolean>,
  faithJudge: (ticket: TicketContext, context: string, reply: string) => Promise<string>,
  ticket: GeneratedTicket,
): Promise<{ ticketId: string; labelPriority: Priority; score: TicketScore }> {
  let score: TicketScore;
  let attempt: AttemptRow | null = null;
  let error: string | undefined;
  try {
    attempt = await runTicket({ db: evalDb, fx: deps.fx, backend: deps.backend }, ticket.id);
    score = await scoreAttempt(ticket.labels, attempt, judge, faithJudge, { from: ticket.from, subject: ticket.subject, body: ticket.body });
  } catch (err) {
    score = failedScore(ticket.labels);
    error = err instanceof Error ? err.message : String(err);
  }

  const stored: StoredResult = { subject: ticket.subject, labelPriority: ticket.labels.priority, ...score, error };
  const detailJson = JSON.stringify(buildDetailSnapshot(ticket, attempt, score, error));
  const attemptId = attempt?.id ?? null;
  insertEvalResultRow(evalDb, { eval_run_id: id, ticket_id: ticket.id, attempt_id: attemptId, scores_json: JSON.stringify(stored), detail_json: detailJson });
  insertEvalResultRow(deps.db, { eval_run_id: id, ticket_id: ticket.id, attempt_id: null, scores_json: JSON.stringify(stored), detail_json: detailJson });

  return { ticketId: ticket.id, labelPriority: ticket.labels.priority, score };
}

/** Runs every ticket, tolerating a single ticket's failure (recorded as a miss, see
 * runOneTicket) without aborting the others. If something outside that per-ticket handling
 * throws - a seeding error, a bug in pool() itself - the run still finishes: finished_at and
 * totals_json (carrying an `error`) are written to both databases from whatever did complete. */
async function runEvalTickets(deps: AgentDeps, begun: Begun): Promise<void> {
  const { id, evalDb, evalDbPath, tickets } = begun;
  const judge = makeJudge(deps.judgeBackend ?? deps.backend);
  const faithJudge = makeFaithJudge(deps.judgeBackend ?? deps.backend);
  const scored: { ticketId: string; labelPriority: Priority; score: TicketScore }[] = [];

  try {
    // Fail the whole run up front rather than recording every ticket as a miss.
    await deps.backend.ensureAvailable?.();
    for (const t of tickets) {
      insertTicket(evalDb, { id: t.id, sender_email: t.from, subject: t.subject, body: t.body, labels: t.labels });
    }
    await pool(tickets, config.runConcurrency, async (ticket) => {
      scored.push(await runOneTicket(deps, evalDb, id, judge, faithJudge, ticket));
    });

    const totals = summarize(scored);
    const finishedAt = new Date().toISOString();
    finishEvalRun(evalDb, id, finishedAt, totals);
    finishEvalRun(deps.db, id, finishedAt, totals);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`eval run ${id} failed:`, message);
    const totals: EvalTotals = { ...summarize(scored), error: message };
    const finishedAt = new Date().toISOString();
    finishEvalRun(evalDb, id, finishedAt, totals);
    finishEvalRun(deps.db, id, finishedAt, totals);
  }
  // Everything the Eval tab shows is mirrored into the main db; the run's own file is scratch.
  evalDb.close();
  removeEvalDbFiles(evalDbPath);
}

/**
 * The backend the eval's fact and faithfulness judges call by default: the Ori feature's
 * /write, with config.judgeModel and config.faithJudgeModel. Tests that want deterministic
 * judge responses pass judgeBackend explicitly (often the same fakeBackend as deps.backend, to
 * share its queue).
 *
 * Returns
 * -------
 * ModelBackend
 *     A fresh Ori backend.
 */
export function defaultJudgeBackend(): ModelBackend {
  return oriBackend();
}

function withJudgeBackend(deps: AgentDeps): AgentDeps {
  return { ...deps, judgeBackend: deps.judgeBackend ?? defaultJudgeBackend() };
}

/** Starts an eval run and returns its id right away; the tickets run in the background.
 * onDone, if given, fires once the background run settles (success or failure) - the server
 * uses it to clear its "eval running" guard. */
export async function startEval(deps: AgentDeps, opts: EvalOpts = {}, onDone?: () => void): Promise<number> {
  const resolvedDeps = withJudgeBackend(deps);
  const begun = await beginEvalRun(resolvedDeps, opts);
  void runEvalTickets(resolvedDeps, begun).finally(() => onDone?.());
  return begun.id;
}

/** Same as startEval, but awaits every ticket before returning. Used by the CLI and tests. */
export async function runEval(deps: AgentDeps, opts: EvalOpts = {}): Promise<number> {
  const resolvedDeps = withJudgeBackend(deps);
  const begun = await beginEvalRun(resolvedDeps, opts);
  await runEvalTickets(resolvedDeps, begun);
  return begun.id;
}

export const INTERRUPTED_EVAL_ERROR = "interrupted: server restarted";

// True when pid names a running process other than this one. process.kill(pid, 0) sends no
// signal; it throws ESRCH for no such process and EPERM for one owned by another user, which
// is still alive.
function isOtherLiveProcess(pid: number | null): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Finish every eval run a stopped process left open (finished_at NULL), with totals over the
 * tickets it completed and `error` set to INTERRUPTED_EVAL_ERROR, and remove its eval db
 * files. A run whose owner_pid is another live process is still running there and is left
 * alone. Returns the number finished.
 */
export function markInterruptedEvalRuns(db: Database, opts: { evalDbPath?: string } = {}): number {
  const open = (db.query("SELECT id, owner_pid FROM eval_runs WHERE finished_at IS NULL").all() as { id: number; owner_pid: number | null }[]).filter(
    (r) => !isOtherLiveProcess(r.owner_pid),
  );
  const finishedAt = new Date().toISOString();
  for (const { id } of open) {
    const rows = db.query("SELECT ticket_id, scores_json FROM eval_results WHERE eval_run_id = $id").all({ $id: id }) as {
      ticket_id: string;
      scores_json: string;
    }[];
    const scored = rows.map((r) => {
      const { subject: _subject, labelPriority, error: _error, ...score } = JSON.parse(r.scores_json) as StoredResult;
      return { ticketId: r.ticket_id, labelPriority, score };
    });
    finishEvalRun(db, id, finishedAt, { ...summarize(scored), error: INTERRUPTED_EVAL_ERROR });
    if (opts.evalDbPath) removeEvalDbFiles(evalDbPathForRun(opts.evalDbPath, id));
  }
  return open.length;
}

export function listEvalRuns(db: Database): (EvalRunRow & { totals: EvalTotals | null })[] {
  const rows = db.query("SELECT * FROM eval_runs ORDER BY id DESC").all() as (EvalRunRow & { totals_json: string | null })[];
  return rows.map((r) => ({ ...r, totals: r.totals_json ? (JSON.parse(r.totals_json) as EvalTotals) : null }));
}

export function getEvalRun(
  db: Database,
  id: number,
): {
  run: EvalRunRow;
  totals: EvalTotals | null;
  results: (EvalResultItem & TicketScore & { error?: string; agent_priority: string | null; guardrail_result: string | null })[];
} | null {
  const runRow = db.query("SELECT * FROM eval_runs WHERE id = $id").get({ $id: id }) as (EvalRunRow & { totals_json: string | null }) | undefined;
  if (!runRow) return null;
  const { totals_json, ...run } = runRow;

  const resultRows = db
    .query("SELECT ticket_id, scores_json, detail_json FROM eval_results WHERE eval_run_id = $id ORDER BY ticket_id ASC")
    .all({ $id: id }) as { ticket_id: string; scores_json: string; detail_json: string }[];

  const results = resultRows.map((r) => {
    const { subject, labelPriority, ...score } = JSON.parse(r.scores_json) as StoredResult;
    const detail = JSON.parse(r.detail_json) as EvalDetailSnapshot;
    return {
      ticket_id: r.ticket_id,
      subject,
      label_priority: labelPriority,
      ...score,
      agent_priority: detail.attempt.priority,
      guardrail_result: detail.attempt.guardrail_result,
    } as EvalResultItem & TicketScore & { error?: string; agent_priority: string | null; guardrail_result: string | null };
  });

  return { run, totals: totals_json ? (JSON.parse(totals_json) as EvalTotals) : null, results };
}

/** The full per-ticket snapshot for the Eval tab's detail pane - null if this run/ticket
 * pair has no recorded result. */
export function getEvalResultDetail(db: Database, runId: number, ticketId: string): EvalDetailSnapshot | null {
  const row = db
    .query("SELECT detail_json FROM eval_results WHERE eval_run_id = $run_id AND ticket_id = $ticket_id")
    .get({ $run_id: runId, $ticket_id: ticketId }) as { detail_json: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.detail_json) as EvalDetailSnapshot;
}

////////////////////////////
// CLI                     //
////////////////////////////

async function main(): Promise<void> {
  const judgeBackend = defaultJudgeBackend();
  try {
    await judgeBackend.ensureAvailable?.();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const fx = await loadFixtures();
  const db = openDb(config.dbPath);
  const backend = getBackend();

  const id = await runEval({ db, fx, backend, judgeBackend }, { evalDbPath: config.evalDbPath });
  const run = getEvalRun(db, id)!;
  const t = run.totals!;

  console.log(`eval run ${id} (${run.run.model}, ${run.run.prompt_version}): ${t.n} tickets`);
  console.log(`  priority exact:     ${(t.priorityExact * 100).toFixed(1)}%`);
  console.log(`  priority within 1:  ${(t.priorityWithinOne * 100).toFixed(1)}%`);
  console.log(`  escalate accuracy:  ${(t.escalateAccuracy * 100).toFixed(1)}%`);
  console.log(`  P1 recall:          ${(t.p1Recall * 100).toFixed(1)}% (of ${t.p1Total})`);
  console.log(`  action match:       ${(t.actionMatch * 100).toFixed(1)}%`);
  console.log(`  facts found:        ${(t.factsRate * 100).toFixed(1)}%`);
  console.log(`  citation validity:  ${(t.citationValidity * 100).toFixed(1)}%`);
  console.log(`  faithful replies:   ${(t.faithfulness * 100).toFixed(1)}% (${t.faithJudged} of ${t.n} judged)`);
  console.log(`  total cost:         $${t.totalCostUsd.toFixed(4)}`);
  console.log(`  median latency:     ${t.medianLatencyMs}ms`);

  const misses = run.results.filter(
    (r) => r.error || !r.priorityExact || !r.escalateCorrect || r.factsFound < r.factsTotal || r.faithful === false,
  );
  if (misses.length > 0) {
    console.log(`\nmisses (${misses.length}):`);
    for (const m of misses) {
      const reasons = [
        m.error && `error: ${m.error}`,
        !m.priorityExact && `priority ${m.label_priority} expected`,
        !m.escalateCorrect && "escalation wrong",
        m.factsFound < m.factsTotal && `facts ${m.factsFound}/${m.factsTotal}`,
        m.faithful === false && `unsupported: ${m.unsupportedClaims}`,
      ].filter(Boolean);
      console.log(`  ${m.ticket_id} ${m.subject}: ${reasons.join(", ")}`);
    }
  }
}

if (import.meta.main) await main();
