import { expect, test } from "bun:test";
import { readEnvConfig } from "../src/config";

// Bun loads KEY= from a .env file as "" (not unset), so a `??` fallback would keep "" instead
// of the default. readEnvConfig builds the config from a plain env object, so these tests
// don't mutate the real process.env (which would leak into other tests).

test("empty string env values fall back to defaults", () => {
  const cfg = readEnvConfig({
    ORI_URL: "",
    ORI_MODEL: "",
    ORI_TIMEOUT_MS: "",
    JUDGE_MODEL: "",
    FAITH_JUDGE_MODEL: "",
    DB_PATH: "",
    EVAL_DB_PATH: "",
    REFUND_LIMIT_USD: "",
    CONFIDENCE_FLOOR: "",
    RUN_CONCURRENCY: "",
    PORT: "",
  });
  expect(cfg.oriUrl).toBe("http://127.0.0.1:4717");
  expect(cfg.oriModel).toBe("anthropic/claude-haiku-4.5");
  expect(cfg.oriTimeoutMs).toBe(90_000);
  expect(cfg.judgeModel).toBe("anthropic/claude-haiku-4.5");
  expect(cfg.faithJudgeModel).toBe("anthropic/claude-sonnet-5");
  expect(cfg.dbPath).toBe("support.db");
  expect(cfg.evalDbPath).toBe("eval.db");
  expect(cfg.refundLimitUsd).toBe(100);
  expect(cfg.confidenceFloor).toBe(0.7);
  expect(cfg.runConcurrency).toBe(4);
  expect(cfg.port).toBe(3000);
});

test("unset env values fall back to the same defaults", () => {
  const cfg = readEnvConfig({});
  expect(cfg.oriModel).toBe("anthropic/claude-haiku-4.5");
  expect(cfg.judgeModel).toBe("anthropic/claude-haiku-4.5");
  expect(cfg.faithJudgeModel).toBe("anthropic/claude-sonnet-5");
  expect(cfg.refundLimitUsd).toBe(100);
  expect(cfg.evalDbPath).toBe("eval.db");
});

test("non-empty env values are respected", () => {
  const cfg = readEnvConfig({ ORI_MODEL: "openai/gpt-test", REFUND_LIMIT_USD: "250", DB_PATH: "custom.db" });
  expect(cfg.oriModel).toBe("openai/gpt-test");
  expect(cfg.refundLimitUsd).toBe(250);
  expect(cfg.dbPath).toBe("custom.db");
  expect(cfg.evalDbPath).toBe("eval.db");
});

test("explicit judge models win over the defaults", () => {
  const cfg = readEnvConfig({ JUDGE_MODEL: "judge-x", FAITH_JUDGE_MODEL: "faith-y" });
  expect(cfg).toMatchObject({ judgeModel: "judge-x", faithJudgeModel: "faith-y" });
});

test("the prose model is an OpenRouter slug", () => {
  expect(readEnvConfig({}).proseModel).toBe("anthropic/claude-opus-5");
});

test("ori timeout defaults to 90s and is configurable", () => {
  expect(readEnvConfig({}).oriTimeoutMs).toBe(90_000);
  expect(readEnvConfig({ ORI_TIMEOUT_MS: "5000" }).oriTimeoutMs).toBe(5000);
});

test("a non-numeric number setting is refused at startup", () => {
  expect(() => readEnvConfig({ REFUND_LIMIT_USD: "abc" })).toThrow(/REFUND_LIMIT_USD/);
  expect(() => readEnvConfig({ PORT: "Infinity" })).toThrow(/PORT/);
  expect(() => readEnvConfig({ ORI_TIMEOUT_MS: "NaN" })).toThrow(/ORI_TIMEOUT_MS/);
});

test("out-of-range settings are refused", () => {
  expect(() => readEnvConfig({ CONFIDENCE_FLOOR: "1.5" })).toThrow(/CONFIDENCE_FLOOR/);
  expect(() => readEnvConfig({ CONFIDENCE_FLOOR: "-0.1" })).toThrow(/CONFIDENCE_FLOOR/);
  expect(() => readEnvConfig({ REFUND_LIMIT_USD: "-1" })).toThrow(/REFUND_LIMIT_USD/);
  expect(() => readEnvConfig({ RUN_CONCURRENCY: "0" })).toThrow(/RUN_CONCURRENCY/);
  expect(() => readEnvConfig({ ORI_TIMEOUT_MS: "0" })).toThrow(/ORI_TIMEOUT_MS/);
});

test("boundary values are accepted", () => {
  const cfg = readEnvConfig({ CONFIDENCE_FLOOR: "0", REFUND_LIMIT_USD: "0", RUN_CONCURRENCY: "1", ORI_TIMEOUT_MS: "1" });
  expect(cfg.confidenceFloor).toBe(0);
  expect(cfg.refundLimitUsd).toBe(0);
  expect(cfg.runConcurrency).toBe(1);
  expect(cfg.oriTimeoutMs).toBe(1);
  expect(readEnvConfig({ CONFIDENCE_FLOOR: "1" }).confidenceFloor).toBe(1);
});
