import { afterEach, beforeEach, expect, test } from "bun:test";
import { config } from "../src/config";
import { MODEL_UNAVAILABLE_MESSAGE, ModelUnavailableError, oriBackend } from "../src/model";

const originalFetch = global.fetch;

function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  global.fetch = ((url: string, init: RequestInit) => impl(url, init)) as unknown as typeof fetch;
}

beforeEach(() => {
  mockFetch(() => {
    throw new Error("fetch not mocked for this test");
  });
});

afterEach(() => {
  global.fetch = originalFetch;
});

test("decide maps a successful response's usage and hits /decide with the ori model", async () => {
  let seenUrl = "";
  let seenBody: any = null;
  mockFetch((url, init) => {
    seenUrl = url;
    seenBody = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({
        raw: '{"priority":"P1"}',
        parsed: { priority: "P1" },
        usage: { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 5, cacheReadTokens: 3, costUsd: 0.001 },
        model: config.oriModel,
        latencyMs: 412,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const result = await oriBackend().decide({ system: "s", user: "u", schema: { type: "object" } });

  expect(seenUrl).toBe(`${config.oriUrl}/decide`);
  expect(seenBody).toEqual({ system: "s", user: "u", schema: { type: "object" }, model: config.oriModel });
  expect(result.parsed).toEqual({ priority: "P1" });
  expect(result.model).toBe(config.oriModel);
  expect(result.latencyMs).toBe(412);
  // inputTokens = uncached input + cache writes; cache reads are counted once, in cacheReadTokens.
  expect(result.usage).toEqual({ inputTokens: 105, outputTokens: 20, cacheReadTokens: 3, costUsd: 0.001 });
});

test("decide passes through a null parsed result when the reply wasn't valid JSON", async () => {
  mockFetch(() =>
    new Response(
      JSON.stringify({ raw: "not json", parsed: null, usage: null, model: config.oriModel, latencyMs: 9 }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

  const result = await oriBackend().decide({ system: "s", user: "u", schema: {} });

  expect(result.parsed).toBeNull();
  expect(result.raw).toBe("not json");
  expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: null });
});

test("a 503 from /decide (chat bridge not started) is ModelUnavailableError", async () => {
  mockFetch(() => new Response("bridge not started", { status: 503 }));

  const err = await oriBackend().decide({ system: "s", user: "u", schema: {} }).catch((e) => e);
  expect(err).toBeInstanceOf(ModelUnavailableError);
  expect(err.message).toBe(MODEL_UNAVAILABLE_MESSAGE);
});

test("a refused connection is ModelUnavailableError", async () => {
  mockFetch(() => {
    throw Object.assign(new TypeError("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
  });

  await expect(oriBackend().decide({ system: "s", user: "u", schema: {} })).rejects.toBeInstanceOf(ModelUnavailableError);
  await expect(oriBackend().write({ system: "s", user: "u", model: "x" })).rejects.toBeInstanceOf(ModelUnavailableError);
});

test("a timeout and other non-2xx responses are ordinary errors, not an outage", async () => {
  mockFetch(() => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  });
  const timeout = await oriBackend().decide({ system: "s", user: "u", schema: {} }).catch((e) => e);
  expect(timeout).not.toBeInstanceOf(ModelUnavailableError);

  mockFetch(() => new Response("upstream failed", { status: 502 }));
  const badGateway = await oriBackend().decide({ system: "s", user: "u", schema: {} }).catch((e) => e);
  expect(badGateway).not.toBeInstanceOf(ModelUnavailableError);
  expect(badGateway.message).toMatch(/502/);
});

test("ensureAvailable passes only when the health route reports a started bridge", async () => {
  let seenUrl = "";
  mockFetch((url) => {
    seenUrl = url;
    return Response.json({ ok: true, bridge: true });
  });
  await oriBackend().ensureAvailable!();
  expect(seenUrl).toBe(`${config.oriUrl}/ticket-reply/health`);

  mockFetch(() => Response.json({ ok: true, bridge: false }));
  await expect(oriBackend().ensureAvailable!()).rejects.toBeInstanceOf(ModelUnavailableError);

  mockFetch(() => {
    throw new TypeError("Unable to connect");
  });
  await expect(oriBackend().ensureAvailable!()).rejects.toBeInstanceOf(ModelUnavailableError);
});

test("write maps usage and hits /write with the request's model", async () => {
  let seenUrl = "";
  let seenBody: any = null;
  mockFetch((url, init) => {
    seenUrl = url;
    seenBody = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({
        text: "Here's an update on your order.",
        usage: { inputTokens: 50, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: null },
        model: config.oriModel,
        latencyMs: 120,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const result = await oriBackend().write({ system: "s", user: "u", model: "anthropic/claude-sonnet-5" });

  expect(seenUrl).toBe(`${config.oriUrl}/write`);
  expect(seenBody).toEqual({ system: "s", user: "u", model: "anthropic/claude-sonnet-5" });
  expect(result.text).toBe("Here's an update on your order.");
  expect(result.usage.costUsd).toBeNull();
});

test("write throws on a non-2xx response", async () => {
  mockFetch(() => new Response("boom", { status: 500 }));

  await expect(oriBackend().write({ system: "s", user: "u", model: "x" })).rejects.toThrow(/500/);
});

test("decide and write both pass an abort signal so a hung Ori turn can't hang the request forever", async () => {
  let seenSignal: AbortSignal | undefined;
  mockFetch((_url, init) => {
    seenSignal = init.signal as AbortSignal;
    return new Response(
      JSON.stringify({ raw: "{}", parsed: {}, usage: null, model: config.oriModel, latencyMs: 1 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  await oriBackend().decide({ system: "s", user: "u", schema: {} });
  expect(seenSignal).toBeInstanceOf(AbortSignal);
  expect(seenSignal!.aborted).toBe(false);

  seenSignal = undefined;
  mockFetch((_url, init) => {
    seenSignal = init.signal as AbortSignal;
    return new Response(
      JSON.stringify({ text: "hi", usage: null, model: config.oriModel, latencyMs: 1 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  await oriBackend().write({ system: "s", user: "u", model: "x" });
  expect(seenSignal).toBeInstanceOf(AbortSignal);
});

test("decide runs the model the backend was built with", async () => {
  let seenBody: any = null;
  mockFetch((_url, init) => {
    seenBody = JSON.parse(init.body as string);
    return Response.json({ raw: "{}", parsed: {}, usage: null, model: "openai/gpt-test", latencyMs: 1 });
  });
  await oriBackend("openai/gpt-test").decide({ system: "s", user: "u", schema: {} });
  expect(seenBody.model).toBe("openai/gpt-test");
});

test("write falls back to the bound model when the request's model is empty; decide always uses it", async () => {
  const models: unknown[] = [];
  mockFetch((url, init) => {
    models.push(JSON.parse(init.body as string).model);
    const payload = url.endsWith("/write")
      ? { text: "ok", usage: null, model: "m", latencyMs: 1 }
      : { raw: "{}", parsed: {}, usage: null, model: "m", latencyMs: 1 };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  });

  const backend = oriBackend("bound/model");
  await backend.write({ system: "s", user: "u", model: "" });
  await backend.decide({ system: "s", user: "u", schema: {} });

  expect(models).toEqual(["bound/model", "bound/model"]);
});

test("under the test preload an unmocked call is refused at once, without reaching a runtime", async () => {
  global.fetch = originalFetch;
  expect(config.oriUrl).toBe("http://127.0.0.1:9");

  const started = performance.now();
  await expect(oriBackend().decide({ system: "s", user: "u", schema: {} })).rejects.toBeInstanceOf(ModelUnavailableError);
  await expect(oriBackend().write({ system: "s", user: "u", model: "x" })).rejects.toBeInstanceOf(ModelUnavailableError);
  await expect(oriBackend().ensureAvailable!()).rejects.toBeInstanceOf(ModelUnavailableError);
  expect(performance.now() - started).toBeLessThan(2_000);
});
