// Route colour as light: official colours tuned in OKLCH, and spectral hues for routes without one.

export type RGB = [number, number, number];
export interface LCH { L: number; C: number; h: number }

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToOklch([r, g, b]: RGB): LCH {
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

function oklchToLinear({ L, C, h }: LCH): RGB {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLCH → sRGB, reducing chroma (never hue or lightness) until it fits the gamut. */
export function oklchToRgb(c: LCH): RGB {
  let lo = 0, hi = c.C, rgb = oklchToLinear(c);
  const inGamut = (v: RGB) => v.every((x) => x >= -1e-4 && x <= 1 + 1e-4);
  if (!inGamut(rgb)) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2, t = oklchToLinear({ ...c, C: mid });
      if (inGamut(t)) { lo = mid; rgb = t; } else hi = mid;
    }
    rgb = oklchToLinear({ ...c, C: lo });
  }
  return rgb.map((x) => Math.round(gam(Math.min(1, Math.max(0, x))) * 1000) / 1000) as RGB;
}

/** Dark theme: lift lightness and chroma so the colour reads as light; keep the hue. */
export function asLight(c: LCH): RGB {
  return oklchToRgb({ L: Math.min(0.86, Math.max(0.7, c.L + 0.08)), C: Math.max(0.18, c.C * 1.15), h: c.h });
}

/** Light theme: the same hue as a deep, saturated ink that stays readable on pale paper. */
export function asInk(c: LCH): RGB {
  return oklchToRgb({ L: Math.min(0.58, Math.max(0.46, c.L - 0.05)), C: Math.max(0.14, c.C), h: c.h });
}

/** Near-grey, black or white colours carry no usable hue. */
export function isNeutral(c: LCH): boolean {
  return c.C < 0.035;
}

export interface SpectralInput {
  key: string;
  /** Sample points in local metres (x east, y north). */
  pts: [number, number][];
}

/**
 * Hues for routes without a usable colour. Hue sweeps around the spectrum by each route's
 * bearing from the city centre, so the city reads as a rainbow; then routes that run
 * within ~300 m of each other are pushed at least ~28° apart so neighbours stay distinct.
 */
export function spectralHues(routes: SpectralInput[], hueStart = 20): Map<string, number> {
  const out = new Map<string, number>();
  if (!routes.length) return out;
  let cx = 0, cy = 0, n = 0;
  for (const r of routes) for (const [x, y] of r.pts) { cx += x; cy += y; n++; }
  cx /= n || 1; cy /= n || 1;
  const info = routes.map((r) => {
    let sx = 0, sy = 0;
    for (const [x, y] of r.pts) { sx += x; sy += y; }
    const k = r.pts.length || 1;
    return { r, ang: Math.atan2(sy / k - cy, sx / k - cx) };
  }).sort((a, b) => a.ang - b.ang);

  // Neighbour graph from a 300 m grid hash.
  const CELL = 300, grid = new Map<string, Set<number>>();
  info.forEach((it, i) => {
    for (const [x, y] of it.r.pts) {
      const k = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
      let s = grid.get(k); if (!s) grid.set(k, (s = new Set())); s.add(i);
    }
  });
  const nb = info.map(() => new Set<number>());
  for (const [k, s] of grid) {
    const [gx, gy] = k.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const o = grid.get(`${gx + dx},${gy + dy}`); if (!o) continue;
      for (const a of s) for (const b of o) if (a !== b) { nb[a].add(b); nb[b].add(a); }
    }
  }
  const hue: number[] = new Array(info.length).fill(NaN);
  const dist = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  info.forEach((_, i) => {
    const base = (hueStart + (360 * i) / info.length) % 360;
    let pick = base, pickScore = -1;
    for (let k = 0; k <= 60; k++) {
      const h = (base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 6 + 360) % 360;
      let minD = 180;
      for (const j of nb[i]) if (!Number.isNaN(hue[j])) minD = Math.min(minD, dist(h, hue[j]));
      if (minD >= 28) { pick = h; break; }
      if (minD > pickScore) { pickScore = minD; pick = h; }
    }
    hue[i] = pick;
  });
  info.forEach((it, i) => out.set(it.r.key, hue[i]));
  return out;
}
