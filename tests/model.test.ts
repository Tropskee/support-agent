import { expect, test } from "bun:test";
import { fakeBackend } from "../src/model";

test("fake backend replays responses in order and records calls", async () => {
  const fb = fakeBackend([{ a: 1 }, "not json"]);
  const r1 = await fb.decide({ system: "s", user: "u", schema: {} });
  expect(r1.parsed).toEqual({ a: 1 });
  const r2 = await fb.decide({ system: "s", user: "u2", schema: {} });
  expect(r2.parsed).toBeNull();
  expect(r2.raw).toBe("not json");
  expect(fb.calls.map((c) => c.user)).toEqual(["u", "u2"]);
});

test("the test preload points Ori at a dead local port and blanks provider keys", () => {
  expect(process.env.ORI_URL).toBe("http://127.0.0.1:9");
  expect(process.env.OPEN_ROUTER_API_KEY ?? "").toBe("");
  expect(process.env.OPENROUTER_API_KEY ?? "").toBe("");
});
