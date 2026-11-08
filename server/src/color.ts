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
 * OKLCH hues of the visible spectrum, red to violet, at roughly even perceptual steps.
 * Spectral light has no magenta or pink, so neither does this ramp.
 */
const SPECTRUM = [27, 45, 64, 86, 110, 140, 165, 192, 222, 250, 272, 292];

/** Hue at position s ∈ [0, 1] along the spectrum. */
export function spectralHue(s: number): number {
  const x = Math.min(1, Math.max(0, s)) * (SPECTRUM.length - 1);
  const i = Math.min(SPECTRUM.length - 2, Math.floor(x));
  return SPECTRUM[i] + (SPECTRUM[i + 1] - SPECTRUM[i]) * (x - i);
}

/**
 * The most saturated displayable colour of a hue, kept bright enough to read as light
 * (lightness 0.6–0.86), like the lens's spectral rays.
 */
export function vivid(h: number): RGB {
  let bestL = 0.7, bestC = 0;
  for (let L = 0.6; L <= 0.861; L += 0.02) {
    let lo = 0, hi = 0.4;
    for (let k = 0; k < 18; k++) {
      const mid = (lo + hi) / 2;
      const rgb = oklchToLinear({ L, C: mid, h });
      if (rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) lo = mid; else hi = mid;
    }
    if (lo > bestC + 0.004) { bestC = lo; bestL = L; }
  }
  return oklchToRgb({ L: bestL, C: bestC * 0.97, h });
}

/**
 * Spectrum positions (0 = red … 1 = violet) for routes without a usable colour. Position
 * sweeps with each route's bearing from the city centre, so the city reads as a rainbow;
 * routes that run within ~300 m of each other are then pushed apart on the spectrum so
 * neighbours stay distinct.
 */
export function spectralPositions(routes: SpectralInput[]): Map<string, number> {
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
  const pos: number[] = new Array(info.length).fill(NaN);
  const MIN_SEP = Math.min(0.14, 0.9 / Math.max(2, Math.sqrt(info.length)));
  info.forEach((_, i) => {
    // A triangle wave (0→1→0) around the city keeps the sweep continuous: no red/violet seam.
    const t = info.length > 1 ? i / info.length : 0;
    const base = t < 0.5 ? t * 2 : 2 - t * 2;
    let pick = base, pickScore = -1;
    for (let k = 0; k <= 50; k++) {
      const p = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.02;
      if (p < 0 || p > 1) continue;
      let minD = 1;
      for (const j of nb[i]) if (!Number.isNaN(pos[j])) minD = Math.min(minD, Math.abs(p - pos[j]));
      if (minD >= MIN_SEP) { pick = p; break; }
      if (minD > pickScore) { pickScore = minD; pick = p; }
    }
    pos[i] = pick;
  });
  info.forEach((it, i) => out.set(it.r.key, pos[i]));
  return out;
}
