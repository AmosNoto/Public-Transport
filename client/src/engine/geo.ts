// Geographic math shared by the camera, picking and per-layer uniforms. The vertex shader
// mirrors `globeLocal` and `flatLocal` exactly (see glsl.ts), so CPU picking matches the GPU.
//
// World frame: origin at the camera's focus point on the surface; +X east, +Y up, +Z south.
// Globe: a sphere of radius R centred at (0, -R, 0). Flat: Web Mercator scaled to metres at the
// focus latitude. `morph` blends globe (0) into flat (1) by camera altitude.

export const R = 6371008.8;
export const D2R = Math.PI / 180;

export const mercY = (latRad: number) => Math.log(Math.tan(Math.PI / 4 + latRad / 2));
export const invMercY = (m: number) => 2 * Math.atan(Math.exp(m)) - Math.PI / 2;
export const wrapPi = (a: number) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
export const wrap180 = (d: number) => d - 360 * Math.floor((d + 180) / 360);

export interface Focus {
  lon: number; // radians
  lat: number;
  sinLat: number;
  cosLat: number;
  merc: number;
  /** Metres per radian of mercator at the focus latitude (R cos φ). */
  scale: number;
}

export function focusOf(lonDeg: number, latDeg: number): Focus {
  const lon = lonDeg * D2R, lat = latDeg * D2R;
  return { lon, lat, sinLat: Math.sin(lat), cosLat: Math.cos(lat), merc: mercY(lat), scale: R * Math.cos(lat) };
}

/** Per-layer uniforms for geometry stored relative to an origin (lon/lat in degrees). */
export function layerOffsets(f: Focus, originLonDeg: number, originLatDeg: number) {
  const dLon = wrapPi(originLonDeg * D2R - f.lon);
  const m0 = mercY(originLatDeg * D2R);
  return { dLon, m0, off: [dLon * f.scale, (m0 - f.merc) * f.scale] as [number, number] };
}

/** Unit direction of (Δλ from focus, φ) in the world frame (east, up, south). */
export function globeDir(f: Focus, dl: number, phi: number): [number, number, number] {
  const cp = Math.cos(phi), sp = Math.sin(phi);
  const x = cp * Math.cos(dl), y = cp * Math.sin(dl), z = sp;
  const n = -f.sinLat * x + f.cosLat * z;
  const u = f.cosLat * x + f.sinLat * z;
  return [y, u, -n];
}

/** World position of a geographic point for a given morph. */
export function worldOf(f: Focus, lonRad: number, latRad: number, morph: number): [number, number, number] {
  const dl = wrapPi(lonRad - f.lon);
  const fx = dl * f.scale, fy = (mercY(Math.max(-1.5, Math.min(1.5, latRad))) - f.merc) * f.scale;
  if (morph >= 0.999) return [fx, 0, -fy];
  const d = globeDir(f, dl, latRad);
  const gx = d[0] * R, gy = d[1] * R - R, gz = d[2] * R;
  return [gx + (fx - gx) * morph, gy + (0 - gy) * morph, gz + (-fy - gz) * morph];
}

/** Geographic point (radians) under a world-space ray, on the sphere or the plane. */
export function rayToGeo(f: Focus, morph: number, o: [number, number, number], dir: [number, number, number]): { lon: number; lat: number } | null {
  if (morph < 0.5) {
    // Sphere centred at (0, -R, 0).
    const ox = o[0], oy = o[1] + R, oz = o[2];
    const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
    const c = ox * ox + oy * oy + oz * oz - R * R;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    if (t < 0) return null;
    const px = (ox + dir[0] * t) / R, py = (oy + dir[1] * t) / R, pz = (oz + dir[2] * t) / R;
    // Local (E, N, U) → ECEF in the focus-longitude frame.
    const E = px, U = py, N = -pz;
    const vx = -N * f.sinLat + U * f.cosLat, vy = E, vz = N * f.cosLat + U * f.sinLat;
    return { lon: f.lon + Math.atan2(vy, vx), lat: Math.asin(Math.max(-1, Math.min(1, vz))) };
  }
  if (dir[1] >= -1e-9) return null;
  const t = -o[1] / dir[1];
  const x = o[0] + dir[0] * t, z = o[2] + dir[2] * t;
  return { lon: f.lon + x / f.scale, lat: invMercY(f.merc + -z / f.scale) };
}

/** Great-circle angle between two points (radians in, radians out). */
export function arc(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const s = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * The subsolar point (where the sun is overhead) for a date, from the NOAA low-precision
 * solar coordinates. Accurate to about a tenth of a degree, plenty for a terminator.
 */
export function subsolar(date: Date): { lat: number; lon: number } {
  const d = date.getTime() / 86400000 - 10957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * D2R;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R;
  const e = (23.439 - 0.00000036 * d) * D2R;
  const decl = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / D2R / 15;
  let eqt = q / 15 - ra; // hours
  eqt = eqt - 24 * Math.round(eqt / 24);
  const utcH = (date.getTime() / 3600000) % 24;
  return { lat: decl, lon: wrapPi(-15 * (utcH - 12 + eqt) * D2R) };
}

/** Cosine of the sun's zenith angle at a point (1 = overhead, < 0 = night). */
export function sunCos(sun: { lat: number; lon: number }, lonRad: number, latRad: number): number {
  return Math.sin(latRad) * Math.sin(sun.lat) + Math.cos(latRad) * Math.cos(sun.lat) * Math.cos(lonRad - sun.lon);
}
