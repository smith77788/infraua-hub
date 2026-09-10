/**
 * Hand-rolled RFC4180-ish CSV parser - no dependency, matching the
 * repo's existing convention (see docs/analyst-architecture.md's
 * rationale for hand-rolled TF-IDF and regex extraction over pulling
 * in a library for something this ingestion stack can own outright).
 * Supports quoted fields, embedded commas/newlines inside quotes, and
 * doubled-quote escaping ("" -> "). Never throws - malformed input
 * just produces whatever rows it can, the same tolerance principle as
 * EntityExtractor's regexes.
 */

function tokenizeRows(input: string): string[][] {
  const text = input.replace(/\r\n/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += char;
    i++;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);

  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export function parseCsv(input: string): Record<string, string>[] {
  const rows = tokenizeRows(input);
  if (rows.length < 2) return [];
  const [header, ...dataRows] = rows;
  return dataRows.map((row) => {
    const record: Record<string, string> = {};
    header.forEach((col, i) => {
      record[col] = row[i] ?? '';
    });
    return record;
  });
}
