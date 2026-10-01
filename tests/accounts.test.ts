import { expect, test } from "bun:test";
import { buildAccounts } from "../scripts/generate_accounts";
import { config } from "../src/config";
import { TIERS } from "../src/types";

const cards = [
  { card_id: "base1-4", name: "Charizard", set_name: "Base", number: "4", rarity: "Rare Holo", year: "1999", sale_count: "900" },
  { card_id: "base1-2", name: "Blastoise", set_name: "Base", number: "2", rarity: "Rare Holo", year: "1999", sale_count: "700" },
  { card_id: "neo1-9", name: "Lugia", set_name: "Neo Genesis", number: "9", rarity: "Rare Holo", year: "2000", sale_count: "500" },
];
const values = [7, 8, 9, 10].flatMap((g) => cards.map((c) => ({
  card_id: c.card_id, variant: "unlimited", grader: "PSA", grade: String(g), sale_count: "20",
  p25: String(g * 90), median: String(g * 100), p75: String(g * 110),
})));
const severity = Array.from({ length: 10 }, (_, i) => i + 1).flatMap((grade) =>
  ["corner", "edge"].flatMap((kind) => ["fray", "fill", "wear"].map((metric) => ({
    grade: String(grade), kind, metric, p10: "100", p50: String(1000 - grade * 50), p90: "990", cert_count: "40",
  }))));

const out = buildAccounts({ cards, values, severity }, 20260928);

test("deterministic for a seed", () => {
  expect(JSON.stringify(buildAccounts({ cards, values, severity }, 20260928))).toBe(JSON.stringify(out));
});

test("70 orders across 40 customers with the scenario mix", () => {
  expect(out.orders).toHaveLength(70);
  expect(out.customers).toHaveLength(40);
  const count = (s: string) => out.orders.filter((o) => o._scenario === s).length;
  expect([count("lost"), count("damaged"), count("double_charged"), count("delayed"),
          count("upcharged"), count("mislabeled")]).toEqual([2, 1, 3, 4, 7, 7]);
});

test("order ids and certs have the right shape and are unique", () => {
  const ids = out.orders.map((o) => o.id);
  expect(new Set(ids).size).toBe(ids.length);
  ids.forEach((id) => expect(id).toMatch(/^CG-\d{5}$/));
  for (const o of out.orders) {
    expect(o.submissions.map((s) => s.id)).toEqual(o.submissions.map((_, n) => `${o.id}-${n + 1}`));
    o.submissions.forEach((s) => expect(s.id).toMatch(/^CG-\d{5}-\d+$/));
  }
  const certs = out.orders.flatMap((o) => o.submissions.map((s) => s.cert)).filter(Boolean);
  expect(new Set(certs).size).toBe(certs.length);
  certs.forEach((c) => expect(c).toMatch(/^\d{8}$/));
});

test("graded submissions have a report whose grade is 1 to 10", () => {
  for (const o of out.orders.filter((o) => o.status === "delivered" || o.status === "shipped")) {
    for (const s of o.submissions) {
      expect(s.report).not.toBeNull();
      expect(s.report!.grade).toBeGreaterThanOrEqual(1);
      expect(s.report!.grade).toBeLessThanOrEqual(10);
      expect(s.report!.corners).toHaveLength(4);
    }
  }
});

test("double_charged orders carry the tier fee twice", () => {
  for (const o of out.orders.filter((o) => o._scenario === "double_charged")) {
    const fee = TIERS[o.tier].feeUsd;
    expect(o.charges.filter((c) => c.amountUsd === fee)).toHaveLength(2);
  }
});

test("upcharged orders have a declared-value adjustment charge", () => {
  for (const o of out.orders.filter((o) => o._scenario === "upcharged")) {
    expect(o.charges.some((c) => c.description === "Declared value adjustment")).toBe(true);
  }
});

test("values are rounded to whole dollars", () => {
  out.values.forEach((v) => expect(Number.isInteger(v.valueUsd)).toBe(true));
});

test("non-upcharged submissions stay within the order's tier cap", () => {
  for (const o of out.orders.filter((o) => o._scenario !== "upcharged")) {
    for (const s of o.submissions) {
      expect(s.declaredValueUsd).toBeLessThanOrEqual(TIERS[o.tier].maxDeclaredUsd);
    }
  }
});

test("lost/damaged orders deliver recently, so the 5-day reporting window is still open", () => {
  const asOf = new Date(`${config.asOf}T00:00:00Z`);
  for (const o of out.orders.filter((o) => o._scenario === "lost" || o._scenario === "damaged")) {
    expect(o.deliveredOn).not.toBeNull();
    const deliveredOn = new Date(`${o.deliveredOn}T00:00:00Z`);
    const daysSinceDelivery = (asOf.getTime() - deliveredOn.getTime()) / 86_400_000;
    expect(daysSinceDelivery).toBeGreaterThanOrEqual(0);
    expect(daysSinceDelivery).toBeLessThanOrEqual(5);
    expect(new Date(`${o.createdOn}T00:00:00Z`).getTime()).toBeLessThan(new Date(`${o.shippedOn}T00:00:00Z`).getTime());
  }
});

test("lost/damaged orders still carry a card at or above their threshold", () => {
  // The shared fixture above tops out around $1,000, below both scenario thresholds, so this
  // needs its own high-value card - one expensive enough to force lost/damaged onto premium
  // (its value exceeds the express cap) while still fitting under premium's cap.
  const highValueCard = { card_id: "test-hv-1", name: "Rare", set_name: "Test Set", number: "1", rarity: "Rare", year: "2005", sale_count: "50" };
  const highValueRows = [8, 9].map((g) => ({
    card_id: "test-hv-1", variant: "unlimited", grader: "PSA", grade: String(g), sale_count: "20",
    p25: String(g * 900), median: String(g * 1000), p75: String(g * 1100),
  }));
  const bigOut = buildAccounts(
    { cards: [...cards, highValueCard], values: [...values, ...highValueRows], severity },
    20260928,
  );
  for (const o of bigOut.orders.filter((o) => o._scenario === "lost" || o._scenario === "damaged")) {
    const threshold = o._scenario === "lost" ? 3000 : 2000;
    expect(o.submissions.some((s) => s.declaredValueUsd >= threshold)).toBe(true);
    for (const s of o.submissions) expect(s.declaredValueUsd).toBeLessThanOrEqual(TIERS[o.tier].maxDeclaredUsd);
  }
});
