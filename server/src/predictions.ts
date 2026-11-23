// Live predictions from GTFS-Realtime TripUpdates, for the "Near you" departures.
//
// Two ways in: feeds that send trip updates in the same message as vehicle positions (the NYC
// subway) are stored on every regular poll; feeds that publish them separately
// (`FeedDef.predictions`) are fetched only when someone asks for departures, and then at most
// every PREDICTION_TTL_S, so hundreds of unwatched feeds aren't polled for nothing.

import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { config } from './config.ts';
import { sourceRequest } from './adapters/request.ts';
import type { FeedDef, RealtimeDef } from './types.ts';

const { FeedMessage, TripDescriptor, TripUpdate } = GtfsRealtimeBindings.transit_realtime;
const CANCELED = TripDescriptor.ScheduleRelationship.CANCELED;
const DELETED = TripDescriptor.ScheduleRelationship.DELETED;
const SKIPPED = TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED;

/** Refetch a source's trip updates when its copy is older than this. */
const PREDICTION_TTL_S = 20;
/** Ignore a copy older than this (the feed has stopped updating). */
const STALE_S = 300;

interface StopUpdate { seq?: number; stop?: string; time?: number; delay?: number; skipped: boolean }
interface TripState { trip?: string; route?: string; dir?: number; date?: string; cancelled: boolean; delay?: number; stops: StopUpdate[] }

interface SourceCopy {
  at: number;
  byTrip: Map<string, TripState>;
  /** Feeds that identify trips by route, direction and start (HSL) rather than trip id. */
  byStart: Map<string, TripState>;
}

/** Latest copy per feed, per source. */
const store = new Map<string, Map<string, SourceCopy>>();

export interface PredictionHealth {
  source: string; feed: string; state: 'ok' | 'error' | 'no-key'; detail?: string;
  lastTry?: number; lastOk?: number; trips: number; failures?: number; retryAt?: number;
}
export const predictionHealth = new Map<string, PredictionHealth>();

type Entity = InstanceType<typeof FeedMessage>['entity'][number];
/** A field's value only if the message actually carried it (the decoder reports absent numbers as 0). */
const has = (o: object | null | undefined, k: string) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const num = (o: object | null | undefined, k: string): number | undefined =>
  has(o, k) && (o as Record<string, unknown>)[k] !== null ? Number((o as Record<string, unknown>)[k]) : undefined;

/** Store the trip updates of one decoded message. Returns how many trips it held. */
export function ingest(feedId: string, sourceId: string, entities: Entity[], at: number): number {
  const byTrip = new Map<string, TripState>(), byStart = new Map<string, TripState>();
  for (const e of entities) {
    const t = e.tripUpdate;
    if (!t?.trip || e.isDeleted) continue;
    const d = t.trip;
    const rel = d.scheduleRelationship ?? 0;
    const st: TripState = {
      trip: d.tripId || undefined, route: d.routeId || undefined, dir: num(d, 'directionId'), date: d.startDate || undefined,
      cancelled: rel === CANCELED || rel === DELETED, delay: num(t, 'delay'), stops: [],
    };
    for (const u of t.stopTimeUpdate ?? []) {
      const time = num(u.departure, 'time') || num(u.arrival, 'time') || undefined;
      st.stops.push({
        seq: num(u, 'stopSequence'), stop: u.stopId || undefined, time,
        delay: num(u.departure, 'delay') ?? num(u.arrival, 'delay'), skipped: u.scheduleRelationship === SKIPPED,
      });
    }
    if (st.trip) byTrip.set(st.trip, st);
    else if (d.routeId && d.startTime && d.startDate) byStart.set(startKey(d.routeId, d.directionId ?? undefined, d.startDate, d.startTime), st);
  }
  let m = store.get(feedId);
  if (!m) store.set(feedId, (m = new Map()));
  m.set(sourceId, { at, byTrip, byStart });
  return byTrip.size + byStart.size;
}

const startKey = (route: string, dir: number | undefined, date: string, start: string) =>
  `${route}|${dir ?? ''}|${date}|${start.length === 7 ? '0' + start : start}`;

const inflight = new Map<string, Promise<void>>();

function healthOf(feed: FeedDef, src: RealtimeDef): PredictionHealth {
  let h = predictionHealth.get(src.id);
  if (!h) predictionHealth.set(src.id, (h = { source: src.id, feed: feed.id, state: 'ok', trips: 0 }));
  return h;
}

async function fetchSource(feed: FeedDef, src: RealtimeDef): Promise<void> {
  const h = healthOf(feed, src);
  h.lastTry = Date.now() / 1000;
  const req = sourceRequest(src);
  if (!req) { h.state = 'no-key'; h.detail = `set ${src.key!.env}`; return; }
  try {
    const res = await fetch(req.url, { headers: { 'User-Agent': config.userAgent, ...req.headers }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      // Rate limited or failing: back off (as the server asks, else doubling up to 15 minutes).
      h.failures = (h.failures ?? 0) + 1;
      const ra = Number(res.headers.get('retry-after'));
      h.retryAt = Date.now() / 1000 + Math.max(ra > 0 ? ra : 0, Math.min(900, 60 * 2 ** (h.failures - 1)));
      throw new Error(`HTTP ${res.status}`);
    }
    const msg = FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
    const now = Date.now() / 1000;
    const at = Math.min(now, Number(msg.header.timestamp ?? 0) || now);
    h.trips = ingest(feed.id, src.id, msg.entity, at);
    h.state = 'ok'; h.detail = undefined; h.lastOk = now; h.failures = 0; h.retryAt = undefined;
  } catch (e) {
    h.state = 'error'; h.detail = (e as Error).message.slice(0, 120);
  }
}

/** Bring a feed's separately published trip updates up to date (no-op if fresh or if it has none). */
export function refresh(feed: FeedDef): Promise<void> {
  const now = Date.now() / 1000;
  const jobs = (feed.predictions ?? []).map((src) => {
    const copy = store.get(feed.id)?.get(src.id);
    const ttl = Math.max(PREDICTION_TTL_S, src.minIntervalS ?? 0);
    // Fresh enough, tried a moment ago (a feed whose header time lags), or backing off.
    const h = predictionHealth.get(src.id);
    if ((copy && now - copy.at < ttl) || now - (h?.lastTry ?? 0) < ttl || now < (h?.retryAt ?? 0)) return Promise.resolve();
    let p = inflight.get(src.id);
    if (!p) {
      p = fetchSource(feed, src).finally(() => inflight.delete(src.id));
      inflight.set(src.id, p);
    }
    return p;
  });
  return Promise.all(jobs).then(() => {});
}

export interface Scheduled {
  feed: string; trip: string; stop: string; seq: number; t: number;
  route: string; dir?: number; start?: string; date: string;
}

export type Prediction =
  | { kind: 'live'; t: number }
  | { kind: 'cancelled' }
  | { kind: 'skipped' }
  | { kind: 'passed' };

/**
 * The ids a realtime feed may use for a timetable trip: its own, or a tail of it (the MTA:
 * "…Weekday-00_072650_1..N03R" → "072650_1..N03R"), sometimes without the route variant after
 * the direction ("…_069600_7..N35R" → "069600_7..N").
 */
export function* tripIds(trip: string): Generator<string> {
  yield trip;
  for (let i = trip.indexOf('_'); i >= 0; i = trip.indexOf('_', i + 1)) {
    const tail = trip.slice(i + 1);
    yield tail;
    const short = tail.replace(/(\.\.[NS]).+$/, '$1');
    if (short !== tail) yield short;
  }
}

function findTrip(d: Scheduled, now: number): TripState | undefined {
  const copies = store.get(d.feed);
  if (!copies) return undefined;
  for (const c of copies.values()) {
    if (now - c.at > STALE_S) continue;
    let st: TripState | undefined;
    for (const id of tripIds(d.trip)) if ((st = c.byTrip.get(id))) break;
    if (!st && d.start && c.byStart.size) st = c.byStart.get(startKey(d.route, d.dir, d.date, d.start)) ?? c.byStart.get(startKey(d.route, undefined, d.date, d.start));
    // The same trip id runs every day: only the run of this service date.
    if (st && st.date && st.date !== d.date) st = undefined;
    if (st) return st;
  }
  return undefined;
}

/** What the realtime feeds say about one timetabled departure, or null if they say nothing. */
export function predict(d: Scheduled, now = Date.now() / 1000): Prediction | null {
  const st = findTrip(d, now);
  if (!st) return null;
  if (st.cancelled) return { kind: 'cancelled' };
  const here = st.stops.find((u) => (u.seq !== undefined ? u.seq === d.seq : u.stop === d.stop));
  if (here) {
    if (here.skipped) return { kind: 'skipped' };
    if (here.time) return { kind: 'live', t: here.time };
    if (here.delay !== undefined) return { kind: 'live', t: d.t + here.delay };
  }
  const seqs = st.stops.filter((u) => u.seq !== undefined);
  if (seqs.length) {
    // Updates only for stops after this one: the vehicle has already been here.
    if (!here && seqs.every((u) => u.seq! > d.seq) && seqs.length === st.stops.length) return { kind: 'passed' };
    // A delay at an earlier stop carries on to later ones.
    const before = seqs.filter((u) => u.seq! < d.seq && u.delay !== undefined).pop();
    if (before) return { kind: 'live', t: d.t + before.delay! };
  }
  if (st.delay !== undefined) return { kind: 'live', t: d.t + st.delay };
  return null;
}

export interface LiveCall { trip: string; route?: string; dir?: number; stop: string; t: number; last?: string }

/**
 * Every predicted call at these stops, from fresh copies of a feed's trip updates. Used to find
 * trips the timetable doesn't have (added trips: some metros run mostly on them).
 */
export function liveCalls(feedId: string, stops: Set<string>, now = Date.now() / 1000): LiveCall[] {
  const out: LiveCall[] = [];
  for (const c of store.get(feedId)?.values() ?? []) {
    if (now - c.at > STALE_S) continue;
    for (const st of c.byTrip.values()) {
      if (st.cancelled) continue;
      const last = st.stops[st.stops.length - 1]?.stop;
      for (const u of st.stops) {
        if (u.stop && u.time && !u.skipped && stops.has(u.stop)) out.push({ trip: st.trip!, route: st.route, dir: st.dir, stop: u.stop, t: u.time, last });
      }
    }
  }
  return out;
}
