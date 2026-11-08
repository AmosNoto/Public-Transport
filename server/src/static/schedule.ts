// Scheduled vehicles from GTFS static: where each trip should be right now according to the
// timetable. Used for a feed only when it has no usable live positions.

import path from 'node:path';
import fs from 'node:fs/promises';
import { Unzip, UnzipInflate, unzipSync, strFromU8 } from 'fflate';
import { config } from '../config.ts';
import { readCsv } from './csv.ts';
import { projectOnto } from '../geo.ts';
import type { CityIndex } from './gtfs.ts';
import type { FeedDef } from '../types.ts';

export interface ScheduledTrip {
  trip: string;
  route: number;
  shape: number;
  headsign?: string;
  /** Seconds after the service day's reference time: arrival, departure per stop. */
  times: Int32Array;
  /** Distance along the shape (m) of each stop. */
  dist: Float32Array;
  /** Which service day this trip belongs to: 0 = today, -1 = yesterday (runs past midnight). */
  day: 0 | -1;
}

export interface ScheduledPosition {
  trip: ScheduledTrip;
  d: number;
  v: number;
  stopped: boolean;
}

export interface FeedSchedule {
  /** Local service date (YYYYMMDD) this was built for. */
  date: string;
  /** Epoch seconds of the reference time ("noon minus 12h") of that service date. */
  base: number;
  trips: ScheduledTrip[];
}

// ---------- time zones ----------

function tzOffsetS(epochS: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epochS * 1000)).map((x) => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000) - Math.floor(epochS);
}

/** Local calendar date in a time zone, as YYYYMMDD. */
export function localDate(epochS: number, tz: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(epochS * 1000)).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}`;
}

/** GTFS service-day reference: local noon minus 12 hours (correct across DST changes). */
export function serviceBase(date: string, tz: string): number {
  const noonUtc = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), 12) / 1000;
  const noon = noonUtc - tzOffsetS(noonUtc, tz);
  return noon - 12 * 3600;
}

function shiftDate(date: string, days: number): string {
  const t = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)) + days * 86400000);
  return t.toISOString().slice(0, 10).replace(/-/g, '');
}

// ---------- parsing ----------

const hms = (s: string) => {
  const m = /^\s*(\d+):(\d\d):(\d\d)/.exec(s);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : NaN;
};

function splitLine(line: string): string[] {
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

/** Stream one CSV file out of a zip without materialising it as a single string. */
function streamCsv(zip: Uint8Array, name: string, onHeader: (h: string[]) => void, onRow: (f: string[]) => void) {
  const uz = new Unzip();
  uz.register(UnzipInflate);
  uz.onfile = (file) => {
    if (path.basename(file.name) !== name) return;
    const dec = new TextDecoder();
    let carry = '', header = false;
    const lines = (text: string) => {
      const parts = (carry + text).split('\n');
      carry = parts.pop() ?? '';
      for (let line of parts) {
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!header) { onHeader(splitLine(line.replace(/^﻿/, '')).map((h) => h.trim())); header = true; continue; }
        if (line) onRow(splitLine(line));
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
}

function activeServices(cal: string, dates: string, date: string): Set<string> {
  const dow = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][
    new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8))).getUTCDay()];
  const on = new Set<string>();
  for (const r of readCsv(cal)) if (r[dow] === '1' && r.start_date <= date && date <= r.end_date) on.add(r.service_id);
  for (const r of readCsv(dates)) {
    if (r.date !== date) continue;
    if (r.exception_type === '1') on.add(r.service_id);
    else if (r.exception_type === '2') on.delete(r.service_id);
  }
  return on;
}

/** Build today's scheduled trips for one feed (plus yesterday's trips still running after midnight). */
export async function buildSchedule(ix: CityIndex, feed: FeedDef, nowS = Date.now() / 1000): Promise<FeedSchedule> {
  const t0 = Date.now();
  const tz = ix.def.tz;
  const today = localDate(nowS, tz), yesterday = shiftDate(today, -1);
  const zip = new Uint8Array(await fs.readFile(path.join(config.cacheDir, 'static', ix.def.id, `${feed.id}.zip`)));
  const small = unzipSync(zip, { filter: (f) => ['calendar.txt', 'calendar_dates.txt', 'trips.txt', 'stops.txt'].includes(path.basename(f.name)) });
  const get = (n: string) => { const k = Object.keys(small).find((f) => path.basename(f) === n); return k ? strFromU8(small[k]) : ''; };
  const cal = get('calendar.txt'), calDates = get('calendar_dates.txt');
  const svcToday = activeServices(cal, calDates, today), svcYest = activeServices(cal, calDates, yesterday);

  // Trips that run today or yesterday and have a shape we can move them along.
  const want = new Map<string, { day: 0 | -1; route: number; shape: number; headsign?: string }>();
  const pending = new Map<string, { day: 0 | -1; route: number; shape: number; headsign?: string }>(); // ran yesterday too
  for (const t of readCsv(get('trips.txt'))) {
    const key = `${feed.id}:${t.trip_id}`;
    const shape = ix.tripShape.get(key), route = ix.tripRoute.get(key);
    if (shape === undefined || route === undefined) continue;
    const info = { route, shape, headsign: t.trip_headsign || undefined };
    if (svcToday.has(t.service_id)) want.set(t.trip_id, { day: 0, ...info });
    else if (svcYest.has(t.service_id)) want.set(t.trip_id, { day: -1, ...info });
    if (svcToday.has(t.service_id) && svcYest.has(t.service_id)) pending.set(t.trip_id, { day: -1, ...info });
  }

  const stops = new Map<string, [number, number]>();
  for (const s of readCsv(get('stops.txt'))) if (s.stop_lat && s.stop_lon) stops.set(s.stop_id, [+s.stop_lat, +s.stop_lon]);

  // Stream stop_times, keeping only wanted trips.
  const rows = new Map<string, [number, number, number, string][]>();
  let iTrip = 0, iArr = 0, iDep = 0, iStop = 0, iSeq = 0;
  streamCsv(zip, 'stop_times.txt', (h) => {
    iTrip = h.indexOf('trip_id'); iArr = h.indexOf('arrival_time'); iDep = h.indexOf('departure_time');
    iStop = h.indexOf('stop_id'); iSeq = h.indexOf('stop_sequence');
  }, (f) => {
    const id = f[iTrip];
    if (!want.has(id)) return;
    let a = rows.get(id);
    if (!a) rows.set(id, (a = []));
    a.push([+f[iSeq], hms(f[iArr]), hms(f[iDep]), f[iStop]]);
  });

  // Distances of stops along each shape, cached per stop pattern.
  const patternCache = new Map<string, Float32Array>();
  const trips: ScheduledTrip[] = [];
  const add = (id: string, w: { day: 0 | -1; route: number; shape: number; headsign?: string }, r: [number, number, number, string][]) => {
    const key = w.shape + '|' + r.map((x) => x[3]).join(',');
    let dist = patternCache.get(key);
    if (!dist) {
      dist = new Float32Array(r.length);
      const pl = ix.polylines[w.shape];
      let prev = 0;
      for (let i = 0; i < r.length; i++) {
        const s = stops.get(r[i][3]);
        const d = s ? projectOnto(pl, s[0], s[1], prev).d : prev;
        prev = dist[i] = Math.max(prev, d);
      }
      patternCache.set(key, dist);
    }
    // Fill missing times (non-timepoint stops) by distance between known neighbours.
    const times = new Int32Array(r.length * 2);
    const known: number[] = [];
    r.forEach((x, i) => { if (!Number.isNaN(x[1]) || !Number.isNaN(x[2])) known.push(i); });
    if (known.length < 2) return;
    for (let i = 0; i < r.length; i++) {
      let arr = r[i][1], dep = r[i][2];
      if (Number.isNaN(arr) && Number.isNaN(dep)) {
        const a = known.filter((k) => k < i).pop(), b = known.find((k) => k > i);
        if (a === undefined || b === undefined) continue;
        const ta = Number.isNaN(r[a][2]) ? r[a][1] : r[a][2], tb = Number.isNaN(r[b][1]) ? r[b][2] : r[b][1];
        const span = dist[b] - dist[a];
        arr = dep = Math.round(ta + (span > 0 ? (dist[i] - dist[a]) / span : 0) * (tb - ta));
      }
      times[i * 2] = Number.isNaN(arr) ? dep : arr;
      times[i * 2 + 1] = Number.isNaN(dep) ? arr : dep;
    }
    trips.push({ trip: id, route: w.route, shape: w.shape, headsign: w.headsign, times, dist, day: w.day });
  };
  for (const [id, r] of rows) {
    r.sort((a, b) => a[0] - b[0]);
    const w = want.get(id)!;
    add(id, w, r);
    const y = pending.get(id);
    if (y && w.day === 0) add(id, y, r); // the same trip from yesterday's service, if still running
  }
  // Yesterday's trips are only relevant if they run past midnight.
  const kept = trips.filter((t) => t.day === 0 || t.times[t.times.length - 1] > 86400);
  console.log(`[schedule] ${ix.def.id}/${feed.id} ${today}: ${kept.length} trips in ${Date.now() - t0} ms`);
  return { date: today, base: serviceBase(today, tz), trips: kept };
}

/** Where every scheduled trip is at `nowS`. */
export function scheduledPositions(s: FeedSchedule, nowS: number): ScheduledPosition[] {
  const out: ScheduledPosition[] = [];
  for (const t of s.trips) {
    const sec = nowS - s.base + (t.day === -1 ? 86400 : 0);
    const n = t.dist.length;
    if (sec < t.times[0] || sec > t.times[(n - 1) * 2]) continue;
    for (let i = 0; i < n; i++) {
      const arr = t.times[i * 2], dep = t.times[i * 2 + 1];
      if (sec >= arr && sec <= dep) { out.push({ trip: t, d: t.dist[i], v: 0, stopped: true }); break; }
      if (i < n - 1) {
        const next = t.times[(i + 1) * 2];
        if (sec > dep && sec < next) {
          const v = (t.dist[i + 1] - t.dist[i]) / Math.max(1, next - dep);
          out.push({ trip: t, d: t.dist[i] + v * (sec - dep), v, stopped: false });
          break;
        }
      }
    }
  }
  return out;
}
