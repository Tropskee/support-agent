import { describe, expect, test } from "bun:test";
import { collectTurn, parseJsonObject } from "../features/ticket-reply/lib/turn";

// Synthetic AgentRuntimeEvent-shaped objects matching the shapes documented for
// Chat.sendMessage(): each carries `.type` and `.payload`.
function delta(text: string) {
  return { type: "assistant.text.delta", payload: { delta: text } } as any;
}
function succeeded(usage: Record<string, unknown> | undefined, durationMs: number, model?: string) {
  return { type: "turn.succeeded", model, payload: { usage, durationMs } } as any;
}
function failed(message: string) {
  return { type: "turn.failed", payload: { failure: { message } } } as any;
}
function sessionFailed(message: string) {
  return { type: "session.failed", payload: { failure: { message } } } as any;
}
function reasoning(text: string) {
  return { type: "reasoning.delta", payload: { delta: text } } as any;
}

describe("collectTurn", () => {
  test("concatenates assistant text deltas and reads usage/duration/model off turn.succeeded", () => {
    const usage = { inputTokens: 120, outputTokens: 40, cacheCreationTokens: 0, cacheReadTokens: 10, costUsd: 0.002 };
    const result = collectTurn([delta("Hello, "), delta("world."), succeeded(usage, 842, "anthropic/claude-haiku-4.5")]);

    expect(result.text).toBe("Hello, world.");
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 40, cacheCreationTokens: 0, cacheReadTokens: 10, costUsd: 0.002 });
    expect(result.durationMs).toBe(842);
    expect(result.model).toBe("anthropic/claude-haiku-4.5");
    expect(result.failure).toBeNull();
  });

  test("returns a null model when turn.succeeded carries none", () => {
    const result = collectTurn([delta("x"), succeeded({ inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }, 5)]);
    expect(result.model).toBeNull();
  });

  test("ignores reasoning deltas", () => {
    const result = collectTurn([reasoning("thinking..."), delta("answer"), succeeded({ inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }, 5)]);
    expect(result.text).toBe("answer");
  });

  test("defaults costUsd to null when usage omits it", () => {
    const result = collectTurn([delta("x"), succeeded({ inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }, 5)]);
    expect(result.usage?.costUsd).toBeNull();
  });

  test("returns null usage/durationMs/model when the turn never succeeds", () => {
    const result = collectTurn([delta("partial")]);
    expect(result.usage).toBeNull();
    expect(result.durationMs).toBeNull();
    expect(result.model).toBeNull();
    expect(result.failure).toBeNull();
  });

  test("captures a turn.failed failure", () => {
    const result = collectTurn([delta("oops"), failed("model overloaded")]);
    expect(result.failure).toEqual({ message: "model overloaded" });
  });

  test("captures a session.failed failure", () => {
    const result = collectTurn([sessionFailed("session died")]);
    expect(result.failure).toEqual({ message: "session died" });
  });
});

describe("parseJsonObject", () => {
  test("parses a plain JSON object", () => {
    expect(parseJsonObject('{"priority":"P1","escalate":false}')).toEqual({ priority: "P1", escalate: false });
  });

  test("strips a ```json fenced block", () => {
    const text = '```json\n{"a": 1}\n```';
    expect(parseJsonObject(text)).toEqual({ a: 1 });
  });

  test("strips a plain ``` fenced block", () => {
    const text = "```\n{\"a\": 1}\n```";
    expect(parseJsonObject(text)).toEqual({ a: 1 });
  });

  test("extracts the outermost object when there's surrounding prose", () => {
    const text = 'Sure, here you go:\n{"a": {"b": 1}}\nLet me know if that helps.';
    expect(parseJsonObject(text)).toEqual({ a: { b: 1 } });
  });

  test("returns null for non-JSON text", () => {
    expect(parseJsonObject("not json at all")).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(parseJsonObject('{"a": 1,}')).toBeNull();
  });

  test("returns null for a JSON array, not an object", () => {
    expect(parseJsonObject("[1, 2, 3]")).toBeNull();
  });
});

describe("collectTurn.succeeded", () => {
  test("is true only when a turn.succeeded event arrived", () => {
    expect(collectTurn([delta("x"), succeeded(undefined, 5)]).succeeded).toBe(true);
    expect(collectTurn([delta("partial")]).succeeded).toBe(false);
    expect(collectTurn([failed("boom")]).succeeded).toBe(false);
  });
});
