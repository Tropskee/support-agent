import { describe, expect, test } from "bun:test";
import { validateDecideBody, validateWriteBody } from "../features/ticket-reply/lib/validate";

describe("validateDecideBody", () => {
  test("accepts a well-formed body", () => {
    const result = validateDecideBody({ system: "s", user: "u", schema: { type: "object" } });
    expect(result).toEqual({ ok: true, value: { system: "s", user: "u", schema: { type: "object" }, model: undefined } });
  });

  test("accepts an explicit model string", () => {
    const result = validateDecideBody({ system: "s", user: "u", schema: {}, model: "anthropic/claude-haiku-4.5" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.model).toBe("anthropic/claude-haiku-4.5");
  });

  test("rejects a non-object body", () => {
    expect(validateDecideBody(null)).toEqual({ ok: false, error: "body must be a JSON object" });
    expect(validateDecideBody("a string")).toEqual({ ok: false, error: "body must be a JSON object" });
    expect(validateDecideBody([1, 2])).toEqual({ ok: false, error: "body must be a JSON object" });
  });

  test("rejects a missing or non-string system", () => {
    expect(validateDecideBody({ user: "u", schema: {} })).toEqual({ ok: false, error: "system must be a string" });
    expect(validateDecideBody({ system: 123, user: "u", schema: {} })).toEqual({ ok: false, error: "system must be a string" });
  });

  test("rejects a missing or non-string user", () => {
    expect(validateDecideBody({ system: "s", schema: {} })).toEqual({ ok: false, error: "user must be a string" });
    expect(validateDecideBody({ system: "s", user: null, schema: {} })).toEqual({ ok: false, error: "user must be a string" });
  });

  test("rejects a missing or non-object schema", () => {
    expect(validateDecideBody({ system: "s", user: "u" })).toEqual({ ok: false, error: "schema must be an object" });
    expect(validateDecideBody({ system: "s", user: "u", schema: "not an object" })).toEqual({ ok: false, error: "schema must be an object" });
    expect(validateDecideBody({ system: "s", user: "u", schema: [1, 2] })).toEqual({ ok: false, error: "schema must be an object" });
  });

  test("rejects a non-string model when present", () => {
    expect(validateDecideBody({ system: "s", user: "u", schema: {}, model: 5 })).toEqual({ ok: false, error: "model must be a string" });
  });
});

describe("validateWriteBody", () => {
  test("accepts a well-formed body", () => {
    expect(validateWriteBody({ system: "s", user: "u" })).toEqual({ ok: true, value: { system: "s", user: "u", model: undefined } });
  });

  test("rejects a non-object body", () => {
    expect(validateWriteBody(undefined)).toEqual({ ok: false, error: "body must be a JSON object" });
  });

  test("rejects a missing or non-string system", () => {
    expect(validateWriteBody({ user: "u" })).toEqual({ ok: false, error: "system must be a string" });
  });

  test("rejects a missing or non-string user", () => {
    expect(validateWriteBody({ system: "s" })).toEqual({ ok: false, error: "user must be a string" });
  });

  test("accepts an explicit model string and drops fields it doesn't know", () => {
    const result = validateWriteBody({ system: "s", user: "u", model: "anthropic/claude-sonnet-5", extra: 200 });
    expect(result).toEqual({ ok: true, value: { system: "s", user: "u", model: "anthropic/claude-sonnet-5" } });
  });

  test("rejects a non-string model when present", () => {
    expect(validateWriteBody({ system: "s", user: "u", model: {} })).toEqual({ ok: false, error: "model must be a string" });
  });
});
