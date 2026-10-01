// One-time extract from my card database into data/. Not needed to run the project.
// Read-only by construction: every query runs in a READ ONLY transaction, and the
// script refuses to continue unless Postgres confirms that. Only aggregates are written.
import { SQL } from "bun";
import { toCsv } from "../src/csv";

const CARD_LIMIT = 150;
const MIN_SALES = 5;

export function safeIdent(value: string | undefined, envName: string): string {
  if (!value || !/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`${envName} must be a plain lowercase table name`);
  }
  return value;
}

async function main() {
  const url = process.env.SOURCE_DATABASE_URL;
  if (!url) throw new Error("SOURCE_DATABASE_URL is not set");
  const cards = safeIdent(process.env.SRC_CARDS_TABLE, "SRC_CARDS_TABLE");
  const sales = safeIdent(process.env.SRC_SALES_TABLE, "SRC_SALES_TABLE");
  const positions = safeIdent(process.env.SRC_POSITIONS_TABLE, "SRC_POSITIONS_TABLE");
  const items = safeIdent(process.env.SRC_ITEMS_TABLE, "SRC_ITEMS_TABLE");

  const sql = new SQL(url);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET TRANSACTION READ ONLY");
      const [{ transaction_read_only }] = await tx.unsafe("SHOW transaction_read_only");
      if (transaction_read_only !== "on") throw new Error("refusing to run: transaction is not read-only");

      const cardKey = `lower(c.set_name) || '|' || c.number || '|' || lower(c.name)`;
      const usable = `s.excluded_reason IS NULL AND s.sold_on >= (SELECT max(sold_on) FROM ${sales}) - 365`;

      const cardRows = await tx.unsafe(`
        SELECT c.id AS card_id, c.name, c.set_name, c.number, c.rarity,
               extract(year FROM c.release_date)::int AS year, count(*)::int AS sale_count
        FROM ${cards} c JOIN ${sales} s ON s.card_key = ${cardKey}
        WHERE ${usable} AND s.grader = 'PSA'
        GROUP BY 1,2,3,4,5,6
        ORDER BY sale_count DESC
        LIMIT ${CARD_LIMIT}`);

      const ids = cardRows.map((r: { card_id: string }) => r.card_id);
      const idList = ids.map((id: string) => "'" + id.replaceAll("'", "''") + "'").join(",");
      const valueRows = await tx.unsafe(`
        SELECT c.id AS card_id, s.variant, s.grader, s.grade, count(*)::int AS sale_count,
               round(percentile_cont(0.25) WITHIN GROUP (ORDER BY s.price)::numeric, 2) AS p25,
               round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY s.price)::numeric, 2) AS median,
               round(percentile_cont(0.75) WITHIN GROUP (ORDER BY s.price)::numeric, 2) AS p75
        FROM ${cards} c JOIN ${sales} s ON s.card_key = ${cardKey}
        WHERE ${usable} AND c.id IN (${idList}) AND s.grader = 'PSA'
        GROUP BY 1,2,3,4
        HAVING count(*) >= ${MIN_SALES}
        ORDER BY 1,2,3,4`);

      const severityRows = await tx.unsafe(`
        WITH graded AS (
          SELECT p.cert, p.kind, p.fray, p.fill, p.wear, floor(i.grade)::int AS grade
          FROM ${positions} p JOIN ${items} i ON i.cert_number = p.cert
          WHERE i.grade IS NOT NULL
        ), long AS (
          SELECT grade, kind, cert, 'fray' AS metric, fray::float AS v FROM graded
          UNION ALL SELECT grade, kind, cert, 'fill', fill::float FROM graded
          UNION ALL SELECT grade, kind, cert, 'wear', wear::float FROM graded WHERE wear IS NOT NULL
        )
        SELECT grade, kind, metric,
               round(percentile_cont(0.1) WITHIN GROUP (ORDER BY v)::numeric) AS p10,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY v)::numeric) AS p50,
               round(percentile_cont(0.9) WITHIN GROUP (ORDER BY v)::numeric) AS p90,
               count(DISTINCT cert)::int AS cert_count
        FROM long GROUP BY 1,2,3 ORDER BY 1,2,3`);

      await Bun.write("data/cards.csv", toCsv(cardRows));
      await Bun.write("data/card_values.csv", toCsv(valueRows));
      await Bun.write("data/grade_severity.csv", toCsv(severityRows));
      console.log(`cards ${cardRows.length}, values ${valueRows.length}, severity ${severityRows.length}`);
    });
  } finally {
    await sql.close();
  }
}

if (import.meta.main) await main();
