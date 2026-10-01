import { dirname, join } from "node:path";

// Bun loads `KEY=` from a .env file as "" rather than leaving it unset, so every setting
// below treats "" the same as a missing variable and falls through to its default.
const str = (env: Record<string, string | undefined>, name: string, fallback: string): string => env[name] || fallback;
const num = (
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  range: { min?: number; max?: number } = {},
): number => {
  const raw = env[name];
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number, got "${raw}"`);
  if (range.min !== undefined && value < range.min) throw new Error(`${name} must be at least ${range.min}, got ${value}`);
  if (range.max !== undefined && value > range.max) throw new Error(`${name} must be at most ${range.max}, got ${value}`);
  return value;
};

// The eval's fact judge checks single yes/no facts on Haiku. The faithfulness judge reads the
// whole ticket plus every context block and reasons about what counts as a claim, so it uses a
// stronger model. Every model setting is an OpenRouter slug that Ori runs.
export function readEnvConfig(env: Record<string, string | undefined>) {
  const dbPath = str(env, "DB_PATH", "support.db");
  return {
    proseModel: "anthropic/claude-opus-5",
    judgeModel: str(env, "JUDGE_MODEL", "anthropic/claude-haiku-4.5"),
    faithJudgeModel: str(env, "FAITH_JUDGE_MODEL", "anthropic/claude-sonnet-5"),
    oriUrl: str(env, "ORI_URL", "http://127.0.0.1:4717"),
    oriModel: str(env, "ORI_MODEL", "anthropic/claude-haiku-4.5"),
    oriTimeoutMs: num(env, "ORI_TIMEOUT_MS", 90_000, { min: 1 }),
    refundLimitUsd: num(env, "REFUND_LIMIT_USD", 100, { min: 0 }),
    confidenceFloor: num(env, "CONFIDENCE_FLOOR", 0.7, { min: 0, max: 1 }),
    runConcurrency: num(env, "RUN_CONCURRENCY", 4, { min: 1 }),
    port: num(env, "PORT", 3000),
    dbPath,
    evalDbPath: str(env, "EVAL_DB_PATH", join(dirname(dbPath), "eval.db")),
    // Fixture "today": turnaround and lateness are computed against this, so the data never drifts.
    asOf: "2026-09-28",
  };
}

export const config = readEnvConfig(process.env);

