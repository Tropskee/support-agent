import { config } from "./config";

// inputTokens is uncached input plus cache-write (cache creation) tokens; it never includes
// cache reads, which are counted only in cacheReadTokens. Total tokens are
// inputTokens + outputTokens + cacheReadTokens, with nothing counted twice.
export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number | null }
export interface DecideRequest { system: string; user: string; schema: Record<string, unknown> }
export interface DecideResult { raw: string; parsed: unknown; usage: Usage; model: string; latencyMs: number }
// model: an OpenRouter slug. Ori's /write route runs every turn with reasoning off and one
// turn, and takes no token cap.
export interface WriteRequest { system: string; user: string; model: string }
export interface ModelBackend {
  decide(req: DecideRequest): Promise<DecideResult>;
  write(req: WriteRequest): Promise<{ text: string; usage: Usage }>;
  // Throws ModelUnavailableError when the backend can't take calls at all. Optional: the
  // test fakes have no runtime to check and leave it out.
  ensureAvailable?(): Promise<void>;
}

export const MODEL_UNAVAILABLE_MESSAGE = "Model runtime unavailable: start it with `bun run up`";

/**
 * The model runtime can't be reached or isn't ready (connection refused, chat bridge not
 * started). Not a property of the ticket, so the agent records no attempt for it and the
 * server answers 503 instead of escalating.
 */
export class ModelUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(MODEL_UNAVAILABLE_MESSAGE, options);
    this.name = "ModelUnavailableError";
  }
}

export function fakeBackend(responses: unknown[]): ModelBackend & { calls: (DecideRequest | WriteRequest)[] } {
  const calls: (DecideRequest | WriteRequest)[] = [];
  const queue = [...responses];
  const zero: Usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, costUsd: 0 };
  return {
    calls,
    async decide(req) {
      calls.push(req);
      const next = queue.shift();
      const parsed = typeof next === "string" ? null : next ?? null;
      return { raw: typeof next === "string" ? next : JSON.stringify(next), parsed, usage: zero, model: "fake", latencyMs: 1 };
    },
    async write(req) {
      calls.push(req);
      const next = queue.shift();
      return { text: typeof next === "string" ? next : "Hello, where is my order?", usage: zero };
    },
  };
}

// Ori's /decide and /write routes (features/ticket-reply/feature.ts) respond with usage
// shaped like RuntimeUsage: inputTokens (uncached input) and outputTokens, plus separate
// cacheCreationTokens and cacheReadTokens. Usage has no cache-write bucket, so cache-creation
// tokens are added to inputTokens; cache reads stay only in cacheReadTokens.
interface OriUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number | null;
}

function usageFromOri(u: OriUsage | null): Usage {
  if (!u) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: null };
  return {
    inputTokens: u.inputTokens + u.cacheCreationTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    costUsd: u.costUsd,
  };
}

const isTimeout = (err: unknown) => err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");

/** fetch against the Ori runtime; a request that never connects is ModelUnavailableError. */
async function oriFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${config.oriUrl}${path}`, init);
  } catch (err) {
    // A timeout means the runtime is up but the turn hung: an ordinary error, recorded on the
    // attempt. Anything else failed before a response, so the runtime isn't reachable.
    if (isTimeout(err)) throw err;
    throw new ModelUnavailableError({ cause: err });
  }
}

async function postOri(path: string, body: unknown): Promise<any> {
  // A hung Ori turn (the model never emits turn.succeeded/turn.failed) must not hang the
  // ticket forever: a timeout throws here, runTicket's catch records it as an error, and the
  // ticket escalates instead of the request never resolving.
  const res = await oriFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.oriTimeoutMs),
  });
  if (!res.ok) {
    const errBody = await res.text();
    // The feature answers 503 when its chat bridge isn't started.
    if (res.status === 503) throw new ModelUnavailableError({ cause: new Error(errBody) });
    throw new Error(`Ori ${path} returned ${res.status}: ${errBody}`);
  }
  return res.json();
}

const HEALTH_TIMEOUT_MS = 5_000;

async function checkOriHealth(): Promise<void> {
  const res = await oriFetch("/ticket-reply/health", { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
  const body = res.ok ? ((await res.json().catch(() => null)) as { bridge?: unknown } | null) : null;
  if (body?.bridge !== true) throw new ModelUnavailableError();
}

/**
 * Backend that calls the ticket-reply feature on the Ori runtime.
 *
 * Ori routes model ids through OpenRouter ("anthropic/claude-haiku-4.5"). `decide` always runs
 * the model bound here. `write` runs the request's `model` (the eval's judges and the prose
 * script pass their own OpenRouter slugs), falling back to the bound model when it is empty.
 */
export function oriBackend(model: string = config.oriModel): ModelBackend {
  return {
    async decide({ system, user, schema }) {
      const data = await postOri("/decide", { system, user, schema, model });
      return {
        raw: data.raw,
        parsed: data.parsed,
        usage: usageFromOri(data.usage),
        model: data.model,
        latencyMs: data.latencyMs,
      };
    },
    async write({ system, user, model: requested }) {
      const data = await postOri("/write", { system, user, model: requested || model });
      return { text: data.text, usage: usageFromOri(data.usage) };
    },
    ensureAvailable: checkOriHealth,
  };
}

export function getBackend(): ModelBackend {
  return oriBackend();
}
