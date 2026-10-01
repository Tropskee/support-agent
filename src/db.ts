import { Database } from "bun:sqlite";
import type { TicketLabels } from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, sender_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
  received_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', current_attempt_id INTEGER,
  label_priority TEXT, label_should_escalate INTEGER, label_expected_action TEXT, label_required_facts_json TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL REFERENCES tickets(id),
  attempt_no INTEGER NOT NULL, parent_attempt_id INTEGER REFERENCES attempts(id),
  model TEXT NOT NULL, prompt_version TEXT NOT NULL, context_json TEXT NOT NULL,
  system_prompt TEXT NOT NULL, user_prompt TEXT NOT NULL, reviewer_notes TEXT,
  raw_response TEXT, parsed_json TEXT, parse_error TEXT,
  priority TEXT, confidence REAL, reasoning TEXT, reply_text TEXT,
  proposed_actions_json TEXT, citations_json TEXT, critique TEXT,
  guardrail_result TEXT NOT NULL, guardrail_reasons_json TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL, latency_ms INTEGER, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL REFERENCES tickets(id),
  attempt_id INTEGER NOT NULL REFERENCES attempts(id), action TEXT NOT NULL,
  edited_reply TEXT, notes TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS eval_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL, prompt_version TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT, totals_json TEXT,
  -- pid of the process running this eval; a restarting server leaves a live owner's run alone
  owner_pid INTEGER
);
-- ticket_id has no FK to tickets(id): an eval run's tickets live only in its own eval db,
-- never in this database's tickets table, so this row can be written here regardless.
CREATE TABLE IF NOT EXISTS eval_results (
  eval_run_id INTEGER NOT NULL REFERENCES eval_runs(id), ticket_id TEXT NOT NULL,
  attempt_id INTEGER REFERENCES attempts(id), scores_json TEXT NOT NULL, detail_json TEXT NOT NULL,
  PRIMARY KEY (eval_run_id, ticket_id)
);
CREATE INDEX IF NOT EXISTS ix_attempts_ticket ON attempts(ticket_id);
`;

export interface TicketRow {
  id: string;
  sender_email: string;
  subject: string;
  body: string;
  received_at: string;
  // "running" while the agent works on it; listTickets(status) never returns it under
  // new/resolved/escalated, so a ticket being run drops out of those queues until it's done.
  status: "new" | "running" | "resolved" | "escalated";
  current_attempt_id: number | null;
  label_priority: string | null;
  label_should_escalate: number | null;
  label_expected_action: string | null;
  label_required_facts_json: string | null;
}

export interface AttemptRow {
  id: number;
  ticket_id: string;
  attempt_no: number;
  parent_attempt_id: number | null;
  model: string;
  prompt_version: string;
  context_json: string;
  system_prompt: string;
  user_prompt: string;
  reviewer_notes: string | null;
  raw_response: string | null;
  parsed_json: string | null;
  parse_error: string | null;
  priority: string | null;
  confidence: number | null;
  reasoning: string | null;
  reply_text: string | null;
  proposed_actions_json: string | null;
  citations_json: string | null;
  critique: string | null;
  guardrail_result: string;
  guardrail_reasons_json: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number | null;
  latency_ms: number | null;
  started_at: string;
  finished_at: string;
  error: string | null;
}

export interface ReviewRow {
  id: number;
  ticket_id: string;
  attempt_id: number;
  action: "approve" | "edit" | "retry";
  edited_reply: string | null;
  notes: string | null;
  created_at: string;
}

export function openDb(path?: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

// One past the highest all-digit TKT-<n> id, padded to the fixtures' width (TKT-001..TKT-100);
// the width grows on its own past 999. Ids with other suffixes (eval tickets) are ignored.
function nextTicketId(db: Database): string {
  const row = db
    .query(
      `SELECT COALESCE(MAX(CAST(SUBSTR(id, 5) AS INTEGER)), 0) AS n FROM tickets
       WHERE id GLOB 'TKT-[0-9]*' AND SUBSTR(id, 5) NOT GLOB '*[^0-9]*'`,
    )
    .get() as { n: number };
  return `TKT-${String(row.n + 1).padStart(3, "0")}`;
}

export function insertTicket(
  db: Database,
  t: { id?: string; sender_email: string; subject: string; body: string; received_at?: string; labels?: TicketLabels },
): TicketRow {
  const id = t.id ?? nextTicketId(db);
  const received_at = t.received_at ?? new Date().toISOString();
  db.query(
    `INSERT INTO tickets (id, sender_email, subject, body, received_at, status, current_attempt_id,
       label_priority, label_should_escalate, label_expected_action, label_required_facts_json)
     VALUES ($id, $sender_email, $subject, $body, $received_at, 'new', NULL, $label_priority, $label_should_escalate, $label_expected_action, $label_required_facts_json)`,
  ).run({
    $id: id,
    $sender_email: t.sender_email,
    $subject: t.subject,
    $body: t.body,
    $received_at: received_at,
    $label_priority: t.labels?.priority ?? null,
    $label_should_escalate: t.labels ? (t.labels.shouldEscalate ? 1 : 0) : null,
    $label_expected_action: t.labels?.expectedAction ?? null,
    $label_required_facts_json: t.labels ? JSON.stringify(t.labels.requiredFacts) : null,
  });
  return getTicket(db, id)!;
}

export function getTicket(db: Database, id: string): TicketRow | null {
  return (db.query("SELECT * FROM tickets WHERE id = $id").get({ $id: id }) as TicketRow | undefined) ?? null;
}

export function listTickets(db: Database, status?: TicketRow["status"]): TicketRow[] {
  if (status) {
    return db.query("SELECT * FROM tickets WHERE status = $status ORDER BY received_at DESC").all({ $status: status }) as TicketRow[];
  }
  return db.query("SELECT * FROM tickets ORDER BY received_at DESC").all() as TicketRow[];
}

export function insertAttempt(db: Database, a: Omit<AttemptRow, "id">): AttemptRow {
  const result = db
    .query(
      `INSERT INTO attempts (
        ticket_id, attempt_no, parent_attempt_id, model, prompt_version, context_json,
        system_prompt, user_prompt, reviewer_notes, raw_response, parsed_json, parse_error,
        priority, confidence, reasoning, reply_text, proposed_actions_json, citations_json, critique,
        guardrail_result, guardrail_reasons_json, input_tokens, output_tokens, cache_read_tokens,
        cost_usd, latency_ms, started_at, finished_at, error
      ) VALUES (
        $ticket_id, $attempt_no, $parent_attempt_id, $model, $prompt_version, $context_json,
        $system_prompt, $user_prompt, $reviewer_notes, $raw_response, $parsed_json, $parse_error,
        $priority, $confidence, $reasoning, $reply_text, $proposed_actions_json, $citations_json, $critique,
        $guardrail_result, $guardrail_reasons_json, $input_tokens, $output_tokens, $cache_read_tokens,
        $cost_usd, $latency_ms, $started_at, $finished_at, $error
      ) RETURNING id`,
    )
    .get({
      $ticket_id: a.ticket_id,
      $attempt_no: a.attempt_no,
      $parent_attempt_id: a.parent_attempt_id,
      $model: a.model,
      $prompt_version: a.prompt_version,
      $context_json: a.context_json,
      $system_prompt: a.system_prompt,
      $user_prompt: a.user_prompt,
      $reviewer_notes: a.reviewer_notes,
      $raw_response: a.raw_response,
      $parsed_json: a.parsed_json,
      $parse_error: a.parse_error,
      $priority: a.priority,
      $confidence: a.confidence,
      $reasoning: a.reasoning,
      $reply_text: a.reply_text,
      $proposed_actions_json: a.proposed_actions_json,
      $citations_json: a.citations_json,
      $critique: a.critique,
      $guardrail_result: a.guardrail_result,
      $guardrail_reasons_json: a.guardrail_reasons_json,
      $input_tokens: a.input_tokens,
      $output_tokens: a.output_tokens,
      $cache_read_tokens: a.cache_read_tokens,
      $cost_usd: a.cost_usd,
      $latency_ms: a.latency_ms,
      $started_at: a.started_at,
      $finished_at: a.finished_at,
      $error: a.error,
    }) as { id: number };
  return { id: result.id, ...a };
}

export function getAttempts(db: Database, ticketId: string): AttemptRow[] {
  return db
    .query("SELECT * FROM attempts WHERE ticket_id = $ticket_id ORDER BY attempt_no ASC")
    .all({ $ticket_id: ticketId }) as AttemptRow[];
}

export function setTicketState(db: Database, id: string, status: TicketRow["status"], currentAttemptId: number | null): void {
  db.query("UPDATE tickets SET status = $status, current_attempt_id = $current_attempt_id WHERE id = $id").run({
    $status: status,
    $current_attempt_id: currentAttemptId,
    $id: id,
  });
}

/**
 * Atomically move a ticket from `expected` to "running".
 *
 * Returns
 * -------
 * boolean
 *     True when this caller claimed the ticket; false when it was not in `expected` (already
 *     running, or in another status), in which case nothing changed.
 */
export function claimTicket(db: Database, id: string, expected: "new" | "escalated"): boolean {
  const result = db.query("UPDATE tickets SET status = 'running' WHERE id = $id AND status = $expected").run({ $id: id, $expected: expected });
  return result.changes === 1;
}

/** Put a claimed ticket back in the status it was claimed from. */
export function releaseTicket(db: Database, id: string, prior: "new" | "escalated"): void {
  db.query("UPDATE tickets SET status = $prior WHERE id = $id AND status = 'running'").run({ $id: id, $prior: prior });
}

/**
 * Return tickets left "running" by a process that stopped mid-run to their prior status.
 * Only "new" tickets (no attempt yet) and "escalated" ones (retries) are ever claimed, so a
 * ticket with no current attempt was new and one with an attempt was escalated.
 */
export function recoverInterruptedTickets(db: Database): number {
  const result = db
    .query("UPDATE tickets SET status = CASE WHEN current_attempt_id IS NULL THEN 'new' ELSE 'escalated' END WHERE status = 'running'")
    .run();
  return result.changes;
}

export function insertReview(
  db: Database,
  r: { ticket_id: string; attempt_id: number; action: "approve" | "edit" | "retry"; edited_reply?: string | null; notes?: string | null },
): void {
  db.query(
    `INSERT INTO reviews (ticket_id, attempt_id, action, edited_reply, notes, created_at)
     VALUES ($ticket_id, $attempt_id, $action, $edited_reply, $notes, $created_at)`,
  ).run({
    $ticket_id: r.ticket_id,
    $attempt_id: r.attempt_id,
    $action: r.action,
    $edited_reply: r.edited_reply ?? null,
    $notes: r.notes ?? null,
    $created_at: new Date().toISOString(),
  });
}

export function getReviews(db: Database, ticketId: string): ReviewRow[] {
  return db.query("SELECT * FROM reviews WHERE ticket_id = $ticket_id ORDER BY created_at ASC").all({ $ticket_id: ticketId }) as ReviewRow[];
}

export interface TicketListItem extends TicketRow {
  priority: string | null;
  guardrail_reasons_json: string | null;
  latency_ms: number | null;
  review_count: number;
  // Reviews where a person approved or edited the reply; retries are not approvals.
  approved_count: number;
}

/** Tickets with their current attempt's summary fields and review counts, in one query. */
export function listTicketSummaries(db: Database, status?: TicketRow["status"]): TicketListItem[] {
  return db
    .query(
      `SELECT t.*, a.priority, a.guardrail_reasons_json, a.latency_ms,
              (SELECT COUNT(*) FROM reviews r WHERE r.ticket_id = t.id) AS review_count,
              (SELECT COUNT(*) FROM reviews r WHERE r.ticket_id = t.id AND r.action IN ('approve', 'edit')) AS approved_count
       FROM tickets t
       LEFT JOIN attempts a ON a.id = t.current_attempt_id
       WHERE $status IS NULL OR t.status = $status
       ORDER BY t.received_at DESC`,
    )
    .all({ $status: status ?? null }) as TicketListItem[];
}

export function stats(db: Database): { byStatus: Record<string, number>; totalCostUsd: number; totalTokens: number; attempts: number } {
  const byStatusRows = db.query("SELECT status, COUNT(*) as n FROM tickets GROUP BY status").all() as { status: string; n: number }[];
  const byStatus: Record<string, number> = {};
  for (const row of byStatusRows) byStatus[row.status] = row.n;

  const totals = db
    .query(
      `SELECT COUNT(*) as attempts,
              COALESCE(SUM(cost_usd), 0) as totalCostUsd,
              COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens), 0) as totalTokens
       FROM attempts`,
    )
    .get() as { attempts: number; totalCostUsd: number; totalTokens: number };

  return { byStatus, totalCostUsd: totals.totalCostUsd, totalTokens: totals.totalTokens, attempts: totals.attempts };
}
