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

/** A city as listed by /api/cities (available before its geometry is loaded). */
export interface CityInfo {
  id: string;
  name: string;
  country: string;
  tz: string;
  origin: { lon: number; lat: number };
  bbox: [number, number, number, number] | null;
  state: 'queued' | 'building' | 'ready' | 'error';
  live: number;
  scheduled: number;
  attribution: Credit[];
}

export async function listCities(): Promise<CityInfo[]> {
  const r = await fetch('/api/cities');
  if (!r.ok) throw new Error(`cities: HTTP ${r.status}`);
  return r.json();
}

export async function loadGlow(id: string): Promise<Float32Array> {
  return new Float32Array(await bin(`/api/city/${id}/glow.bin`));
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
