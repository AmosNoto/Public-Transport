// Load one city's preprocessed static data and turn it into GPU textures.

import * as THREE from 'three';

export type Mode = 'subway' | 'rail' | 'bus' | 'tram';
export const MODES: Mode[] = ['subway', 'rail', 'bus', 'tram'];

export interface RouteInfo {
  id: string; feed: string; short: string; long: string; mode: Mode;
  light: [number, number, number]; ink: [number, number, number]; official: boolean;
}
export interface ShapeInfo { id: string; route: number; start: number; count: number; length: number }

export interface CityData {
  id: string;
  name: string;
  tz: string;
  origin: { lon: number; lat: number };
  bbox: [number, number, number, number];
  routes: RouteInfo[];
  shapes: ShapeInfo[];
  attribution: { name: string; license: string; url?: string }[];
  lineVerts: Float32Array;
  lineChains: Uint32Array;
  water: Float32Array;
  shapePts: THREE.DataTexture;
  shapeTab: THREE.DataTexture;
}

async function bin(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.arrayBuffer();
}

export function floatTexture(data: Float32Array, width: number): THREE.DataTexture {
  const h = Math.max(1, Math.ceil(data.length / 4 / width));
  const padded = new Float32Array(width * h * 4);
  padded.set(data);
  const t = new THREE.DataTexture(padded, width, h, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export async function loadCity(id: string): Promise<CityData> {
  const metaRes = await fetch(`/api/city/${id}`);
  if (!metaRes.ok) throw new Error(`city ${id}: HTTP ${metaRes.status}`);
  const meta = await metaRes.json();
  const [pts, lines, chains, water] = await Promise.all(
    ['points.bin', 'lines.bin', 'chains.bin', 'water.bin'].map((f) => bin(`/api/city/${id}/${f}`)),
  );
  const shapes: ShapeInfo[] = meta.shapes;
  const tab = new Float32Array(shapes.length * 4);
  shapes.forEach((s, i) => { tab[i * 4] = s.start; tab[i * 4 + 1] = s.count; tab[i * 4 + 2] = s.length; tab[i * 4 + 3] = s.route; });
  return {
    ...meta,
    lineVerts: new Float32Array(lines),
    lineChains: new Uint32Array(chains),
    water: new Float32Array(water),
    shapePts: floatTexture(new Float32Array(pts), 2048),
    shapeTab: floatTexture(tab, 1024),
  };
}
