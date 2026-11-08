// Live-or-scheduled, per feed. A feed with usable live positions shows those. When its live
// data is missing, failing, stale or empty for a couple of minutes (or it has no realtime
// endpoint at all), its vehicles are placed from the timetable instead, flagged "scheduled".

import { buildSchedule, localDate, scheduledPositions, type FeedSchedule } from './static/schedule.ts';
import { FLAG_SCHEDULED, FLAG_SNAPPED, FLAG_STOPPED, type VehicleState } from './live.ts';
import type { CityIndex } from './static/gtfs.ts';
import type { FeedDef, FeedHealth } from './types.ts';

/** How long live data may be unusable before the timetable takes over. */
const LIVE_GRACE_S = 120;

/** Feeds to show from the timetable regardless of live data (diagnostics), e.g. FORCE_SCHEDULED=mbta. */
export const FORCED = new Set((process.env.FORCE_SCHEDULED ?? '').split(',').map((s) => s.trim()).filter(Boolean));

export class FeedFallback {
  mode: 'live' | 'scheduled' = 'live';
  private schedule?: FeedSchedule;
  private building?: Promise<void>;
  private lastLive: number;
  /** Scheduled vehicles currently shown, by key. */
  readonly shown = new Map<string, VehicleState>();

  constructor(private ix: CityIndex, private feed: FeedDef, private health: () => FeedHealth[]) {
    this.lastLive = Date.now() / 1000;
  }

  get feedId() { return this.feed.id; }

  /** Whether any live source can run at all (one without its API key, or forced off, can't). */
  private get hasRealtime() {
    return this.health().some((h) => h.state !== 'no-key' && h.state !== 'skipped' && h.state !== 'timetable');
  }

  /** Live is usable when any of the feed's sources is delivering vehicles. */
  private liveUsable(): boolean {
    return this.hasRealtime && this.health().some((h) => h.state === 'ok' && h.vehicles > 0);
  }

  /** Re-evaluate; returns scheduled vehicles to send and keys that have ended. */
  tick(now = Date.now() / 1000): { changed: VehicleState[]; gone: string[] } {
    if (this.liveUsable()) this.lastLive = now;
    const want = FORCED.has(this.feed.id) || !this.hasRealtime || now - this.lastLive > LIVE_GRACE_S ? 'scheduled' : 'live';
    if (want !== this.mode) console.log(`[fallback] ${this.ix.def.id}/${this.feed.id}: ${this.mode} → ${want}`);
    this.mode = want;

    if (want === 'live') {
      const gone = [...this.shown.keys()];
      this.shown.clear();
      return { changed: [], gone };
    }
    // Build (or rebuild after the service day rolls over) in the background.
    const today = localDate(now, this.ix.def.tz);
    if ((!this.schedule || this.schedule.date !== today) && !this.building) {
      this.building = buildSchedule(this.ix, this.feed, now)
        .then((s) => { this.schedule = s; })
        .catch((e) => console.error(`[schedule] ${this.feed.id} failed:`, e))
        .finally(() => { this.building = undefined; });
    }
    if (!this.schedule) return { changed: [], gone: [] };

    const changed: VehicleState[] = [];
    const seen = new Set<string>();
    for (const p of scheduledPositions(this.schedule, now)) {
      const key = `${this.feed.id}:sched:${p.trip.trip}:${p.trip.day}`;
      seen.add(key);
      const s: VehicleState = {
        key, vid: p.trip.trip, route: p.trip.route, shape: p.trip.shape, d: p.d, v: p.v, ts: now, rx: 0, ry: 0,
        flags: FLAG_SCHEDULED | FLAG_SNAPPED | (p.stopped ? FLAG_STOPPED : 0), tripId: p.trip.trip,
      };
      this.shown.set(key, s);
      changed.push(s);
    }
    const gone: string[] = [];
    for (const k of this.shown.keys()) if (!seen.has(k)) { this.shown.delete(k); gone.push(k); }
    return { changed, gone };
  }
}
