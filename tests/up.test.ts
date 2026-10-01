import { expect, test } from "bun:test";
import { config } from "../src/config";
import {
  findOri,
  isOriWarningOrError,
  LinePrefixer,
  oriPortFrom,
  oriTimeoutMessage,
  portInUseMessage,
  probeApp,
  probeBridge,
  readyMessage,
  unexpectedExitMessage,
  waitUntilReady,
  type ProbeResult,
} from "../scripts/up";

test("oriPortFrom reads the explicit port, else the scheme's default", () => {
  expect(oriPortFrom("http://127.0.0.1:4717")).toBe(4717);
  expect(oriPortFrom("http://localhost:9000/")).toBe(9000);
  expect(oriPortFrom("http://ori.test")).toBe(80);
  expect(oriPortFrom("https://ori.test")).toBe(443);
});

test("oriPortFrom rejects a value that isn't an http(s) URL", () => {
  expect(() => oriPortFrom("127.0.0.1:4717")).toThrow(/ORI_URL/);
  expect(() => oriPortFrom("not a url")).toThrow(/ORI_URL/);
});

test("findOri prefers PATH, then ~/.local/bin/ori, else null", () => {
  expect(findOri(() => "/usr/local/bin/ori", () => true, "/home/x")).toBe("/usr/local/bin/ori");
  expect(findOri(() => null, (p) => p === "/home/x/.local/bin/ori", "/home/x")).toBe("/home/x/.local/bin/ori");
  expect(findOri(() => null, () => false, "/home/x")).toBeNull();
});

const fetchReturning = (respond: () => Response | Promise<Response>) => (async () => respond()) as unknown as typeof fetch;

test("probeBridge is ready only when the health route says bridge:true", async () => {
  let seen = "";
  const bridgeUp = (async (url: string) => {
    seen = url;
    return Response.json({ ok: true, bridge: true });
  }) as unknown as typeof fetch;
  expect(await probeBridge("http://ori", bridgeUp)).toBe("ready");
  expect(seen).toBe("http://ori/ticket-reply/health");

  expect(await probeBridge("http://ori", fetchReturning(() => Response.json({ ok: true, bridge: false })))).toBe("not-ready");
  expect(await probeBridge("http://ori", fetchReturning(() => new Response("nope", { status: 404 })))).toBe("not-ready");
  expect(await probeBridge("http://ori", fetchReturning(() => new Response("not json")))).toBe("not-ready");
  const refused = fetchReturning(() => {
    throw new TypeError("Unable to connect");
  });
  expect(await probeBridge("http://ori", refused)).toBe("unreachable");
});

test("probeApp is ready on any 2xx", async () => {
  expect(await probeApp("http://app/", fetchReturning(() => new Response("<html>")))).toBe("ready");
  expect(await probeApp("http://app/", fetchReturning(() => new Response("", { status: 500 })))).toBe("not-ready");
});

// A clock that only moves when the poller sleeps, so the timeout is exercised without waiting.
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

test("waitUntilReady polls until the probe reports ready", async () => {
  const results: ProbeResult[] = ["unreachable", "not-ready", "ready"];
  let calls = 0;
  const outcome = await waitUntilReady(async () => results[calls++]!, { ...fakeClock(), timeoutMs: 10_000, intervalMs: 500 });
  expect(outcome).toEqual({ ready: true });
  expect(calls).toBe(3);
});

test("waitUntilReady gives up at the deadline and reports the last probe result", async () => {
  let calls = 0;
  const outcome = await waitUntilReady(
    async () => {
      calls++;
      return "not-ready";
    },
    { ...fakeClock(), timeoutMs: 2_000, intervalMs: 500 },
  );
  expect(outcome).toEqual({ ready: false, last: "not-ready" });
  expect(calls).toBe(5);
});

test("waitUntilReady stops as soon as it is aborted", async () => {
  let calls = 0;
  const outcome = await waitUntilReady(
    async () => {
      calls++;
      return "unreachable";
    },
    { ...fakeClock(), aborted: () => calls >= 2 },
  );
  expect(outcome).toEqual({ ready: false, last: "aborted" });
  expect(calls).toBe(2);
});

test("the ready line names the console URL", () => {
  expect(readyMessage(3000)).toBe("Console ready: http://localhost:3000");
});

test("the Ori timeout message says whether Ori never listened or its bridge never started, and suggests ori login", () => {
  const unreachable = oriTimeoutMessage("unreachable", 60_000);
  expect(unreachable).toContain(`did not start listening on ${config.oriUrl} within 60 s`);
  expect(unreachable).toContain("`ori login`");
  const notReady = oriTimeoutMessage("not-ready", 60_000);
  expect(notReady).toContain("chat bridge did not start within 60 s");
  expect(notReady).toContain("`ori login`");
});

test("port-in-use and unexpected-exit messages name the process and what to change", () => {
  expect(portInUseMessage(4717, "ori")).toMatch(/^Port 4717 \(the Ori runtime, from ORI_URL\) is already in use\./);
  expect(portInUseMessage(3000, "app")).toMatch(/^Port 3000 \(the console, from PORT\) is already in use\./);
  expect(unexpectedExitMessage("ori", 1)).toMatch(/^The Ori runtime exited with code 1; stopping the other process\..*`ori login`/);
  expect(unexpectedExitMessage("app", null)).toBe("The console server was killed; stopping the other process. See the [app] lines above.");
});

test("LinePrefixer prefixes whole lines and holds a partial line until it completes", () => {
  const prefixer = new LinePrefixer("[ori]");
  const bytes = new TextEncoder();
  expect(prefixer.push(bytes.encode("listening on 4717\nbooting fea"))).toBe("[ori] listening on 4717\n");
  expect(prefixer.push("tures\r\n\nready")).toBe("[ori] booting features\n[ori]\n");
  expect(prefixer.flush()).toBe("[ori] ready\n");
  expect(prefixer.flush()).toBe("");
});

test("LinePrefixer drops lines its shouldShow predicate rejects", () => {
  const prefixer = new LinePrefixer("[ori]", (line) => line.includes("keep"));
  expect(prefixer.push("keep this\ndrop this\n")).toBe("[ori] keep this\n");
  expect(prefixer.flush()).toBe("");
});

test("isOriWarningOrError matches warnings, errors, failures, and stack traces", () => {
  expect(isOriWarningOrError("WARN: deprecated flag")).toBe(true);
  expect(isOriWarningOrError("ERROR: could not reach upstream")).toBe(true);
  expect(isOriWarningOrError("error: connection refused")).toBe(true);
  expect(isOriWarningOrError("request failed after 3 retries")).toBe(true);
  expect(isOriWarningOrError("✗ health check")).toBe(true);
  expect(isOriWarningOrError("Uncaught exception in handler")).toBe(true);
  expect(isOriWarningOrError("    at Object.<anonymous> (/app/index.ts:12:5)")).toBe(true);
});

test("isOriWarningOrError leaves ordinary INFO lines out", () => {
  expect(isOriWarningOrError("INFO: listening on port 4717")).toBe(false);
  expect(isOriWarningOrError("booting features")).toBe(false);
  expect(isOriWarningOrError("ready")).toBe(false);
});
