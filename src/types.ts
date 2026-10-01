import { z } from "zod";

export type Tier = "value" | "standard" | "express" | "premium";
export type OrderStatus = "received" | "grading" | "shipped" | "delivered";
export type Scenario =
  | "lost" | "damaged" | "double_charged" | "delayed" | "upcharged" | "mislabeled"
  | "graded" | "in_progress" | "shipped" | "received";

export interface Card { id: string; name: string; setName: string; number: string; rarity: string; year: number | null }
export interface CardValue { cardId: string; grade: number; valueUsd: number } // PSA-equivalent market value
export interface Customer { email: string; name: string; since: string; phone: string }
// score is a 0-1000 condition score sampled from the metric = "wear" rows; higher is better condition.
export interface PositionScore { position: string; score: number }
export interface GradeReport {
  grade: number;
  corners: PositionScore[]; // 4 front corners
  edges: PositionScore[]; // 4 front edges
  surface: "clean" | "light scratches" | "print lines" | "scratches and dents";
  centering: { front: string; back: string }; // e.g. "55/45", "60/40"
}
export interface Submission {
  id: string; cardId: string; declaredValueUsd: number;
  cert: string | null; label: string | null; report: GradeReport | null;
}
export interface Charge { description: string; amountUsd: number; chargedOn: string }
export interface Order {
  id: string; customerEmail: string; tier: Tier; status: OrderStatus;
  createdOn: string; promisedBy: string; shippedOn: string | null; deliveredOn: string | null;
  carrier: string | null; tracking: string | null; insuredReturn: boolean;
  shipTo: string; charges: Charge[]; submissions: Submission[];
  _scenario: Scenario; // generator bookkeeping; stripped before anything reaches a prompt
}
export const TIERS: Record<Tier, { feeUsd: number; maxDeclaredUsd: number; businessDays: number }> = {
  value: { feeUsd: 25, maxDeclaredUsd: 500, businessDays: 45 },
  standard: { feeUsd: 50, maxDeclaredUsd: 1500, businessDays: 20 },
  express: { feeUsd: 150, maxDeclaredUsd: 5000, businessDays: 5 },
  premium: { feeUsd: 300, maxDeclaredUsd: 25000, businessDays: 2 },
};

export const ACTION_TYPES = [
  "refund", "credit", "regrade_request", "grade_change", "authenticity_finding",
  "carrier_claim", "insurance_claim", "label_correction", "address_change", "info_only", "other",
] as const;

export const DecisionSchema = z.object({
  critique: z.string().optional(),
  priority: z.enum(["P1", "P2", "P3", "P4", "P5"]),
  reasoning: z.string(),
  reply: z.string().min(1),
  proposed_actions: z.array(z.object({
    type: z.enum(ACTION_TYPES),
    amount_usd: z.number().nonnegative().nullable(),
    detail: z.string(),
  })),
  citations: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type Decision = z.infer<typeof DecisionSchema>;
export type Priority = Decision["priority"];

// A ticket's ground-truth label and the fact checks it is built from. pattern/notPattern are case-insensitive regex sources.
export interface RequiredFact { description: string; pattern?: string; notPattern?: string }
export interface TicketLabels {
  priority: Priority;
  shouldEscalate: boolean;
  expectedAction: (typeof ACTION_TYPES)[number];
  requiredFacts: RequiredFact[];
}
