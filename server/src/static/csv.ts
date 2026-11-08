// CSV readers for GTFS. Small files can be read whole (`readCsv`); everything else streams
// straight out of the zip (`zipCsv`), so even a gigabyte of stop_times never becomes one string.

import path from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';

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

/** Split one CSV line (GTFS fields never contain newlines in practice; quotes are handled). */
export function splitLine(line: string): string[] {
  if (line.indexOf('"') < 0) return line.split(',');
  const out: string[] = [];
  let f = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(f); f = ''; }
    else f += c;
  }
  out.push(f);
  return out;
}

/** Column lookup for a streamed file: `col('shape_id')` gives the field index, or -1. */
export type Columns = (name: string) => number;

/**
 * Stream every line of one file in a zip, as fields, to `onLine` (header line included).
 * Returns false if the file isn't in the zip.
 */
function zipLines(zip: Uint8Array, name: string, onLine: (f: string[]) => void): boolean {
  const uz = new Unzip();
  uz.register(UnzipInflate);
  let found = false;
  uz.onfile = (file) => {
    if (path.basename(file.name) !== name || found) return;
    found = true;
    const dec = new TextDecoder();
    let carry = '';
    const lines = (text: string) => {
      const parts = (carry + text).split('\n');
      carry = parts.pop() ?? '';
      for (let line of parts) {
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line) onLine(splitLine(line));
      }
    };
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      lines(dec.decode(chunk, { stream: !final }));
      if (final && carry) { const c = carry; carry = ''; lines(c + '\n'); }
    };
    file.start();
  };
  uz.push(zip, true);
  return found;
}

/**
 * Stream one CSV file out of a zip. `onHeader` receives a column lookup; `onRow` receives the
 * raw fields of each data line. Returns false if the file isn't in the zip.
 */
export function zipCsv(zip: Uint8Array, name: string, onHeader: (col: Columns) => void, onRow: (f: string[]) => void): boolean {
  let header = true;
  return zipLines(zip, name, (f) => {
    if (header) {
      const h = f.map((x) => x.replace(/^\uFEFF/, '').trim());
      onHeader((n) => h.indexOf(n));
      header = false;
    } else onRow(f);
  });
}

/** Read a small file from a zip as row objects (calendar, routes, agency…). */
export function zipRows(zip: Uint8Array, name: string): Row[] {
  const rows: Row[] = [];
  let header: string[] | null = null;
  zipLines(zip, name, (f) => {
    if (!header) { header = f.map((x) => x.replace(/^\uFEFF/, '').trim()); return; }
    const o: Row = {};
    for (let k = 0; k < header.length; k++) o[header[k]] = f[k] ?? '';
    rows.push(o);
  });
  return rows;
}
