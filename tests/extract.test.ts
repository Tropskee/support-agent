import { expect, test } from "bun:test";
import { safeIdent } from "../scripts/extract_data";

test("accepts plain identifiers", () => {
  expect(safeIdent("sales", "SRC_SALES_TABLE")).toBe("sales");
});

test("rejects anything that could inject SQL", () => {
  expect(() => safeIdent("sales; drop table x", "SRC_SALES_TABLE")).toThrow();
  expect(() => safeIdent("", "SRC_SALES_TABLE")).toThrow();
});
