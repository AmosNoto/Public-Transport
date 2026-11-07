// Water polygons for a city, from OpenFreeMap vector tiles (OpenMapTiles schema, OSM data).
// Only the `water` layer is used: no roads, no labels. Triangulated here so the client just draws.

import path from 'node:path';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import earcut from 'earcut';
import { config } from '../config.ts';
import { toRel, type Origin } from '../geo.ts';
import { fetchCached } from './gtfs.ts';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
export const BASEMAP_ATTRIBUTION = 'OpenFreeMap © OpenMapTiles, data © OpenStreetMap contributors';

let tileUrl: string | null = null;
async function tileTemplate(): Promise<string> {
  if (tileUrl) return tileUrl;
  const buf = await fetchCached(TILEJSON, path.join(config.cacheDir, 'basemap', 'tilejson.json'), 7 * 86400);
  tileUrl = JSON.parse(buf.toString()).tiles[0] as string;
  return tileUrl;
}

const lon2x = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

/** Pick the most detailed zoom that keeps the tile count polite. */
function chooseZoom(b: [number, number, number, number], maxTiles: number): number {
  for (let z = 12; z >= 6; z--) {
    const n = (lon2x(b[2], z) - lon2x(b[0], z) + 1) * (lat2y(b[1], z) - lat2y(b[3], z) + 1);
    if (n <= maxTiles) return z;
  }
  return 6;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()!); }));
}

/** Triangles of water, as (x, y) relative-mercator pairs, three vertices per triangle. */
export async function buildWater(cityId: string, origin: Origin, bbox: [number, number, number, number]): Promise<Float32Array> {
  const tpl = await tileTemplate();
  const z = chooseZoom(bbox, 150);
  const x0 = lon2x(bbox[0], z), x1 = lon2x(bbox[2], z), y0 = lat2y(bbox[3], z), y1 = lat2y(bbox[1], z);
  const tiles: [number, number][] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push([x, y]);

  const out: number[] = [];
  await pool(tiles, 6, async ([x, y]) => {
    const url = tpl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
    let buf: Buffer;
    try {
      buf = await fetchCached(url, path.join(config.cacheDir, 'basemap', 'tiles', `${z}`, `${x}`, `${y}.pbf`), 30 * 86400);
    } catch (e) {
      console.warn(`[basemap] ${cityId} tile ${z}/${x}/${y}: ${(e as Error).message}`);
      return;
    }
    const vt = new VectorTile(new PbfReader(buf));
    const layer = vt.layers.water;
    if (!layer) return;
    for (let i = 0; i < layer.length; i++) {
      const gj = layer.feature(i).toGeoJSON(x, y, z);
      const g = gj.geometry;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const rings of polys) {
        const flat: number[] = [], holes: number[] = [];
        rings.forEach((ring, ri) => {
          if (ri > 0) holes.push(flat.length / 2);
          for (const [lon, lat] of ring) { const [rx, ry] = toRel(origin, lon, lat); flat.push(rx, ry); }
        });
        const tri = earcut(flat, holes, 2);
        for (const t of tri) out.push(flat[t * 2], flat[t * 2 + 1]);
      }
    }
  });
  console.log(`[basemap] ${cityId}: ${tiles.length} tiles at z${z}, ${out.length / 6} water triangles`);
  return Float32Array.from(out);
}
