import type { ApiContribution, Chat, ChatContribution } from "ori";
import { decideSystemPrompt, TURN_PARAMETERS } from "./lib/decide-prompt";
import { collectTurn, parseJsonObject, type CollectedTurn } from "./lib/turn";
import { validateDecideBody, validateWriteBody } from "./lib/validate";

// Same env var and default as config.oriModel in src/config.ts. The feature package can't
// import across the workspace boundary into src/, so it reads ORI_MODEL directly rather than
// hardcoding a second copy of the default that could drift from config's.
const DEFAULT_MODEL = process.env.ORI_MODEL || "anthropic/claude-haiku-4.5";

let bridge: Chat | undefined;

export const chat = {
  name: "ticket-reply",
  async start(c: Chat) {
    bridge = c;
  },
  async stop() {
    bridge = undefined;
  },
} satisfies ChatContribution;

function noBridge(): Response {
  return Response.json({ error: "chat bridge not started; run `ori start`" }, { status: 503 });
}

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, response: badRequest("invalid JSON body") };
  }
}

type TurnOutcome = { ok: true; turn: CollectedTurn; latencyMs: number } | { ok: false; response: Response };

/**
 * Run one model turn on the chat bridge and collect it.
 *
 * Returns
 * -------
 * TurnOutcome
 *     The collected turn and its latency, or a 502 response when the bridge threw, the turn
 *     failed, or the event stream ended without the turn succeeding.
 */
async function runTurn(chatBridge: Chat, input: { prompt: string; systemPrompt: string; model: string; signal: AbortSignal }): Promise<TurnOutcome> {
  const started = performance.now();
  const events = [];
  try {
    for await (const event of chatBridge.sendMessage({ ...input, parameters: TURN_PARAMETERS })) {
      events.push(event);
    }
  } catch (err) {
    return { ok: false, response: Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 }) };
  }
  const turn = collectTurn(events);
  if (turn.failure) {
    return { ok: false, response: Response.json({ error: turn.failure.message, failure: turn.failure }, { status: 502 }) };
  }
  if (!turn.succeeded) {
    return { ok: false, response: Response.json({ error: "turn ended without finishing" }, { status: 502 }) };
  }
  return { ok: true, turn, latencyMs: turn.durationMs ?? Math.round(performance.now() - started) };
}

export const api = {
  routes: {
    // Named under the feature so the runtime's own built-in /health route doesn't shadow it.
    "GET /ticket-reply/health": async () => Response.json({ ok: true, bridge: bridge !== undefined }),

    "POST /decide": async (request) => {
      if (!bridge) return noBridge();
      const parsed = await readJsonBody(request);
      if (!parsed.ok) return parsed.response;
      const validated = validateDecideBody(parsed.value);
      if (!validated.ok) return badRequest(validated.error);
      const body = validated.value;
      const model = body.model ?? DEFAULT_MODEL;
      const systemPrompt = decideSystemPrompt(body.system, body.schema);

      const outcome = await runTurn(bridge, { prompt: body.user, systemPrompt, model, signal: request.signal });
      if (!outcome.ok) return outcome.response;
      const { turn, latencyMs } = outcome;
      return Response.json({
        raw: turn.text,
        parsed: parseJsonObject(turn.text),
        usage: turn.usage,
        model: turn.model ?? model,
        latencyMs,
      });
    },

    "POST /write": async (request) => {
      if (!bridge) return noBridge();
      const parsed = await readJsonBody(request);
      if (!parsed.ok) return parsed.response;
      const validated = validateWriteBody(parsed.value);
      if (!validated.ok) return badRequest(validated.error);
      const body = validated.value;
      const model = body.model ?? DEFAULT_MODEL;

      const outcome = await runTurn(bridge, { prompt: body.user, systemPrompt: body.system, model, signal: request.signal });
      if (!outcome.ok) return outcome.response;
      const { turn, latencyMs } = outcome;
      return Response.json({ text: turn.text, usage: turn.usage, model: turn.model ?? model, latencyMs });
    },
  },
} satisfies ApiContribution;
