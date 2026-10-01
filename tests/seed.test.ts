import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadSeedTickets } from "../src/seed";

test("a missing tickets file seeds nothing; a broken one is an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sa-seed-"));
  try {
    expect(await loadSeedTickets(join(dir, "missing.json"))).toBeNull();
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{not json");
    await expect(loadSeedTickets(broken)).rejects.toThrow();
    const ok = join(dir, "tickets.json");
    writeFileSync(ok, "[]");
    expect(await loadSeedTickets(ok)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
