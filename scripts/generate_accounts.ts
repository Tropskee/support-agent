// Builds the seeded fixture set (cards, values, customers, orders) from the real
// aggregates in data/ plus a fixed order-mix table. Every random draw goes through the
// seeded rng so the whole run is reproducible.
import { config } from "../src/config";
import { parseCsv } from "../src/csv";
import { between, jitter, mulberry32, pick } from "../src/rng";
import {
  TIERS,
  type Card,
  type CardValue,
  type Charge,
  type Customer,
  type GradeReport,
  type Order,
  type OrderStatus,
  type PositionScore,
  type Scenario,
  type Submission,
  type Tier,
} from "../src/types";

interface RawCardRow {
  card_id: string; name: string; set_name: string; number: string; rarity: string;
  year: string; sale_count: string;
}
interface RawValueRow {
  card_id: string; variant: string; grader: string; grade: string; sale_count: string;
  p25: string; median: string; p75: string;
}
interface RawSeverityRow {
  grade: string; kind: string; metric: string; p10: string; p90: string; p50: string; cert_count: string;
}

interface BuildInput { cards: RawCardRow[]; values: RawValueRow[]; severity: RawSeverityRow[] }
interface BuildOutput { cards: Card[]; values: CardValue[]; customers: Customer[]; orders: Order[] }

////////////////////
// FIXED NAME DATA //
////////////////////

const FIRST_NAMES = [
  "Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Avery", "Quinn", "Drew",
  "Skyler", "Reese", "Rowan", "Emerson", "Finley", "Harper", "Hayden", "Kendall", "Logan", "Peyton",
  "Sage", "Charlie", "Dakota", "Elliot", "Frankie", "Gray", "Indigo", "Jules", "Kai", "Lane",
  "Marlowe", "Nico", "Oakley", "Parker", "River", "Shay", "Tatum", "Val", "Wren", "Zion",
];
const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez",
  "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin",
  "Lee", "Perez", "Thompson", "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson",
  "Walker", "Young", "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores",
];
const STREET_NAMES = [
  "Maple", "Oak", "Pine", "Cedar", "Elm", "Birch", "Walnut", "Chestnut", "Spruce", "Willow",
  "Sycamore", "Magnolia", "Aspen", "Poplar", "Hickory",
];
const STREET_SUFFIXES = ["St", "Ave", "Rd", "Dr", "Ln", "Ct", "Blvd", "Way"];
const CITY_STATE_ZIP: [string, string, string][] = [
  ["Columbus", "OH", "43004"], ["Austin", "TX", "78701"], ["Denver", "CO", "80202"], ["Portland", "OR", "97201"],
  ["Raleigh", "NC", "27601"], ["Madison", "WI", "53703"], ["Boise", "ID", "83702"], ["Tucson", "AZ", "85701"],
  ["Richmond", "VA", "23219"], ["Spokane", "WA", "99201"], ["Reno", "NV", "89501"], ["Tulsa", "OK", "74103"],
  ["Omaha", "NE", "68102"], ["Louisville", "KY", "40202"], ["Des Moines", "IA", "50309"],
];

/////////////////////
// DATE ARITHMETIC //
/////////////////////

const DAY_MS = 86_400_000;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);
const iso = (d: Date) => d.toISOString().slice(0, 10);

function addBusinessDays(start: Date, n: number): Date {
  let cur = start;
  let added = 0;
  while (added < n) {
    cur = addDays(cur, 1);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return cur;
}

/////////////////////////
// SMALL MATH HELPERS ///
/////////////////////////

const roundTo10 = (v: number) => Math.round(v / 10) * 10;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function triangular(rand: () => number, low: number, mode: number, high: number): number {
  if (high <= low) return low;
  const u = rand();
  const c = (mode - low) / (high - low);
  return u < c
    ? low + Math.sqrt(u * (high - low) * (mode - low))
    : high - Math.sqrt((1 - u) * (high - low) * (high - mode));
}

const ALL_TIER_WEIGHTS: [Tier, number][] = [
  ["value", 0.40], ["standard", 0.35], ["express", 0.20], ["premium", 0.05],
];
// graded orders not forced to express draw from the other three tiers, renormalized.
const GRADED_NONEXPRESS_WEIGHTS: [Tier, number][] = [
  ["value", 40 / 80], ["standard", 35 / 80], ["premium", 5 / 80],
];

function weightedTier(rand: () => number, weights: [Tier, number][]): Tier {
  const r = rand();
  let acc = 0;
  for (const [tier, w] of weights) {
    acc += w;
    if (r < acc) return tier;
  }
  return weights[weights.length - 1]![0];
}

//////////////////////////
// MAIN BUILD FUNCTION ///
//////////////////////////

export function buildAccounts(input: BuildInput, seed: number): BuildOutput {
  const rand = mulberry32(seed);
  const ASOF = new Date(`${config.asOf}T00:00:00Z`);

  // ---- cards ----
  const cards: Card[] = input.cards.map((r) => ({
    id: r.card_id,
    name: r.name,
    setName: r.set_name,
    number: r.number,
    rarity: r.rarity,
    year: r.year ? Number(r.year) : null,
  }));

  // ---- values ----
  const values: CardValue[] = [];
  for (const card of cards) {
    const psaRows = input.values.filter((v) => v.card_id === card.id && v.grader === "PSA");
    if (psaRows.length === 0) continue;

    const salesByVariant = new Map<string, number>();
    for (const r of psaRows) salesByVariant.set(r.variant, (salesByVariant.get(r.variant) ?? 0) + Number(r.sale_count));
    let bestVariant = psaRows[0]!.variant;
    let bestSales = -1;
    for (const [variant, sales] of salesByVariant) {
      if (sales > bestSales) { bestVariant = variant; bestSales = sales; }
    }

    const medianByGrade = new Map<number, number>();
    for (const r of psaRows) if (r.variant === bestVariant) medianByGrade.set(Number(r.grade), Number(r.median));
    const knownGrades = [...medianByGrade.keys()].sort((a, b) => a - b);
    if (knownGrades.length === 0) continue;
    const minGrade = knownGrades[0]!, maxGrade = knownGrades[knownGrades.length - 1]!;

    for (let grade = 1; grade <= 10; grade++) {
      if (grade < minGrade || grade > maxGrade) continue;
      let median: number;
      if (medianByGrade.has(grade)) {
        median = medianByGrade.get(grade)!;
      } else {
        const lower = knownGrades.filter((g) => g < grade).pop()!;
        const upper = knownGrades.find((g) => g > grade)!;
        const mLower = medianByGrade.get(lower)!, mUpper = medianByGrade.get(upper)!;
        median = mLower + (mUpper - mLower) * (grade - lower) / (upper - lower);
      }
      values.push({ cardId: card.id, grade, valueUsd: Math.round(jitter(rand, median, 0.04)) });
    }
  }

  const valuesByCard = new Map<string, CardValue[]>();
  for (const v of values) {
    if (!valuesByCard.has(v.cardId)) valuesByCard.set(v.cardId, []);
    valuesByCard.get(v.cardId)!.push(v);
  }
  const cardsWithValues = cards.filter((c) => (valuesByCard.get(c.id)?.length ?? 0) > 0);

  function nearestValue(cardId: string, grade: number): CardValue | null {
    const rows = valuesByCard.get(cardId);
    if (!rows || rows.length === 0) return null;
    let best = rows[0]!;
    for (const r of rows) if (Math.abs(r.grade - grade) < Math.abs(best.grade - grade)) best = r;
    return best;
  }

  // ---- severity ----
  const severityMap = new Map<string, { p10: number; p50: number; p90: number }>();
  for (const r of input.severity) {
    severityMap.set(`${r.grade}|${r.kind}|${r.metric}`, { p10: Number(r.p10), p50: Number(r.p50), p90: Number(r.p90) });
  }
  function wearRow(grade: number, kind: "corner" | "edge") {
    const exact = severityMap.get(`${grade}|${kind}|wear`);
    if (exact) return exact;
    let best: { g: number; row: { p10: number; p50: number; p90: number } } | null = null;
    for (let g = 1; g <= 10; g++) {
      const row = severityMap.get(`${g}|${kind}|wear`);
      if (row && (!best || Math.abs(g - grade) < Math.abs(best.g - grade))) best = { g, row };
    }
    return best?.row ?? null;
  }

  // ---- customers ----
  const customers: Customer[] = FIRST_NAMES.map((first, i) => {
    const last = LAST_NAMES[i]!;
    const sinceOffsetDays = between(rand, 0, 1977); // ~2021-01-01 to 2026-06-01
    const since = iso(addDays(new Date("2021-01-01T00:00:00Z"), sinceOffsetDays));
    return {
      email: `${first}.${last}@example.com`.toLowerCase(),
      name: `${first} ${last}`,
      since,
      phone: `555-01${String(i).padStart(2, "0")}`,
    };
  });

  // ---- report generation ----
  const CORNER_POSITIONS = ["TOP LEFT", "TOP RIGHT", "BOTTOM LEFT", "BOTTOM RIGHT"];
  const EDGE_POSITIONS = ["TOP", "RIGHT", "BOTTOM", "LEFT"];

  function surfaceFor(grade: number): GradeReport["surface"] {
    if (grade >= 9) return "clean";
    if (grade >= 7) return "light scratches";
    if (grade >= 5) return "print lines";
    return "scratches and dents";
  }
  function centeringX(maxX: number) {
    const steps = (maxX - 50) / 5;
    return 50 + 5 * between(rand, 0, steps);
  }
  function centeringFor(grade: number): GradeReport["centering"] {
    const frontMax = grade >= 10 ? 55 : grade >= 9 ? 60 : grade >= 8 ? 65 : 75;
    const backMax = grade >= 9 ? 75 : 85;
    const fx = centeringX(frontMax), bx = centeringX(backMax);
    return { front: `${fx}/${100 - fx}`, back: `${bx}/${100 - bx}` };
  }
  function buildReport(grade: number): GradeReport {
    const scoreAt = (position: string, kind: "corner" | "edge"): PositionScore => {
      const row = wearRow(grade, kind);
      const score = row ? Math.round(triangular(rand, row.p10, row.p50, row.p90)) : 1000;
      return { position, score };
    };
    return {
      grade,
      corners: CORNER_POSITIONS.map((p) => scoreAt(p, "corner")),
      edges: EDGE_POSITIONS.map((p) => scoreAt(p, "edge")),
      surface: surfaceFor(grade),
      centering: centeringFor(grade),
    };
  }

  // ---- orders ----
  interface ScenarioEntry { scenario: Scenario; forceExpress?: boolean }
  const scenarioList: ScenarioEntry[] = [];
  const push = (s: Scenario, n: number, forceExpressCount = 0) => {
    for (let i = 0; i < n; i++) scenarioList.push({ scenario: s, forceExpress: i < forceExpressCount });
  };
  push("lost", 2);
  push("damaged", 1);
  push("double_charged", 3);
  push("delayed", 4);
  push("upcharged", 7);
  push("mislabeled", 7);
  push("graded", 24, 3);
  push("in_progress", 8);
  push("shipped", 8);
  push("received", 6);

  // Fisher-Yates shuffle with the seeded rng.
  for (let i = scenarioList.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [scenarioList[i], scenarioList[j]] = [scenarioList[j]!, scenarioList[i]!];
  }

  const statusFor = (s: Scenario): OrderStatus => {
    if (s === "delayed" || s === "in_progress") return "grading";
    if (s === "shipped") return "shipped";
    if (s === "received") return "received";
    return "delivered";
  };

  function drawCreatedOn(tier: Tier, condition: (promisedBy: Date) => boolean): { createdOn: Date; promisedBy: Date } {
    for (let i = 0; i < 200; i++) {
      const offset = between(rand, 5, 90);
      const createdOn = addDays(ASOF, -offset);
      const promisedBy = addBusinessDays(createdOn, TIERS[tier].businessDays);
      if (condition(promisedBy)) return { createdOn, promisedBy };
    }
    const offset = condition(addDays(ASOF, -90)) ? 90 : 5;
    const createdOn = addDays(ASOF, -offset);
    return { createdOn, promisedBy: addBusinessDays(createdOn, TIERS[tier].businessDays) };
  }

  function pickShippedOnDelivered(createdOn: Date, promisedBy: Date): Date {
    const maxByDelivery = addDays(ASOF, -3); // so deliveredOn (shippedOn + 3) lands on/before asOf
    const maxByPromise = addDays(promisedBy, -1);
    const upper = maxByDelivery.getTime() < maxByPromise.getTime() ? maxByDelivery : maxByPromise;
    const lower = addDays(createdOn, 1);
    if (upper.getTime() <= lower.getTime()) return lower;
    const spanDays = Math.round((upper.getTime() - lower.getTime()) / DAY_MS);
    return addDays(lower, between(rand, 0, spanDays));
  }
  function pickShippedOnInTransit(createdOn: Date): Date {
    const lower = addDays(createdOn, 1);
    if (ASOF.getTime() <= lower.getTime()) return lower;
    const spanDays = Math.round((ASOF.getTime() - lower.getTime()) / DAY_MS);
    return addDays(lower, between(rand, 0, spanDays));
  }

  const randomDigits = (n: number) => Array.from({ length: n }, () => between(rand, 0, 9)).join("");

  const usedOrderIds = new Set<string>();
  function nextOrderId(): string {
    let id: string;
    do {
      id = `CG-${String(20_000 + between(rand, 0, 999)).padStart(5, "0")}`;
    } while (usedOrderIds.has(id));
    usedOrderIds.add(id);
    return id;
  }
  const usedCerts = new Set<string>();
  function nextCert(): string {
    let cert: string;
    do {
      cert = String(between(rand, 10_000_000, 99_999_999));
    } while (usedCerts.has(cert));
    usedCerts.add(cert);
    return cert;
  }

  function labelFor(card: Card): string {
    return card.year != null
      ? `${card.year} ${card.setName} ${card.name} #${card.number}`
      : `${card.setName} ${card.name} #${card.number}`;
  }
  function mislabeledLabelFor(card: Card): string {
    const siblings = cards.filter((c) => c.setName === card.setName && c.id !== card.id);
    if (siblings.length > 0) {
      const wrongCard = pick(rand, siblings);
      const year = card.year != null ? `${card.year} ` : "";
      return `${year}${card.setName} ${wrongCard.name} #${card.number}`;
    }
    const year = card.year != null ? `${card.year} ` : "";
    return `${year}${card.setName} ${card.name} #${Number(card.number) + 1}`;
  }

  const orders: Order[] = [];

  scenarioList.forEach((entry, index) => {
    const { scenario } = entry;
    const customer = customers[index % customers.length]!;
    const status = statusFor(scenario);

    let tier: Tier;
    if (scenario === "lost") tier = pick(rand, ["express", "premium"]);
    else if (scenario === "damaged") tier = "express";
    else if (scenario === "double_charged") tier = "standard";
    else if (scenario === "upcharged") tier = pick(rand, ["value", "standard"]);
    else if (scenario === "graded") tier = entry.forceExpress ? "express" : weightedTier(rand, GRADED_NONEXPRESS_WEIGHTS);
    else tier = weightedTier(rand, ALL_TIER_WEIGHTS);

    // lost/damaged: resolve the forced high-value card (and, if nothing fits the tier's cap,
    // widen the tier to premium) before any tier-dependent date/charge math runs.
    let forcedCard: Card | null = null, forcedGrade = 0, forcedValue = 0;
    if (scenario === "lost" || scenario === "damaged") {
      const threshold = scenario === "lost" ? 3000 : 2000;
      forcedGrade = pick(rand, [8, 9]);
      const candidatesWithinCap = (cap: number) =>
        cardsWithValues
          .map((c) => ({ c, v: nearestValue(c.id, forcedGrade) }))
          .filter((x): x is { c: Card; v: CardValue } => !!x.v && x.v.valueUsd >= threshold && x.v.valueUsd <= cap);

      let candidates = candidatesWithinCap(TIERS[tier].maxDeclaredUsd);
      if (candidates.length === 0 && tier !== "premium") {
        tier = "premium";
        candidates = candidatesWithinCap(TIERS[tier].maxDeclaredUsd);
      }
      if (candidates.length > 0) {
        const chosen = pick(rand, candidates);
        forcedCard = chosen.c;
        forcedValue = chosen.v.valueUsd;
      }
    }

    let createdOn: Date, promisedBy: Date;
    if (scenario === "delayed") {
      ({ createdOn, promisedBy } = drawCreatedOn(tier, (pb) => pb.getTime() < ASOF.getTime()));
    } else if (scenario === "in_progress") {
      ({ createdOn, promisedBy } = drawCreatedOn(tier, (pb) => pb.getTime() >= ASOF.getTime()));
    } else {
      const offset = between(rand, 5, 90);
      createdOn = addDays(ASOF, -offset);
      promisedBy = addBusinessDays(createdOn, TIERS[tier].businessDays);
    }

    let shippedOn: Date | null = null, deliveredOn: Date | null = null, carrier: string | null = null, tracking: string | null = null;
    if (status === "delivered") {
      // Still draw as usual first so the rand() sequence for every later order is unaffected,
      // then overwrite for lost/damaged: those need to read as recent (within the 5-day
      // reporting window), not wherever pickShippedOnDelivered happened to land them.
      shippedOn = pickShippedOnDelivered(createdOn, promisedBy);
      deliveredOn = addDays(shippedOn, 3);
      if (scenario === "lost" || scenario === "damaged") {
        deliveredOn = addDays(ASOF, -2);
        shippedOn = addDays(deliveredOn, -3);
        if (createdOn.getTime() >= shippedOn.getTime()) createdOn = addDays(shippedOn, -TIERS[tier].businessDays);
      }
    } else if (status === "shipped") {
      shippedOn = pickShippedOnInTransit(createdOn);
    }
    if (shippedOn) {
      carrier = pick(rand, ["UPS", "USPS"]);
      tracking = carrier === "UPS" ? `1Z${randomDigits(16)}` : randomDigits(22);
    }

    const numSubmissions = scenario === "double_charged" ? 1 : between(rand, 1, 4);
    const isGradedStatus = status === "delivered" || status === "shipped";

    const submissions: Submission[] = [];
    for (let i = 0; i < numSubmissions; i++) {
      const card = i === 0 && forcedCard ? forcedCard : pick(rand, cardsWithValues);
      const expectedGrade = i === 0 && forcedCard ? forcedGrade : between(rand, 6, 10);
      const valueRow = i === 0 && forcedCard ? { valueUsd: forcedValue } : nearestValue(card.id, expectedGrade);
      let declaredValueUsd = roundTo10(valueRow?.valueUsd ?? 0);
      if (scenario !== "upcharged") declaredValueUsd = Math.min(declaredValueUsd, TIERS[tier].maxDeclaredUsd);

      let cert: string | null = null, label: string | null = null, report: GradeReport | null = null;
      if (isGradedStatus) {
        const finalGrade = clamp(expectedGrade + between(rand, -2, 1), 1, 10);
        cert = nextCert();
        label = labelFor(card);
        report = buildReport(finalGrade);
      }
      submissions.push({ id: "", cardId: card.id, declaredValueUsd, cert, label, report });
    }

    let upchargeCharge: Charge | null = null;
    if (scenario === "upcharged" && submissions.length > 0) {
      const target = submissions[0]!;
      const extra = between(rand, 5, 200) * 10;
      target.declaredValueUsd = TIERS[tier].maxDeclaredUsd + extra;
      const nextTier: Tier = tier === "value" ? "standard" : "express";
      upchargeCharge = {
        description: "Declared value adjustment",
        amountUsd: TIERS[nextTier].feeUsd - TIERS[tier].feeUsd,
        chargedOn: iso(createdOn),
      };
    }

    if (scenario === "mislabeled" && isGradedStatus && submissions.length > 0) {
      const target = pick(rand, submissions);
      const card = cards.find((c) => c.id === target.cardId)!;
      target.label = mislabeledLabelFor(card);
    }

    const totalDeclared = submissions.reduce((sum, s) => sum + s.declaredValueUsd, 0);
    const insuredReturn = totalDeclared > 500;

    const [city, state, zip] = pick(rand, CITY_STATE_ZIP);
    const shipTo = `${between(rand, 100, 9999)} ${pick(rand, STREET_NAMES)} ${pick(rand, STREET_SUFFIXES)}, ${city}, ${state} ${zip}`;

    const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
    const charges: Charge[] = [
      {
        description: `${tierLabel} grading x${numSubmissions}`,
        amountUsd: TIERS[tier].feeUsd * numSubmissions,
        chargedOn: iso(createdOn),
      },
    ];
    if (scenario === "double_charged") {
      charges.push({ description: `${tierLabel} grading x${numSubmissions}`, amountUsd: TIERS[tier].feeUsd * numSubmissions, chargedOn: iso(createdOn) });
    }
    if (upchargeCharge) charges.push(upchargeCharge);
    if (shippedOn) charges.push({ description: "Return shipping", amountUsd: 20, chargedOn: iso(shippedOn) });

    // The order id is drawn here, after everything else, so the rng sequence stays where it
    // has always been; submission ids are scoped to it once it exists ("CG-20985-1").
    const orderId = nextOrderId();
    submissions.forEach((s, n) => (s.id = `${orderId}-${n + 1}`));
    orders.push({
      id: orderId,
      customerEmail: customer.email,
      tier,
      status,
      createdOn: iso(createdOn),
      promisedBy: iso(promisedBy),
      shippedOn: shippedOn ? iso(shippedOn) : null,
      deliveredOn: deliveredOn ? iso(deliveredOn) : null,
      carrier,
      tracking,
      insuredReturn,
      shipTo,
      charges,
      submissions,
      _scenario: scenario,
    });
  });

  return { cards, values, customers, orders };
}

if (import.meta.main) {
  const [cardsCsv, valuesCsv, severityCsv] = await Promise.all([
    Bun.file("data/cards.csv").text(),
    Bun.file("data/card_values.csv").text(),
    Bun.file("data/grade_severity.csv").text(),
  ]);
  const out = buildAccounts(
    {
      cards: parseCsv(cardsCsv) as unknown as RawCardRow[],
      values: parseCsv(valuesCsv) as unknown as RawValueRow[],
      severity: parseCsv(severityCsv) as unknown as RawSeverityRow[],
    },
    20260928,
  );
  await Promise.all([
    Bun.write("fixtures/cards.json", JSON.stringify(out.cards, null, 2)),
    Bun.write("fixtures/values.json", JSON.stringify(out.values, null, 2)),
    Bun.write("fixtures/customers.json", JSON.stringify(out.customers, null, 2)),
    Bun.write("fixtures/orders.json", JSON.stringify(out.orders, null, 2)),
  ]);
}
