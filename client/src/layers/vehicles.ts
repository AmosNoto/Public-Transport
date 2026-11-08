// Live vehicles. Every dot is placed by the GPU: given its last fix (distance along its shape,
// speed, time) the vertex shader extrapolates along the real route geometry. When a new fix
// arrives the difference is eased out over a few seconds, and a dot never runs backwards for
// small corrections, so there's no teleporting or jitter. Dots fade over a minute once
// their source goes quiet.

import * as THREE from 'three';
import { COMMON, ROUTES, SHAPES, quadCorners } from '../engine/glsl.ts';
import type { SharedUniforms, LayerUniforms, CityUniforms } from '../engine/engine.ts';
import type { CityData } from '../data/city.ts';

/** Seconds of extrapolation beyond a fix before a dot waits for the next one. */
export const HORIZON = 45;
/** Seconds over which a correction is eased out. */
export const EASE = 3;
/** A dot ahead of its new fix by more than this is allowed to glide back rather than hold. */
const HOLD_MAX = 150;
/** Corrections larger than this restart the dot with a fade instead of sliding. */
const JUMP = 600;
export const FADE_START = 120, FADE_END = 180;

const FLAG_STOPPED = 1;
/** Placed from the timetable rather than a live position. */
const FLAG_SCHEDULED = 4;

/** Wire form from the server: [key, route, shape, d, v, ts, rx, ry, flags]. */
export type WireVehicle = [string, number, number, number, number, number, number, number, number];

interface Slot {
  key: string;
  i: number;
  route: number;
  shape: number;
  dF: number; v: number; tF: number;
  err: number; tC: number; hold: number; born: number;
  rx: number; ry: number;
  /** Unsnapped vehicles: where the glide starts, and how long it takes (s). */
  px: number; py: number; glide: number;
  stopped: boolean;
  scheduled: boolean;
}

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** CPU mirror of the shader's motion model. */
function distanceAt(s: Slot, t: number, length: number): number {
  const target = s.dF + s.v * Math.min(HORIZON, Math.max(0, t - s.tF));
  let d = target + s.err * (1 - smooth(s.tC, s.tC + EASE, t));
  if (s.err > 0 && s.err < HOLD_MAX) d = Math.max(d, s.hold);
  return Math.min(length, Math.max(0, d));
}

export class Vehicles {
  readonly mesh: THREE.Mesh;
  private slots = new Map<string, Slot>();
  private free: number[] = [];
  private cap = 0;
  private geo = new THREE.InstancedBufferGeometry();
  private aA!: THREE.InstancedBufferAttribute; // shape, dF, v, tF
  private aB!: THREE.InstancedBufferAttribute; // err, tC, born, hold
  private aC!: THREE.InstancedBufferAttribute; // rx, ry, route, flags
  private count = 0;

  constructor(private city: CityData, u: SharedUniforms, lu: LayerUniforms, cu: CityUniforms, routeTex: THREE.Texture) {
    const q = quadCorners();
    this.geo.setAttribute('position', new THREE.BufferAttribute(q.position, 3));
    this.geo.setIndex(q.index);
    this.grow(2048);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...u, ...lu, ...cu, uRouteTex: { value: routeTex },
        uShapePts: { value: city.shapePts }, uShapeTab: { value: city.shapeTab }, uSize: { value: 11 }, uGain: { value: 1 },
      },
      transparent: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: COMMON + ROUTES + SHAPES + /* glsl */ `
        attribute vec4 aA; attribute vec4 aB; attribute vec4 aC;
        uniform float uSize, uGain, uAlpha, uBoost;
        varying vec2 vUv; varying vec3 vColor; varying float vSched;
        const float HORIZON = ${HORIZON.toFixed(1)}, EASE = ${EASE.toFixed(1)}, HOLD_MAX = ${HOLD_MAX.toFixed(1)};
        void main() {
          vec4 rs = routeState(aC.z);
          // Not on a known line: glide in a straight line from where it was drawn to its latest
          // reported position, over about one update interval, so it moves continuously.
          vec2 rel = mix(vec2(aB.x, aB.w), aC.xy, clamp((uTime - aB.y) / max(aA.z, 0.5), 0.0, 1.0));
          if (aA.x >= 0.0) {
            vec4 info = shapeInfo(aA.x);
            float target = aA.y + aA.z * clamp(uTime - aA.w, 0.0, HORIZON);
            float d = target + aB.x * (1.0 - smoothstep(aB.y, aB.y + EASE, uTime));
            if (aB.x > 0.0 && aB.x < HOLD_MAX) d = max(d, aB.w);
            rel = shapeAt(info, clamp(d, 0.0, info.z));
          }
          float age = uTime - aA.w;
          float alpha = smoothstep(aB.z, aB.z + 1.2, uTime) * (1.0 - smoothstep(${FADE_START.toFixed(1)}, ${FADE_END.toFixed(1)}, age));
          // Vehicles show even when their route is quiet; a hidden mode hides them entirely.
          float on = rs.a > 0.0 ? 1.0 : 0.0;
          // Scheduled vehicles: dimmer and closer to the route colour, drawn as hollow rings.
          vSched = aC.w >= 4.0 ? 1.0 : 0.0;
          vec4 c = clipOf(rel);
          alpha *= gVis * uAlpha * uGain;
          vColor = (vSched > 0.5 ? rs.rgb * 0.8 : mix(rs.rgb, vec3(1.0), 0.45) * 1.25) * alpha * on * uBoost;
          vec2 corner = position.xy * vec2(2.0, 1.0) - vec2(1.0, 0.0);
          vUv = corner;
          c.xy += corner * uSize * uDpr * 0.5 / (uRes * 0.5) * c.w;
          gl_Position = (alpha * on) > 0.002 ? c : vec4(2.0, 2.0, 2.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vColor; varying float vSched;
        void main() {
          float r = length(vUv);
          if (r > 1.0) discard;
          // The lens photon falloff: 1 at the centre, 0.6 at a quarter, 0 at the edge.
          float a = r < 0.25 ? mix(1.0, 0.6, r / 0.25) : mix(0.6, 0.0, (r - 0.25) / 0.75);
          if (vSched > 0.5) a = exp(-pow((r - 0.55) / 0.14, 2.0)) * 0.9; // hollow ring, dark centre
          gl_FragColor = vec4(vColor * a, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
  }

  private grow(n: number) {
    const old = [this.aA, this.aB, this.aC];
    const mk = (prev?: THREE.InstancedBufferAttribute) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      if (prev) (a.array as Float32Array).set(prev.array as Float32Array);
      return a;
    };
    this.aA = mk(old[0]); this.aB = mk(old[1]); this.aC = mk(old[2]);
    for (let i = this.cap; i < n; i++) (this.aA.array as Float32Array)[i * 4 + 3] = -1e6; // empty slots: long dead
    this.geo.setAttribute('aA', this.aA); this.geo.setAttribute('aB', this.aB); this.geo.setAttribute('aC', this.aC);
    this.cap = n;
  }

  private write(s: Slot) {
    const A = this.aA.array as Float32Array, B = this.aB.array as Float32Array, C = this.aC.array as Float32Array, i = s.i * 4;
    const free = s.shape < 0;
    A[i] = s.shape; A[i + 1] = s.dF; A[i + 2] = free ? s.glide : s.stopped ? 0 : s.v; A[i + 3] = s.tF;
    B[i] = free ? s.px : s.err; B[i + 1] = s.tC; B[i + 2] = s.born; B[i + 3] = free ? s.py : s.hold;
    C[i] = s.rx; C[i + 1] = s.ry; C[i + 2] = s.route; C[i + 3] = (s.stopped ? FLAG_STOPPED : 0) + (s.scheduled ? FLAG_SCHEDULED : 0);
  }

  /** Apply fixes. `now` and timestamps are seconds on the client time base. */
  update(list: WireVehicle[], now: number, toLocal: (epoch: number) => number) {
    for (const [key, route, shape, d, v, ts, rx, ry, flags] of list) {
      const tF = toLocal(ts);
      let s = this.slots.get(key);
      const stopped = (flags & FLAG_STOPPED) !== 0;
      const scheduled = (flags & FLAG_SCHEDULED) !== 0;
      const speed = stopped ? 0 : v;
      if (!s) {
        let i = this.free.pop();
        if (i === undefined) { if (this.count >= this.cap) this.grow(this.cap * 2); i = this.count++; }
        s = { key, i, route, shape, dF: d, v, tF, err: 0, tC: now, hold: d, born: now, rx, ry, px: rx, py: ry, glide: 1, stopped, scheduled };
        this.slots.set(key, s);
      } else if (s.shape === shape && shape >= 0) {
        const len = this.city.shapes[shape].length;
        const shown = distanceAt({ ...s, v: s.stopped ? 0 : s.v }, now, len);
        const target = d + speed * Math.min(HORIZON, Math.max(0, now - tF));
        const err = shown - target;
        Object.assign(s, { route, dF: d, v, tF, rx, ry, stopped, scheduled, tC: now, hold: shown });
        if (Math.abs(err) > JUMP) { s.err = 0; s.born = now; } else s.err = err;
      } else if (s.shape < 0 && shape < 0) {
        // Still off any known line: glide from where it's drawn now to the new position.
        const k = Math.min(1, Math.max(0, (now - s.tC) / Math.max(s.glide, 0.5)));
        const sx = s.px + (s.rx - s.px) * k, sy = s.py + (s.ry - s.py) * k;
        const jump = Math.hypot(rx - sx, ry - sy) * 6.371e6; // metres, roughly
        const glide = Math.min(15, Math.max(3, tF - s.tF));
        Object.assign(s, { route, dF: d, v, tF, rx, ry, stopped, scheduled, tC: now, px: sx, py: sy, glide });
        if (jump > JUMP * 4) { s.px = rx; s.py = ry; s.born = now; }
      } else {
        // New trip, or moving on/off a line: start fresh, fading in where it is.
        Object.assign(s, { route, shape, dF: d, v, tF, rx, ry, px: rx, py: ry, glide: 1, stopped, scheduled, err: 0, tC: now, hold: d, born: now });
      }
      this.write(s);
    }
    this.aA.needsUpdate = this.aB.needsUpdate = this.aC.needsUpdate = true;
    this.geo.instanceCount = this.count;
  }

  /** Vehicles the server says have ended: start their fade-out now. */
  end(keys: string[], now: number) {
    for (const k of keys) {
      const s = this.slots.get(k);
      if (!s) continue;
      s.tF = Math.min(s.tF, now - FADE_START);
      this.write(s);
    }
    this.aA.needsUpdate = this.aB.needsUpdate = this.aC.needsUpdate = true;
  }

  /** Recycle slots whose dots have fully faded. */
  sweep(now: number) {
    for (const [k, s] of this.slots) {
      if (now - s.tF > FADE_END + 5) {
        this.slots.delete(k);
        (this.aA.array as Float32Array)[s.i * 4 + 3] = -1e6;
        this.free.push(s.i);
        this.aA.needsUpdate = true;
      }
    }
  }

  /** Live vehicles per route and per shape (for photon density and route activity). */
  activity(now: number): { perRoute: Map<number, number>; perShape: Map<number, number>; total: number; scheduled: number } {
    const perRoute = new Map<number, number>(), perShape = new Map<number, number>();
    let total = 0, scheduled = 0;
    for (const s of this.slots.values()) {
      if (now - s.tF > FADE_START) continue;
      perRoute.set(s.route, (perRoute.get(s.route) ?? 0) + 1);
      if (s.scheduled) { scheduled++; continue; } // no flowing light, not counted as live
      total++;
      if (s.shape >= 0) perShape.set(s.shape, (perShape.get(s.shape) ?? 0) + 1);
    }
    return { perRoute, perShape, total, scheduled };
  }

  /** Zoomed out, hundreds of dots share a few pixels: shrink and dim them so a city stays light, not glare. */
  setZoom(metresPerPixel: number) {
    const u = (this.mesh.material as THREE.ShaderMaterial).uniforms;
    u.uSize.value = 11 * Math.min(1, Math.max(0.36, Math.pow(8 / metresPerPixel, 0.35)));
    u.uGain.value = Math.min(1, Math.max(0.12, Math.pow(30 / metresPerPixel, 0.5)));
  }
}
