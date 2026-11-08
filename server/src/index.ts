// Afterglow server: discovers feeds, polls live sources politely, builds timetables in the
// background, and streams one normalised vehicle stream to browsers over WebSocket. Clients
// subscribe per place as the camera approaches; at globe level they get only per-place counts
// and a compact glow of each place's route network.

import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import { config } from './config.ts';
import { cityDefs } from './cities/index.ts';
import { discover, CATALOG_ATTRIBUTION, type Discovery } from './catalog/mobilitydb.ts';
import { readGlow, type CityIndex } from './static/gtfs.ts';
import { waterTile, BASEMAP_ATTRIBUTION, MAX_WATER_ZOOM } from './static/basemap.ts';
import { toWire, type VehicleState } from './live.ts';
import { toRel } from './geo.ts';
import { Places, type Place } from './places.ts';

function send(p: Place, msg: object) {
  if (!p.subscribers.size) return;
  const s = JSON.stringify(msg);
  for (const ws of p.subscribers) if (ws.readyState === 1) ws.send(s);
}

const places = new Places((p: Place, changed: VehicleState[], gone: string[]) => {
  const now = Date.now() / 1000;
  if (changed.length) send(p, { type: 'veh', city: p.def.id, now, v: changed.map(toWire) });
  if (gone.length) send(p, { type: 'gone', city: p.def.id, now, keys: gone });
});

// Curated cities first, then everything the catalog knows about.
const curated = cityDefs();
for (const def of curated) await places.add(def);
let discovery: Discovery | null = null;
let discoveryError: string | null = null;
async function runDiscovery() {
  if (!config.catalog) return;
  try {
    const covered = new Set(curated.flatMap((c) => c.feeds.flatMap((f) => f.mdb ?? [])));
    discovery = await discover(covered, config.maxStaticBytes);
    discoveryError = null;
    for (const def of discovery.cities) await places.add(def);
    console.log(`[catalog] ${discovery.cities.length} places from the Mobility Database, ${discovery.skipped.length} feeds skipped`);
  } catch (e) {
    discoveryError = (e as Error).message;
    console.error('[catalog] discovery failed:', e);
  }
}
void runDiscovery();
// New feeds appear in the catalog over time.
setInterval(runDiscovery, 24 * 3600 * 1000);

const app = Fastify({ logger: false });
await app.register(compress, { global: true, encodings: ['br', 'gzip'], threshold: 2048, customTypes: /^application\/(json|octet-stream)/ });
await app.register(websocket);

const counts = (p: Place, now = Date.now() / 1000) => ({ live: p.liveCount(now), scheduled: p.scheduledCount() });

function attribution(p: Place) {
  return [
    ...p.def.feeds.map((f) => ({ name: f.attribution, license: f.license.name, url: f.license.url, legend: f.legend })),
    ...(p.def.source === 'catalog' ? [CATALOG_ATTRIBUTION] : []),
    { name: BASEMAP_ATTRIBUTION, license: 'ODbL', url: 'https://www.openstreetmap.org/copyright' },
  ];
}

/** Whether any live source of the place can run (has no missing key and isn't forced off). */
function hasUsableLive(p: Place) {
  return p.def.feeds.some((f) => places.sourcesOf(f).some((h) => h.state !== 'no-key' && h.state !== 'timetable' && h.state !== 'skipped'));
}

app.get('/api/cities', async () => {
  const now = Date.now() / 1000;
  return [...places.all.values()].filter((p) => p.located && p.state !== 'skipped').map((p) => ({
    id: p.def.id, name: p.def.name, region: p.def.region ?? '', country: p.def.country, tz: p.def.tz, origin: p.def.origin,
    bbox: p.area, state: p.state, error: p.error ?? null, ...counts(p, now),
    source: p.def.source, timetableOnly: !hasUsableLive(p), v: p.summary ? Math.round(p.summary.builtAt) : 0,
    attribution: attribution(p),
  }));
});

/** Load a place for a viewer (builds its timetable first if needed: can take a while). */
async function loaded(id: string) {
  const p = places.all.get(id);
  if (!p) return null;
  return (await places.ensureLoaded(p)) && p.index ? p : null;
}

app.get<{ Params: { id: string } }>('/api/city/:id', async (req, reply) => {
  const p = await loaded(req.params.id);
  if (!p) return reply.code(404).send({ error: 'unknown or unavailable place' });
  const ix = p.index!;
  reply.header('Cache-Control', 'no-cache');
  return {
    id: p.def.id, name: p.def.name, country: p.def.country, tz: p.def.tz, origin: p.def.origin, bbox: ix.bbox,
    routes: ix.routes, shapes: ix.shapes, attribution: attribution(p),
  };
});

const BINARIES: Partial<Record<string, (ix: CityIndex) => ArrayBufferView>> = {
  'points.bin': (ix) => ix.points,
  'lines.bin': (ix) => ix.lineVerts,
  'chains.bin': (ix) => ix.lineChains,
};
app.get<{ Params: { id: string; file: string } }>('/api/city/:id/:file', async (req, reply) => {
  const get = BINARIES[req.params.file];
  const p = get && (await loaded(req.params.id));
  if (!p || !get) return reply.code(404).send({ error: 'not found' });
  const v = get(p.index!);
  reply.header('Content-Type', 'application/octet-stream').header('Cache-Control', 'no-cache');
  return reply.send(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
});

/**
 * Compact glow of one place: Float32 [minX, minY, maxX, maxY] (origin-relative), then per sample
 * Uint16 x, Uint16 y (quantised within that box: ~2 m at city scale) and Uint8 r, g, b, 0.
 */
/** Most samples per place sent to browsers: a city is a few dozen pixels on the globe, and the glow
 *  is blurred by bloom, so this is plenty (and keeps all ~300 glows to ~2 MB, fine on a phone). */
const GLOW_MAX = 1000;

async function glowBin(p: Place): Promise<Buffer> {
  if (p.glowBin) return p.glowBin;
  let all = await readGlow(p.summary!);
  // Keep the glow to the place's area (with a margin), so a metro cut from a national feed
  // doesn't glow along every intercity line that passes through it.
  if (p.area && p.def.feeds.every((f) => f.filter?.bbox)) {
    const [w, sth, e, n] = p.area, mx = (e - w) * 0.25, my = (n - sth) * 0.25;
    const [x0, y0] = toRel(p.def.origin, w - mx, sth - my), [x1, y1] = toRel(p.def.origin, e + mx, n + my);
    const keep: number[] = [];
    for (let i = 0; i < all.length; i += 5) if (all[i] >= x0 && all[i] <= x1 && all[i + 1] >= y0 && all[i + 1] <= y1) keep.push(...all.subarray(i, i + 5));
    all = Float32Array.from(keep);
  }
  // Samples run along the network, so an even stride keeps them spread over all of it.
  const total = all.length / 5, n = Math.min(total, GLOW_MAX);
  const g = new Float32Array(n * 5);
  for (let i = 0; i < n; i++) g.set(all.subarray(Math.floor((i * total) / n) * 5, Math.floor((i * total) / n) * 5 + 5), i * 5);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = g[i * 5], y = g[i * 5 + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (!n) x0 = y0 = x1 = y1 = 0;
  const out = Buffer.alloc(16 + n * 8);
  out.writeFloatLE(x0, 0); out.writeFloatLE(y0, 4); out.writeFloatLE(x1, 8); out.writeFloatLE(y1, 12);
  const sx = x1 > x0 ? 65535 / (x1 - x0) : 0, sy = y1 > y0 ? 65535 / (y1 - y0) : 0;
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let i = 0; i < n; i++) {
    const o = 16 + i * 8;
    out.writeUInt16LE(Math.round((g[i * 5] - x0) * sx), o);
    out.writeUInt16LE(Math.round((g[i * 5 + 1] - y0) * sy), o + 2);
    out[o + 4] = c(g[i * 5 + 2]); out[o + 5] = c(g[i * 5 + 3]); out[o + 6] = c(g[i * 5 + 4]);
  }
  return (p.glowBin = out);
}

/** Glows of several places in one response: per place, Uint32 byte length then its glow (0 if unavailable). */
app.get<{ Querystring: { ids?: string } }>('/api/glows.bin', async (req, reply) => {
  const ids = (req.query.ids ?? '').split(',').filter(Boolean).slice(0, 64);
  const parts: Buffer[] = [];
  for (const id of ids) {
    const p = places.all.get(id);
    let b: Buffer | null = null;
    if (p?.summary) { try { b = await glowBin(p); } catch { b = null; } }
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b ? b.length : 0);
    parts.push(len);
    if (b) parts.push(b);
  }
  reply.header('Content-Type', 'application/octet-stream').header('Cache-Control', 'public, max-age=3600');
  return reply.send(Buffer.concat(parts));
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

app.get('/api/health', async () => {
  const now = Date.now() / 1000;
  const mem = process.memoryUsage();
  return {
    now,
    server: { uptime: Math.round(process.uptime()), rssMB: Math.round(mem.rss / 1e6), heapMB: Math.round(mem.heapUsed / 1e6) },
    catalog: {
      enabled: config.catalog, error: discoveryError, fetchedAt: discovery?.fetchedAt ?? null,
      places: discovery?.cities.length ?? 0, attribution: CATALOG_ATTRIBUTION,
    },
    builds: places.progress(),
    cities: [...places.all.values()].map((p) => ({
      id: p.def.id, name: p.def.name, country: p.def.country, source: p.def.source, state: p.state, error: p.error ?? null,
      loaded: !!p.live, viewers: p.subscribers.size, ...counts(p, now),
      timetableMB: p.summary ? Math.round(p.summary.bytes / 1e5) / 10 : null, builtAt: p.summary?.builtAt ?? null,
    })),
    feeds: [...places.health.values()].map((h) => {
      const p = places.all.get(h.city);
      const fb = p?.fallbacks.find((f) => f.feedId === h.feed || p.def.feeds.find((x) => x.id === f.feedId)?.realtime?.some((r) => r.id === h.feed));
      return { ...h, cityName: p?.def.name ?? h.city, mode: fb?.mode ?? (h.state === 'timetable' ? 'scheduled' : 'live'), scheduled: fb?.shown.size ?? 0 };
    }),
    skipped: discovery?.skipped ?? [],
    keys: (discovery?.keyed ?? []).map((k) => ({ env: k.env, host: k.host, info: k.info ?? null, feeds: k.feeds.length, set: !!config.key(k.env) })),
  };
});

app.register(async (scope) => {
  scope.get('/ws', { websocket: true }, (socket) => {
    const subs = new Set<Place>();
    socket.on('message', async (raw: Buffer) => {
      let m: { type?: string; city?: string };
      try { m = JSON.parse(String(raw)); } catch { return; }
      const p = m.city ? places.all.get(m.city) : undefined;
      if (m.type === 'sub' && p) {
        if (subs.has(p)) return;
        subs.add(p);
        if (!(await places.ensureLoaded(p)) || !subs.has(p) || socket.readyState !== 1) return;
        p.subscribers.add(socket);
        for (const a of p.adapters) a.poke?.();
        const all = [...p.live!.vehicles.values(), ...p.fallbacks.flatMap((f) => [...f.shown.values()])];
        socket.send(JSON.stringify({ type: 'snap', city: p.def.id, now: Date.now() / 1000, v: all.map(toWire) }));
      } else if (m.type === 'unsub' && p) {
        subs.delete(p); p.subscribers.delete(socket);
      } else if (m.type === 'want' && p) {
        places.want(p);
      } else if (m.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', now: Date.now() / 1000 }));
      }
    });
    socket.on('close', () => { for (const p of subs) p.subscribers.delete(socket); });
  });
});

// Counters for everyone, every few seconds: [live, scheduled] per place with anything running.
setInterval(() => {
  const now = Date.now() / 1000;
  let total = 0, scheduled = 0, feeds = 0;
  const per: Record<string, [number, number]> = {};
  for (const p of places.all.values()) {
    const c = counts(p, now);
    if (c.live || c.scheduled) per[p.def.id] = [c.live, c.scheduled];
    total += c.live; scheduled += c.scheduled;
  }
  for (const h of places.health.values()) if (h.state === 'ok') feeds++;
  const msg = JSON.stringify({ type: 'stats', now, total, scheduled, feeds, cities: per });
  for (const ws of app.websocketServer?.clients ?? []) if (ws.readyState === 1) ws.send(msg);
}, 4000);

const dist = path.join(config.root, 'dist');
if (config.production && fs.existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist });
}

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`[afterglow] server on http://localhost:${config.port}; ${curated.length} curated cities${config.catalog ? ' + catalog discovery' : ''}`);
