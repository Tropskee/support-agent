import { afterEach, expect, test } from "bun:test";
import { api, chat } from "../features/ticket-reply/feature";
import { TURN_PARAMETERS } from "../features/ticket-reply/lib/decide-prompt";

// A stand-in for Ori's Chat bridge: replays a fixed event list and records what it was sent.
function fakeChat(events: unknown[]) {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    bridge: {
      async *sendMessage(input: Record<string, unknown>) {
        sent.push(input);
        for (const event of events) yield event;
      },
    },
  };
}

const usage = { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0.001 };
const delta = (text: string) => ({ type: "assistant.text.delta", payload: { delta: text } });
const succeeded = { type: "turn.succeeded", model: "anthropic/claude-haiku-4.5", payload: { usage, durationMs: 42 } };

const decideRequest = () =>
  new Request("http://ori/decide", { method: "POST", body: JSON.stringify({ system: "s", user: "u", schema: { type: "object" } }) });
const writeRequest = () => new Request("http://ori/write", { method: "POST", body: JSON.stringify({ system: "s", user: "u" }) });

type Route = (request: Request) => Promise<Response>;
const decide = api.routes["POST /decide"] as Route;
const write = api.routes["POST /write"] as Route;

afterEach(async () => {
  await chat.stop();
});

test("decide and write answer 503 before the bridge is started", async () => {
  expect((await decide(decideRequest())).status).toBe(503);
  expect((await write(writeRequest())).status).toBe(503);
});

test("decide returns the parsed decision and runs the turn with TURN_PARAMETERS", async () => {
  const fake = fakeChat([delta('{"priority":'), delta('"P3"}'), succeeded]);
  await chat.start(fake.bridge as never);
  const res = await decide(decideRequest());
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ parsed: { priority: "P3" }, usage, model: "anthropic/claude-haiku-4.5", latencyMs: 42 });
  expect(fake.sent[0]!.parameters).toEqual(TURN_PARAMETERS);
  expect(TURN_PARAMETERS).toEqual({ reasoning: { effort: "none" }, maxTurns: 1 });
});

test("write returns the text and runs the turn with TURN_PARAMETERS", async () => {
  const fake = fakeChat([delta("Hello."), succeeded]);
  await chat.start(fake.bridge as never);
  const res = await write(writeRequest());
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ text: "Hello.", usage });
  expect(fake.sent[0]!.parameters).toEqual(TURN_PARAMETERS);
});

test("write runs the turn on the body's model when one is given", async () => {
  const fake = fakeChat([delta("yes"), succeeded]);
  await chat.start(fake.bridge as never);
  const body = { system: "Answer only yes or no.", user: "u", model: "anthropic/claude-sonnet-5" };
  const res = await write(new Request("http://ori/write", { method: "POST", body: JSON.stringify(body) }));
  expect(res.status).toBe(200);
  expect(fake.sent[0]).toMatchObject({ model: "anthropic/claude-sonnet-5", systemPrompt: "Answer only yes or no.", parameters: TURN_PARAMETERS });
});

test("a turn that ends without succeeding or failing is a 502, not an empty success", async () => {
  await chat.start(fakeChat([delta("partial")]).bridge as never);
  const decided = await decide(decideRequest());
  expect(decided.status).toBe(502);
  expect(((await decided.json()) as { error: string }).error).toMatch(/without finishing/);
  expect((await write(writeRequest())).status).toBe(502);
});

test("a failed turn is a 502 carrying the failure", async () => {
  await chat.start(fakeChat([{ type: "turn.failed", payload: { failure: { message: "model overloaded" } } }]).bridge as never);
  const res = await decide(decideRequest());
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({ error: "model overloaded" });
});

test("a bridge that throws mid-stream is a 502", async () => {
  await chat.start({
    async *sendMessage() {
      throw new Error("bridge crashed");
    },
  } as never);
  const res = await write(writeRequest());
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "bridge crashed" });
});
