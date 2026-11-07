// Download and preprocess GTFS static into what the renderer and the live snapper need.

import fs from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { readCsv } from './csv.ts';
import { config } from '../config.ts';
import { makePolyline, simplifyIdx, toRel, type Polyline, EARTH_R } from '../geo.ts';
import { hexToRgb, rgbToOklch, isNeutral, asLight, asInk, spectralHues, type LCH } from '../color.ts';
import type { CityDef, FeedDef, Mode, RouteInfo, ShapeInfo } from '../types.ts';

/** Everything the live side needs to snap vehicles. */
export interface CityIndex {
  def: CityDef;
  routes: RouteInfo[];
  shapes: ShapeInfo[];
  polylines: Polyline[];
  routeIdx: Map<string, number>; // `${feed}:${route_id}`
  tripShape: Map<string, number>; // `${feed}:${trip_id}` → shape index
  tripRoute: Map<string, number>;
  tripHeadsign: Map<string, string>;
  /** Most common shape for each `${feed}:${route}:${dir}`. */
  defaultShape: Map<string, number>;
  bbox: [number, number, number, number];
  /** Binary buffers sent to clients. */
  points: Float32Array; // (mx, my, cum, 0) per shape vertex, relative to origin
  /** Deduplicated route network as polylines: (x, y) per vertex, relative to origin. */
  lineVerts: Float32Array;
  /** Per chain: start vertex, vertex count, route index. */
  lineChains: Uint32Array;
}

export function modeOf(routeType: number): Mode {
  const t = routeType;
  if (t === 1 || t === 12 || (t >= 400 && t < 500)) return 'subway';
  if (t === 2 || (t >= 100 && t < 200)) return 'rail';
  if (t === 3 || t === 11 || (t >= 200 && t < 300) || (t >= 700 && t < 900)) return 'bus';
  return 'tram'; // 0 tram/light rail, 4 ferry, 5 cable tram, 6 aerial, 7 funicular, 900+, 1000+, 1300+, 1400+
}

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
    await fs.writeFile(file, buf);
    return buf;
  } catch (e) {
    if (st) return fs.readFile(file);
    throw e;
  }
}

const WANT = new Set(['routes.txt', 'trips.txt', 'shapes.txt', 'agency.txt']);

async function loadFeedFiles(city: CityDef, feed: FeedDef) {
  const zipPath = path.join(config.cacheDir, 'static', city.id, `${feed.id}.zip`);
  const zip = await fetchCached(feed.static, zipPath, 24 * 3600, feed.headers);
  const files = unzipSync(new Uint8Array(zip), { filter: (f) => WANT.has(path.basename(f.name)) });
  const get = (n: string) => {
    const k = Object.keys(files).find((f) => path.basename(f) === n);
    return k ? strFromU8(files[k]) : '';
  };
  return { routes: get('routes.txt'), trips: get('trips.txt'), shapes: get('shapes.txt') };
}

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

export async function buildCity(city: CityDef): Promise<CityIndex> {
  const o = city.origin;
  const routes: RouteInfo[] = [];
  const routeIdx = new Map<string, number>();
  const shapes: ShapeInfo[] = [];
  const polylines: Polyline[] = [];
  const tripShape = new Map<string, number>(), tripRoute = new Map<string, number>(), tripHeadsign = new Map<string, string>();
  const defaultShape = new Map<string, number>();
  const rawColor: (LCH | null)[] = [];
  const routeShapes: number[][] = [];

  for (const feed of city.feeds) {
    const f = await loadFeedFiles(city, feed);

    // Routes.
    const local = new Map<string, number>();
    for (const r of readCsv(f.routes)) {
      const rgb = hexToRgb(r.route_color || '');
      const idx = routes.length;
      routes.push({
        id: r.route_id, feed: feed.id, short: r.route_short_name || '', long: r.route_long_name || '',
        mode: modeOf(Number(r.route_type)), light: [1, 1, 1], ink: [0, 0, 0], official: false,
      });
      rawColor.push(rgb ? rgbToOklch(rgb) : null);
      routeShapes.push([]);
      routeIdx.set(`${feed.id}:${r.route_id}`, idx);
      local.set(r.route_id, idx);
    }

    // Trips: which shapes are used, by which route and direction.
    const shapeUse = new Map<string, { route: number; dirs: Map<number, number> }>();
    const tripShapeId = new Map<string, string>();
    for (const t of readCsv(f.trips)) {
      const ri = local.get(t.route_id);
      if (ri === undefined || !t.shape_id) continue;
      tripShapeId.set(t.trip_id, t.shape_id);
      tripRoute.set(`${feed.id}:${t.trip_id}`, ri);
      if (t.trip_headsign) tripHeadsign.set(`${feed.id}:${t.trip_id}`, t.trip_headsign);
      let u = shapeUse.get(t.shape_id);
      if (!u) shapeUse.set(t.shape_id, (u = { route: ri, dirs: new Map() }));
      const d = Number(t.direction_id || 0);
      u.dirs.set(d, (u.dirs.get(d) ?? 0) + 1);
    }

    // Shapes: group points by shape_id, sort by sequence.
    const pts = new Map<string, { seq: number; lat: number; lon: number }[]>();
    for (const s of readCsv(f.shapes)) {
      if (!shapeUse.has(s.shape_id)) continue;
      let a = pts.get(s.shape_id);
      if (!a) pts.set(s.shape_id, (a = []));
      a.push({ seq: Number(s.shape_pt_sequence), lat: Number(s.shape_pt_lat), lon: Number(s.shape_pt_lon) });
    }
    const localShape = new Map<string, number>();
    const best = new Map<string, { n: number; s: number }>();
    for (const [sid, arr] of pts) {
      arr.sort((a, b) => a.seq - b.seq);
      const lat = Float64Array.from(arr, (p) => p.lat), lon = Float64Array.from(arr, (p) => p.lon);
      const keep = simplifyIdx(lat, lon, 1.5);
      const pl = makePolyline(Float64Array.from(keep, (i) => lat[i]), Float64Array.from(keep, (i) => lon[i]));
      if (pl.length < 10) continue;
      const u = shapeUse.get(sid)!;
      const si = shapes.length;
      shapes.push({ id: sid, route: u.route, start: 0, count: pl.lat.length, length: pl.length });
      polylines.push(pl);
      routeShapes[u.route].push(si);
      localShape.set(sid, si);
      for (const [d, n] of u.dirs) {
        const k = `${feed.id}:${routes[u.route].id}:${d}`;
        const b = best.get(k);
        if (!b || n > b.n) best.set(k, { n, s: si });
      }
    }
    for (const [k, b] of best) defaultShape.set(k, b.s);
    for (const [tid, sid] of tripShapeId) {
      const si = localShape.get(sid);
      if (si !== undefined) tripShape.set(`${feed.id}:${tid}`, si);
    }
  }

  // Colour. A colour shared by many routes (e.g. every bus the same yellow) is a brand
  // colour, not a line colour: those routes get spectral hues instead.
  const freq = new Map<string, number>();
  rawColor.forEach((c, i) => {
    if (!c || !routeShapes[i].length) return;
    const k = `${Math.round(c.L * 50)},${Math.round(c.C * 50)},${Math.round(c.h / 6)}`;
    freq.set(k, (freq.get(k) ?? 0) + 1);
  });
  const generic: number[] = [];
  rawColor.forEach((c, i) => {
    if (!routeShapes[i].length) return;
    const k = c && `${Math.round(c.L * 50)},${Math.round(c.C * 50)},${Math.round(c.h / 6)}`;
    if (!c || isNeutral(c) || (freq.get(k!) ?? 0) >= 6) generic.push(i);
    else { routes[i].light = asLight(c); routes[i].ink = asInk(c); routes[i].official = true; }
  });
  const kx = Math.cos((o.lat * Math.PI) / 180) * EARTH_R * (Math.PI / 180), ky = EARTH_R * (Math.PI / 180);
  const hues = spectralHues(generic.map((ri) => {
    const s: [number, number][] = [];
    for (const si of routeShapes[ri]) {
      const pl = polylines[si];
      for (let d = 0, j = 0; d <= pl.length; d += 250) {
        while (j < pl.cum.length - 2 && pl.cum[j + 1] < d) j++;
        s.push([(pl.lon[j] - o.lon) * kx, (pl.lat[j] - o.lat) * ky]);
      }
    }
    return { key: String(ri), pts: s };
  }));
  for (const ri of generic) {
    const h = hues.get(String(ri)) ?? 0;
    routes[ri].light = asLight({ L: 0.66, C: 0.32, h }); // C beyond gamut: clamps to the most saturated colour of that hue, like the lens's spectral rays
    routes[ri].ink = asInk({ L: 0.52, C: 0.16, h });
  }

  // Pack shape vertices for the GPU.
  let total = 0;
  for (const s of shapes) { s.start = total; total += s.count; }
  const points = new Float32Array(total * 4);
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  shapes.forEach((s, si) => {
    const pl = polylines[si];
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
    if (!sis.length) return;
    for (const ch of routeNetwork(sis.map((si) => polylines[si]))) {
      const lat = Float64Array.from(ch.lat), lon = Float64Array.from(ch.lon);
      const keep = simplifyIdx(lat, lon, 1.5);
      if (keep.length < 2) continue;
      lc.push(lv.length / 2, keep.length, ri);
      for (const k of keep) { const [x, y] = toRel(o, lon[k], lat[k]); lv.push(x, y); }
    }
  });

  return {
    def: city, routes, shapes, polylines, routeIdx, tripShape, tripRoute, tripHeadsign, defaultShape,
    bbox: [minLon, minLat, maxLon, maxLat],
    points, lineVerts: Float32Array.from(lv), lineChains: Uint32Array.from(lc),
  };
}
