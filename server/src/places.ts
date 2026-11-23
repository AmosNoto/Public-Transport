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
import fs from 'node:fs/promises';
import path from 'node:path';
import { placeName } from './geonames.ts';
import type { Region } from './static/split.ts';
import type { WebSocket } from 'ws';
import { config } from './config.ts';
import { loadIndex, loadStops, readSummary, type CityIndex, type CitySummary } from './static/gtfs.ts';
import { LiveCity, type VehicleState } from './live.ts';
import { History } from './history.ts';
import { FeedFallback, FORCED } from './fallback.ts';
import { gtfsRtAdapter } from './adapters/gtfs-rt.ts';
import { hslMqttAdapter } from './adapters/hsl-mqtt.ts';
import type { SourceAdapter } from './adapters/types.ts';
import type { CityDef, FeedDef, FeedHealth, RealtimeDef, RouteInfo, VehicleFix } from './types.ts';
import { asInk, rgbToOklch, spectralHue, vivid } from './color.ts';

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
  /** Recent live positions, for time-lapse. */
  readonly history = new History(config.historyMinutes * 60, config.historyStepS);
  /** Some source reports progress between stops rather than coordinates (needs stop positions). */
  progress = false;
  /** Compact glow, built on first request. */
  glowBin?: Buffer;
  waiters: (() => void)[] = [];
  private box: [number, number, number, number] | null = null;
  /** The area the place covers: its feeds' filter box when every feed is filtered (a national feed
   *  narrowed to one metro, whose routes may still run far beyond it), else the timetable's extent. */
  area: [number, number, number, number] | null = null;

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
    this.area = b;
    this.box = [b[0] - 0.02, b[1] - 0.02, b[2] + 0.02, b[3] + 0.02];
    this.glowBin = undefined;
  }

  liveCount(now = Date.now() / 1000): number {
    if (this.live) return this.live.activeCount(now);
    let n = 0;
    const b = this.box;
    for (const f of this.raw.values()) {
      if (now - f.ts >= LIVE_WINDOW_S) continue;
      // Vehicles reporting no trip or route are out of service (in a depot, deadheading); feeds
      // with no timetable often send neither, so there every vehicle counts.
      if (!f.tripId && !f.routeId && !this.def.positionsOnly) continue;
      if (b && (f.lon < b[0] || f.lon > b[2] || f.lat < b[1] || f.lat > b[3])) continue;
      n++;
    }
    return n;
  }

  scheduledCount(): number { return this.fallbacks.reduce((n, f) => n + f.shown.size, 0); }

  /** A place cut from a bigger feed (a metro, a region) keeps only vehicles near its own area. */
  keeps(f: VehicleFix): boolean {
    const filt = this.def.feeds.every((x) => x.filter?.bbox) ? this.def.feeds[0].filter!.bbox! : null;
    if (!filt || !Number.isFinite(f.lat)) return true;
    const m = 0.3;
    return f.lon >= filt[0] - m && f.lon <= filt[2] + m && f.lat >= filt[1] - m && f.lat <= filt[3] + m;
  }
}

/**
 * Stand-in index for a place with no timetable: one "route" per feed (so its dots get a colour
 * and a name), no shapes, so every vehicle is drawn where it reports itself.
 */
function positionsIndex(p: Place): CityIndex {
  const routes: RouteInfo[] = p.def.feeds.map((f) => {
    let h = 0;
    for (const ch of f.id + f.agency) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const light = vivid(spectralHue((h % 1000) / 1000));
    return { id: '*', feed: f.id, short: '', long: f.agency, mode: 'bus', light, ink: asInk(rgbToOklch(light)), official: false };
  });
  const a = p.area ?? [p.def.origin.lon, p.def.origin.lat, p.def.origin.lon, p.def.origin.lat];
  return {
    def: p.def, routes, shapes: [], polylines: [], routeIdx: new Map(routes.map((r, i) => [`${r.feed}:*`, i])),
    tripShape: new Map(), tripRoute: new Map(), dirShapes: new Map(), bbox: a,
    points: new Float32Array(0), lineVerts: new Float32Array(0), lineChains: new Uint32Array(0), glow: new Float32Array(0),
  };
}

type Broadcast = (p: Place, changed: VehicleState[], gone: string[]) => void;

export class Places {
  readonly all = new Map<string, Place>();
  readonly health = new Map<string, FeedHealth>();
  private readonly started = Date.now() / 1000;
  private running = 0;
  /** Live sources by id, with every place they feed (regions of one national feed share one). */
  private sources = new Map<string, { places: Set<Place>; adapter: SourceAdapter | null }>();

  constructor(private broadcast: Broadcast) {
    setInterval(() => this.tick(), 10_000);
    setInterval(() => this.pump(), 2_000);
  }

  /** Register a place: health records, live sources, and its last build if there is one. */
  async add(def: CityDef) {
    if (this.all.has(def.id)) return;
    const p = new Place(def);
    this.all.set(def.id, p);
    // A national feed split into regions earlier: use them (the split is redone if they're lost).
    const saved = def.source === 'catalog' && !def.splitFrom ? await this.savedRegions(def.id) : null;
    if (saved) {
      p.state = 'skipped';
      p.error = `national timetable, shown as ${saved.length} regions`;
      for (const r of saved) await this.add(r);
      return;
    }
    const s = def.positionsOnly ? null : await readSummary(def.id);
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
    const shared = this.sources.get(src.id);
    if (shared) {
      shared.places.add(p);
      if (shared.adapter) p.adapters.push(shared.adapter);
      return;
    }
    const entry: { places: Set<Place>; adapter: SourceAdapter | null } = { places: new Set([p]), adapter: null };
    this.sources.set(src.id, entry);
    // A source shared by regions is listed under the national place it belongs to.
    const h: FeedHealth = { feed: src.id, city: p.def.splitFrom ?? p.def.id, provider: src.provider ?? feed.agency, license, state: 'starting', vehicles: 0, polls: 0, failures: 0 };
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
      intervalS: () => ([...entry.places].some((q) => q.subscribers.size) ? config.pollIntervalS : config.idlePollIntervalS),
      emit: (fixes) => { for (const q of entry.places) this.onFixes(q, fixes); },
      health: (patch) => Object.assign(h, patch),
    });
    entry.adapter = a;
    p.adapters.push(a);
  }

  /** Stop feeding a place; a source nobody else uses stops polling. */
  private detach(p: Place) {
    for (const f of p.def.feeds) for (const src of f.realtime ?? []) {
      const e = this.sources.get(src.id);
      if (!e) continue;
      e.places.delete(p);
      if (!e.places.size) { e.adapter?.stop(); this.sources.delete(src.id); }
    }
    p.adapters.length = 0;
    p.raw.clear();
  }

  /** A place with no timetable is wherever its vehicles are: the median of their positions. */
  private locate(p: Place) {
    const lat: number[] = [], lon: number[] = [];
    for (const f of p.raw.values()) if (Number.isFinite(f.lat) && Number.isFinite(f.lon)) { lat.push(f.lat); lon.push(f.lon); }
    if (lat.length < 2) return;
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
    const q = (a: number[], k: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * k))];
    // Box of the middle 96% (one stray GPS fix shouldn't make the place continent-sized).
    p.area = [q(lon, 0.02), q(lat, 0.02), q(lon, 0.98), q(lat, 0.98)];
    if (!p.located) {
      p.def.origin = { lon: Math.round(med(lon) * 1e5) / 1e5, lat: Math.round(med(lat) * 1e5) / 1e5 };
      p.state = 'ready';
      console.log(`[positions] ${p.def.id}: located at ${p.def.origin.lat}, ${p.def.origin.lon} from ${lat.length} vehicles`);
    }
  }

  private onFixes(p: Place, all: VehicleFix[]) {
    const fixes = all.filter((f) => p.keeps(f));
    if (!fixes.length) return;
    p.history.add(fixes);
    if (p.def.positionsOnly && (!p.located || !p.area)) this.locate(p);
    if (!p.progress && fixes.some((f) => f.progress)) {
      p.progress = true;
      if (p.live && !p.live.stops) void this.attachStops(p);
    }
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
      if (p.def.positionsOnly) {
        if (!p.located) return false;
        this.locate(p);
        const ix = positionsIndex(p);
        p.index = ix;
        p.live = new LiveCity(ix);
        p.live.apply([...p.raw.values()].sort((a, b) => a.ts - b.ts));
        p.fallbacks = [];
        return true;
      }
      if (!p.summary) {
        if (p.state === 'skipped' || p.state === 'error') return false;
        this.want(p);
        await new Promise<void>((r) => p.waiters.push(r));
        if (!p.summary) return false;
      }
      const ix = await loadIndex(p.def, p.summary);
      p.index = ix;
      p.live = new LiveCity(ix);
      if (p.progress) await this.attachStops(p);
      p.live.apply([...p.raw.values()].sort((a, b) => a.ts - b.ts));
      p.fallbacks = p.def.feeds.map((f) => new FeedFallback(ix, f, () => this.sourcesOf(f)));
      for (const a of p.adapters) a.poke?.();
      console.log(`[load] ${p.def.id}: index loaded (${ix.routes.length} routes)`);
      return true;
    })().catch((e) => { console.error(`[load] ${p.def.id} failed:`, e); return false; })
      .finally(() => { p.loading = undefined; });
    return p.loading;
  }

  /** Stop positions for a place whose vehicles are reported by progress between stops. */
  private async attachStops(p: Place) {
    const live = p.live;
    if (!live) return;
    try {
      live.stops = await loadStops(p.def);
      console.log(`[load] ${p.def.id}: ${live.stops.size} stops for progress-reported vehicles`);
    } catch (e) {
      console.warn(`[load] ${p.def.id}: stops unavailable:`, (e as Error).message);
    }
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
      p.history.trim(now);
      if (p.def.positionsOnly) this.locate(p);
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
    if (p.state === 'skipped' || p.def.positionsOnly) return null;
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
        } else if (m.tooLarge && config.maxSplitBytes > 0 && p.def.source === 'catalog' && !p.def.splitFrom && !p.def.positionsOnly) {
          // A national timetable: split it into metro regions rather than skip it.
          p.state = 'skipped';
          p.error = `${m.error}; splitting into regions`;
          this.detach(p);
          console.log(`[static] ${p.def.id}: ${m.error}; splitting into regions`);
          void this.split(p);
        } else if (m.tooLarge) {
          p.state = 'skipped';
          p.error = m.error;
          this.detach(p);
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

  // ---- national feeds split into regions -----------------------------------------------

  private regionsFile(id: string) { return path.join(config.cacheDir, 'built', id, 'regions.json'); }

  private async savedRegions(id: string): Promise<CityDef[] | null> {
    try { return JSON.parse(await fs.readFile(this.regionsFile(id), 'utf8')); } catch { return null; }
  }

  /** Cluster a national feed's stops into regions (in the build worker), name them, add them. */
  private async split(p: Place) {
    const exclude = [...this.all.values()].filter((q) => q.def.source === 'curated' && q.area).map((q) => q.area!);
    const res = await new Promise<{ ok: boolean; split?: { regions: Region[] }; error?: string }>((resolve) => {
      const w = new Worker(new URL('./static/buildWorker.ts', import.meta.url), {
        workerData: { city: p.def, job: 'split', maxBytes: config.maxSplitBytes, exclude }, resourceLimits: { maxOldGenerationSizeMb: config.buildMemoryMb },
      });
      w.once('message', (m) => { void w.terminate(); resolve(m); });
      w.once('error', (e: Error) => resolve({ ok: false, error: e.message }));
    });
    if (!res.ok || !res.split) { p.error = `could not split: ${res.error}`; console.warn(`[split] ${p.def.id}: ${res.error}`); return; }
    const base = p.def, used = new Set<string>(), defs: CityDef[] = [];
    for (const [i, r] of res.split.regions.entries()) {
      const name = (await placeName(r.center.lat, r.center.lon)) ?? `${base.name} ${i + 1}`;
      const slug = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      let id = `${base.id}-${slug || i + 1}`;
      while (used.has(id)) id += '-2';
      used.add(id);
      defs.push({
        id, name, region: base.name, country: base.country, tz: base.tz, origin: r.center, auto: true, source: 'catalog', splitFrom: base.id,
        feeds: base.feeds.map((f) => ({
          ...f,
          // The publisher's own copy first (the catalog mirror can lag), the mirror as fallback.
          static: f.staticAlt ?? f.static, staticAlt: f.staticAlt ? f.static : undefined,
          zipKey: base.id, filter: { ...f.filter, bbox: r.bbox }, maxBytes: config.maxSplitBytes,
        })),
      });
    }
    await fs.mkdir(path.dirname(this.regionsFile(base.id)), { recursive: true });
    await fs.writeFile(this.regionsFile(base.id), JSON.stringify(defs, null, 1));
    p.error = `national timetable, shown as ${defs.length} regions`;
    console.log(`[split] ${base.id}: ${defs.map((d) => d.name).join(', ')}`);
    for (const d of defs) await this.add(d);
  }

  /** Builds in progress and how many places are still waiting for their first build. */
  progress() {
    let queued = 0, ready = 0, failed = 0, skipped = 0;
    const building: string[] = [];
    for (const p of this.all.values()) {
      if (p.def.positionsOnly) continue; // nothing to build
      if (p.building) building.push(p.def.id);
      if (p.state === 'ready') ready++;
      else if (p.state === 'queued' || p.state === 'building') queued++;
      else if (p.state === 'error') failed++;
      else skipped++;
    }
    return { ready, queued, failed, skipped, building };
  }
}
