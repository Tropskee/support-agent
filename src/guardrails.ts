import { config } from "./config";
import type { Context } from "./lookup";
import type { Decision } from "./types";

export type EscalationReason = "p1" | "money_over_limit" | "grade_or_authenticity" | "low_confidence" | "bad_citation" | "error";
export interface GuardrailResult { result: "resolve" | "escalate"; reasons: { reason: EscalationReason; detail: string }[] }

const MONEY_ACTIONS = new Set(["refund", "credit", "insurance_claim", "carrier_claim"]);
const GRADE_ACTIONS = new Set(["grade_change", "authenticity_finding"]);

export function applyGuardrails(
  d: Decision,
  ctx: Context,
  limits = { refundLimitUsd: config.refundLimitUsd, confidenceFloor: config.confidenceFloor },
): GuardrailResult {
  const reasons: GuardrailResult["reasons"] = [];
  if (d.priority === "P1") reasons.push({ reason: "p1", detail: "Triaged P1" });
  // A money-typed action must say how much. Every amount counts toward the limit whatever the
  // action's type, so money can't slip through under "other" or a regrade fee.
  const noAmount = d.proposed_actions.find((a) => MONEY_ACTIONS.has(a.type) && a.amount_usd == null);
  if (noAmount) {
    reasons.push({ reason: "money_over_limit", detail: `${noAmount.type} with no amount` });
  } else {
    const total = d.proposed_actions.reduce((sum, a) => sum + (a.amount_usd ?? 0), 0);
    if (total > limits.refundLimitUsd) {
      reasons.push({ reason: "money_over_limit", detail: `proposed amounts total $${total} > $${limits.refundLimitUsd} limit` });
    }
  }
  if (d.proposed_actions.some((a) => GRADE_ACTIONS.has(a.type))) {
    reasons.push({ reason: "grade_or_authenticity", detail: "Proposes a grade or authenticity outcome" });
  }
  if (d.confidence < limits.confidenceFloor) {
    reasons.push({ reason: "low_confidence", detail: `Confidence ${d.confidence} < ${limits.confidenceFloor}` });
  }
  const unknown = d.citations.filter((c) => !ctx.labels.has(c));
  if (unknown.length) reasons.push({ reason: "bad_citation", detail: `Cited blocks not in context: ${unknown.join(", ")}` });
  const deduped = reasons.filter((r, i) => reasons.findIndex((x) => x.reason === r.reason) === i);
  return { result: deduped.length ? "escalate" : "resolve", reasons: deduped };
}

export const errorEscalation = (detail: string): GuardrailResult => ({ result: "escalate", reasons: [{ reason: "error", detail }] });
