// Generic GTFS-Realtime VehiclePositions poller. Covers every catalog feed that speaks GTFS-RT.

import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { config } from '../config.ts';
import type { VehicleFix } from '../types.ts';
import type { AdapterContext, SourceAdapter } from './types.ts';

const { FeedMessage, VehiclePosition } = GtfsRealtimeBindings.transit_realtime;
const STOPPED_AT = VehiclePosition.VehicleStopStatus.STOPPED_AT;

/** A feed whose header timestamp is older than this is reported as stale. */
const STALE_AFTER_S = 180;

export function gtfsRtAdapter(): SourceAdapter {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let etag: string | null = null, lastModified: string | null = null;
  let failures = 0, polls = 0;

  async function poll(ctx: AdapterContext) {
    const url = ctx.feed.vehicles!;
    const headers: Record<string, string> = { 'User-Agent': config.userAgent, ...ctx.feed.headers };
    if (etag) headers['If-None-Match'] = etag;
    if (lastModified) headers['If-Modified-Since'] = lastModified;
    const base = Math.max(config.pollIntervalS, ctx.feed.minIntervalS ?? 0);
    let next = base;
    polls++;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      if (res.status === 304) {
        ctx.health({ lastPoll: Date.now() / 1000, polls });
      } else if (!res.ok) {
        failures++;
        // Back off on rate limiting and server errors, with jitter, up to 5 minutes.
        next = Math.min(300, base * 2 ** Math.min(failures, 5)) * (0.8 + Math.random() * 0.4);
        const ra = Number(res.headers.get('retry-after'));
        if (ra > 0) next = Math.max(next, ra);
        ctx.health({ state: res.status === 401 || res.status === 403 ? 'no-key' : 'http-error', detail: `HTTP ${res.status}`, lastPoll: Date.now() / 1000, polls, failures });
      } else {
        etag = res.headers.get('etag');
        lastModified = res.headers.get('last-modified');
        const buf = new Uint8Array(await res.arrayBuffer());
        let msg;
        try { msg = FeedMessage.decode(buf); } catch (e) {
          failures++;
          ctx.health({ state: 'decode-error', detail: (e as Error).message.slice(0, 120), lastPoll: Date.now() / 1000, polls, failures });
          return;
        }
        failures = 0;
        const now = Date.now() / 1000;
        const headerTs = Number(msg.header.timestamp ?? 0) || now;
        const fixes: VehicleFix[] = [];
        for (const e of msg.entity) {
          const v = e.vehicle;
          if (!v?.position || e.isDeleted) continue;
          const { latitude: lat, longitude: lon } = v.position;
          if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
          fixes.push({
            feed: ctx.feed.id,
            vid: v.vehicle?.id || e.id,
            label: v.vehicle?.label || undefined,
            tripId: v.trip?.tripId || undefined,
            routeId: v.trip?.routeId || undefined,
            directionId: v.trip?.directionId ?? undefined,
            lat, lon,
            bearing: v.position.bearing ?? undefined,
            speed: v.position.speed ?? undefined,
            ts: Math.min(now, Number(v.timestamp ?? 0) || headerTs),
            stopId: v.stopId || undefined,
            stopped: v.currentStatus === STOPPED_AT,
          });
        }
        const age = Math.max(0, now - headerTs);
        ctx.emit(fixes, true);
        ctx.health({
          state: age > STALE_AFTER_S ? 'stale' : fixes.length ? 'ok' : 'empty',
          detail: undefined, lastOk: now, lastPoll: now, headerAge: Math.round(age), vehicles: fixes.length, polls, failures,
        });
      }
    } catch (e) {
      failures++;
      next = Math.min(300, base * 2 ** Math.min(failures, 5)) * (0.8 + Math.random() * 0.4);
      ctx.health({ state: 'network-error', detail: (e as Error).message.slice(0, 120), lastPoll: Date.now() / 1000, polls, failures });
    } finally {
      if (!stopped) timer = setTimeout(() => poll(ctx), next * 1000);
    }
  }

  return {
    kind: 'gtfs-rt',
    start(ctx) {
      // Spread first polls so many feeds don't fire at once.
      timer = setTimeout(() => poll(ctx), Math.random() * 1500);
    },
    stop() { stopped = true; if (timer) clearTimeout(timer); },
  };
}
