// Afterglow server: preprocesses static GTFS, polls live sources politely, and streams one
// normalised vehicle stream to browsers over WebSocket. Clients subscribe per city as the
// camera approaches; at globe level they get only per-city counts and a static glow sample.

import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import type { WebSocket } from 'ws';
import { config } from './config.ts';
import { cityDefs } from './cities/index.ts';
import { buildCity, type CityIndex } from './static/gtfs.ts';
import { waterTile, BASEMAP_ATTRIBUTION, MAX_WATER_ZOOM } from './static/basemap.ts';
import { LiveCity, toWire, type VehicleState } from './live.ts';
import { gtfsRtAdapter } from './adapters/gtfs-rt.ts';
import { hslMqttAdapter } from './adapters/hsl-mqtt.ts';
import { FeedFallback, FORCED } from './fallback.ts';
import type { SourceAdapter } from './adapters/types.ts';
import type { CityDef, FeedDef, FeedHealth } from './types.ts';

interface CityRuntime {
  def: CityDef;
  state: 'queued' | 'building' | 'ready' | 'error';
  ready: Promise<void>;
  index?: CityIndex;
  live?: LiveCity;
  fallbacks: FeedFallback[];
  adapters: SourceAdapter[];
  subscribers: Set<WebSocket>;
  error?: string;
}

const health = new Map<string, FeedHealth>();
const cities = new Map<string, CityRuntime>();

function adapterFor(feed: FeedDef): SourceAdapter | null {
  if (!feed.realtime || FORCED.has(feed.id)) return null; // forced to the timetable: don't poll live
  switch (feed.realtime.kind) {
    case 'gtfs-rt': return gtfsRtAdapter();
    case 'hsl-mqtt': return hslMqttAdapter();
  }
}

function send(rt: CityRuntime, msg: object) {
  if (!rt.subscribers.size) return;
  const s = JSON.stringify(msg);
  for (const ws of rt.subscribers) if (ws.readyState === 1) ws.send(s);
}
const broadcast = (rt: CityRuntime, changed: VehicleState[]) =>
  changed.length && send(rt, { type: 'veh', city: rt.def.id, now: Date.now() / 1000, v: changed.map(toWire) });
const sendGone = (rt: CityRuntime, keys: string[]) =>
  keys.length && send(rt, { type: 'gone', city: rt.def.id, now: Date.now() / 1000, keys });

async function startCity(rt: CityRuntime) {
  const { def } = rt;
  rt.state = 'building';
  const t0 = Date.now();
  rt.index = await buildCity(def);
  const ix = rt.index;
  console.log(`[static] ${def.id}: ${ix.routes.length} routes, ${ix.shapes.length} shapes, ${ix.tripRoute.size} trips, ${ix.lineVerts.length / 2} line vertices in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  rt.live = new LiveCity(ix);
  for (const feed of def.feeds) rt.fallbacks.push(new FeedFallback(ix, feed, () => health.get(feed.id)));
  for (const feed of def.feeds) {
    const a = adapterFor(feed);
    if (!a) continue;
    a.start({
      cityId: def.id, feed,
      emit: (fixes) => broadcast(rt, rt.live!.apply(fixes)),
      health: (p) => health.set(feed.id, { ...health.get(feed.id)!, ...p }),
    });
    rt.adapters.push(a);
  }
  rt.state = 'ready';
}

// Build cities one at a time (memory stays bounded), smallest downloads first.
const defs = cityDefs();
for (const def of defs) {
  const rt: CityRuntime = { def, state: 'queued', fallbacks: [], adapters: [], subscribers: new Set(), ready: Promise.resolve() };
  for (const f of def.feeds) {
    health.set(f.id, {
      feed: f.id, city: def.id, state: f.realtime && !FORCED.has(f.id) ? 'starting' : 'timetable', detail: f.realtime ? undefined : f.note,
      vehicles: 0, polls: 0, failures: 0,
    });
  }
  cities.set(def.id, rt);
}
const ORDER = ['seattle', 'boston', 'brisbane', 'oslo', 'toronto', 'helsinki', 'amsterdam'];
const rank = (id: string) => { const i = ORDER.indexOf(id); return i < 0 ? ORDER.length : i; };
let chain = Promise.resolve();
for (const rt of [...cities.values()].sort((a, b) => rank(a.def.id) - rank(b.def.id))) {
  rt.ready = chain = chain.then(() => startCity(rt)).catch((e) => {
    rt.state = 'error';
    rt.error = (e as Error).message;
    console.error(`[city] ${rt.def.id} failed:`, e);
  });
}

const app = Fastify({ logger: false });
await app.register(compress, { global: true, encodings: ['br', 'gzip'], threshold: 2048, customTypes: /^application\/(json|octet-stream)/ });
await app.register(websocket);

async function readyCity(id: string) {
  const rt = cities.get(id);
  if (!rt) return null;
  await rt.ready;
  return rt.index ? rt : null;
}

function counts(rt: CityRuntime) {
  return { live: rt.live?.activeCount() ?? 0, scheduled: rt.fallbacks.reduce((n, f) => n + f.shown.size, 0) };
}

function attribution(rt: CityRuntime) {
  return [
    ...rt.def.feeds.map((f) => ({ name: f.attribution, license: f.license.name, url: f.license.url, legend: f.legend })),
    { name: BASEMAP_ATTRIBUTION, license: 'ODbL', url: 'https://www.openstreetmap.org/copyright' },
  ];
}

app.get('/api/cities', async () => [...cities.values()].map((rt) => ({
  id: rt.def.id, name: rt.def.name, country: rt.def.country, tz: rt.def.tz, origin: rt.def.origin,
  bbox: rt.index?.bbox ?? null, state: rt.state, error: rt.error ?? null, ...counts(rt),
  attribution: attribution(rt),
})));

app.get<{ Params: { id: string } }>('/api/city/:id', async (req, reply) => {
  const rt = await readyCity(req.params.id);
  if (!rt) return reply.code(404).send({ error: 'unknown or unavailable city' });
  const ix = rt.index!;
  reply.header('Cache-Control', 'no-cache');
  return {
    id: rt.def.id, name: rt.def.name, country: rt.def.country, tz: rt.def.tz, origin: rt.def.origin, bbox: ix.bbox,
    routes: ix.routes, shapes: ix.shapes, attribution: attribution(rt),
  };
});

const BINARIES: Partial<Record<string, (ix: CityIndex) => ArrayBufferView>> = {
  'points.bin': (ix) => ix.points,
  'lines.bin': (ix) => ix.lineVerts,
  'chains.bin': (ix) => ix.lineChains,
  'glow.bin': (ix) => ix.glow,
};
app.get<{ Params: { id: string; file: string } }>('/api/city/:id/:file', async (req, reply) => {
  const get = BINARIES[req.params.file];
  const rt = get && (await readyCity(req.params.id));
  if (!rt || !get) return reply.code(404).send({ error: 'not found' });
  const v = get(rt.index!);
  reply.header('Content-Type', 'application/octet-stream').header('Cache-Control', 'no-cache');
  return reply.send(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
});

app.get<{ Params: { z: string; x: string; y: string } }>('/api/water/:z/:x/:y', async (req, reply) => {
  const z = Number(req.params.z), x = Number(req.params.x), y = Number(req.params.y);
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > MAX_WATER_ZOOM || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
    return reply.code(400).send({ error: 'bad tile' });
  }
  try {
    const tri = await waterTile(z, x, y);
    reply.header('Content-Type', 'application/octet-stream').header('Cache-Control', 'public, max-age=86400');
    return reply.send(Buffer.from(tri.buffer, tri.byteOffset, tri.byteLength));
  } catch (e) {
    return reply.code(502).send({ error: (e as Error).message });
  }
});

app.get('/api/health', async () => ({
  now: Date.now() / 1000,
  cities: [...cities.values()].map((rt) => ({ id: rt.def.id, state: rt.state, error: rt.error ?? null, ...counts(rt) })),
  feeds: [...health.values()].map((h) => {
    const fb = cities.get(h.city)?.fallbacks.find((f) => f.feedId === h.feed);
    return { ...h, mode: fb?.mode ?? (h.state === 'timetable' ? 'scheduled' : 'live'), scheduled: fb?.shown.size ?? 0 };
  }),
}));

app.register(async (scope) => {
  scope.get('/ws', { websocket: true }, (socket) => {
    const subs = new Set<CityRuntime>();
    socket.on('message', async (raw: Buffer) => {
      let m: { type?: string; city?: string };
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === 'sub' && m.city) {
        const rt = await readyCity(m.city);
        if (!rt || subs.has(rt) || socket.readyState !== 1) return;
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

// Counters for everyone, every few seconds: live and scheduled vehicles per city.
setInterval(() => {
  let total = 0, scheduled = 0;
  const per: Record<string, { live: number; scheduled: number }> = {};
  for (const rt of cities.values()) { const c = counts(rt); per[rt.def.id] = c; total += c.live; scheduled += c.scheduled; }
  const msg = JSON.stringify({ type: 'stats', now: Date.now() / 1000, total, scheduled, cities: per });
  for (const ws of app.websocketServer?.clients ?? []) if (ws.readyState === 1) ws.send(msg);
}, 4000);

const dist = path.join(config.root, 'dist');
if (config.production && fs.existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist });
}

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`[afterglow] server on http://localhost:${config.port}; building ${defs.length} cities in the background`);
