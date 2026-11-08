// Water for any part of the world, as triangles, from OpenFreeMap vector tiles (OpenMapTiles
// schema, OSM data). Only the `water` layer is used: no roads, no labels. At low zooms the
// triangles are subdivided so they follow the globe's curvature instead of cutting through it.
//
// Output coordinates are relative to the tile's north-west corner: (Δλ radians, Δ mercator y),
// the same encoding as city geometry, so the client projects both with one function.

import path from 'node:path';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import earcut from 'earcut';
import { config } from '../config.ts';
import { mercY } from '../geo.ts';
import { fetchCached } from './gtfs.ts';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
export const BASEMAP_ATTRIBUTION = 'OpenFreeMap © OpenMapTiles, data © OpenStreetMap contributors';
export const MAX_WATER_ZOOM = 12;

let tileUrl: string | null = null;
let tileUrlAt = 0;
async function tileTemplate(): Promise<string> {
  if (tileUrl && Date.now() - tileUrlAt < 6 * 3600_000) return tileUrl;
  const buf = await fetchCached(TILEJSON, path.join(config.cacheDir, 'basemap', 'tilejson.json'), 24 * 3600);
  tileUrl = JSON.parse(buf.toString()).tiles[0] as string;
  tileUrlAt = Date.now();
  return tileUrl;
}

export const tileLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
export const tileLat = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

/** Longest edge (degrees) allowed per zoom so flat triangles hug the sphere. */
const maxEdgeDeg = (z: number) => (z <= 2 ? 3 : z <= 5 ? 1.5 : z <= 7 ? 0.75 : Infinity);

/**
 * Split triangles (lon/lat degrees) at the midpoint of their longest edge until every edge is
 * short enough. Bisection keeps the count proportional to area (earcut's long slivers would
 * explode under 1→4 splitting); the T-junctions it leaves open hairline gaps no wider than the
 * chord sag (< 1 km at globe zoom, far below a pixel).
 */
function subdivide(tri: number[], maxDeg: number): number[] {
  if (!Number.isFinite(maxDeg)) return tri;
  const out: number[] = [];
  const stack: number[][] = [];
  for (let i = 0; i < tri.length; i += 6) stack.push(tri.slice(i, i + 6));
  const m2 = maxDeg * maxDeg;
  while (stack.length) {
    const t = stack.pop()!;
    const [ax, ay, bx, by, cx, cy] = t;
    const ab = (ax - bx) ** 2 + (ay - by) ** 2, bc = (bx - cx) ** 2 + (by - cy) ** 2, ca = (cx - ax) ** 2 + (cy - ay) ** 2;
    const e = Math.max(ab, bc, ca);
    if (e <= m2 || out.length > 4_000_000) { out.push(...t); continue; }
    if (e === ab) { const mx = (ax + bx) / 2, my = (ay + by) / 2; stack.push([ax, ay, mx, my, cx, cy], [mx, my, bx, by, cx, cy]); }
    else if (e === bc) { const mx = (bx + cx) / 2, my = (by + cy) / 2; stack.push([ax, ay, bx, by, mx, my], [ax, ay, mx, my, cx, cy]); }
    else { const mx = (cx + ax) / 2, my = (cy + ay) / 2; stack.push([ax, ay, bx, by, mx, my], [mx, my, bx, by, cx, cy]); }
  }
  return out;
}

const memo = new Map<string, Promise<Float32Array>>();

/** Water triangles for one tile, cached in memory (LRU-ish) and on disk (raw tile). */
export function waterTile(z: number, x: number, y: number): Promise<Float32Array> {
  const key = `${z}/${x}/${y}`;
  let p = memo.get(key);
  if (p) { memo.delete(key); memo.set(key, p); return p; }
  p = buildWaterTile(z, x, y);
  memo.set(key, p);
  p.catch(() => memo.delete(key));
  while (memo.size > 800) memo.delete(memo.keys().next().value!);
  return p;
}

async function buildWaterTile(z: number, x: number, y: number): Promise<Float32Array> {
  const tpl = await tileTemplate();
  const url = tpl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  const buf = await fetchCached(url, path.join(config.cacheDir, 'basemap', 'tiles', `${z}`, `${x}`, `${y}.pbf`), 30 * 86400);
  const vt = new VectorTile(new PbfReader(buf));
  const layer = vt.layers.water;
  const lon0 = tileLon(x, z), lat0 = tileLat(y, z), m0 = mercY(lat0);
  const out: number[] = [];
  if (layer) {
    for (let i = 0; i < layer.length; i++) {
      const g = layer.feature(i).toGeoJSON(x, y, z).geometry;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const rings of polys) {
        // Triangulate in lon / mercator-y (a planar, conformal space), subdivide in degrees.
        const flat: number[] = [], holes: number[] = [], ll: number[] = [];
        rings.forEach((ring, ri) => {
          if (ri > 0) holes.push(flat.length / 2);
          for (const [lon, lat] of ring) { flat.push(lon, mercY(Math.max(-85.06, Math.min(85.06, lat)))); ll.push(lon, lat); }
        });
        const idx = earcut(flat, holes, 2);
        const tri: number[] = [];
        for (const t of idx) tri.push(ll[t * 2], ll[t * 2 + 1]);
        for (const [i2, v] of subdivide(tri, maxEdgeDeg(z)).entries()) {
          if (i2 % 2 === 0) out.push(((v - lon0) * Math.PI) / 180);
          else out.push(mercY(Math.max(-85.06, Math.min(85.06, v))) - m0);
        }
      }
    }
  }
  return Float32Array.from(out);
}
