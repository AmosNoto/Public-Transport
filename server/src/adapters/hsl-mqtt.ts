// Helsinki (HSL) high-frequency positioning: every vehicle publishes its position about once a
// second over MQTT. Messages are coalesced per vehicle and emitted every couple of seconds.
// Topic layout: /hfp/v2/journey/ongoing/vp/<mode>/<operator>/<vehicle>/<route_id>/<dir 1|2>/…

import mqtt from 'mqtt';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { VehicleFix } from '../types.ts';
import type { AdapterContext, SourceAdapter } from './types.ts';

/** How often coalesced positions are emitted (s). */
const FLUSH_S = 2;
/** A vehicle not heard from for this long no longer counts as live. */
const SEEN_S = 120;

interface HfpVp {
  desi?: string; dir?: string; oper?: number; veh?: number; tsi?: number; tst?: string;
  spd?: number | null; hdg?: number | null; lat?: number | null; long?: number | null; drst?: number | null; route?: string;
}

export function hslMqttAdapter(): SourceAdapter {
  let client: mqtt.MqttClient | null = null;
  let flush: NodeJS.Timeout | null = null;
  const pending = new Map<string, VehicleFix>();
  const seen = new Map<string, number>();
  let lastMessage = 0, messages = 0, failures = 0;

  return {
    kind: 'hsl-mqtt',
    start(ctx: AdapterContext) {
      const rt = ctx.feed.realtime;
      if (!rt || rt.kind !== 'hsl-mqtt') return;
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
      client = mqtt.connect(rt.url, {
        clientId: `afterglow-${Math.random().toString(16).slice(2, 10)}`,
        reconnectPeriod: 5000, connectTimeout: 20_000, keepalive: 60, clean: true,
        wsOptions: proxy ? { agent: new HttpsProxyAgent(proxy) } : undefined,
      });
      client.on('connect', () => {
        client!.subscribe(rt.topic, { qos: 0 });
        ctx.health({ state: lastMessage ? 'ok' : 'starting', detail: 'connected', lastPoll: Date.now() / 1000 });
      });
      client.on('error', (e) => { failures++; ctx.health({ state: 'network-error', detail: e.message.slice(0, 120), failures }); });
      client.on('offline', () => ctx.health({ state: 'network-error', detail: 'offline', failures }));
      client.on('message', (topic, payload) => {
        const parts = topic.split('/');
        let vp: HfpVp | undefined;
        try { vp = (JSON.parse(payload.toString()) as { VP?: HfpVp }).VP; } catch { return; }
        if (!vp || vp.lat == null || vp.long == null) return;
        const routeId = parts[9] || vp.route;
        const dir = Number(parts[10] || vp.dir);
        const vid = `${parts[7] ?? vp.oper}/${parts[8] ?? vp.veh}`;
        const ts = vp.tsi ?? (vp.tst ? Date.parse(vp.tst) / 1000 : Date.now() / 1000);
        messages++;
        lastMessage = Date.now() / 1000;
        seen.set(vid, ts);
        pending.set(vid, {
          feed: ctx.feed.id, vid, label: vp.desi, routeId, directionId: dir === 1 || dir === 2 ? dir - 1 : undefined,
          lat: vp.lat, lon: vp.long, bearing: vp.hdg ?? undefined, speed: vp.spd ?? undefined, ts,
          stopped: vp.spd != null && vp.spd < 0.3,
        });
      });
      flush = setInterval(() => {
        const now = Date.now() / 1000;
        if (pending.size) { ctx.emit([...pending.values()], false); pending.clear(); }
        for (const [k, t] of seen) if (now - t > SEEN_S) seen.delete(k);
        const quiet = lastMessage ? now - lastMessage : Infinity;
        ctx.health({
          state: quiet > 60 ? (client?.connected ? 'stale' : 'network-error') : seen.size ? 'ok' : 'empty',
          vehicles: seen.size, lastOk: lastMessage || undefined, lastPoll: now, headerAge: Number.isFinite(quiet) ? Math.round(quiet) : undefined,
          polls: messages, failures,
        });
      }, FLUSH_S * 1000);
    },
    stop() {
      if (flush) clearInterval(flush);
      client?.end(true);
    },
  };
}
