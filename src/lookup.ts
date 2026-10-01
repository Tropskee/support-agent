import type { Fixtures } from "./fixtures";
import type { Order } from "./types";
import { config } from "./config";

export interface ContextBlock {
  label: string;
  body: string;
}
export interface TicketInput {
  from: string;
  subject: string;
  body: string;
}
export interface Context {
  blocks: ContextBlock[];
  labels: Set<string>;
  customerFound: boolean;
  orderId: string | null;
}

interface PolicySection {
  id: string;
  title: string;
  keywords: string[];
  text: string;
}

const ORDER_ID_RE = /CG-\d{5}/g;
const CERT_RE = /\b\d{8}\b/g;
const MAX_POLICY_SECTIONS = 4;

export function parsePolicy(md: string): PolicySection[] {
  return md
    .split(/^## /m)
    .slice(1)
    .map((chunk): PolicySection => {
      const [headingLine, ...rest] = chunk.split("\n");
      const heading = headingLine!.trim();
      const id = heading.split(".")[0]!.trim();
      const title = heading.slice(heading.indexOf(".") + 1).trim();
      const body = rest.join("\n");
      const keywordMatch = body.match(/<!--\s*keywords:\s*(.*?)\s*-->/);
      const keywords = (keywordMatch?.[1] ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
      const text = body.replace(/<!--\s*keywords:.*?-->\n?/, "").trim();
      return { id, title, keywords, text };
    });
}

const DAY_MS = 86_400_000;

/** Weekdays after `promisedBy` up to and including `asOf`; 0 when not past the promised date. */
export function businessDaysLate(promisedBy: string, asOf: string): number {
  let cur = new Date(`${promisedBy}T00:00:00Z`).getTime();
  const end = new Date(`${asOf}T00:00:00Z`).getTime();
  let count = 0;
  while (cur < end) {
    cur += DAY_MS;
    const dow = new Date(cur).getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

/** The card as our intake record has it, in slab-label form ("2000 Neo Genesis Lugia #9"). */
export function cardLabel(fx: Fixtures, cardId: string): string {
  const card = fx.cards.get(cardId);
  if (!card) return cardId;
  const year = card.year != null ? `${card.year} ` : "";
  return `${year}${card.setName} ${card.name} #${card.number}`;
}

type Submission = Order["submissions"][number];

/** A printed slab label that disagrees with the intake record, or null when it matches. */
function mismatchedLabel(fx: Fixtures, s: Submission): string | null {
  return s.label && s.label !== cardLabel(fx, s.cardId) ? s.label : null;
}

function findValue(fx: Fixtures, cardId: string, grade: number): number | null {
  const candidates = fx.values
    .filter((v) => v.cardId === cardId && v.grade <= grade)
    .sort((a, b) => b.grade - a.grade);
  return candidates[0]?.valueUsd ?? null;
}

function renderOrderBody(fx: Fixtures, order: Order): string {
  const daysLate =
    order.status !== "shipped" && order.status !== "delivered" ? businessDaysLate(order.promisedBy, config.asOf) : 0;
  const lines = [
    `today: ${config.asOf}`,
    `tier: ${order.tier}`,
    `status: ${order.status}`,
    `created: ${order.createdOn}`,
    `promised by: ${order.promisedBy}`,
    `shipped: ${order.shippedOn ?? "not yet"}`,
    `delivered: ${order.deliveredOn ?? "not yet"}`,
    `late: ${daysLate > 0 ? `yes, ${daysLate} business days past the promised ${order.promisedBy}` : "no"}`,
    `carrier: ${order.carrier ?? "none"}`,
    `tracking: ${order.tracking ?? "none"}`,
    `insured: ${order.insuredReturn ? "yes" : "no"}`,
    `ship to: ${order.shipTo}`,
  ];
  if (order.charges.length > 0) {
    lines.push("charges:");
    for (const c of order.charges) {
      lines.push(`- ${c.description} | $${c.amountUsd} | ${c.chargedOn}`);
    }
  } else {
    lines.push("charges: none");
  }
  lines.push("submissions:");
  for (const s of order.submissions) {
    const gradePart = s.report ? `grade ${s.report.grade}` : "ungraded";
    const certPart = s.cert ? `cert ${s.cert}` : "no cert";
    const printed = mismatchedLabel(fx, s);
    const labelPart = printed ? ` | slab label printed as "${printed}", which does not match our record` : "";
    lines.push(`- ${s.id} | ${cardLabel(fx, s.cardId)} | declared $${s.declaredValueUsd} | ${gradePart} | ${certPart}${labelPart}`);
  }
  return lines.join("\n");
}

function renderGradeReport(fx: Fixtures, s: Submission & { report: NonNullable<Submission["report"]> }): string {
  const report = s.report;
  const lines = ["Condition scores are 0-1000 per position; higher is better.", `card: ${cardLabel(fx, s.cardId)}`];
  const printed = mismatchedLabel(fx, s);
  if (printed) lines.push(`slab label printed as: "${printed}" (does not match our record)`);
  lines.push(`grade: ${report.grade}`);
  for (const c of report.corners) {
    lines.push(`corner ${c.position}: ${c.score}/1000`);
  }
  for (const e of report.edges) {
    lines.push(`edge ${e.position}: ${e.score}/1000`);
  }
  lines.push(`surface: ${report.surface}`);
  lines.push(`centering: front ${report.centering.front}, back ${report.centering.back}`);
  return lines.join("\n");
}

export function buildContext(fx: Fixtures, ticket: TicketInput): Context {
  const blocks: ContextBlock[] = [];
  const labels = new Set<string>();
  const add = (label: string, body: string) => {
    blocks.push({ label, body });
    labels.add(label);
  };

  const senderEmail = ticket.from.trim().toLowerCase();
  const customer = fx.customers.get(senderEmail);
  const customerFound = customer !== undefined;

  const text = `${ticket.subject}\n${ticket.body}`;
  const lowerText = text.toLowerCase();

  const mentionedOrderIds = Array.from(new Set(text.match(ORDER_ID_RE) ?? []));
  const sendersOrders = customer ? fx.orders.filter((o) => o.customerEmail.toLowerCase() === senderEmail) : [];

  // Every mentioned order on the sender's account, in mention order; the first is the one
  // the ticket resolves to (ctx.orderId).
  const ownedOrders: Order[] = [];
  const lookupOnlyIds: string[] = [];
  let resolvedOrder: Order | null = null;

  if (customer) {
    for (const id of mentionedOrderIds) {
      const owned = sendersOrders.find((o) => o.id === id);
      if (owned) ownedOrders.push(owned);
      else lookupOnlyIds.push(id);
    }
    resolvedOrder = ownedOrders[0] ?? null;
    if (!resolvedOrder && mentionedOrderIds.length === 0) {
      const openOrders = sendersOrders.filter((o) => o.status !== "delivered");
      const sorted = [...(openOrders.length > 0 ? openOrders : sendersOrders)].sort((a, b) => b.createdOn.localeCompare(a.createdOn));
      resolvedOrder = sorted[0] ?? null;
      if (resolvedOrder) ownedOrders.push(resolvedOrder);
    }
  }
  // Unknown sender: no order data at all (rule 1), not even an order_lookup block for a
  // mentioned id. The no_account block already tells the agent what to do.

  if (customerFound && customer) {
    add("customer", `name: ${customer.name}\nsince: ${customer.since}\norders: ${sendersOrders.length}`);
  } else {
    add(
      "no_account",
      "No account matches this email. Do not reveal any order details. Ask the sender for their order number and the email on the account.",
    );
  }

  for (const order of ownedOrders) {
    add(`order ${order.id}`, renderOrderBody(fx, order));
  }

  for (const id of lookupOnlyIds) {
    add(`order_lookup ${id}`, "This order is not on the sender's account. No details may be shared.");
  }

  const mentionedCerts = Array.from(new Set(text.match(CERT_RE) ?? []));
  const valueKeys = new Set<string>();
  const addValueBlock = (cardId: string, grade: number) => {
    const key = `${cardId}|${grade}`;
    if (valueKeys.has(key)) return;
    valueKeys.add(key);
    const valueUsd = findValue(fx, cardId, grade);
    add(
      `value ${cardId} grade ${grade}`,
      valueUsd !== null ? `market value about $${valueUsd} at grade ${grade}` : `no market value available at grade ${grade}`,
    );
  };

  for (const order of ownedOrders) {
    for (const s of order.submissions) {
      if (s.cert && s.report) {
        const label = `grade_report ${s.cert}`;
        if (!labels.has(label)) add(label, renderGradeReport(fx, { ...s, report: s.report }));
      }
      addValueBlock(s.cardId, s.report?.grade ?? 9);
    }
  }

  const ordersByCert = new Map<string, { order: Order; sub: Order["submissions"][number] }>();
  for (const o of fx.orders) {
    for (const s of o.submissions) {
      if (s.cert) ordersByCert.set(s.cert, { order: o, sub: s });
    }
  }

  for (const cert of mentionedCerts) {
    const reportLabel = `grade_report ${cert}`;
    if (labels.has(reportLabel)) continue; // already covered (a mentioned order or an earlier mention)

    // A cert belonging to any of the sender's own orders is a grade report, even when
    // it sits in an order the ticket didn't mention.
    const ownSub = sendersOrders
      .flatMap((o) => o.submissions.map((sub) => ({ order: o, sub })))
      .find((entry) => entry.sub.cert === cert);

    if (ownSub && ownSub.sub.report) {
      add(reportLabel, renderGradeReport(fx, { ...ownSub.sub, report: ownSub.sub.report }));
      addValueBlock(ownSub.sub.cardId, ownSub.sub.report.grade);
      continue;
    }

    const registryLabel = `cert_registry ${cert}`;
    if (labels.has(registryLabel)) continue;
    const found = ordersByCert.get(cert);
    if (!found) {
      add(registryLabel, "no card is registered under this cert");
      continue;
    }
    const grade = found.sub.report?.grade ?? "ungraded";
    add(registryLabel, `card: ${cardLabel(fx, found.sub.cardId)}\ngrade: ${grade}`);

    const grade9 = found.sub.report?.grade ?? 9;
    addValueBlock(found.sub.cardId, grade9);
  }

  // Keyword matching is against the ticket's own subject + body only. Section 1 always
  // runs; the rest are ranked by how many of their keywords hit (ties broken by id) so a
  // ticket about one topic doesn't get crowded out by tangentially-matching sections.
  const sections = parsePolicy(fx.policy);
  const section1 = sections.find((s) => s.id === "1");
  const ranked = sections
    .filter((s) => s.id !== "1")
    .map((s) => ({ section: s, hits: s.keywords.filter((k) => lowerText.includes(k.toLowerCase())).length }))
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.hits - a.hits || Number(a.section.id) - Number(b.section.id));

  const chosen: PolicySection[] = [];
  if (section1) chosen.push(section1);
  for (const r of ranked) {
    if (chosen.length >= MAX_POLICY_SECTIONS) break;
    chosen.push(r.section);
  }
  chosen.sort((a, b) => Number(a.id) - Number(b.id));
  for (const s of chosen) {
    add(`policy ${s.id}`, s.text);
  }

  return { blocks, labels, customerFound, orderId: resolvedOrder?.id ?? null };
}

export function renderBlocks(blocks: ContextBlock[]): string {
  return blocks.map((b) => `[${b.label}]\n${b.body}`).join("\n\n");
}

export function renderContext(ctx: Context): string {
  return renderBlocks(ctx.blocks);
}
