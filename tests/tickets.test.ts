import { expect, test } from "bun:test";
import { ARCHETYPES, generateTickets } from "../src/archetypes";
import { loadFixtures } from "../src/fixtures";
import { fakeBackend } from "../src/model";

test("archetype counts give the required priority mix", () => {
  const byP: Record<string, number> = {};
  for (const a of ARCHETYPES) byP[a.priority] = (byP[a.priority] ?? 0) + a.count;
  expect(byP).toEqual({ P1: 5, P2: 10, P3: 20, P4: 30, P5: 35 });
});

test("generates 100 labeled tickets deterministically", async () => {
  const fx = await loadFixtures();
  const prose = Array.from({ length: 100 }, (_, i) => `Subject: Question ${i}\n\nHello there, body ${i}.`);
  const a = await generateTickets(fx, fakeBackend([...prose]), 7);
  const b = await generateTickets(fx, fakeBackend([...prose]), 7);
  expect(a).toHaveLength(100);
  expect(a.map((t) => t.labels)).toEqual(b.map((t) => t.labels));
  expect(a.filter((t) => t.labels.priority === "P1").every((t) => t.labels.shouldEscalate)).toBe(true);
  expect(new Set(a.map((t) => t.id)).size).toBe(100);
});

test("hard cases are present", async () => {
  const fx = await loadFixtures();
  const t = await generateTickets(fx, fakeBackend(Array(100).fill("Subject: x\n\ny")), 7);
  const keys = new Set(t.map((x) => x.archetype));
  for (const k of ["lost_polite", "prompt_injection", "other_customer_order", "shouting_faq", "no_account"]) expect(keys.has(k)).toBe(true);
});

test("no_account tickets come from unknown emails", async () => {
  const fx = await loadFixtures();
  const t = await generateTickets(fx, fakeBackend(Array(100).fill("Subject: x\n\ny")), 7);
  for (const x of t.filter((x) => x.archetype === "no_account")) expect(fx.customers.has(x.from)).toBe(false);
});
