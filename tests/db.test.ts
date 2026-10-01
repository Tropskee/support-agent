import { expect, test } from "bun:test";
import { getTicket, insertTicket, listTickets, openDb, recoverInterruptedTickets, stats } from "../src/db";

test("insert and read back a ticket; stats start at zero", () => {
  const db = openDb(":memory:");
  const t = insertTicket(db, { id: "TKT-0001", sender_email: "a@example.com", subject: "s", body: "b" });
  expect(getTicket(db, "TKT-0001")!.status).toBe("new");
  expect(listTickets(db, "new").map((x) => x.id)).toEqual([t.id]);
  expect(stats(db).attempts).toBe(0);
});

test("recoverInterruptedTickets puts tickets left running back in their prior status", () => {
  const db = openDb(":memory:");
  insertTicket(db, { id: "TKT-001", sender_email: "a@example.com", subject: "s", body: "b" });
  insertTicket(db, { id: "TKT-002", sender_email: "a@example.com", subject: "s", body: "b" });
  db.exec("UPDATE tickets SET status = 'running'");
  db.exec("UPDATE tickets SET current_attempt_id = 7 WHERE id = 'TKT-002'");
  expect(recoverInterruptedTickets(db)).toBe(2);
  expect(getTicket(db, "TKT-001")!.status).toBe("new");
  expect(getTicket(db, "TKT-002")!.status).toBe("escalated");
});

test("stats counts each token once: input + output + cache reads", () => {
  const db = openDb(":memory:");
  insertTicket(db, { id: "TKT-001", sender_email: "a@example.com", subject: "s", body: "b" });
  db.exec(`INSERT INTO attempts (ticket_id, attempt_no, model, prompt_version, context_json, system_prompt, user_prompt,
    guardrail_result, guardrail_reasons_json, input_tokens, output_tokens, cache_read_tokens, started_at, finished_at)
    VALUES ('TKT-001', 1, 'm', 'v', '[]', 's', 'u', 'resolve', '[]', 105, 20, 3, 'x', 'x')`);
  expect(stats(db).totalTokens).toBe(128);
});

test("new ticket ids follow the highest numeric id, at the fixtures' 3-digit width", () => {
  const db = openDb(":memory:");
  expect(insertTicket(db, { sender_email: "a@example.com", subject: "s", body: "b" }).id).toBe("TKT-001");
  insertTicket(db, { id: "TKT-100", sender_email: "a@example.com", subject: "s", body: "b" });
  insertTicket(db, { id: "TKT-e01", sender_email: "a@example.com", subject: "s", body: "b" });
  expect(insertTicket(db, { sender_email: "a@example.com", subject: "s", body: "b" }).id).toBe("TKT-101");
  // a gap (a deleted or skipped id) can't make the next id collide with an existing one
  insertTicket(db, { id: "TKT-999", sender_email: "a@example.com", subject: "s", body: "b" });
  expect(insertTicket(db, { sender_email: "a@example.com", subject: "s", body: "b" }).id).toBe("TKT-1000");
});
