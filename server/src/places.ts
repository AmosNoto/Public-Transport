// Every place on the map, from discovery to unload.
//
// - Live sources are polled from startup, whether or not anyone is looking: their raw positions
//   drive the counters and decide which timetables get built first. Unwatched feeds are polled
//   slowly (IDLE_POLL_INTERVAL_S), watched ones at POLL_INTERVAL_S.
// - Timetables are built in the background, one at a time in a worker thread, and cached on
//   disk: places someone is flying to first, then curated cities, then catalog places by how
//   many vehicles they're reporting. Each place is rebuilt when its timetable changes (checked
//   daily).
// - A place's full index (needed to snap vehicles to routes and to run its timetable) is loaded
//   only while someone is watching it, and dropped a few minutes after they leave.

import { Worker } from 'node:worker_threads';
import type { WebSocket } from 'ws';
import { config } from './config.ts';
import { loadIndex, readSummary, type CityIndex, type CitySummary } from './static/gtfs.ts';
import { LiveCity, type VehicleState } from './live.ts';
import { FeedFallback, FORCED } from './fallback.ts';
import { gtfsRtAdapter } from './adapters/gtfs-rt.ts';
import { hslMqttAdapter } from './adapters/hsl-mqtt.ts';
import type { SourceAdapter } from './adapters/types.ts';
import type { CityDef, FeedDef, FeedHealth, RealtimeDef, VehicleFix } from './types.ts';

/** A vehicle counts as live if heard from this recently. */
export const LIVE_WINDOW_S = 180;
/** Raw positions older than this are dropped. */
const FORGET_S = 300;
/** Keep a place's index loaded this long after its last viewer leaves. */
const LINGER_S = 180;
/** Revalidate each timetable about this often. */
const REVALIDATE_S = 24 * 3600;
/** After a failed build, try again after this long. */
const RETRY_S = 6 * 3600;
/** Give live feeds this long after startup to report, before ranking catalog builds by them. */
const WARMUP_S = 45;

export type PlaceState = 'queued' | 'building' | 'ready' | 'error' | 'skipped';

export class Place {
  state: PlaceState = 'queued';
  summary: CitySummary | null = null;
  error?: string;
  retryAt = 0;
  building = false;
  /** When a viewer last asked for this place to be prepared (builds jump the queue). */
  wantedAt = 0;
  index?: CityIndex;
  live?: LiveCity;
  fallbacks: FeedFallback[] = [];
  loading?: Promise<boolean>;
  readonly subscribers = new Set<WebSocket>();
  lastUsed = 0;
  /** Latest raw fix per vehicle, from every source, whether or not the index is loaded. */
  readonly raw = new Map<string, VehicleFix>();
  readonly adapters: SourceAdapter[] = [];
  /** Compact glow, built on first request. */
  glowBin?: Buffer;
  waiters: (() => void)[] = [];
  private box: [number, number, number, number] | null = null;

  constructor(readonly def: CityDef) {}

  get located() { return Number.isFinite(this.def.origin.lon) && Number.isFinite(this.def.origin.lat); }
  get hasLive() { return this.def.feeds.some((f) => f.realtime?.length); }

  setSummary(s: CitySummary) {
    this.summary = s;
    this.def.origin = s.origin;
    this.def.tz = s.tz;
    // Count raw vehicles inside the area the place draws (curated filters narrow national feeds).
    const filt = this.def.feeds.map((f) => f.filter?.bbox).filter(Boolean) as [number, number, number, number][];
    const b = filt.length === this.def.feeds.length && filt.length ? filt.reduce((a, x) => [Math.min(a[0], x[0]), Math.min(a[1], x[1]), Math.max(a[2], x[2]), Math.max(a[3], x[3])]) : s.bbox;
    this.box = [b[0] - 0.02, b[1] - 0.02, b[2] + 0.02, b[3] + 0.02];
    this.glowBin = undefined;
  }

  liveCount(now = Date.now() / 1000): number {
    if (this.live) return this.live.activeCount(now);
    let n = 0;
    const b = this.box;
    for (const f of this.raw.values()) {
      if (now - f.ts >= LIVE_WINDOW_S) continue;
      // Vehicles reporting no trip or route are out of service (in a depot, deadheading).
      if (!f.tripId && !f.routeId) continue;
      if (b && (f.lon < b[0] || f.lon > b[2] || f.lat < b[1] || f.lat > b[3])) continue;
      n++;
    }
    return n;
  }

  scheduledCount(): number { return this.fallbacks.reduce((n, f) => n + f.shown.size, 0); }
}

type Broadcast = (p: Place, changed: VehicleState[], gone: string[]) => void;

export class Places {
  readonly all = new Map<string, Place>();
  readonly health = new Map<string, FeedHealth>();
  private readonly started = Date.now() / 1000;
  private running = 0;

  constructor(private broadcast: Broadcast) {
    setInterval(() => this.tick(), 10_000);
    setInterval(() => this.pump(), 2_000);
  }

  /** Register a place: health records, live sources, and its last build if there is one. */
  async add(def: CityDef) {
    if (this.all.has(def.id)) return;
    const p = new Place(def);
    this.all.set(def.id, p);
    const s = await readSummary(def.id);
    if (s) { p.setSummary(s); p.state = 'ready'; }
    for (const feed of def.feeds) {
      const license = feed.license.url ?? null;
      if (!feed.realtime?.length) {
        this.health.set(feed.id, { feed: feed.id, city: def.id, provider: feed.agency, license, state: 'timetable', detail: feed.note, vehicles: 0, polls: 0, failures: 0 });
        continue;
      }
      for (const src of feed.realtime) this.startSource(p, feed, src, license);
    }
  }

  private startSource(p: Place, feed: FeedDef, src: RealtimeDef, license: string | null) {
    const h: FeedHealth = { feed: src.id, city: p.def.id, provider: src.provider ?? feed.agency, license, state: 'starting', vehicles: 0, polls: 0, failures: 0 };
    this.health.set(src.id, h);
    if (FORCED.has(feed.id)) { h.state = 'timetable'; h.detail = 'forced to the timetable (FORCE_SCHEDULED)'; return; }
    let url = src.url;
    const headers: Record<string, string> = { ...src.headers };
    if (src.key) {
      const key = config.key(src.key.env);
      if (!key) { h.state = 'no-key'; h.detail = `set ${src.key.env} to enable (see KEYS.md)`; return; }
      if (src.key.param) { const u = new URL(url); u.searchParams.set(src.key.param, key); url = u.toString(); }
      if (src.key.header) headers[src.key.header] = key;
    }
    const a = src.kind === 'hsl-mqtt' ? hslMqttAdapter() : gtfsRtAdapter();
    a.start({
      cityId: p.def.id, feed, source: src, url, headers,
      intervalS: () => (p.subscribers.size ? config.pollIntervalS : config.idlePollIntervalS),
      emit: (fixes) => this.onFixes(p, fixes),
      health: (patch) => Object.assign(h, patch),
    });
    p.adapters.push(a);
  }

  private onFixes(p: Place, fixes: VehicleFix[]) {
    for (const f of fixes) {
      const k = `${f.feed}:${f.vid}`;
      const prev = p.raw.get(k);
      if (!prev || f.ts > prev.ts) p.raw.set(k, f);
    }
    if (p.live) this.broadcast(p, p.live.apply(fixes), []);
  }

  sourcesOf(feed: FeedDef): FeedHealth[] {
    return (feed.realtime ?? []).map((s) => this.health.get(s.id)).filter((h): h is FeedHealth => !!h);
  }

  /** A viewer is heading here: build its timetable next if it isn't built yet. */
  want(p: Place) {
    p.wantedAt = Date.now() / 1000;
    this.pump();
  }

  /** Load the full index (building first if needed). False if the place can't be shown. */
  ensureLoaded(p: Place): Promise<boolean> {
    p.lastUsed = Date.now() / 1000;
    if (p.live) return Promise.resolve(true);
    if (p.loading) return p.loading;
    p.loading = (async () => {
      if (!p.summary) {
        if (p.state === 'skipped' || p.state === 'error') return false;
        this.want(p);
        await new Promise<void>((r) => p.waiters.push(r));
        if (!p.summary) return false;
      }
      const ix = await loadIndex(p.def, p.summary);
      p.index = ix;
      p.live = new LiveCity(ix);
      p.live.apply([...p.raw.values()].sort((a, b) => a.ts - b.ts));
      p.fallbacks = p.def.feeds.map((f) => new FeedFallback(ix, f, () => this.sourcesOf(f)));
      for (const a of p.adapters) a.poke?.();
      console.log(`[load] ${p.def.id}: index loaded (${ix.routes.length} routes)`);
      return true;
    })().catch((e) => { console.error(`[load] ${p.def.id} failed:`, e); return false; })
      .finally(() => { p.loading = undefined; });
    return p.loading;
  }

  private unload(p: Place) {
    p.index = undefined;
    p.live = undefined;
    p.fallbacks = [];
    console.log(`[load] ${p.def.id}: unloaded`);
  }

  /** Timetable fallback, idle unloading, raw-position pruning. */
  private tick() {
    const now = Date.now() / 1000;
    for (const p of this.all.values()) {
      for (const [k, f] of p.raw) if (now - f.ts > FORGET_S) p.raw.delete(k);
      if (!p.live) continue;
      if (p.subscribers.size) p.lastUsed = now;
      else if (now - p.lastUsed > LINGER_S && !p.loading) { this.unload(p); continue; }
      for (const fb of p.fallbacks) {
        const { changed, gone } = fb.tick(now);
        if (changed.length || gone.length) this.broadcast(p, changed, gone);
      }
    }
  }

  // ---- background builds -------------------------------------------------------------

  private rank(p: Place, now: number): number | null {
    if (p.building) return null;
    const wanted = now - p.wantedAt < 300;
    if (p.state === 'skipped') return null;
    if (p.state === 'error') return now > p.retryAt ? (wanted ? 0 : 6) : null;
    if (p.state === 'queued') {
      if (wanted) return 0;
      if (p.def.source === 'curated') return 1;
      if (now - this.started < WARMUP_S) return null;
      // Catalog places: those reporting vehicles first, the most active first.
      return p.raw.size ? 2 + 1 / (1 + p.liveCount(now)) : 4;
    }
    // Ready: revalidate once a day (a cheap 304 when nothing changed).
    if (p.summary && now - (p.summary.checkedAt ?? p.summary.builtAt) > REVALIDATE_S && now > p.retryAt) return wanted ? 0 : 5;
    return null;
  }

  /** Start the next build: one at a time, plus one more slot for places a viewer is waiting on. */
  private pump() {
    const now = Date.now() / 1000;
    let best: Place | null = null, bestR = Infinity;
    for (const p of this.all.values()) {
      const r = this.rank(p, now);
      if (r !== null && r < bestR) { best = p; bestR = r; }
    }
    if (!best) return;
    if (this.running >= 2 || (this.running >= 1 && bestR >= 1)) return;
    void this.build(best);
  }

  private build(p: Place): Promise<void> {
    p.building = true;
    if (!p.summary) p.state = 'building';
    this.running++;
    const t0 = Date.now();
    return new Promise<void>((resolve) => {
      // A heap cap per build: a timetable too big to index fails alone instead of starving the server.
      const w = new Worker(new URL('./static/buildWorker.ts', import.meta.url), {
        workerData: { city: p.def }, resourceLimits: { maxOldGenerationSizeMb: config.buildMemoryMb },
      });
      let done = false;
      const finish = (m: { ok: boolean; summary?: CitySummary; error?: string; tooLarge?: boolean }) => {
        if (done) return;
        done = true;
        void w.terminate();
        const now = Date.now() / 1000;
        if (m.ok && m.summary) {
          const changed = p.summary?.dir !== m.summary.dir;
          p.setSummary(m.summary);
          p.state = 'ready';
          p.error = undefined;
          if (changed) {
            const s = m.summary;
            console.log(`[static] ${p.def.id}: ${s.routes} routes, ${s.shapes} shapes, ${s.trips} trips (${(s.bytes / 1e6).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
          }
        } else if (m.tooLarge) {
          p.state = 'skipped';
          p.error = m.error;
          for (const a of p.adapters) a.stop();
          p.adapters.length = 0;
          p.raw.clear();
          for (const f of p.def.feeds) for (const h of this.sourcesOf(f)) { h.state = 'skipped'; h.detail = m.error; }
          console.log(`[static] ${p.def.id}: skipped, ${m.error}`);
        } else {
          p.error = m.error;
          p.retryAt = now + RETRY_S;
          if (!p.summary) p.state = 'error';
          console.warn(`[static] ${p.def.id}: ${m.error}`);
        }
        p.building = false;
        this.running--;
        for (const r of p.waiters.splice(0)) r();
        resolve();
        setImmediate(() => this.pump());
      };
      w.once('message', finish);
      w.once('error', (e: Error & { code?: string }) => finish(e.code === 'ERR_WORKER_OUT_OF_MEMORY'
        ? { ok: false, tooLarge: true, error: `needs more than ${config.buildMemoryMb} MB to index (BUILD_MEMORY_MB)` }
        : { ok: false, error: e.message }));
      w.once('exit', (code) => finish({ ok: false, error: `build worker exited (${code})` }));
    });
  }

  /** Builds in progress and how many places are still waiting for their first build. */
  progress() {
    let queued = 0, ready = 0, failed = 0, skipped = 0;
    const building: string[] = [];
    for (const p of this.all.values()) {
      if (p.building) building.push(p.def.id);
      if (p.state === 'ready') ready++;
      else if (p.state === 'queued' || p.state === 'building') queued++;
      else if (p.state === 'error') failed++;
      else skipped++;
    }
    return { ready, queued, failed, skipped, building };
  }
}
