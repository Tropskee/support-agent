import type { Database } from "bun:sqlite";
import type { GeneratedTicket } from "./archetypes";
import { getTicket, insertTicket } from "./db";

/** Inserts tickets whose ids aren't already present. Returns the number inserted. */
export function seedTickets(db: Database, tickets: GeneratedTicket[]): number {
  let inserted = 0;
  for (const t of tickets) {
    if (getTicket(db, t.id)) continue;
    insertTicket(db, { id: t.id, sender_email: t.from, subject: t.subject, body: t.body, labels: t.labels });
    inserted++;
  }
  return inserted;
}

/**
 * Read the generated tickets file.
 *
 * Returns
 * -------
 * GeneratedTicket[] | null
 *     The tickets, or null when the file doesn't exist. Any other failure (unreadable,
 *     malformed JSON) is thrown rather than read as "no tickets".
 */
export async function loadSeedTickets(path: string | URL): Promise<GeneratedTicket[] | null> {
  try {
    return (await Bun.file(path).json()) as GeneratedTicket[];
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}
