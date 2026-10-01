import { readFileSync } from "node:fs";
import type { Fixtures } from "../src/fixtures";
import type { Order } from "../src/types";

const report = { grade: 8, corners: [], edges: [], surface: "light scratches" as const, centering: { front: "60/40", back: "70/30" } };
const order = (id: string, email: string, status: Order["status"], createdOn: string, cert: string | null): Order => ({
  id, customerEmail: email, tier: "standard", status, createdOn, promisedBy: "2026-09-01",
  shippedOn: null, deliveredOn: null, carrier: null, tracking: null, insuredReturn: false,
  shipTo: "1 Main St", charges: [], _scenario: "graded",
  submissions: [{ id: `${id}-1`, cardId: "neo1-9", declaredValueUsd: 400, cert, label: "2000 Neo Genesis Lugia #9", report: cert ? report : null }],
});
const policy = "## 1. How we handle support\n<!-- keywords: -->\nOne.\n\n## 4. Grades and regrades\n<!-- keywords: grade, regrade -->\nFour.\n\n## 7. Loss and damage\n<!-- keywords: lost, empty -->\nSeven.\n";
export const fx: Fixtures = {
  cards: new Map([["neo1-9", { id: "neo1-9", name: "Lugia", setName: "Neo Genesis", number: "9", rarity: "Rare Holo", year: 2000 }]]),
  values: [{ cardId: "neo1-9", grade: 8, valueUsd: 900 }, { cardId: "neo1-9", grade: 9, valueUsd: 2100 }],
  customers: new Map([["kenji@example.com", { email: "kenji@example.com", name: "Kenji T", since: "2023-01-01", phone: "555-0101" }],
                      ["ana@example.com", { email: "ana@example.com", name: "Ana R", since: "2022-01-01", phone: "555-0102" }]]),
  orders: [order("CG-20001", "kenji@example.com", "delivered", "2026-08-01", "12345678"),
           order("CG-20002", "kenji@example.com", "grading", "2026-09-01", null),
           order("CG-20003", "ana@example.com", "delivered", "2026-08-10", "87654321")],
  policy,
};

const realPolicy = readFileSync(new URL("../fixtures/policy.md", import.meta.url), "utf-8");
export const fxRealPolicy: Fixtures = { ...fx, policy: realPolicy };
