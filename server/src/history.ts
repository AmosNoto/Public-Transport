// Time-lapse history: every place keeps its recent live positions (HISTORY_MINUTES, default 60),
// whether or not anyone is watching, so a viewer can replay the last hour of any city.
//
// Raw fixes are stored compactly (struct of arrays, ~30 bytes each, in fixed-size chunks that
// are dropped whole as they age out), at most one per vehicle every HISTORY_STEP_S seconds.
// Replaying runs them through a fresh snapper, exactly like live data, so the dots follow the
// same routes the same way.

import type { VehicleFix } from './types.ts';

const CHUNK = 1024;

class Chunk {
  n = 0;
  readonly t = new Uint32Array(CHUNK);
  readonly lat = new Float32Array(CHUNK);
  readonly lon = new Float32Array(CHUNK);
  readonly vid = new Uint32Array(CHUNK);
  readonly trip = new Uint32Array(CHUNK);
  readonly route = new Uint32Array(CHUNK);
  readonly feed = new Uint16Array(CHUNK);
  readonly dir = new Int8Array(CHUNK);
  readonly stopped = new Uint8Array(CHUNK);
  readonly speed = new Float32Array(CHUNK);
  /** Progress-reported vehicles (no coordinates): last stop and when, next stops and arrivals.
   *  Allocated only in chunks that hold such vehicles. */
  prog?: { at: Uint32Array; atTs: Uint32Array; nx: Uint32Array; nt: Uint32Array };
}

/** Interned strings (vehicle, trip, route ids), so each record stores small numbers. */
class Strings {
  private ids = new Map<string, number>();
  readonly list: string[] = [''];
  id(s: string | undefined): number {
    if (!s) return 0;
    let i = this.ids.get(s);
    if (i === undefined) { i = this.list.length; this.list.push(s); this.ids.set(s, i); }
    return i;
  }
  get size() { return this.list.length; }
}

export class History {
  private chunks: Chunk[] = [];
  private strings = new Strings();
  private lastAt = new Map<number, number>();

  constructor(private windowS: number, private stepS: number) {}

  /** Record fixes (only vehicles in service, at most one per vehicle per step). */
  add(fixes: VehicleFix[]) {
    for (const f of fixes) {
      if (!f.tripId && !f.routeId) continue;
      const vid = this.strings.id(`${f.feed}:${f.vid}`);
      const t = Math.round(f.ts);
      const last = this.lastAt.get(vid);
      if (last !== undefined && t - last < this.stepS) continue;
      this.lastAt.set(vid, t);
      let c = this.chunks[this.chunks.length - 1];
      if (!c || c.n === CHUNK) { c = new Chunk(); this.chunks.push(c); }
      const i = c.n++;
      c.t[i] = t; c.lat[i] = f.lat; c.lon[i] = f.lon; c.vid[i] = vid;
      c.trip[i] = this.strings.id(f.tripId); c.route[i] = this.strings.id(f.routeId);
      c.feed[i] = this.strings.id(f.feed);
      c.dir[i] = f.directionId ?? -1; c.stopped[i] = f.stopped ? 1 : 0; c.speed[i] = f.speed ?? NaN;
      const pr = f.progress;
      if (pr) {
        const g = (c.prog ??= { at: new Uint32Array(CHUNK), atTs: new Uint32Array(CHUNK), nx: new Uint32Array(CHUNK * 3), nt: new Uint32Array(CHUNK * 3) });
        g.at[i] = this.strings.id(pr.at); g.atTs[i] = pr.atTs ?? 0;
        for (let k = 0; k < 3; k++) { g.nx[i * 3 + k] = this.strings.id(pr.next[k]?.[0]); g.nt[i * 3 + k] = pr.next[k]?.[1] ?? 0; }
      }
    }
  }

  /** Drop chunks entirely older than the window; restart interning when nothing is left. */
  trim(now = Date.now() / 1000) {
    while (this.chunks.length > 1 && this.chunks[0].t[this.chunks[0].n - 1] < now - this.windowS) this.chunks.shift();
    if (this.chunks.length === 1 && this.chunks[0].n && this.chunks[0].t[this.chunks[0].n - 1] < now - this.windowS) this.chunks = [];
    if (!this.chunks.length && this.strings.size > 1) { this.strings = new Strings(); this.lastAt.clear(); }
  }

  get bytes() { return this.chunks.reduce((n, c) => n + CHUNK * (c.prog ? 62 : 30), 0); }
  get oldest(): number | null { return this.chunks.length && this.chunks[0].n ? this.chunks[0].t[0] : null; }

  /** Fixes from `from` (epoch s) on, oldest first, in buckets of `bucketS` seconds. */
  batches(from: number, bucketS = 10): { t: number; fixes: VehicleFix[] }[] {
    const L = this.strings.list;
    const all: VehicleFix[] = [];
    for (const c of this.chunks) {
      for (let i = 0; i < c.n; i++) {
        const t = c.t[i];
        if (t < from) continue;
        const key = L[c.vid[i]], feed = L[c.feed[i]];
        const fix: VehicleFix = {
          feed, vid: key.slice(feed.length + 1), tripId: L[c.trip[i]] || undefined, routeId: L[c.route[i]] || undefined,
          directionId: c.dir[i] >= 0 ? c.dir[i] : undefined, lat: c.lat[i], lon: c.lon[i], ts: t,
          speed: Number.isNaN(c.speed[i]) ? undefined : c.speed[i], stopped: c.stopped[i] === 1,
        };
        const g = c.prog;
        if (g && Number.isNaN(c.lat[i])) {
          const next: [string, number][] = [];
          for (let k = 0; k < 3; k++) if (g.nx[i * 3 + k]) next.push([L[g.nx[i * 3 + k]], g.nt[i * 3 + k]]);
          fix.progress = { at: L[g.at[i]] || undefined, atTs: g.atTs[i] || undefined, next };
        }
        all.push(fix);
      }
    }
    all.sort((a, b) => a.ts - b.ts);
    const out: { t: number; fixes: VehicleFix[] }[] = [];
    for (const f of all) {
      const t = Math.floor(f.ts / bucketS) * bucketS + bucketS;
      if (!out.length || out[out.length - 1].t !== t) out.push({ t, fixes: [] });
      out[out.length - 1].fixes.push(f);
    }
    return out;
  }
}
