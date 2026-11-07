// Small, fast RFC-4180 CSV reader for GTFS text files.

export type Row = Record<string, string>;

/** Iterate rows of a CSV document as objects keyed by header. Handles BOM, quotes and CRLF. */
export function* readCsv(text: string): Generator<Row> {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  let header: string[] | null = null;

  const readRow = (): string[] | null => {
    if (i >= n) return null;
    const out: string[] = [];
    let field = '';
    for (;;) {
      if (i >= n) { out.push(field); return out; }
      let c = text.charCodeAt(i);
      if (c === 34 /* " */) {
        i++;
        for (;;) {
          const j = text.indexOf('"', i);
          if (j < 0) { field += text.slice(i); i = n; break; }
          field += text.slice(i, j);
          i = j + 1;
          if (text.charCodeAt(i) === 34) { field += '"'; i++; } else break;
        }
        c = text.charCodeAt(i);
      }
      // Unquoted run up to the next delimiter.
      let j = i;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === 44 || d === 10 || d === 13) break;
        j++;
      }
      field += text.slice(i, j);
      i = j;
      c = text.charCodeAt(i);
      if (c === 44) { out.push(field); field = ''; i++; continue; }
      out.push(field);
      if (c === 13) i++;
      if (text.charCodeAt(i) === 10) i++;
      return out;
    }
  };

  for (;;) {
    const r = readRow();
    if (!r) return;
    if (!header) { header = r.map((h) => h.trim()); continue; }
    if (r.length === 1 && r[0] === '') continue;
    const o: Row = {};
    for (let k = 0; k < header.length; k++) o[header[k]] = r[k] ?? '';
    yield o;
  }
}
