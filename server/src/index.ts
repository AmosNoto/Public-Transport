// Afterglow server: preprocesses static GTFS, polls live sources politely, and streams one
// normalised vehicle stream to browsers over WebSocket.

import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import type { WebSocket } from 'ws';
import { config } from './config.ts';
import { boston } from './cities/boston.ts';
import { buildCity, type CityIndex } from './static/gtfs.ts';
import { buildWater, BASEMAP_ATTRIBUTION } from './static/basemap.ts';
import { LiveCity, toWire, type VehicleState } from './live.ts';
import { gtfsRtAdapter } from './adapters/gtfs-rt.ts';
import { FeedFallback, FORCED } from './fallback.ts';
import type { SourceAdapter } from './adapters/types.ts';
import type { CityDef, FeedHealth } from './types.ts';

const CITIES: CityDef[] = [boston];

interface CityRuntime {
  def: CityDef;
  ready: Promise<void>;
  index?: CityIndex;
  water?: Float32Array;
  live?: LiveCity;
  fallbacks: FeedFallback[];
  adapters: SourceAdapter[];
  subscribers: Set<WebSocket>;
  error?: string;
}

const health = new Map<string, FeedHealth>();
const cities = new Map<string, CityRuntime>();

function sendGone(rt: CityRuntime, keys: string[]) {
  if (!keys.length || !rt.subscribers.size) return;
  const msg = JSON.stringify({ type: 'gone', city: rt.def.id, now: Date.now() / 1000, keys });
  for (const ws of rt.subscribers) if (ws.readyState === 1) ws.send(msg);
}

function broadcast(rt: CityRuntime, changed: VehicleState[]) {
  if (!changed.length || !rt.subscribers.size) return;
  const msg = JSON.stringify({ type: 'veh', city: rt.def.id, now: Date.now() / 1000, v: changed.map(toWire) });
  for (const ws of rt.subscribers) if (ws.readyState === 1) ws.send(msg);
}

function startCity(def: CityDef): CityRuntime {
  const rt: CityRuntime = { def, adapters: [], fallbacks: [], subscribers: new Set(), ready: Promise.resolve() };
  for (const f of def.feeds) health.set(f.id, { feed: f.id, city: def.id, state: 'starting', vehicles: 0, polls: 0, failures: 0 });
  rt.ready = (async () => {
    const t0 = Date.now();
    rt.index = await buildCity(def);
    console.log(`[static] ${def.id}: ${rt.index.routes.length} routes, ${rt.index.shapes.length} shapes, ${rt.index.points.length / 4} shape vertices, ${rt.index.lineChains.length / 3} line chains, ${rt.index.lineVerts.length / 2} line vertices in ${Date.now() - t0} ms`);
    rt.water = await buildWater(def.id, def.origin, rt.index.bbox);
    rt.live = new LiveCity(rt.index);
    for (const feed of def.feeds) rt.fallbacks.push(new FeedFallback(rt.index, feed, () => health.get(feed.id)));
    for (const feed of def.feeds) {
      if (!feed.vehicles || FORCED.has(feed.id)) continue; // forced to the timetable: don't poll live
      const a = gtfsRtAdapter();
      a.start({
        cityId: def.id, feed,
        emit: (fixes) => broadcast(rt, rt.live!.apply(fixes)),
        health: (p) => health.set(feed.id, { ...health.get(feed.id)!, ...p }),
      });
      rt.adapters.push(a);
    }
  })().catch((e) => {
    rt.error = (e as Error).message;
    console.error(`[city] ${def.id} failed:`, e);
  });
  return rt;
}

for (const def of CITIES) cities.set(def.id, startCity(def));

const app = Fastify({ logger: false });
await app.register(compress, { global: true, encodings: ['br', 'gzip'] });
await app.register(websocket);

async function cityOr404(id: string) {
  const rt = cities.get(id);
  if (!rt) return null;
  await rt.ready;
  return rt.index ? rt : null;
}

app.get('/api/cities', async () => [...cities.values()].map((rt) => ({
  id: rt.def.id, name: rt.def.name, tz: rt.def.tz, origin: rt.def.origin, bbox: rt.index?.bbox ?? null,
  vehicles: rt.live?.activeCount() ?? 0, ready: !!rt.live, error: rt.error ?? null,
})));

app.get<{ Params: { id: string } }>('/api/city/:id', async (req, reply) => {
  const rt = await cityOr404(req.params.id);
  if (!rt) return reply.code(404).send({ error: 'unknown or unavailable city' });
  const ix = rt.index!;
  reply.header('Cache-Control', 'no-cache');
  return {
    id: rt.def.id, name: rt.def.name, tz: rt.def.tz, origin: rt.def.origin, bbox: ix.bbox,
    routes: ix.routes, shapes: ix.shapes,
    attribution: [
      ...rt.def.feeds.map((f) => ({ name: f.attribution, license: f.license.name, url: f.license.url })),
      { name: BASEMAP_ATTRIBUTION, license: 'ODbL', url: 'https://www.openstreetmap.org/copyright' },
    ],
  };
});

const BINARIES: Partial<Record<string, (rt: CityRuntime) => ArrayBufferView>> = {
  'points.bin': (rt) => rt.index!.points,
  'lines.bin': (rt) => rt.index!.lineVerts,
  'chains.bin': (rt) => rt.index!.lineChains,
  'water.bin': (rt) => rt.water!,
};
app.get<{ Params: { id: string; file: string } }>('/api/city/:id/:file', async (req, reply) => {
  const get = BINARIES[req.params.file];
  const rt = get && (await cityOr404(req.params.id));
  if (!rt) return reply.code(404).send({ error: 'not found' });
  const v = get(rt);
  reply.header('Content-Type', 'application/octet-stream').header('Cache-Control', 'no-cache');
  return reply.send(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
});

app.get('/api/health', async () => ({
  now: Date.now() / 1000,
  feeds: [...health.values()].map((h) => {
    const fb = cities.get(h.city)?.fallbacks.find((f) => f.feedId === h.feed);
    return { ...h, mode: fb?.mode ?? 'live', scheduled: fb?.shown.size ?? 0 };
  }),
}));

app.register(async (scope) => {
  scope.get('/ws', { websocket: true }, (socket) => {
    const subs = new Set<CityRuntime>();
    socket.on('message', async (raw) => {
      let m: { type?: string; city?: string };
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === 'sub' && m.city) {
        const rt = await cityOr404(m.city);
        if (!rt || subs.has(rt)) return;
        subs.add(rt); rt.subscribers.add(socket);
        const all = [...rt.live!.vehicles.values(), ...rt.fallbacks.flatMap((f) => [...f.shown.values()])];
        socket.send(JSON.stringify({ type: 'snap', city: rt.def.id, now: Date.now() / 1000, v: all.map(toWire) }));
      } else if (m.type === 'unsub' && m.city) {
        const rt = cities.get(m.city);
        if (rt) { subs.delete(rt); rt.subscribers.delete(socket); }
      } else if (m.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', now: Date.now() / 1000 }));
      }
    });
    socket.on('close', () => { for (const rt of subs) rt.subscribers.delete(socket); });
  });
});

// Timetable fallback: re-evaluated every 10 s per feed.
setInterval(() => {
  for (const rt of cities.values()) for (const fb of rt.fallbacks) {
    const { changed, gone } = fb.tick();
    broadcast(rt, changed);
    sendGone(rt, gone);
  }
}, 10_000);

// Worldwide counter, pushed to everyone every few seconds.
setInterval(() => {
  let total = 0;
  const per: Record<string, number> = {};
  for (const rt of cities.values()) { const n = rt.live?.activeCount() ?? 0; per[rt.def.id] = n; total += n; }
  const msg = JSON.stringify({ type: 'stats', now: Date.now() / 1000, total, cities: per });
  for (const ws of app.websocketServer?.clients ?? []) if (ws.readyState === 1) ws.send(msg);
}, 5000);

const dist = path.join(config.root, 'dist');
if (config.production && fs.existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist });
}

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`[afterglow] server on http://localhost:${config.port}`);
