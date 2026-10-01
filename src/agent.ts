import type { Database } from "bun:sqlite";
import { config } from "./config";
import {
  claimTicket,
  getAttempts,
  getTicket,
  insertAttempt,
  insertReview,
  releaseTicket,
  setTicketState,
  type AttemptRow,
} from "./db";
import type { Fixtures } from "./fixtures";
import { applyGuardrails, errorEscalation, type GuardrailResult } from "./guardrails";
import { buildContext, type TicketInput } from "./lookup";
import { ModelUnavailableError, type ModelBackend, type Usage } from "./model";
import { buildUserPrompt, decisionJsonSchema, finalizeReply, PROMPT_VERSION, stripInlineCitations, SYSTEM_PROMPT } from "./prompt";
import { DecisionSchema, type Decision } from "./types";

export interface AgentDeps {
  db: Database;
  fx: Fixtures;
  backend: ModelBackend;
  // Eval-only: backend for the fact and faithfulness judges (config.judgeModel and
  // config.faithJudgeModel).
  judgeBackend?: ModelBackend;
}

// The retry names no tool: the Ori turn has none, so telling the model to "use the tool" can never succeed.
const SCHEMA_RETRY_SUFFIX = (message: string) =>
  `\n\nYour last output did not match the schema: ${message}. Answer again with the corrected decision.`;

// Models sometimes echo a context block's bracketed label verbatim ("[order CG-20083]")
// or wrap it in quotes, instead of the bare label ("order CG-20083") the guardrail and the
// console compare against ctx.labels. Normalise before guardrails run and before storing,
// so every model gets the same bare-label comparison.
export function normalizeCitation(raw: string): string {
  return raw
    .trim()
    .replace(/^[["']+/, "")
    .replace(/[\]"']+$/, "")
    .trim()
    .replace(/\s+/g, " ");
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    costUsd: a.costUsd === null || b.costUsd === null ? null : a.costUsd + b.costUsd,
  };
}

/** The ticket is already being run, or is not in a status this run can start from. */
export class TicketNotRunnableError extends Error {}

/**
 * Run the agent on one ticket and record the attempt.
 *
 * A first run needs a "new" ticket and a retry an "escalated" one. The ticket is claimed
 * atomically (status "running") before anything else, so two concurrent calls on one ticket
 * can't both run; the loser gets TicketNotRunnableError. If anything throws after the claim,
 * the ticket goes back to the status it was claimed from.
 */
export async function runTicket(deps: AgentDeps, ticketId: string, retry?: { notes: string }): Promise<AttemptRow> {
  const prior = retry ? "escalated" : "new";
  if (!getTicket(deps.db, ticketId)) throw new Error(`ticket not found: ${ticketId}`);
  if (!claimTicket(deps.db, ticketId, prior)) {
    throw new TicketNotRunnableError(`ticket ${ticketId} is already running or is not ${prior}`);
  }
  try {
    return await runClaimedTicket(deps, ticketId, retry);
  } catch (err) {
    releaseTicket(deps.db, ticketId, prior);
    throw err;
  }
}

async function runClaimedTicket(deps: AgentDeps, ticketId: string, retry?: { notes: string }): Promise<AttemptRow> {
  const { db, fx, backend } = deps;

  const ticket = getTicket(db, ticketId)!;
  const ticketInput: TicketInput = { from: ticket.sender_email, subject: ticket.subject, body: ticket.body };
  const ctx = buildContext(fx, ticketInput);

  const previousAttempts = getAttempts(db, ticketId);

  let previousDecision: Decision | undefined;
  let parentAttemptId: number | null = null;
  if (retry) {
    if (ticket.current_attempt_id == null) throw new Error(`ticket has no current attempt to retry: ${ticketId}`);
    const prevAttempt = previousAttempts.find((a) => a.id === ticket.current_attempt_id);
    if (!prevAttempt) throw new Error(`no previous attempt to retry for ticket: ${ticketId}`);
    // A previous attempt that never produced a decision (a schema failure or a model error)
    // has nothing to critique; run fresh but still carry the reviewer's notes into the prompt.
    if (prevAttempt.parsed_json) previousDecision = JSON.parse(prevAttempt.parsed_json) as Decision;
    parentAttemptId = prevAttempt.id;
  }

  const startedAt = new Date().toISOString();

  let userPrompt = buildUserPrompt(ticketInput, ctx, retry ? { previous: previousDecision, notes: retry.notes } : undefined);

  let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
  let decision: Decision | null = null;
  let rawResponse: string | null = null;
  let parseError: string | null = null;
  let errorMessage: string | null = null;
  // The model the backend reports it ran; config.oriModel if no decide call returned.
  let reportedModel = config.oriModel;
  // The model calls' own latency, summed over a schema retry; null if no call returned.
  let latencyMs: number | null = null;

  try {
    const first = await backend.decide({ system: SYSTEM_PROMPT, user: userPrompt, schema: decisionJsonSchema() });
    usage = addUsage(usage, first.usage);
    latencyMs = first.latencyMs;
    rawResponse = first.raw;
    reportedModel = first.model;
    const parsed1 = DecisionSchema.safeParse(first.parsed);
    if (parsed1.success) {
      decision = parsed1.data;
    } else {
      userPrompt = `${userPrompt}${SCHEMA_RETRY_SUFFIX(parsed1.error.message)}`;
      const second = await backend.decide({ system: SYSTEM_PROMPT, user: userPrompt, schema: decisionJsonSchema() });
      usage = addUsage(usage, second.usage);
      latencyMs += second.latencyMs;
      rawResponse = second.raw;
      reportedModel = second.model;
      const parsed2 = DecisionSchema.safeParse(second.parsed);
      if (parsed2.success) {
        decision = parsed2.data;
      } else {
        parseError = parsed2.error.message;
      }
    }
  } catch (err) {
    // An outage says nothing about this ticket: no attempt, and runTicket restores its status.
    if (err instanceof ModelUnavailableError) throw err;
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  if (decision) {
    decision = { ...decision, citations: decision.citations.map(normalizeCitation) };
  }

  const guardrail: GuardrailResult = decision ? applyGuardrails(decision, ctx) : errorEscalation(errorMessage ?? parseError ?? "unknown error");

  const finishedAt = new Date().toISOString();
  const status = guardrail.result === "resolve" ? "resolved" : "escalated";

  const record = db.transaction(() => {
    const attempt = insertAttempt(db, {
      ticket_id: ticketId,
      attempt_no: previousAttempts.length + 1,
      parent_attempt_id: parentAttemptId,
      model: reportedModel,
      prompt_version: PROMPT_VERSION,
      context_json: JSON.stringify(ctx.blocks),
      system_prompt: SYSTEM_PROMPT,
      user_prompt: userPrompt,
      reviewer_notes: retry?.notes ?? null,
      raw_response: rawResponse,
      parsed_json: decision ? JSON.stringify(decision) : null,
      parse_error: parseError,
      priority: decision?.priority ?? null,
      confidence: decision?.confidence ?? null,
      reasoning: decision?.reasoning ?? null,
      reply_text: decision ? finalizeReply(stripInlineCitations(decision.reply)) : null,
      proposed_actions_json: decision ? JSON.stringify(decision.proposed_actions) : null,
      citations_json: decision ? JSON.stringify(decision.citations) : null,
      critique: decision?.critique ?? null,
      guardrail_result: guardrail.result,
      guardrail_reasons_json: JSON.stringify(guardrail.reasons),
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_tokens: usage.cacheReadTokens,
      cost_usd: usage.costUsd,
      latency_ms: latencyMs,
      started_at: startedAt,
      finished_at: finishedAt,
      error: errorMessage,
    });
    setTicketState(db, ticketId, status, attempt.id);
    if (retry && parentAttemptId !== null) {
      insertReview(db, { ticket_id: ticketId, attempt_id: parentAttemptId, action: "retry", notes: retry.notes });
    }
    return attempt;
  });
  return record();
}
