// Pure helpers for the model bake-off (model-bakeoff.eval.ts): which catalog models qualify,
// which labelled tickets become cases, and how one reply is scored. No model calls here; the
// eval file owns every agent.run and its pilotCases wrap, as `ori eval docs sdk` requires.
import type { ModelSlug } from "ori";
import type { CatalogModel } from "ori/eval";
import { parseJsonObject } from "../../features/ticket-reply/lib/turn";
import { normalizeCitation } from "../../src/agent";
import type { GeneratedTicket } from "../../src/archetypes";
import { checkRegexFact } from "../../src/eval";
import { applyGuardrails } from "../../src/guardrails";
import type { Context } from "../../src/lookup";
import { finalizeReply, stripInlineCitations } from "../../src/prompt";
import { DecisionSchema } from "../../src/types";

export interface CaseScore {
  validJson: boolean;
  schemaValid: boolean;
  priorityExact: boolean;
  escalateCorrect: boolean;
  factsFound: number;
  factsChecked: number;
}

/**
 * Whether a catalog model accepts a reasoning effort, read from its published reasoning list.
 *
 * Parameters
 * ----------
 * model : CatalogModel
 *     A catalog record from rankedModels().
 * effort : string
 *     The effort the comparison runs at.
 *
 * Returns
 * -------
 * boolean
 *     False when reasoning is mandatory and the effort is "none", or when the model publishes
 *     an effort list without this level. True when it publishes no list (it does not reason,
 *     so the effort is moot).
 */
export function acceptsEffort(model: CatalogModel, effort: string): boolean {
  if (effort === "none" && model.reasoningMandatory === true) return false;
  return model.reasoningEfforts === undefined || model.reasoningEfforts.includes(effort);
}

/**
 * The vendor segment of a slug, which is also its judge family ("openai/gpt-x" -> "openai").
 */
export function vendorOf(slug: string): string {
  return slug.replace(/^~/, "").split("/")[0]!;
}

/**
 * Pick the slate: text-out models that accept the production effort, at most one per vendor,
 * in the catalog's own order, up to `size`.
 *
 * Parameters
 * ----------
 * models : readonly CatalogModel[]
 *     rankedModels() output, already filtered on price, context and capability.
 * effort : string
 *     The effort every candidate runs at.
 * size : number
 *     How many candidates to return.
 *
 * Returns
 * -------
 * ModelSlug[]
 *     A mutable list, as test.concurrent.each needs.
 */
export function pickSlate(models: readonly CatalogModel[], effort: string, size: number): ModelSlug[] {
  const vendors = new Set<string>();
  const slate: ModelSlug[] = [];
  for (const model of models) {
    if (slate.length === size) break;
    const textOnly = model.outputModalities?.length === 1 && model.outputModalities[0] === "text";
    const vendor = vendorOf(model.slug);
    if (!textOnly || !acceptsEffort(model, effort) || vendors.has(vendor)) continue;
    vendors.add(vendor);
    slate.push(model.slug);
  }
  return slate;
}

/**
 * The first ticket of each named archetype, in the order the archetypes are listed.
 *
 * Parameters
 * ----------
 * tickets : readonly GeneratedTicket[]
 *     The labelled tickets from fixtures/tickets.json.
 * archetypes : readonly string[]
 *     Archetype names to take one ticket from each.
 *
 * Returns
 * -------
 * GeneratedTicket[]
 *
 * Raises
 * ------
 * Error
 *     When an archetype has no ticket, so a renamed archetype fails loudly instead of
 *     shrinking the case set.
 */
export function selectCases(tickets: readonly GeneratedTicket[], archetypes: readonly string[]): GeneratedTicket[] {
  return archetypes.map((archetype) => {
    const ticket = tickets.find((t) => t.archetype === archetype);
    if (!ticket) throw new Error(`no ticket with archetype "${archetype}" in fixtures/tickets.json`);
    return ticket;
  });
}

/**
 * Score one raw model reply the way production would handle it, against the ticket's label.
 *
 * Mirrors src/agent.ts runTicket on a first attempt: parse the JSON object, validate it with
 * DecisionSchema, normalise citations, then run the guardrails. A reply that fails to parse
 * escalates as an error, exactly as production does. Facts are checked on the finalized reply
 * text with the eval's regexes; facts that need a judge are not scored here.
 *
 * Parameters
 * ----------
 * text : string
 *     The model's raw reply.
 * ticket : GeneratedTicket
 *     The labelled ticket.
 * ctx : Context
 *     The context built for that ticket (labels drive the citation guardrail).
 *
 * Returns
 * -------
 * CaseScore
 */
export function scoreReply(text: string, ticket: GeneratedTicket, ctx: Context): CaseScore {
  const { labels } = ticket;
  const parsed = parseJsonObject(text);
  const result = DecisionSchema.safeParse(parsed);
  const decision = result.success ? { ...result.data, citations: result.data.citations.map(normalizeCitation) } : null;

  // Production escalates any reply it cannot parse (errorEscalation in src/guardrails.ts).
  const escalated = decision ? applyGuardrails(decision, ctx).result === "escalate" : true;
  const replyText = decision ? finalizeReply(stripInlineCitations(decision.reply)) : "";
  const factResults = labels.requiredFacts
    .map((fact) => checkRegexFact(fact, replyText))
    .filter((found): found is boolean => found !== null);

  return {
    validJson: parsed !== null,
    schemaValid: decision !== null,
    priorityExact: decision?.priority === labels.priority,
    escalateCorrect: escalated === labels.shouldEscalate,
    factsFound: decision ? factResults.filter(Boolean).length : 0,
    factsChecked: factResults.length,
  };
}

/**
 * One log line summarising a candidate's scores across the cases it completed.
 *
 * Parameters
 * ----------
 * model : string
 *     The candidate slug.
 * effort : string
 *     The effort it ran at.
 * scores : readonly CaseScore[]
 *     One score per completed case.
 * infraFailures : number
 *     Cases that never produced a reply (rate limit, timeout, failed turn).
 *
 * Returns
 * -------
 * string
 */
export function summaryLine(model: string, effort: string, scores: readonly CaseScore[], infraFailures: number): string {
  const n = scores.length;
  const count = (pick: (s: CaseScore) => boolean) => `${scores.filter(pick).length}/${n}`;
  const factsFound = scores.reduce((sum, s) => sum + s.factsFound, 0);
  const factsChecked = scores.reduce((sum, s) => sum + s.factsChecked, 0);
  return [
    `bakeoff ${model}`,
    `effort=${effort}`,
    `scored=${n}`,
    `failed_runs=${infraFailures}`,
    `json=${count((s) => s.validJson)}`,
    `schema=${count((s) => s.schemaValid)}`,
    `priority=${count((s) => s.priorityExact)}`,
    `escalate=${count((s) => s.escalateCorrect)}`,
    `facts=${factsFound}/${factsChecked}`,
  ].join("  ");
}
