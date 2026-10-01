// Pure request-body validation for the ticket-reply routes, kept separate from feature.ts
// so it is testable without a running Ori chat bridge.

export interface DecideBody {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  model?: string;
}

export interface WriteBody {
  system: string;
  user: string;
  model?: string;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a decoded JSON body against the shape POST /decide expects.
 *
 * Parameters
 * ----------
 * body : unknown
 *     The result of `await request.json()`.
 *
 * Returns
 * -------
 * Validated<DecideBody>
 *     `{ ok: true, value }` with `system`/`user` as strings, `schema` as a plain object, and
 *     `model` as a string or undefined; otherwise `{ ok: false, error }` naming the first
 *     field that failed.
 */
export function validateDecideBody(body: unknown): Validated<DecideBody> {
  if (!isPlainObject(body)) return { ok: false, error: "body must be a JSON object" };
  if (typeof body.system !== "string") return { ok: false, error: "system must be a string" };
  if (typeof body.user !== "string") return { ok: false, error: "user must be a string" };
  if (!isPlainObject(body.schema)) return { ok: false, error: "schema must be an object" };
  if (body.model !== undefined && typeof body.model !== "string") return { ok: false, error: "model must be a string" };
  return { ok: true, value: { system: body.system, user: body.user, schema: body.schema, model: body.model as string | undefined } };
}

/**
 * Validate a decoded JSON body against the shape POST /write expects.
 *
 * Parameters
 * ----------
 * body : unknown
 *     The result of `await request.json()`.
 *
 * Returns
 * -------
 * Validated<WriteBody>
 *     `{ ok: true, value }` with `system`/`user` as strings and `model` as a string or
 *     undefined; otherwise `{ ok: false, error }` naming the first field that failed.
 */
export function validateWriteBody(body: unknown): Validated<WriteBody> {
  if (!isPlainObject(body)) return { ok: false, error: "body must be a JSON object" };
  if (typeof body.system !== "string") return { ok: false, error: "system must be a string" };
  if (typeof body.user !== "string") return { ok: false, error: "user must be a string" };
  if (body.model !== undefined && typeof body.model !== "string") return { ok: false, error: "model must be a string" };
  return { ok: true, value: { system: body.system, user: body.user, model: body.model as string | undefined } };
}
