// Load one city's preprocessed static data and turn it into GPU textures.

import * as THREE from 'three';
import type { Ribbon } from '../layers/ribbon.ts';

export type Mode = 'subway' | 'rail' | 'bus' | 'tram';
export const MODES: Mode[] = ['subway', 'rail', 'bus', 'tram'];

export interface RouteInfo {
  id: string; feed: string; short: string; long: string; mode: Mode;
  light: [number, number, number]; ink: [number, number, number]; official: boolean;
}
export interface ShapeInfo { id: string; route: number; start: number; count: number; length: number }

export interface Credit { name: string; license: string; url?: string; legend?: string }

/** A place as listed by /api/cities (available before its geometry is loaded). */
export interface CityInfo {
  id: string;
  name: string;
  /** State, province or metro area, when known. */
  region: string;
  country: string;
  tz: string;
  origin: { lon: number; lat: number };
  bbox: [number, number, number, number] | null;
  /** ready: timetable built (glow and detail available); queued/building: not yet. */
  state: 'queued' | 'building' | 'ready' | 'error';
  live: number;
  scheduled: number;
  /** Hand-checked city, or discovered from the feed catalog. */
  source: 'curated' | 'catalog';
  /** No live source can run (none published, or its API key isn't set): shown from the timetable. */
  timetableOnly: boolean;
  /** Build stamp; changes when the timetable is rebuilt. */
  v: number;
  attribution: Credit[];
}

export async function listCities(): Promise<CityInfo[]> {
  const r = await fetch('/api/cities');
  if (!r.ok) throw new Error(`cities: HTTP ${r.status}`);
  return r.json();
}

/**
 * Glows of several places in one request, decoded to (x, y, r, g, b) per sample.
 * Wire format per place: Uint32 length, then Float32 [minX, minY, maxX, maxY] and per sample
 * Uint16 x, Uint16 y (quantised in that box), Uint8 r, g, b, pad.
 */
export async function loadGlows(ids: string[]): Promise<Map<string, Float32Array>> {
  const buf = await bin(`/api/glows.bin?ids=${ids.map(encodeURIComponent).join(',')}`);
  const dv = new DataView(buf);
  const out = new Map<string, Float32Array>();
  let o = 0;
  for (const id of ids) {
    if (o + 4 > buf.byteLength) break;
    const len = dv.getUint32(o, true);
    o += 4;
    if (!len) continue;
    const x0 = dv.getFloat32(o, true), y0 = dv.getFloat32(o + 4, true), x1 = dv.getFloat32(o + 8, true), y1 = dv.getFloat32(o + 12, true);
    const n = (len - 16) / 8, sx = (x1 - x0) / 65535, sy = (y1 - y0) / 65535;
    const g = new Float32Array(n * 5);
    for (let i = 0, p = o + 16; i < n; i++, p += 8) {
      g[i * 5] = x0 + dv.getUint16(p, true) * sx;
      g[i * 5 + 1] = y0 + dv.getUint16(p + 2, true) * sy;
      g[i * 5 + 2] = dv.getUint8(p + 4) / 255; g[i * 5 + 3] = dv.getUint8(p + 5) / 255; g[i * 5 + 4] = dv.getUint8(p + 6) / 255;
    }
    out.set(id, g);
    o += len;
  }
  return out;
}

export interface CityData {
  id: string;
  name: string;
  country: string;
  tz: string;
  origin: { lon: number; lat: number };
  bbox: [number, number, number, number];
  routes: RouteInfo[];
  shapes: ShapeInfo[];
  attribution: Credit[];
  ribbon: Ribbon;
  shapePts: THREE.DataTexture;
  shapeTab: THREE.DataTexture;
}

async function bin(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.arrayBuffer();
}

function floatTexture(data: Float32Array, width: number, height: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// City geometry is fetched and prepared in a worker so loading never stalls a frame.
let worker: Worker | null = null;
let nextReq = 1;
const pending = new Map<number, { resolve: (v: CityData) => void; reject: (e: Error) => void }>();

export function loadCity(id: string): Promise<CityData> {
  if (!worker) {
    worker = new Worker(new URL('./cityWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data;
      const p = pending.get(m.req);
      if (!p) return;
      pending.delete(m.req);
      if (!m.ok) { p.reject(new Error(m.error)); return; }
      p.resolve({
        ...m.meta,
        ribbon: m.ribbon,
        shapePts: floatTexture(m.shapePts.data, 2048, m.shapePts.height),
        shapeTab: floatTexture(m.shapeTab.data, 1024, m.shapeTab.height),
      });
    };
  }
  const req = nextReq++;
  return new Promise((resolve, reject) => {
    pending.set(req, { resolve, reject });
    worker!.postMessage({ req, id });
  });
}
