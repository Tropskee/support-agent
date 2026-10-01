// What POST /decide sends besides the caller's prompts: the JSON-only instruction appended
// to the system prompt, and the parameters every ticket turn runs with. Kept here rather than
// inline in feature.ts so the model bake-off (evals/ticket-reply) sends exactly the same text
// and parameters without a second copy that could drift.

// Reasoning off for ticket turns.
export const TURN_EFFORT = "none" as const;

// One model turn: a decision or a judge answer is a single reply, never a tool loop.
export const TURN_PARAMETERS = { reasoning: { effort: TURN_EFFORT }, maxTurns: 1 };

/**
 * Append the JSON-only reply instruction POST /decide adds to the caller's system prompt.
 *
 * Parameters
 * ----------
 * system : string
 *     The caller's system prompt (the app's SYSTEM_PROMPT).
 * schema : Record<string, unknown>
 *     The JSON Schema the reply must match.
 *
 * Returns
 * -------
 * string
 *     The system prompt the Ori turn actually runs with.
 */
export function decideSystemPrompt(system: string, schema: Record<string, unknown>): string {
  return `${system}\n\nReply with ONLY one JSON object matching this JSON Schema, no other text, no markdown fencing, no explanation. Do not call any tools; reply with the JSON object as plain text. Citation values must be plain label strings with no surrounding brackets or quotes (e.g. "order CG-20083", not "[order CG-20083]"):\n${JSON.stringify(schema)}`;
}
