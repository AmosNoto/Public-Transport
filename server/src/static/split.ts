// Splitting a national timetable into metro regions. A whole-country feed is too big to index
// as one place, but each of its cities is not: find where its stops cluster (a 10 km grid,
// densest cells first), and make each cluster a region with a bounding box. Each region is then
// built like any place, from the same downloaded zip, keeping only the routes that run through
// its box (the FeedFilter bbox already used for Amsterdam).

import { fetchCached, staticZipPath } from './gtfs.ts';
import { zipCsv } from './csv.ts';
import type { CityDef } from '../types.ts';

export interface Region {
  bbox: [number, number, number, number];
  center: { lon: number; lat: number };
  stops: number;
}

/** Grid cell size (km). */
const CELL_KM = 10;
/** A cell needs this many stops to start a region (a town centre, not a village). */
const SEED_STOPS = 80;
/** Cells this far from a seed (km), with a few stops each, join its region... */
const JOIN_KM = 40;
const JOIN_STOPS = 4;
/** ...and nothing else may start a region this close to it. */
const CLAIM_KM = 55;
/** A region needs this many stops in all, and there are at most this many per feed. */
const REGION_STOPS = 250;
const MAX_REGIONS = 14;

const overlaps = (a: [number, number, number, number], b: [number, number, number, number]) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/**
 * Download (shared zip) and cluster a feed's stops into regions, skipping any that overlap
 * `exclude` (areas curated cities already cover). Runs in the build worker.
 */
export async function splitRegions(city: CityDef, maxBytes: number, exclude: [number, number, number, number][]): Promise<{ regions: Region[]; bytes: number }> {
  const lat: number[] = [], lon: number[] = [];
  let bytes = 0;
  for (const feed of city.feeds) {
    const file = staticZipPath(feed.zipKey ?? city.id, feed.id);
    // The publisher's own copy first (the catalog mirror can lag by months), then the mirror.
    const first = feed.staticAlt ?? feed.static, second = feed.staticAlt ? feed.static : undefined;
    let buf: Buffer;
    try {
      buf = await fetchCached(first, file, 24 * 3600, feed.staticHeaders, maxBytes);
    } catch (e) {
      if (!second) throw e;
      buf = await fetchCached(second, file, 24 * 3600, feed.staticHeaders, maxBytes);
    }
    bytes += buf.byteLength;
    let iLat = -1, iLon = -1, iType = -1;
    zipCsv(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), 'stops.txt', (col) => { iLat = col('stop_lat'); iLon = col('stop_lon'); iType = col('location_type'); }, (f) => {
      if (iType >= 0 && f[iType] && f[iType] !== '0') return; // stations and entrances: count the stops themselves
      const la = Number(f[iLat]), lo = Number(f[iLon]);
      if (Number.isFinite(la) && Number.isFinite(lo) && (la || lo)) { lat.push(la); lon.push(lo); }
    });
  }
  if (!lat.length) throw new Error('timetable has no stops');

  // Count stops per ~10 km cell (longitude scaled at the median latitude).
  const lat0 = [...lat].sort((a, b) => a - b)[lat.length >> 1];
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180), ky = 110.57;
  const cells = new Map<string, { x: number; y: number; n: number }>();
  for (let i = 0; i < lat.length; i++) {
    const x = Math.floor((lon[i] * kx) / CELL_KM), y = Math.floor((lat[i] * ky) / CELL_KM);
    const k = `${x},${y}`;
    const c = cells.get(k);
    if (c) c.n++; else cells.set(k, { x, y, n: 1 });
  }
  const boxOf = (c: { x: number; y: number }): [number, number, number, number] =>
    [(c.x * CELL_KM) / kx, (c.y * CELL_KM) / ky, ((c.x + 1) * CELL_KM) / kx, ((c.y + 1) * CELL_KM) / ky];
  const all = [...cells.values()].filter((c) => !exclude.some((b) => overlaps(boxOf(c), b)));
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) * CELL_KM;

  const claimed = new Set<{ x: number; y: number; n: number }>();
  const regions: Region[] = [];
  for (const seed of [...all].sort((a, b) => b.n - a.n)) {
    if (seed.n < SEED_STOPS || regions.length >= MAX_REGIONS) break;
    if (claimed.has(seed)) continue;
    const members = all.filter((c) => !claimed.has(c) && c.n >= JOIN_STOPS && dist(c, seed) <= JOIN_KM);
    for (const c of all) if (dist(c, seed) <= CLAIM_KM) claimed.add(c);
    const n = members.reduce((s, c) => s + c.n, 0);
    if (n < REGION_STOPS) continue;
    let w = Infinity, s = Infinity, e = -Infinity, nn = -Infinity;
    for (const c of members) { const b = boxOf(c); w = Math.min(w, b[0]); s = Math.min(s, b[1]); e = Math.max(e, b[2]); nn = Math.max(nn, b[3]); }
    const sb = boxOf(seed);
    regions.push({
      bbox: [+w.toFixed(4), +s.toFixed(4), +e.toFixed(4), +nn.toFixed(4)],
      center: { lon: +((sb[0] + sb[2]) / 2).toFixed(4), lat: +((sb[1] + sb[3]) / 2).toFixed(4) }, stops: n,
    });
  }
  return { regions, bytes };
}
