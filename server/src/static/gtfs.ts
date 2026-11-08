// Download and preprocess GTFS static into what the renderer and the live snapper need.
// Everything streams out of the zip, so national feeds (hundreds of MB of shapes) never sit in
// memory as text. Results are cached on disk, keyed by the feed files, so restarts are instant.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { zipCsv, zipRows } from './csv.ts';
import { config } from '../config.ts';
import { makePolyline, simplifyIdx, toRel, type Polyline, EARTH_R } from '../geo.ts';
import { hexToRgb, rgbToOklch, isNeutral, asLight, asInk, spectralPositions, spectralHue, vivid, type LCH } from '../color.ts';
import type { CityDef, FeedDef, Mode, RouteInfo, ShapeInfo } from '../types.ts';

/** Bump when the build output changes, to invalidate disk caches. */
const BUILD_VERSION = 4;

/** Everything the live side needs to snap vehicles, plus the buffers sent to clients. */
export interface CityIndex {
  def: CityDef;
  routes: RouteInfo[];
  shapes: ShapeInfo[];
  polylines: Polyline[];
  routeIdx: Map<string, number>; // `${feed}:${route_id}`
  tripShape: Map<string, number>; // `${feed}:${trip_id}` → shape index
  tripRoute: Map<string, number>;
  /** Shapes for each `${feed}:${route}:${dir}`, most used first. */
  dirShapes: Map<string, number[]>;
  bbox: [number, number, number, number];
  /** (mx, my, cum, 0) per shape vertex, relative to origin. */
  points: Float32Array;
  /** Deduplicated route network as polylines: (x, y) per vertex, relative to origin. */
  lineVerts: Float32Array;
  /** Per chain: start vertex, vertex count, route index. */
  lineChains: Uint32Array;
  /** City glow for the globe: (x, y, r, g, b) per sample point along the network. */
  glow: Float32Array;
}

export function modeOf(routeType: number): Mode {
  const t = routeType;
  if (t === 1 || t === 12 || (t >= 400 && t < 500)) return 'subway';
  if (t === 2 || (t >= 100 && t < 200)) return 'rail';
  if (t === 3 || t === 11 || (t >= 200 && t < 300) || (t >= 700 && t < 900)) return 'bus';
  return 'tram'; // 0 tram/light rail, 4 ferry, 5 cable tram, 6 aerial, 7 funicular, 900+, 1000+, 1300+, 1400+
}

/** Brightness by mode on the globe: rapid transit reads strongest. */
const GLOW_WEIGHT: Record<Mode, number> = { subway: 1, tram: 0.85, rail: 0.8, bus: 0.45 };

/**
 * Fetch a URL through a disk cache. A fresh copy is used as-is; a stale one is revalidated
 * with If-Modified-Since, and kept if the network fails.
 */
export async function fetchCached(url: string, file: string, maxAgeS: number, headers: Record<string, string> = {}): Promise<Buffer> {
  const st = await fs.stat(file).catch(() => null);
  if (st && Date.now() - st.mtimeMs < maxAgeS * 1000) return fs.readFile(file);
  try {
    const h: Record<string, string> = { 'User-Agent': config.userAgent, ...headers };
    if (st) h['If-Modified-Since'] = st.mtime.toUTCString();
    const res = await fetch(url, { headers: h });
    if (st && res.status === 304) { const now = new Date(); await fs.utimes(file, now, now); return fs.readFile(file); }
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file + '.part', buf);
    await fs.rename(file + '.part', file);
    return buf;
  } catch (e) {
    if (st) return fs.readFile(file);
    throw e;
  }
}

export const staticZipPath = (cityId: string, feedId: string) => path.join(config.cacheDir, 'static', cityId, `${feedId}.zip`);

/** Quantised key for a coordinate, ~1 m, used to merge segments shared by route variants. */
const qk = (lat: number, lon: number) => `${Math.round(lat * 1e5)},${Math.round(lon * 1e5)}`;

/**
 * Merge all shape variants of one route into a network of unique edges, then walk it back
 * into polylines. Variants and both directions share streets, so drawing each shape would
 * double-count light where nothing is actually shared between routes.
 */
function routeNetwork(lines: Polyline[]): { lat: number[]; lon: number[] }[] {
  const nodes = new Map<string, { lat: number; lon: number; adj: Set<string> }>();
  const node = (lat: number, lon: number) => {
    const k = qk(lat, lon);
    let n = nodes.get(k);
    if (!n) nodes.set(k, (n = { lat, lon, adj: new Set() }));
    return k;
  };
  for (const pl of lines) {
    let prev = node(pl.lat[0], pl.lon[0]);
    for (let i = 1; i < pl.lat.length; i++) {
      const cur = node(pl.lat[i], pl.lon[i]);
      if (cur !== prev) { nodes.get(prev)!.adj.add(cur); nodes.get(cur)!.adj.add(prev); }
      prev = cur;
    }
  }
  const used = new Set<string>();
  const ek = (a: string, b: string) => (a < b ? a + '|' + b : b + '|' + a);
  const chains: { lat: number[]; lon: number[] }[] = [];
  const walk = (start: string, next: string) => {
    const c = { lat: [nodes.get(start)!.lat], lon: [nodes.get(start)!.lon] };
    let prev = start, cur = next;
    used.add(ek(prev, cur));
    for (;;) {
      const n = nodes.get(cur)!;
      c.lat.push(n.lat); c.lon.push(n.lon);
      if (n.adj.size !== 2) break;
      const nx = [...n.adj].find((a) => a !== prev)!;
      if (used.has(ek(cur, nx))) break;
      used.add(ek(cur, nx));
      prev = cur; cur = nx;
    }
    chains.push(c);
  };
  for (const [k, n] of nodes) if (n.adj.size !== 2) for (const a of n.adj) if (!used.has(ek(k, a))) walk(k, a);
  for (const [k, n] of nodes) for (const a of n.adj) if (!used.has(ek(k, a))) walk(k, a); // pure loops
  return chains;
}

interface TempRoute { feed: string; id: string; short: string; long: string; type: number; color: LCH | null; shapes: number[] }

/** Stream one feed's routes, trips and shapes into the shared build state. */
function readFeed(zip: Uint8Array, feed: FeedDef, st: {
  routes: TempRoute[]; shapes: { id: string; route: number }[]; polylines: Polyline[];
  trips: [string, number, number][]; // [`${feed}:${trip}`, temp route, shape or -1]
  dirUse: Map<string, Map<number, number>>; // `${feed}:${route}:${dir}` → shape → trips
}) {
  const types = feed.filter?.routeTypes, bbox = feed.filter?.bbox;

  // Routes.
  const local = new Map<string, number>();
  for (const r of zipRows(zip, 'routes.txt')) {
    const type = Number(r.route_type);
    if (types && !types.includes(type)) continue;
    const rgb = hexToRgb(r.route_color || '');
    local.set(r.route_id, st.routes.length);
    st.routes.push({ feed: feed.id, id: r.route_id, short: r.route_short_name || '', long: r.route_long_name || '', type, color: rgb ? rgbToOklch(rgb) : null, shapes: [] });
  }

  // Trips, first pass: which shapes are used, by which route.
  const shapeRoute = new Map<string, number>();
  let cR = -1, cS = -1, cT = -1, cD = -1;
  zipCsv(zip, 'trips.txt', (col) => { cR = col('route_id'); cS = col('shape_id'); cT = col('trip_id'); cD = col('direction_id'); }, (f) => {
    const ri = local.get(f[cR]);
    if (ri !== undefined && cS >= 0 && f[cS]) shapeRoute.set(f[cS], ri);
  });

  // Shapes, streamed shape by shape (GTFS files are normally grouped by shape_id).
  const localShape = new Map<string, number>();
  const done = new Set<string>(), split = new Set<string>();
  const finalize = (sid: string, seq: number[], lat: number[], lon: number[]) => {
    const ri = shapeRoute.get(sid);
    if (ri === undefined || lat.length < 2) return;
    const order = seq.map((_, i) => i);
    let sorted = true;
    for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1]) { sorted = false; break; }
    if (!sorted) order.sort((a, b) => seq[a] - seq[b]);
    const la = Float64Array.from(order, (i) => lat[i]), lo = Float64Array.from(order, (i) => lon[i]);
    const keep = simplifyIdx(la, lo, 1.5);
    const pl = makePolyline(Float64Array.from(keep, (i) => la[i]), Float64Array.from(keep, (i) => lo[i]));
    if (pl.length < 10) return;
    if (bbox) {
      let inside = false;
      for (let i = 0; i < pl.lat.length && !inside; i++) inside = pl.lon[i] >= bbox[0] && pl.lon[i] <= bbox[2] && pl.lat[i] >= bbox[1] && pl.lat[i] <= bbox[3];
      if (!inside) return;
    }
    const si = st.shapes.length;
    st.shapes.push({ id: sid, route: ri });
    st.polylines.push(pl);
    st.routes[ri].shapes.push(si);
    localShape.set(sid, si);
  };
  let cur: string | undefined, seq: number[] = [], lat: number[] = [], lon: number[] = [];
  let cId = -1, cLat = -1, cLon = -1, cSeq = -1;
  const shapesHeader = (col: (n: string) => number) => { cId = col('shape_id'); cLat = col('shape_pt_lat'); cLon = col('shape_pt_lon'); cSeq = col('shape_pt_sequence'); };
  zipCsv(zip, 'shapes.txt', shapesHeader, (f) => {
    const id = f[cId];
    if (id !== cur) {
      if (cur !== undefined && !split.has(cur)) { finalize(cur, seq, lat, lon); done.add(cur); }
      cur = id; seq = []; lat = []; lon = [];
      if (done.has(id)) split.add(id); // file not grouped by shape: gather these in a second pass
    }
    if (split.has(id) || !shapeRoute.has(id)) return;
    seq.push(Number(f[cSeq])); lat.push(Number(f[cLat])); lon.push(Number(f[cLon]));
  });
  if (cur !== undefined && !split.has(cur)) finalize(cur, seq, lat, lon);
  if (split.size) {
    for (const id of split) { const si = localShape.get(id); if (si !== undefined) { localShape.delete(id); st.routes[st.shapes[si].route].shapes = st.routes[st.shapes[si].route].shapes.filter((x) => x !== si); } }
    const acc = new Map<string, { seq: number[]; lat: number[]; lon: number[] }>();
    zipCsv(zip, 'shapes.txt', shapesHeader, (f) => {
      if (!split.has(f[cId])) return;
      let a = acc.get(f[cId]); if (!a) acc.set(f[cId], (a = { seq: [], lat: [], lon: [] }));
      a.seq.push(Number(f[cSeq])); a.lat.push(Number(f[cLat])); a.lon.push(Number(f[cLon]));
    });
    for (const [id, a] of acc) finalize(id, a.seq, a.lat, a.lon);
  }

  // Trips, second pass: map each trip to its shape and route, and count shapes per direction.
  zipCsv(zip, 'trips.txt', (col) => { cR = col('route_id'); cS = col('shape_id'); cT = col('trip_id'); cD = col('direction_id'); }, (f) => {
    const ri = local.get(f[cR]);
    if (ri === undefined) return;
    const si = cS >= 0 ? localShape.get(f[cS]) : undefined;
    st.trips.push([`${feed.id}:${f[cT]}`, ri, si ?? -1]);
    if (si !== undefined) {
      const k = `${feed.id}:${f[cR]}:${cD >= 0 ? Number(f[cD] || 0) : 0}`;
      let m = st.dirUse.get(k); if (!m) st.dirUse.set(k, (m = new Map()));
      m.set(si, (m.get(si) ?? 0) + 1);
    }
  });
}

/** Sample points along the network for the globe-level city glow. */
function glowSamples(lineVerts: Float32Array, lineChains: Uint32Array, routes: RouteInfo[], scale: number): Float32Array {
  let total = 0;
  for (let c = 0; c < lineChains.length; c += 3) {
    const s = lineChains[c], n = lineChains[c + 1];
    for (let i = s + 1; i < s + n; i++) total += Math.hypot(lineVerts[i * 2] - lineVerts[i * 2 - 2], lineVerts[i * 2 + 1] - lineVerts[i * 2 - 1]) * scale;
  }
  const step = Math.max(150, total / 2500);
  const out: number[] = [];
  for (let c = 0; c < lineChains.length; c += 3) {
    const s = lineChains[c], n = lineChains[c + 1], r = routes[lineChains[c + 2]];
    const w = GLOW_WEIGHT[r.mode];
    let carry = Math.random() * step;
    for (let i = s + 1; i < s + n; i++) {
      const ax = lineVerts[i * 2 - 2], ay = lineVerts[i * 2 - 1], bx = lineVerts[i * 2], by = lineVerts[i * 2 + 1];
      const len = Math.hypot(bx - ax, by - ay) * scale;
      let d = carry;
      while (d < len) { const t = d / len; out.push(ax + (bx - ax) * t, ay + (by - ay) * t, r.light[0] * w, r.light[1] * w, r.light[2] * w); d += step; }
      carry = d - len;
    }
  }
  return Float32Array.from(out);
}

async function buildFresh(city: CityDef, zips: Uint8Array[]): Promise<CityIndex> {
  const o = city.origin;
  const st = { routes: [] as TempRoute[], shapes: [] as { id: string; route: number }[], polylines: [] as Polyline[], trips: [] as [string, number, number][], dirUse: new Map<string, Map<number, number>>() };
  city.feeds.forEach((feed, i) => readFeed(zips[i], feed, st));

  // Keep only routes that have geometry; remap indices.
  const remap = new Int32Array(st.routes.length).fill(-1);
  const routes: RouteInfo[] = [];
  const raw: (LCH | null)[] = [];
  const routeShapes: number[][] = [];
  st.routes.forEach((r, i) => {
    if (!r.shapes.length) return;
    remap[i] = routes.length;
    routes.push({ id: r.id, feed: r.feed, short: r.short, long: r.long, mode: modeOf(r.type), light: [1, 1, 1], ink: [0, 0, 0], official: false });
    raw.push(r.color);
    routeShapes.push(r.shapes);
  });
  const routeIdx = new Map<string, number>();
  routes.forEach((r, i) => routeIdx.set(`${r.feed}:${r.id}`, i));
  const shapes: ShapeInfo[] = st.shapes.map((s, i) => ({ id: s.id, route: remap[s.route], start: 0, count: st.polylines[i].lat.length, length: st.polylines[i].length }));
  const tripShape = new Map<string, number>(), tripRoute = new Map<string, number>();
  for (const [k, r, s] of st.trips) {
    if (remap[r] < 0) continue;
    tripRoute.set(k, remap[r]);
    if (s >= 0) tripShape.set(k, s);
  }
  const dirShapes = new Map<string, number[]>();
  for (const [k, m] of st.dirUse) dirShapes.set(k, [...m.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s));

  // Colour. A colour shared by many routes (e.g. every bus the same yellow) is a brand
  // colour, not a line colour: those routes get spectral colours instead.
  const ck = (c: LCH) => `${Math.round(c.L * 50)},${Math.round(c.C * 50)},${Math.round(c.h / 6)}`;
  const freq = new Map<string, number>();
  for (const c of raw) if (c) freq.set(ck(c), (freq.get(ck(c)) ?? 0) + 1);
  const generic: number[] = [];
  raw.forEach((c, i) => {
    if (!c || isNeutral(c) || (freq.get(ck(c)) ?? 0) >= 6) generic.push(i);
    else { routes[i].light = asLight(c); routes[i].ink = asInk(c); routes[i].official = true; }
  });
  const kx = Math.cos((o.lat * Math.PI) / 180) * EARTH_R * (Math.PI / 180), ky = EARTH_R * (Math.PI / 180);
  const positions = spectralPositions(generic.map((ri) => {
    const s: [number, number][] = [];
    for (const si of routeShapes[ri]) {
      const pl = st.polylines[si];
      for (let d = 0, j = 0; d <= pl.length; d += 250) {
        while (j < pl.cum.length - 2 && pl.cum[j + 1] < d) j++;
        s.push([(pl.lon[j] - o.lon) * kx, (pl.lat[j] - o.lat) * ky]);
      }
    }
    return { key: String(ri), pts: s };
  }));
  for (const ri of generic) {
    const h = spectralHue(positions.get(String(ri)) ?? 0);
    routes[ri].light = vivid(h);
    routes[ri].ink = asInk({ L: 0.52, C: 0.16, h });
  }

  // Pack shape vertices for the GPU.
  let total = 0;
  for (const s of shapes) { s.start = total; total += s.count; }
  const points = new Float32Array(total * 4);
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  shapes.forEach((s, si) => {
    const pl = st.polylines[si];
    for (let i = 0; i < s.count; i++) {
      const [x, y] = toRel(o, pl.lon[i], pl.lat[i]);
      const p = (s.start + i) * 4;
      points[p] = x; points[p + 1] = y; points[p + 2] = pl.cum[i];
      minLon = Math.min(minLon, pl.lon[i]); maxLon = Math.max(maxLon, pl.lon[i]);
      minLat = Math.min(minLat, pl.lat[i]); maxLat = Math.max(maxLat, pl.lat[i]);
    }
  });

  // Deduplicated per-route line network.
  const lv: number[] = [], lc: number[] = [];
  routeShapes.forEach((sis, ri) => {
    for (const ch of routeNetwork(sis.map((si) => st.polylines[si]))) {
      const lat = Float64Array.from(ch.lat), lon = Float64Array.from(ch.lon);
      const keep = simplifyIdx(lat, lon, 1.5);
      if (keep.length < 2) continue;
      lc.push(lv.length / 2, keep.length, ri);
      for (const k of keep) { const [x, y] = toRel(o, lon[k], lat[k]); lv.push(x, y); }
    }
  });
  const lineVerts = Float32Array.from(lv), lineChains = Uint32Array.from(lc);

  return {
    def: city, routes, shapes, polylines: st.polylines, routeIdx, tripShape, tripRoute, dirShapes,
    bbox: [minLon, minLat, maxLon, maxLat],
    points, lineVerts, lineChains,
    glow: glowSamples(lineVerts, lineChains, routes, EARTH_R * Math.cos((o.lat * Math.PI) / 180)),
  };
}

// ---------- disk cache ----------

async function writeCache(dir: string, ix: CityIndex) {
  await fs.mkdir(dir, { recursive: true });
  const meta = {
    routes: ix.routes, shapes: ix.shapes, bbox: ix.bbox,
    trips: [...ix.tripRoute.entries()].map(([k, r]) => [k, r, ix.tripShape.get(k) ?? -1]),
    dirShapes: [...ix.dirShapes.entries()],
  };
  const poly = new Float64Array(ix.points.length / 2);
  ix.shapes.forEach((s, si) => {
    const pl = ix.polylines[si];
    for (let i = 0; i < s.count; i++) { poly[(s.start + i) * 2] = pl.lat[i]; poly[(s.start + i) * 2 + 1] = pl.lon[i]; }
  });
  const w = (name: string, a: ArrayBufferView) => fs.writeFile(path.join(dir, name), Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  await Promise.all([
    w('points.bin', ix.points), w('lines.bin', ix.lineVerts), w('chains.bin', ix.lineChains), w('glow.bin', ix.glow), w('poly.bin', poly),
  ]);
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta)); // written last: marks the cache complete
}

async function readCache(dir: string, city: CityDef): Promise<CityIndex | null> {
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
    const r = async (name: string) => { const b = await fs.readFile(path.join(dir, name)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
    const [points, lines, chains, glow, polyBuf] = await Promise.all(['points.bin', 'lines.bin', 'chains.bin', 'glow.bin', 'poly.bin'].map(r));
    const poly = new Float64Array(polyBuf);
    const shapes: ShapeInfo[] = meta.shapes;
    const polylines = shapes.map((s) => {
      const lat = new Float64Array(s.count), lon = new Float64Array(s.count);
      for (let i = 0; i < s.count; i++) { lat[i] = poly[(s.start + i) * 2]; lon[i] = poly[(s.start + i) * 2 + 1]; }
      return makePolyline(lat, lon);
    });
    const routes: RouteInfo[] = meta.routes;
    const routeIdx = new Map<string, number>();
    routes.forEach((x, i) => routeIdx.set(`${x.feed}:${x.id}`, i));
    const tripShape = new Map<string, number>(), tripRoute = new Map<string, number>();
    for (const [k, rr, s] of meta.trips as [string, number, number][]) { tripRoute.set(k, rr); if (s >= 0) tripShape.set(k, s); }
    return {
      def: city, routes, shapes, polylines, routeIdx, tripShape, tripRoute, dirShapes: new Map(meta.dirShapes), bbox: meta.bbox,
      points: new Float32Array(points), lineVerts: new Float32Array(lines), lineChains: new Uint32Array(chains), glow: new Float32Array(glow),
    };
  } catch {
    return null;
  }
}

/** Build (or load from cache) a city's static index. Downloads feeds that are missing or stale. */
export async function buildCity(city: CityDef): Promise<CityIndex> {
  const zips: Uint8Array[] = [];
  const stamp: unknown[] = [BUILD_VERSION, city.origin];
  for (const feed of city.feeds) {
    const file = staticZipPath(city.id, feed.id);
    const buf = await fetchCached(feed.static, file, 24 * 3600, feed.staticHeaders);
    zips.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    // Content hash, not mtime: a daily revalidation that returns 304 must not force a rebuild.
    stamp.push(feed.id, feed.static, crypto.createHash('sha1').update(buf).digest('hex'), feed.filter ?? null);
  }
  const key = crypto.createHash('sha1').update(JSON.stringify(stamp)).digest('hex').slice(0, 16);
  const dir = path.join(config.cacheDir, 'built', city.id, key);
  const cached = await readCache(dir, city);
  if (cached) return cached;
  const ix = await buildFresh(city, zips);
  await writeCache(dir, ix);
  // Remove older builds of this city.
  const parent = path.dirname(dir);
  for (const d of await fs.readdir(parent)) if (d !== key) await fs.rm(path.join(parent, d), { recursive: true, force: true });
  return ix;
}
