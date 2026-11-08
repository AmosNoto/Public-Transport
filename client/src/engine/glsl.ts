// GLSL shared by every layer. All geometry arrives relative to an origin (its city, tile or
// the earth grid) as (Δλ radians, Δ mercator-y). `worldOf` places it in the world frame for
// the current focus, as a blend of its position on the globe and on the flat map by `uMorph`,
// so every layer unrolls from globe to map together. CPU mirror: engine/geo.ts.
//
// World frame: origin at the focus point on the surface; +X east, +Y up, +Z south.

export const COMMON = /* glsl */ `
const float EARTH_R = 6371008.8;
uniform float uScale;      // metres per radian at the focus latitude (R·cos φ)
uniform vec2  uLatC;       // (sin, cos) of the focus latitude
uniform float uLonC;       // focus longitude (radians), for absolute positions
uniform float uMorph;      // 0 = globe, 1 = flat map
uniform vec3  uCam;        // camera position in the world frame
uniform float uTime;       // seconds since the client time base
uniform vec2  uRes;        // drawing-buffer size in pixels
uniform float uDpr;
// Per layer: where this layer's origin is relative to the focus.
uniform float uDLon;       // origin longitude - focus longitude (radians, wrapped)
uniform float uM0;         // origin mercator y (absolute)
uniform vec2  uOff;        // flat-map offset of the origin from the focus (metres, computed in double)

float gVis;                // set by worldOf: 1 on the visible side of the globe, 0 behind it
float gFacing;             // set by worldOf: cosine between the surface normal and the view (globe only)

vec3 globeDirOf(float dl, float phi) {
  float cp = cos(phi), sp = sin(phi);
  float x = cp * cos(dl), y = cp * sin(dl), z = sp;
  float n = -uLatC.x * x + uLatC.y * z;
  float u =  uLatC.y * x + uLatC.x * z;
  return vec3(y, u, -n);
}

vec3 worldOf(vec2 rel) {
  vec2 p = rel * uScale + uOff;
  vec3 flatP = vec3(p.x, 0.0, -p.y);
  if (uMorph >= 0.999) { gVis = 1.0; gFacing = 1.0; return flatP; }
  float phi = 2.0 * atan(exp(uM0 + rel.y)) - 1.5707963268;
  vec3 d = globeDirOf(uDLon + rel.x, phi);
  vec3 g = d * EARTH_R - vec3(0.0, EARTH_R, 0.0);
  // Visible if the surface there faces the camera; soft at the limb.
  float facing = dot(d, normalize(uCam - g));
  gFacing = facing;
  gVis = mix(smoothstep(-0.02, 0.05, facing), 1.0, smoothstep(0.6, 1.0, uMorph));
  return mix(g, flatP, uMorph);
}

vec4 clipOf(vec2 rel) {
  return projectionMatrix * viewMatrix * vec4(worldOf(rel), 1.0);
}

// Absolute geographic position of a relative point (radians), for sun shading.
vec2 geoOf(vec2 rel) {
  return vec2(uLonC + uDLon + rel.x, 2.0 * atan(exp(uM0 + rel.y)) - 1.5707963268);
}
`;

export const SUN = /* glsl */ `
uniform vec2 uSun;         // subsolar point (lat, lon) in radians
uniform float uDayNight;   // 1 = shade by real sun (Auto theme); 0 = no day/night
// 1 in full night, 0 in daylight, with a soft twilight band around the terminator.
float nightOf(vec2 geo) {
  float c = sin(geo.y) * sin(uSun.x) + cos(geo.y) * cos(uSun.x) * cos(geo.x - uSun.y);
  return uDayNight * (1.0 - smoothstep(-0.12, 0.08, c));
}
`;

export const ROUTES = /* glsl */ `
uniform sampler2D uRouteTex; // per route: rgb colour, a = intensity (mode toggles, activity, hover)
vec4 routeState(float r) {
  int i = int(r + 0.5);
  return texelFetch(uRouteTex, ivec2(i % 1024, i / 1024), 0);
}
`;

export const SHAPES = /* glsl */ `
uniform sampler2D uShapePts; // per vertex: rel x, rel y, cumulative metres
uniform sampler2D uShapeTab; // per shape: start, count, length, route
const int PTS_W = 2048;

vec4 shapeInfo(float s) {
  int i = int(s + 0.5);
  return texelFetch(uShapeTab, ivec2(i % 1024, i / 1024), 0);
}
vec4 shapePt(int i) {
  return texelFetch(uShapePts, ivec2(i % PTS_W, i / PTS_W), 0);
}
// Position at distance d (metres) along shape s; binary search over cumulative distance.
vec2 shapeAt(vec4 info, float d) {
  int lo = int(info.x), hi = int(info.x + info.y) - 1;
  for (int it = 0; it < 22; it++) {
    if (lo >= hi) break;
    int mid = (lo + hi + 1) / 2;
    if (shapePt(mid).z <= d) lo = mid; else hi = mid - 1;
  }
  int last = int(info.x + info.y) - 1;
  vec4 a = shapePt(lo), b = shapePt(min(lo + 1, last));
  float seg = max(b.z - a.z, 1e-3);
  return mix(a.xy, b.xy, clamp((d - a.z) / seg, 0.0, 1.0));
}
`;

/** Unit quad used by every instanced layer: corner.x along, corner.y across. */
export function quadCorners(): { position: Float32Array; index: number[] } {
  return { position: new Float32Array([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]), index: [0, 1, 2, 2, 1, 3] };
}
