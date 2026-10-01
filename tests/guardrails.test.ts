import { expect, test } from "bun:test";
import { applyGuardrails } from "../src/guardrails";
import type { Context } from "../src/lookup";
import type { Decision } from "../src/types";

const ctx: Context = { blocks: [], labels: new Set(["customer", "order CG-20001", "policy 4"]), customerFound: true, orderId: "CG-20001" };
const base: Decision = { priority: "P3", reasoning: "r", reply: "hi", proposed_actions: [{ type: "info_only", amount_usd: null, detail: "" }], citations: ["order CG-20001"], confidence: 0.9 };
const limits = { refundLimitUsd: 100, confidenceFloor: 0.7 };
const reasons = (d: Partial<Decision>) => applyGuardrails({ ...base, ...d }, ctx, limits).reasons.map((r) => r.reason);

test("clean decision resolves", () => {
  expect(applyGuardrails(base, ctx, limits)).toEqual({ result: "resolve", reasons: [] });
});
test("P1 escalates", () => expect(reasons({ priority: "P1" })).toEqual(["p1"]));
test("refund over limit escalates, at limit does not", () => {
  expect(reasons({ proposed_actions: [{ type: "refund", amount_usd: 150, detail: "" }] })).toEqual(["money_over_limit"]);
  expect(reasons({ proposed_actions: [{ type: "refund", amount_usd: 100, detail: "" }] })).toEqual([]);
});
test("insurance claim over limit escalates", () =>
  expect(reasons({ proposed_actions: [{ type: "insurance_claim", amount_usd: 6500, detail: "" }] })).toEqual(["money_over_limit"]));
test("grade change and authenticity always escalate; regrade request does not", () => {
  expect(reasons({ proposed_actions: [{ type: "grade_change", amount_usd: null, detail: "" }] })).toEqual(["grade_or_authenticity"]);
  expect(reasons({ proposed_actions: [{ type: "authenticity_finding", amount_usd: null, detail: "" }] })).toEqual(["grade_or_authenticity"]);
  expect(reasons({ proposed_actions: [{ type: "regrade_request", amount_usd: 25, detail: "" }] })).toEqual([]);
});
test("money action with no amount escalates", () =>
  expect(reasons({ proposed_actions: [{ type: "refund", amount_usd: null, detail: "" }] })).toEqual(["money_over_limit"]));
test("several under-limit money actions that sum over the limit escalate", () => {
  expect(
    reasons({
      proposed_actions: [
        { type: "refund", amount_usd: 60, detail: "" },
        { type: "credit", amount_usd: 60, detail: "" },
      ],
    }),
  ).toEqual(["money_over_limit"]);
  expect(
    reasons({
      proposed_actions: [
        { type: "refund", amount_usd: 40, detail: "" },
        { type: "credit", amount_usd: 40, detail: "" },
      ],
    }),
  ).toEqual([]);
});
test("low confidence escalates", () => expect(reasons({ confidence: 0.5 })).toEqual(["low_confidence"]));
test("citation to a block not in the prompt escalates", () =>
  expect(reasons({ citations: ["order CG-99999"] })).toEqual(["bad_citation"]));
test("reasons accumulate", () =>
  expect(reasons({ priority: "P1", confidence: 0.2 })).toEqual(["p1", "low_confidence"]));
test("an amount on any action type counts toward the money limit", () => {
  expect(reasons({ proposed_actions: [{ type: "other", amount_usd: 500, detail: "" }] })).toEqual(["money_over_limit"]);
  expect(
    reasons({
      proposed_actions: [
        { type: "refund", amount_usd: 60, detail: "" },
        { type: "regrade_request", amount_usd: 60, detail: "" },
      ],
    }),
  ).toEqual(["money_over_limit"]);
  expect(reasons({ proposed_actions: [{ type: "regrade_request", amount_usd: 25, detail: "" }] })).toEqual([]);
});
test("a non-money action with no amount does not escalate", () =>
  expect(reasons({ proposed_actions: [{ type: "address_change", amount_usd: null, detail: "" }] })).toEqual([]));
