const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

export function toCsv(rows: Record<string, string | number | null>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]!);
  const lines = rows.map((r) => cols.map((c) => quote(r[c] == null ? "" : String(r[c]))).join(","));
  return [cols.join(","), ...lines].join("\n") + "\n";
}

export function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let field = "", row: string[] = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); records.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); records.push(row); }
  const [header, ...body] = records;
  return body.map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i] ?? ""])));
}
