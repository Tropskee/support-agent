import { expect, test } from "bun:test";
import { between, jitter, mulberry32, pick } from "../src/rng";

test("same seed gives same sequence", () => {
  const a = mulberry32(42), b = mulberry32(42);
  expect([a(), a(), a()]).toEqual([b(), b(), b()]);
});

test("between is inclusive and bounded", () => {
  const r = mulberry32(1);
  const xs = Array.from({ length: 500 }, () => between(r, 3, 5));
  expect(Math.min(...xs)).toBe(3);
  expect(Math.max(...xs)).toBe(5);
});

test("jitter stays within pct", () => {
  const r = mulberry32(7);
  for (let i = 0; i < 200; i++) {
    const v = jitter(r, 1000, 0.05);
    expect(v).toBeGreaterThanOrEqual(950);
    expect(v).toBeLessThanOrEqual(1050);
  }
});

test("pick returns an element", () => {
  expect(["a", "b"]).toContain(pick(mulberry32(3), ["a", "b"]));
});
