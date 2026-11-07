// GLSL shared by every layer. All geometry arrives as coordinates relative to its city's
// origin (radians of Web-Mercator); `worldOf` turns that into metres around the camera focus.
// Milestone 2 adds the globe here: one function, so every layer morphs together.

export const COMMON = /* glsl */ `
uniform float uScale;      // metres per radian at the focus latitude (R·cos φ)
uniform vec2  uOff;        // this city's origin relative to the focus, metres (computed in double on the CPU)
uniform float uTime;       // seconds since the client time base
uniform vec2  uRes;        // drawing-buffer size in pixels
uniform float uDpr;

vec3 worldOf(vec2 rel) {
  vec2 p = rel * uScale + uOff;
  return vec3(p.x, 0.0, -p.y);
}

vec4 clipOf(vec2 rel) {
  return projectionMatrix * viewMatrix * vec4(worldOf(rel), 1.0);
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
