// Live vehicle state for one city: snapping to shapes, speed estimation, change tracking.

import { projectOnto, toRel, type Polyline } from './geo.ts';
import type { CityIndex } from './static/gtfs.ts';
import type { Mode, VehicleFix } from './types.ts';

/** Typical in-service speeds (m/s), used until a vehicle has two fixes to measure from. */
const PRIOR_SPEED: Record<Mode, number> = { subway: 10, rail: 16, bus: 5, tram: 6 };
const MAX_SPEED: Record<Mode, number> = { subway: 30, rail: 55, bus: 30, tram: 25 };
/** A fix further than this from its shape is drawn where it is, unsnapped. */
const SNAP_MAX_M = 120;
/** Forget vehicles not heard from for this long (the client has faded them out by then). */
const FORGET_S = 300;

export const FLAG_STOPPED = 1;
export const FLAG_SNAPPED = 2;
/** Placed from the timetable, not a live position. */
export const FLAG_SCHEDULED = 4;

export interface VehicleState {
  key: string;
  vid: string;
  label?: string;
  route: number;
  shape: number;
  /** Distance along the shape (m) at `ts`. */
  d: number;
  /** Estimated speed along the shape (m/s). */
  v: number;
  ts: number;
  rx: number;
  ry: number;
  flags: number;
  tripId?: string;
  stopId?: string;
}

/** Compact wire form: [key, route, shape, d, v, ts, rx, ry, flags]. */
export type WireVehicle = [string, number, number, number, number, number, number, number, number];

export function toWire(s: VehicleState): WireVehicle {
  return [s.key, s.route, s.shape, Math.round(s.d * 10) / 10, Math.round(s.v * 100) / 100, s.ts, s.rx, s.ry, s.flags];
}

/** A stop must be this close to a shape to count as on it (metres). */
const STOP_ON_SHAPE_M = 150;
/** Placing a train before its next stop, never look back further than this (metres). */
const MAX_LOOKBACK_M = 2500;

/** Point at distance d along a polyline. */
function pointAt(pl: Polyline, d: number): { lat: number; lon: number } {
  const c = pl.cum, n = c.length;
  if (d <= 0 || n < 2) return { lat: pl.lat[0], lon: pl.lon[0] };
  if (d >= c[n - 1]) return { lat: pl.lat[n - 1], lon: pl.lon[n - 1] };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= d) lo = mid; else hi = mid; }
  const t = c[hi] > c[lo] ? (d - c[lo]) / (c[hi] - c[lo]) : 0;
  return { lat: pl.lat[lo] + (pl.lat[hi] - pl.lat[lo]) * t, lon: pl.lon[lo] + (pl.lon[hi] - pl.lon[lo]) * t };
}

export class LiveCity {
  readonly vehicles = new Map<string, VehicleState>();
  /** Stop coordinates by `${feed}:${stop_id}`, loaded for feeds that report progress, not positions. */
  stops: Map<string, [number, number]> | null = null;
  private stopOnShape = new Map<string, { d: number; off: number }>();
  /** Shape indices per route, for trips the timetable doesn't know (added or detoured trips). */
  private routeShapes = new Map<number, number[]>();
  constructor(readonly idx: CityIndex) {
    idx.shapes.forEach((sh, i) => {
      let a = this.routeShapes.get(sh.route);
      if (!a) this.routeShapes.set(sh.route, (a = []));
      a.push(i);
    });
  }

  /** Where a stop falls along a shape (cached). */
  private stopAlong(feed: string, stop: string, shape: number): { d: number; off: number } | null {
    const k = `${shape}|${feed}:${stop}`;
    let r = this.stopOnShape.get(k);
    if (!r) {
      const c = this.stops?.get(`${feed}:${stop}`);
      if (!c) return null;
      r = projectOnto(this.idx.polylines[shape], c[0], c[1]);
      this.stopOnShape.set(k, r);
    }
    return r.off <= STOP_ON_SHAPE_M ? r : null;
  }

  /**
   * Place a vehicle reported by progress (last stop, upcoming arrivals) on one of its shapes:
   * the shape on which its stops come in the right order, at the distance its timing implies.
   */
  private byProgress(f: VehicleFix, cands: number[], speedMax: number, prior: number, now: number): { shape: number; d: number; v: number; stopped: boolean } | null {
    const p = f.progress!;
    if (!this.stops) return null;
    const next = p.next, at = p.at;
    const stoppedHere = !!at && (!next.length || next[0][0] === at);
    for (const c of cands) {
      if (stoppedHere) {
        const s = this.stopAlong(f.feed, at!, c);
        if (s) return { shape: c, d: s.d, v: 0, stopped: true };
        continue;
      }
      const s0 = this.stopAlong(f.feed, next[0][0], c);
      if (!s0) continue;
      const s1 = next[1] ? this.stopAlong(f.feed, next[1][0], c) : null;
      const sa = at ? this.stopAlong(f.feed, at, c) : null;
      // Direction: the next stops (or the last one and the next) must come in order along it.
      if (next[1] && (!s1 || s1.d <= s0.d)) continue;
      if (at && (!sa || sa.d >= s0.d)) continue;
      const a0 = next[0][1];
      if (sa) {
        // Left `at` around its timestamp, due at the next stop at a0: in between, by time.
        const t0 = Math.min(p.atTs ?? f.ts, a0 - 20), span = Math.max(20, a0 - t0);
        const v = Math.min(speedMax, Math.max(1, (s0.d - sa.d) / span));
        return { shape: c, d: sa.d + (s0.d - sa.d) * Math.min(1, Math.max(0, (now - t0) / span)), v, stopped: false };
      }
      // Only the arrivals known: back off from the next stop by the time still to go.
      const v = s1 ? Math.min(speedMax, Math.max(1, (s1.d - s0.d) / Math.max(30, next[1][1] - a0))) : prior;
      return { shape: c, d: Math.max(0, s0.d - Math.min(MAX_LOOKBACK_M, v * Math.max(0, a0 - now))), v, stopped: false };
    }
    return null;
  }

  /** Apply a batch of fixes; returns the vehicles that changed. `now` is passed when replaying history. */
  apply(fixes: VehicleFix[], now = Date.now() / 1000): VehicleState[] {
    const changed: VehicleState[] = [];
    const ix = this.idx;
    for (const f of fixes) {
      const key = `${f.feed}:${f.vid}`;
      const prev = this.vehicles.get(key);
      if (prev && prev.ts >= f.ts) continue;

      let route = f.tripId !== undefined ? ix.tripRoute.get(`${f.feed}:${f.tripId}`) : undefined;
      if (route === undefined && f.routeId) route = ix.routeIdx.get(`${f.feed}:${f.routeId}`);
      // Feeds with no timetable have one stand-in route for all their vehicles.
      if (route === undefined) route = ix.routeIdx.get(`${f.feed}:*`);
      if (route === undefined) continue; // unknown route: nothing honest to colour it with
      const tripShape = f.tripId !== undefined ? ix.tripShape.get(`${f.feed}:${f.tripId}`) : undefined;
      // Candidate shapes: the trip's own; otherwise (trips added or changed in real time) the
      // shape it was on last time, the route's usual shape for its direction, then any shape
      // of the route. The first one within snapping distance wins, so it doesn't flip between
      // overlapping variants.
      let cands: number[];
      if (tripShape !== undefined) cands = [tripShape];
      else {
        const routeId = f.routeId ?? ix.routes[route].id;
        const dir = f.directionId !== undefined ? ix.dirShapes.get(`${f.feed}:${routeId}:${f.directionId}`) ?? [] : [];
        const all = this.routeShapes.get(route) ?? [];
        cands = [...new Set([...(prev && prev.route === route && prev.shape >= 0 ? [prev.shape] : []), ...dir, ...all])];
      }

      const mode = ix.routes[route].mode;
      let d = 0, flags = f.stopped ? FLAG_STOPPED : 0;
      let shape: number | undefined;
      if (f.progress && !Number.isFinite(f.lat)) {
        // Reported by progress between stops: place it from its timing, then carry on as usual.
        const pr = this.byProgress(f, cands, MAX_SPEED[mode], PRIOR_SPEED[mode], now);
        if (!pr) continue;
        const pt = pointAt(ix.polylines[pr.shape], pr.d);
        const [rx, ry] = toRel(ix.def.origin, pt.lon, pt.lat);
        const s: VehicleState = {
          key, vid: f.vid, label: f.label, route, shape: pr.shape, d: pr.d, v: pr.v, ts: Math.max(f.ts, Math.min(now, f.ts + 120)), rx, ry,
          flags: FLAG_SNAPPED | (pr.stopped ? FLAG_STOPPED : 0), tripId: f.tripId, stopId: f.stopId,
        };
        this.vehicles.set(key, s);
        changed.push(s);
        continue;
      }
      for (const c of cands) {
        const sameShape = prev && prev.shape === c;
        const hint = sameShape ? prev.d + prev.v * Math.min(60, f.ts - prev.ts) : undefined;
        const p = projectOnto(ix.polylines[c], f.lat, f.lon, hint);
        if (p.off <= SNAP_MAX_M) { shape = c; d = p.d; flags |= FLAG_SNAPPED; break; }
      }

      let v: number;
      if (prev && shape !== undefined && prev.shape === shape && f.ts - prev.ts < 180) {
        const inst = Math.min(MAX_SPEED[mode], Math.max(0, (d - prev.d) / (f.ts - prev.ts)));
        // Blend with the previous estimate; a stop dwell shouldn't erase the running speed.
        v = f.stopped ? prev.v : prev.v * 0.4 + inst * 0.6;
        if (f.speed !== undefined && f.speed > 0.5 && f.speed < MAX_SPEED[mode]) v = v * 0.5 + f.speed * 0.5;
      } else {
        v = f.speed !== undefined && f.speed > 0.5 && f.speed < MAX_SPEED[mode] ? f.speed : PRIOR_SPEED[mode];
      }

      const [rx, ry] = toRel(ix.def.origin, f.lon, f.lat);
      const s: VehicleState = {
        key, vid: f.vid, label: f.label, route, shape: shape ?? -1, d, v, ts: f.ts, rx, ry, flags,
        tripId: f.tripId, stopId: f.stopId,
      };
      this.vehicles.set(key, s);
      changed.push(s);
    }
    for (const [k, s] of this.vehicles) if (now - s.ts > FORGET_S) this.vehicles.delete(k);
    return changed;
  }

  /** Vehicles heard from in the last few minutes. */
  activeCount(now = Date.now() / 1000): number {
    let n = 0;
    for (const s of this.vehicles.values()) if (now - s.ts < 180) n++;
    return n;
  }
}
