import { expect, test } from "bun:test";
import { parseCsv, toCsv } from "../src/csv";

test("round trips quotes, commas and nulls", () => {
  const rows = [{ name: 'Erika\'s "Clefable", holo', n: 3, v: null }];
  const back = parseCsv(toCsv(rows));
  expect(back).toEqual([{ name: 'Erika\'s "Clefable", holo', n: "3", v: "" }]);
});
