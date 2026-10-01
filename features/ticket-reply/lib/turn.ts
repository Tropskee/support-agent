// Pure helpers for turning a Chat.sendMessage() event stream into the shape the
// ticket-reply routes respond with. Kept separate from feature.ts so it is testable
// without a running Ori chat bridge: feed it a synthetic array of events.
import type { AgentRuntimeEvent } from "ori";

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number | null;
}

export interface CollectedTurn {
  text: string;
  usage: TurnUsage | null;
  failure: { message: string; [key: string]: unknown } | null;
  // Whether a "turn.succeeded" event arrived. A stream can end with neither it nor a failure.
  succeeded: boolean;
  durationMs: number | null;
  // The model that actually produced the turn, read off the "turn.succeeded" event
  // itself (every AgentRuntimeEvent carries an optional top-level `model`, separate
  // from its payload) rather than echoing back whatever model we requested — Ori may
  // run a different one than asked, and the caller wants to know which it was.
  model: string | null;
}

/**
 * Replay the events from one Chat.sendMessage() turn into the final reply text,
 * usage totals, failure (if any), duration, and the model that ran it.
 *
 * Parameters
 * ----------
 * events : readonly AgentRuntimeEvent[]
 *     The events yielded by `bridge.sendMessage(...)`, collected in order.
 *
 * Returns
 * -------
 * CollectedTurn
 *     `text` is the concatenation of every "assistant.text.delta" payload's
 *     `delta`. `usage`, `durationMs`, and `model` come from the "turn.succeeded"
 *     event, if one occurred, and `succeeded` says whether it did. `failure` comes
 *     from a "turn.failed" or "session.failed" event, if one occurred instead.
 */
export function collectTurn(events: readonly AgentRuntimeEvent[]): CollectedTurn {
  let text = "";
  let usage: TurnUsage | null = null;
  let failure: CollectedTurn["failure"] = null;
  let succeeded = false;
  let durationMs: number | null = null;
  let model: string | null = null;

  for (const event of events) {
    if (event.type === "assistant.text.delta") {
      text += event.payload.delta;
      continue;
    }
    if (event.type === "turn.succeeded") {
      succeeded = true;
      durationMs = event.payload.durationMs ?? null;
      model = event.model ?? null;
      if (event.payload.usage) {
        const u = event.payload.usage;
        usage = {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheCreationTokens: u.cacheCreationTokens,
          cacheReadTokens: u.cacheReadTokens,
          costUsd: u.costUsd ?? null,
        };
      }
      continue;
    }
    if (event.type === "turn.failed" || event.type === "session.failed") {
      failure = event.payload.failure;
      continue;
    }
  }

  return { text, usage, failure, succeeded, durationMs, model };
}

/**
 * Parse a model reply that is supposed to be a single JSON object, tolerating a
 * ```json fenced code block around it.
 *
 * Parameters
 * ----------
 * text : str
 *     The raw reply text.
 *
 * Returns
 * -------
 * object | null
 *     The parsed object, or null if no JSON object could be extracted or parsed.
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;

  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
