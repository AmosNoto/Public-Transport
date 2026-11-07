// Live vehicle state for one city: snapping to shapes, speed estimation, change tracking.

import { projectOnto, toRel } from './geo.ts';
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

export class LiveCity {
  readonly vehicles = new Map<string, VehicleState>();
  constructor(readonly idx: CityIndex) {}

  /** Apply a batch of fixes; returns the vehicles that changed. */
  apply(fixes: VehicleFix[]): VehicleState[] {
    const changed: VehicleState[] = [];
    const ix = this.idx;
    for (const f of fixes) {
      const key = `${f.feed}:${f.vid}`;
      const prev = this.vehicles.get(key);
      if (prev && prev.ts >= f.ts) continue;

      let route = f.tripId !== undefined ? ix.tripRoute.get(`${f.feed}:${f.tripId}`) : undefined;
      if (route === undefined && f.routeId) route = ix.routeIdx.get(`${f.feed}:${f.routeId}`);
      if (route === undefined) continue; // unknown route: nothing honest to colour it with
      let shape = f.tripId !== undefined ? ix.tripShape.get(`${f.feed}:${f.tripId}`) : undefined;
      if (shape === undefined && f.routeId !== undefined) shape = ix.defaultShape.get(`${f.feed}:${f.routeId}:${f.directionId ?? 0}`);

      const mode = ix.routes[route].mode;
      let d = 0, flags = f.stopped ? FLAG_STOPPED : 0;
      if (shape !== undefined) {
        const sameShape = prev && prev.shape === shape;
        const hint = sameShape ? prev.d + prev.v * Math.min(60, f.ts - prev.ts) : undefined;
        const p = projectOnto(ix.polylines[shape], f.lat, f.lon, hint);
        if (p.off <= SNAP_MAX_M) { d = p.d; flags |= FLAG_SNAPPED; } else shape = undefined;
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
    const now = Date.now() / 1000;
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
