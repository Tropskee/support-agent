import { expect, test } from "bun:test";
import { config } from "../src/config";
import { buildContext, businessDaysLate, parsePolicy, renderContext } from "../src/lookup";
import { fx, fxRealPolicy } from "./helpers";

const labels = (ctx: { blocks: { label: string }[] }) => ctx.blocks.map((b) => b.label);

test("parses policy sections with keywords", () => {
  const s = parsePolicy(fx.policy);
  expect(s.map((x) => x.id)).toEqual(["1", "4", "7"]);
  expect(s[1]!.keywords).toEqual(["grade", "regrade"]);
});

test("resolves the mentioned order, its grade report and value", () => {
  const ctx = buildContext(fx, { from: "Kenji@Example.com", subject: "Why did my Lugia only get a grade of 8", body: "Order CG-20001" });
  expect(labels(ctx)).toEqual(expect.arrayContaining(["customer", "order CG-20001", "grade_report 12345678", "value neo1-9 grade 8", "policy 1", "policy 4"]));
  expect(ctx.orderId).toBe("CG-20001");
});

test("defaults to the most recent open order", () => {
  const ctx = buildContext(fx, { from: "kenji@example.com", subject: "status?", body: "any update" });
  expect(ctx.orderId).toBe("CG-20002");
});

test("someone else's order is withheld", () => {
  const ctx = buildContext(fx, { from: "kenji@example.com", subject: "status", body: "what about CG-20003" });
  expect(labels(ctx)).toContain("order_lookup CG-20003");
  expect(labels(ctx)).not.toContain("order CG-20003");
  expect(renderContext(ctx)).not.toContain("87654321");
});

test("unknown sender gets no_account and no order data", () => {
  const ctx = buildContext(fx, { from: "stranger@example.com", subject: "where is CG-20001", body: "" });
  expect(labels(ctx)).toContain("no_account");
  expect(labels(ctx).some((l) => l.startsWith("order "))).toBe(false);
  expect(labels(ctx).some((l) => l.startsWith("order_lookup "))).toBe(false);
});

test("a cert not on the account shows registry info only", () => {
  const ctx = buildContext(fx, { from: "kenji@example.com", subject: "is this real", body: "cert 87654321" });
  expect(labels(ctx)).toContain("cert_registry 87654321");
  expect(renderContext(ctx)).not.toContain("ana@example.com");
});

test("a cert on the account but outside the resolved order still gets a grade report", () => {
  const ctx = buildContext(fx, { from: "kenji@example.com", subject: "status", body: "any update on cert 12345678" });
  expect(ctx.orderId).toBe("CG-20002");
  expect(labels(ctx)).toContain("grade_report 12345678");
  expect(labels(ctx)).not.toContain("cert_registry 12345678");
  expect(labels(ctx)).toContain("value neo1-9 grade 8");
});

test("policy matching ranks by keyword hits and ignores context blocks", () => {
  const empty = buildContext(fxRealPolicy, { from: "kenji@example.com", subject: "my box arrived empty, the card is missing", body: "" });
  expect(labels(empty)).toContain("policy 7");

  const authenticity = buildContext(fxRealPolicy, { from: "kenji@example.com", subject: "is this slab real? cert 12345678", body: "" });
  expect(labels(authenticity)).toContain("policy 10");

  const packing = buildContext(fxRealPolicy, { from: "kenji@example.com", subject: "how should I pack my cards before shipping?", body: "" });
  expect(labels(packing)).toContain("policy 6");
});

test("scenario bookkeeping never reaches the prompt", () => {
  const ctx = buildContext(fx, { from: "kenji@example.com", subject: "x", body: "CG-20001" });
  expect(renderContext(ctx)).not.toContain("_scenario");
  expect(renderContext(ctx)).not.toContain("graded\"");
});

test("a slab label that disagrees with the record shows the record's card and the printed label", () => {
  const [delivered, ...rest] = fx.orders;
  const mislabeled = { ...delivered!, submissions: [{ ...delivered!.submissions[0]!, label: "2000 Neo Genesis Typhlosion #17" }] };
  const ctx = buildContext({ ...fx, orders: [mislabeled, ...rest] }, { from: "kenji@example.com", subject: "wrong label", body: "CG-20001" });
  const order = ctx.blocks.find((b) => b.label === "order CG-20001")!.body;
  expect(order).toContain('2000 Neo Genesis Lugia #9 | declared $400 | grade 8 | cert 12345678 | slab label printed as "2000 Neo Genesis Typhlosion #17"');
  const report = ctx.blocks.find((b) => b.label === "grade_report 12345678")!.body;
  expect(report).toContain("card: 2000 Neo Genesis Lugia #9");
  expect(report).toContain('slab label printed as: "2000 Neo Genesis Typhlosion #17"');
});

test("a matching slab label adds no mismatch note", () => {
  const ctx = buildContext(fx, { from: "kenji@example.com", subject: "x", body: "CG-20001" });
  expect(renderContext(ctx)).not.toContain("slab label printed");
});

test("counts business days late, skipping weekends", () => {
  expect(businessDaysLate("2026-09-01", "2026-09-28")).toBe(19);
  expect(businessDaysLate("2026-09-25", "2026-09-27")).toBe(0); // Friday promise, Sunday today
  expect(businessDaysLate("2026-09-28", "2026-09-01")).toBe(0);
});

test("an open order past its promise date states today's date and how many business days late it is", () => {
  const ctx = buildContext(fx, { from: "kenji@example.com", subject: "status?", body: "any update" });
  const order = ctx.blocks.find((b) => b.label === "order CG-20002")!.body;
  expect(order).toContain(`today: ${config.asOf}`);
  expect(order).toContain(`late: yes, ${businessDaysLate("2026-09-01", config.asOf)} business days past the promised 2026-09-01`);
});

test("an ungraded submission with no printed label shows the full card label", () => {
  const [a, open, c] = fx.orders;
  const unlabeled = { ...open!, submissions: [{ ...open!.submissions[0]!, label: null }] };
  const ctx = buildContext({ ...fx, orders: [a!, unlabeled, c!] }, { from: "kenji@example.com", subject: "status?", body: "any update" });
  const order = ctx.blocks.find((b) => b.label === "order CG-20002")!.body;
  expect(order).toContain("- CG-20002-1 | 2000 Neo Genesis Lugia #9 | declared $400 | ungraded | no cert");
});

test("a ticket naming two of the sender's own orders gets both, the resolved one first", () => {
  const ctx = buildContext(fx, { from: "kenji@example.com", subject: "two orders", body: "What about CG-20002 and CG-20001?" });
  expect(ctx.orderId).toBe("CG-20002");
  const orderLabels = labels(ctx).filter((l) => l.startsWith("order "));
  expect(orderLabels).toEqual(["order CG-20002", "order CG-20001"]);
  // the second order's graded submission gets its grade report and value too
  expect(labels(ctx)).toContain("grade_report 12345678");
  expect(labels(ctx)).toContain("value neo1-9 grade 8");
});
