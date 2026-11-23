// "Near me": the next departures from the stops around a point, from the timetables of the
// places that cover it. Each lookup scans a timetable in a worker thread and keeps the next
// twelve hours of departures, so a viewer who stays put (or moves a little) is answered from
// memory afterwards.

import { Worker } from 'node:worker_threads';
import { config } from './config.ts';
import { modeOf, staticZipPath } from './static/gtfs.ts';
import { distM, type Departure, type NearbyStop } from './static/departures.ts';
import type { Place, Places } from './places.ts';
import type { Mode } from './types.ts';
import { liveCalls, predict, refresh, tripIds, type LiveCall } from './predictions.ts';

/** A cached scan is reused for points this close to where it was made. */
const REUSE_M = 150;
/** And for this long (it holds twelve hours of departures). */
const REUSE_S = 4 * 3600;
const CACHE_PER_PLACE = 24;
/** Shown per stop, and how far ahead. */
const SHOW_PER_STOP = 5;
const SHOW_AHEAD_S = 3 * 3600;
const SHOW_STOPS = 8;
/** Longest the reply waits for prediction feeds. */
const PREDICTION_WAIT_MS = 3500;
/** Places looked up per point, and timetable scans run at once (each reads a whole zip). */
const MAX_PLACES = 6;
const MAX_SCANS = 2;

let scansRunning = 0;
const scanQueue: (() => void)[] = [];
async function scanSlot<T>(job: () => Promise<T>): Promise<T> {
  if (scansRunning >= MAX_SCANS) await new Promise<void>((r) => scanQueue.push(r));
  scansRunning++;
  try { return await job(); } finally { scansRunning--; scanQueue.shift()?.(); }
}

interface Scan { lat: number; lon: number; at: number; stops: NearbyStop[] }

const cache = new Map<string, Scan[]>();
const inflight = new Map<string, Promise<NearbyStop[]>>();

/**
 * Built places whose area holds the point: hand-checked cities first, then the most specific
 * (smallest). A city centre is often inside several regional operators' areas too (downtown
 * Seattle: King County Metro, Sound Transit, and the Kitsap, Pierce and Community Transit
 * buses that run in), so take a few.
 */
export function placesAt(places: Places, lat: number, lon: number): Place[] {
  const m = 0.01;
  return [...places.all.values()]
    .filter((p) => p.summary && p.area && !p.def.positionsOnly && p.state !== 'skipped'
      && lon >= p.area[0] - m && lon <= p.area[2] + m && lat >= p.area[1] - m && lat <= p.area[3] + m)
    .sort((a, b) => Number(b.def.source === 'curated') - Number(a.def.source === 'curated') || size(a.area!) - size(b.area!))
    .slice(0, MAX_PLACES);
}
const size = (b: [number, number, number, number]) => (b[2] - b[0]) * (b[3] - b[1]);

function scan(p: Place, lat: number, lon: number): Promise<NearbyStop[]> {
  const now = Date.now() / 1000;
  const hit = cache.get(p.def.id)?.find((s) => now - s.at < REUSE_S && distM(lat, lon, s.lat, s.lon) < REUSE_M);
  if (hit) return Promise.resolve(hit.stops);
  const key = `${p.def.id}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
  const running = inflight.get(key);
  if (running) return running;
  const job = {
    feeds: p.def.feeds.map((f) => ({ id: f.id, zip: staticZipPath(f.zipKey ?? p.def.id, f.id) })),
    tz: p.def.tz, lat, lon, nowS: now,
  };
  const t0 = Date.now();
  const run = scanSlot(() => new Promise<NearbyStop[]>((resolve, reject) => {
    const w = new Worker(new URL('./static/nearbyWorker.ts', import.meta.url), {
      workerData: job, resourceLimits: { maxOldGenerationSizeMb: config.buildMemoryMb },
    });
    let done = false;
    const finish = (m: { ok: boolean; stops?: NearbyStop[]; error?: string }) => {
      if (done) return;
      done = true;
      void w.terminate();
      if (m.ok && m.stops) resolve(m.stops); else reject(new Error(m.error ?? 'lookup failed'));
    };
    w.once('message', finish);
    w.once('error', (e: Error) => finish({ ok: false, error: e.message }));
    w.once('exit', (code) => finish({ ok: false, error: `nearby worker exited (${code})` }));
  })).then((stops) => {
    const list = cache.get(p.def.id) ?? [];
    list.unshift({ lat, lon, at: now, stops });
    list.length = Math.min(list.length, CACHE_PER_PLACE);
    cache.set(p.def.id, list);
    console.log(`[nearby] ${p.def.id}: ${stops.length} stops in ${Date.now() - t0} ms`);
    return stops;
  }).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

interface Dep {
  t: number; sched: number | null; rt: 'live' | 'cancelled' | 'skipped' | null;
  trip: string; route: string; dir?: number; short: string; long: string; mode: Mode; color: string | null; dest: string;
}

const wire = (d: Departure) => ({
  trip: d.trip, route: d.route, dir: d.dir, short: d.short, long: d.long, mode: modeOf(d.type), color: d.color ?? null, dest: d.dest,
});

/**
 * Predicted trips at this stop that aren't in its timetable (a metro adding trains, a bus
 * running an extra). Named after a timetabled trip of the same route (and direction), ending
 * at the same stop when there is one: they share names, colour and where they're going.
 */
function addedTrips(s: NearbyStop, calls: LiveCall[], now: number): Dep[] {
  const known = new Set<string>();
  for (const d of s.deps) for (const id of tripIds(d.trip)) known.add(id);
  const out: Dep[] = [];
  for (const c of calls) {
    if (c.stop !== s.id || known.has(c.trip) || !c.route || c.t < now - 30 || c.t > now + SHOW_AHEAD_S) continue;
    const same = (d: Departure) => d.route === c.route && (c.dir === undefined || d.dir === undefined || d.dir === c.dir);
    // Same last stop first, so a branching line (Ashmont or Braintree) names the right branch.
    const like = s.deps.find((d) => same(d) && d.end === c.last) ?? s.deps.find(same);
    if (!like) continue; // a route this stop doesn't serve in the timetable: nothing to call it
    out.push({ ...wire(like), trip: c.trip, dir: c.dir ?? like.dir, t: c.t, sched: null, rt: 'live' });
  }
  return out;
}

/**
 * Where a route's trips here are predicted, timetabled trips of the same route and direction
 * that have no prediction but are due before the last predicted one aren't coming as timetabled:
 * the feed covers that stretch of time, and they're not in it (replaced, or not running).
 */
function dropReplaced(deps: Dep[]): Dep[] {
  const key = (d: Dep) => `${d.route}|${d.dir ?? ''}`;
  const lastLive = new Map<string, number>();
  for (const d of deps) if (d.rt === 'live') lastLive.set(key(d), Math.max(lastLive.get(key(d)) ?? 0, d.t));
  return deps.filter((d) => d.rt !== null || !(d.t < (lastLive.get(key(d)) ?? 0)));
}

/** The reply to /api/nearby: covering places, and the nearest stops with what leaves them next. */
export async function nearby(places: Places, lat: number, lon: number) {
  const now = Date.now() / 1000;
  const at = placesAt(places, lat, lon);
  // Timetable scans and fresh predictions in parallel; predictions get a few seconds at most
  // (a slow feed shouldn't hold up the answer: its departures show as timetabled).
  const feeds = [...new Map(at.flatMap((p) => p.def.feeds).map((f) => [f.id, f])).values()];
  const live = Promise.race([Promise.all(feeds.map(refresh)), new Promise((r) => setTimeout(r, PREDICTION_WAIT_MS))]);
  const results = await Promise.allSettled(at.map((p) => scan(p, lat, lon).then((stops) => ({ p, stops }))));
  await live;
  const seen = new Set<string>();
  const stops = [];
  let predicted = 0;
  // Predicted calls at the nearby stops, per feed (for trips the timetable doesn't have).
  const calls = new Map<string, LiveCall[]>();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const f of new Set(r.value.stops.map((s) => s.feed))) {
      calls.set(f, [...(calls.get(f) ?? []), ...liveCalls(f, new Set(r.value.stops.filter((s) => s.feed === f).map((s) => s.id)), now)]);
    }
  }
  for (const r of results) {
    if (r.status === 'rejected') { console.warn('[nearby] lookup failed:', r.reason?.message ?? r.reason); continue; }
    for (const s of r.value.stops) {
      // Regions cut from one national feed share stops: list each once.
      const k = `${s.feed}:${s.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const deps: Dep[] = [];
      for (const d of s.deps) {
        if (d.t > now + SHOW_AHEAD_S) break;
        const p = predict({ ...d, stop: s.id }, now);
        if (p?.kind === 'passed') continue;
        const t = p?.kind === 'live' ? p.t : d.t;
        if (t < now - 30 || t > now + SHOW_AHEAD_S) continue;
        deps.push({ ...wire(d), t, sched: d.t, rt: p?.kind ?? null });
      }
      deps.push(...addedTrips(s, calls.get(s.feed) ?? [], now));
      const kept = dropReplaced(deps).sort((a, b) => a.t - b.t).slice(0, SHOW_PER_STOP);
      predicted += kept.filter((d) => d.rt).length;
      stops.push({
        place: r.value.p.def.id, feed: s.feed, id: s.id, name: s.name, code: s.code ?? null, lat: s.lat, lon: s.lon,
        distM: Math.round(distM(lat, lon, s.lat, s.lon)),
        deps: kept,
      });
    }
  }
  stops.sort((a, b) => a.distM - b.distM);
  // The nearest stops with something leaving soon (the very nearest even if nothing is), counting
  // a station's platforms as one: viewers see them merged by name, and a big station's dozen
  // platforms would otherwise crowd out the trams outside.
  const names = new Set<string>();
  const shown = stops.filter((s, i) => {
    if (!s.deps.length && i > 0) return false;
    if (!names.has(s.name) && names.size >= SHOW_STOPS) return false;
    names.add(s.name);
    return true;
  });
  return {
    now,
    places: at.map((p) => ({ id: p.def.id, name: p.def.name, tz: p.def.tz })),
    failed: results.some((r) => r.status === 'rejected'),
    /** Whether any departure here has a live prediction (else everything is timetabled). */
    live: predicted > 0,
    stops: shown,
  };
}
