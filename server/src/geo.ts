// Geometry helpers shared by preprocessing and live snapping.

export const EARTH_R = 6371008.8;
const D2R = Math.PI / 180;

export function mercY(latDeg: number): number {
  const φ = latDeg * D2R;
  return Math.log(Math.tan(Math.PI / 4 + φ / 2));
}

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dφ = (lat2 - lat1) * D2R, dλ = (lon2 - lon1) * D2R;
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** An origin that everything in a city is stored relative to, so float32 keeps sub-centimetre precision. */
export interface Origin { lon: number; lat: number }

/** Relative Web-Mercator coordinates in radians: x = Δλ, y = Δ(mercator y). */
export function toRel(o: Origin, lon: number, lat: number): [number, number] {
  return [(lon - o.lon) * D2R, mercY(lat) - mercY(o.lat)];
}

/** Douglas–Peucker on lon/lat using a local metric; returns kept indices. */
export function simplifyIdx(lat: Float64Array, lon: Float64Array, tolM: number): number[] {
  const n = lat.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const kx = Math.cos(lat[0] * D2R) * EARTH_R * D2R, ky = EARTH_R * D2R;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const tol2 = tolM * tolM;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = lon[a] * kx, ay = lat[a] * ky, bx = lon[b] * kx, by = lat[b] * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let best = -1, bestD = tol2;
    for (let i = a + 1; i < b; i++) {
      const px = lon[i] * kx - ax, py = lat[i] * ky - ay;
      let t = L2 > 0 ? (px * dx + py * dy) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - t * dx, ey = py - t * dy, d = ex * ex + ey * ey;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

export interface Polyline {
  lat: Float64Array;
  lon: Float64Array;
  /** Cumulative distance in metres at each vertex. */
  cum: Float64Array;
  length: number;
}

export function makePolyline(lat: Float64Array, lon: Float64Array): Polyline {
  const cum = new Float64Array(lat.length);
  for (let i = 1; i < lat.length; i++) cum[i] = cum[i - 1] + haversine(lat[i - 1], lon[i - 1], lat[i], lon[i]);
  return { lat, lon, cum, length: cum[cum.length - 1] ?? 0 };
}

/**
 * Project a point onto a polyline. Returns distance along the line and the perpendicular
 * offset in metres. `hint` (a previous distance) breaks ties on loops and out-and-back
 * shapes: among candidates within a few metres of the best, the one nearest the hint wins.
 */
export function projectOnto(pl: Polyline, lat: number, lon: number, hint?: number): { d: number; off: number } {
  const kx = Math.cos(lat * D2R) * EARTH_R * D2R, ky = EARTH_R * D2R;
  const n = pl.lat.length;
  const cands: { d: number; off: number }[] = [];
  let best = Infinity;
  for (let i = 0; i < n - 1; i++) {
    const ax = (pl.lon[i] - lon) * kx, ay = (pl.lat[i] - lat) * ky;
    const bx = (pl.lon[i + 1] - lon) * kx, by = (pl.lat[i + 1] - lat) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + t * dx, ey = ay + t * dy, off = Math.sqrt(ex * ex + ey * ey);
    if (off < best + 25) {
      cands.push({ d: pl.cum[i] + t * (pl.cum[i + 1] - pl.cum[i]), off });
      if (off < best) best = off;
    }
  }
  const near = cands.filter((c) => c.off <= best + 15);
  if (hint === undefined || near.length <= 1) return near.reduce((a, b) => (b.off < a.off ? b : a), near[0] ?? { d: 0, off: Infinity });
  return near.reduce((a, b) => (Math.abs(b.d - hint) < Math.abs(a.d - hint) ? b : a));
}
