// Departures from the stops near a point, straight from the GTFS timetable. Runs in a worker
// thread: it streams the whole of stop_times once (gigabytes for a national feed), keeping only
// rows at the few nearby stops, so the live server never stalls on it.

import fs from 'node:fs/promises';
import { own, zipCsv, zipRows } from './csv.ts';
import { activeServices, hms, localDate, serviceBase, shiftDate } from './schedule.ts';

export interface NearbyJob {
  feeds: { id: string; zip: string }[];
  tz: string;
  lat: number;
  lon: number;
  nowS: number;
}

export interface Departure {
  /** Epoch seconds the vehicle is timetabled to leave this stop. */
  t: number;
  trip: string;
  feed: string;
  /** GTFS route_id, and the route's names, type and colour from routes.txt. */
  route: string;
  short: string;
  long: string;
  type: number;
  color?: string;
  /** Where it's going: the trip's headsign, or the name of its last stop. */
  dest: string;
  /** For matching realtime predictions: this stop's stop_sequence, the trip's direction_id,
   *  its first departure ("HH:MM:SS" as in the timetable) and its service date (YYYYMMDD). */
  seq: number;
  /** The trip's last stop (stop_id). */
  end: string;
  dir?: number;
  start?: string;
  date: string;
}

export interface NearbyStop {
  feed: string;
  id: string;
  name: string;
  code?: string;
  lat: number;
  lon: number;
  distM: number;
  deps: Departure[];
}

/** Look this far for stops, widening once if there are too few close by. */
const RADII_M = [600, 1500];
/** Stops considered, per feed: the nearest few distinct names, with all their platforms (a big
 *  station has a dozen, which shouldn't crowd out the stops around it). */
const MAX_NAMES = 8;
const MAX_STOPS = 40;
/** Keep departures up to this far ahead (so one scan serves a viewer for hours). */
const AHEAD_S = 12 * 3600;
const MAX_DEPS_PER_STOP = 400;

export function distM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export async function nearbyDepartures(job: NearbyJob): Promise<NearbyStop[]> {
  const out: NearbyStop[] = [];
  for (const f of job.feeds) out.push(...(await feedDepartures(job, f.id, f.zip)));
  return out.sort((a, b) => a.distM - b.distM);
}

async function feedDepartures(job: NearbyJob, feedId: string, zipPath: string): Promise<NearbyStop[]> {
  const zip = new Uint8Array(await fs.readFile(zipPath));

  // Every stop's name (for destinations), and the boardable stops near the point.
  const names = new Map<string, string>();
  const cands: NearbyStop[] = [];
  let sI = -1, sN = -1, sC = -1, sLa = -1, sLo = -1, sT = -1;
  zipCsv(zip, 'stops.txt', (col) => {
    sI = col('stop_id'); sN = col('stop_name'); sC = col('stop_code'); sLa = col('stop_lat'); sLo = col('stop_lon'); sT = col('location_type');
  }, (f) => {
    const id = own(f[sI]), name = (sN >= 0 && f[sN]) ? own(f[sN].trim()) : id;
    names.set(id, name);
    if (sT >= 0 && f[sT] && f[sT] !== '0') return; // stations, entrances: departures are from their platforms
    const la = Number(f[sLa]), lo = Number(f[sLo]);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return;
    if (Math.abs(la - job.lat) > 0.02 || Math.abs(lo - job.lon) > 0.03 / Math.max(0.2, Math.cos(job.lat * Math.PI / 180))) return;
    const d = distM(job.lat, job.lon, la, lo);
    if (d <= RADII_M[RADII_M.length - 1]) cands.push({ feed: feedId, id, name, code: (sC >= 0 && f[sC]) ? own(f[sC]) : undefined, lat: la, lon: lo, distM: Math.round(d), deps: [] });
  });
  cands.sort((a, b) => a.distM - b.distM);
  const close = cands.filter((s) => s.distM <= RADII_M[0]);
  const picked = new Set<string>();
  const near = (close.length >= 3 ? close : cands).filter((c) => {
    if (!picked.has(c.name) && picked.size >= MAX_NAMES) return false;
    picked.add(c.name);
    return true;
  }).slice(0, MAX_STOPS);
  if (!near.length) return [];
  const byId = new Map(near.map((s) => [s.id, s]));

  // One pass over stop_times: rows at the nearby stops, plus each of those trips' last stop.
  type Row = { stop: NearbyStop; trip: string; seq: number; sec: number };
  const rows: Row[] = [];
  const tripEnd = new Map<string, { seq: number; stop: string; first: number; start: string }>();
  let cur = '', curSeq = -Infinity, curStop = '', curFirst = Infinity, curStart = '';
  let iT = -1, iA = -1, iD = -1, iS = -1, iQ = -1, iP = -1;
  zipCsv(zip, 'stop_times.txt', (col) => {
    iT = col('trip_id'); iA = col('arrival_time'); iD = col('departure_time'); iS = col('stop_id'); iQ = col('stop_sequence'); iP = col('pickup_type');
  }, (f) => {
    const trip = f[iT], seq = +f[iQ];
    // Rows usually come grouped by trip: remember the first and furthest stops of the current trip so far.
    if (trip !== cur) { cur = trip; curSeq = -Infinity; curStop = ''; curFirst = Infinity; curStart = ''; }
    if (seq > curSeq) { curSeq = seq; curStop = f[iS]; }
    if (seq < curFirst && (f[iD] || f[iA])) { curFirst = seq; curStart = (f[iD] || f[iA]).trim(); }
    const end = tripEnd.get(trip);
    if (end && seq > end.seq) { end.seq = seq; end.stop = own(f[iS]); }
    if (end && seq < end.first && (f[iD] || f[iA])) { end.first = seq; end.start = own((f[iD] || f[iA]).trim()); }
    const stop = byId.get(f[iS]);
    if (!stop || (iP >= 0 && f[iP] === '1')) return; // not near, or no boarding here
    const sec = hms(f[iD]);
    const t = Number.isNaN(sec) ? hms(f[iA]) : sec;
    if (Number.isNaN(t)) return;
    const id = own(trip);
    rows.push({ stop, trip: id, seq, sec: t });
    if (!end) tripEnd.set(id, { seq: curSeq, stop: own(curStop), first: curFirst, start: own(curStart) });
  });
  if (!rows.length) return [];

  // Which services run yesterday (past midnight), today and tomorrow, local to the place.
  const cal = zipRows(zip, 'calendar.txt'), calDates = zipRows(zip, 'calendar_dates.txt');
  const today = localDate(job.nowS, job.tz);
  const days = [-1, 0, 1].map((k) => {
    const date = shiftDate(today, k);
    return { date, svc: activeServices(cal, calDates, date), base: serviceBase(date, job.tz) };
  });

  // Trips of those rows: route, service, headsign, direction.
  const tripInfo = new Map<string, { route: string; svc: string; head?: string; dir?: number }>();
  let tT = -1, tR = -1, tS = -1, tH = -1, tD = -1;
  zipCsv(zip, 'trips.txt', (col) => { tT = col('trip_id'); tR = col('route_id'); tS = col('service_id'); tH = col('trip_headsign'); tD = col('direction_id'); }, (f) => {
    if (!tripEnd.has(f[tT])) return;
    tripInfo.set(own(f[tT]), {
      route: own(f[tR]), svc: own(f[tS]), head: (tH >= 0 && f[tH]?.trim()) ? own(f[tH].trim()) : undefined,
      dir: tD >= 0 && (f[tD] === '0' || f[tD] === '1') ? +f[tD] : undefined,
    });
  });
  const routes = new Map<string, { short: string; long: string; type: number; color?: string }>();
  for (const r of zipRows(zip, 'routes.txt')) {
    routes.set(r.route_id, { short: r.route_short_name ?? '', long: r.route_long_name ?? '', type: Number(r.route_type ?? 3), color: /^[0-9a-fA-F]{6}$/.test(r.route_color ?? '') ? r.route_color : undefined });
  }

  // From a while back: a late vehicle timetabled earlier may still be on its way.
  const from = job.nowS - 1800, to = job.nowS + AHEAD_S;
  for (const r of rows) {
    const ti = tripInfo.get(r.trip), end = tripEnd.get(r.trip);
    if (!ti || !end || r.seq >= end.seq) continue; // the trip ends here: nothing to board
    const ro = routes.get(ti.route) ?? { short: '', long: '', type: 3 };
    for (const d of days) {
      if (!d.svc.has(ti.svc)) continue;
      const t = d.base + r.sec;
      if (t < from || t > to) continue;
      r.stop.deps.push({
        t, trip: r.trip, feed: feedId, route: ti.route, short: ro.short, long: ro.long, type: ro.type, color: ro.color,
        dest: ti.head ?? names.get(end.stop) ?? '',
        seq: r.seq, end: end.stop, dir: ti.dir, start: end.start || undefined, date: d.date,
      });
    }
  }
  for (const s of near) {
    s.deps.sort((a, b) => a.t - b.t);
    if (s.deps.length > MAX_DEPS_PER_STOP) s.deps.length = MAX_DEPS_PER_STOP;
  }
  return near.filter((s) => s.deps.length);
}
