// Live vehicles. Every dot is placed by the GPU: given its last fix (distance along its shape,
// speed, time) the vertex shader extrapolates along the real route geometry. When a new fix
// arrives the difference is eased out over a few seconds, and a dot never runs backwards for
// small corrections, so there's no teleporting or jitter. Dots fade over a minute once
// their source goes quiet.

import * as THREE from 'three';
import { COMMON, ROUTES, SHAPES, quadCorners } from '../engine/glsl.ts';
import type { SharedUniforms } from '../engine/engine.ts';
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
  stopped: boolean;
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

  constructor(private city: CityData, u: SharedUniforms, off: THREE.Vector2, routeTex: THREE.Texture) {
    const q = quadCorners();
    this.geo.setAttribute('position', new THREE.BufferAttribute(q.position, 3));
    this.geo.setIndex(q.index);
    this.grow(2048);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...u, uOff: { value: off }, uRouteTex: { value: routeTex },
        uShapePts: { value: city.shapePts }, uShapeTab: { value: city.shapeTab }, uSize: { value: 11 },
      },
      transparent: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: COMMON + ROUTES + SHAPES + /* glsl */ `
        attribute vec4 aA; attribute vec4 aB; attribute vec4 aC;
        uniform float uSize;
        varying vec2 vUv; varying vec3 vColor;
        const float HORIZON = ${HORIZON.toFixed(1)}, EASE = ${EASE.toFixed(1)}, HOLD_MAX = ${HOLD_MAX.toFixed(1)};
        void main() {
          vec4 rs = routeState(aC.z);
          vec2 rel = aC.xy;
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
          vColor = mix(rs.rgb, vec3(1.0), 0.45) * 1.25 * alpha * on;
          vec4 c = clipOf(rel);
          vec2 corner = position.xy * vec2(2.0, 1.0) - vec2(1.0, 0.0);
          vUv = corner;
          c.xy += corner * uSize * uDpr * 0.5 / (uRes * 0.5) * c.w;
          gl_Position = (alpha * on) > 0.002 ? c : vec4(2.0, 2.0, 2.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vColor;
        void main() {
          float r = length(vUv);
          if (r > 1.0) discard;
          // The lens photon falloff: 1 at the centre, 0.6 at a quarter, 0 at the edge.
          float a = r < 0.25 ? mix(1.0, 0.6, r / 0.25) : mix(0.6, 0.0, (r - 0.25) / 0.75);
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
    A[i] = s.shape; A[i + 1] = s.dF; A[i + 2] = s.stopped ? 0 : s.v; A[i + 3] = s.tF;
    B[i] = s.err; B[i + 1] = s.tC; B[i + 2] = s.born; B[i + 3] = s.hold;
    C[i] = s.rx; C[i + 1] = s.ry; C[i + 2] = s.route; C[i + 3] = s.stopped ? FLAG_STOPPED : 0;
  }

  /** Apply fixes. `now` and timestamps are seconds on the client time base. */
  update(list: WireVehicle[], now: number, toLocal: (epoch: number) => number) {
    for (const [key, route, shape, d, v, ts, rx, ry, flags] of list) {
      const tF = toLocal(ts);
      let s = this.slots.get(key);
      const stopped = (flags & FLAG_STOPPED) !== 0;
      const speed = stopped ? 0 : v;
      if (!s) {
        let i = this.free.pop();
        if (i === undefined) { if (this.count >= this.cap) this.grow(this.cap * 2); i = this.count++; }
        s = { key, i, route, shape, dF: d, v, tF, err: 0, tC: now, hold: d, born: now, rx, ry, stopped };
        this.slots.set(key, s);
      } else if (s.shape === shape && shape >= 0) {
        const len = this.city.shapes[shape].length;
        const shown = distanceAt({ ...s, v: s.stopped ? 0 : s.v }, now, len);
        const target = d + speed * Math.min(HORIZON, Math.max(0, now - tF));
        const err = shown - target;
        Object.assign(s, { route, dF: d, v, tF, rx, ry, stopped, tC: now, hold: shown });
        if (Math.abs(err) > JUMP) { s.err = 0; s.born = now; } else s.err = err;
      } else {
        // New trip, or no shape: start fresh, fading in where it is.
        Object.assign(s, { route, shape, dF: d, v, tF, rx, ry, stopped, err: 0, tC: now, hold: d, born: now });
      }
      this.write(s);
    }
    this.aA.needsUpdate = this.aB.needsUpdate = this.aC.needsUpdate = true;
    this.geo.instanceCount = this.count;
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
  activity(now: number): { perRoute: Map<number, number>; perShape: Map<number, number>; total: number } {
    const perRoute = new Map<number, number>(), perShape = new Map<number, number>();
    let total = 0;
    for (const s of this.slots.values()) {
      if (now - s.tF > FADE_START) continue;
      total++;
      perRoute.set(s.route, (perRoute.get(s.route) ?? 0) + 1);
      if (s.shape >= 0) perShape.set(s.shape, (perShape.get(s.shape) ?? 0) + 1);
    }
    return { perRoute, perShape, total };
  }

  setSize(px: number) { (this.mesh.material as THREE.ShaderMaterial).uniforms.uSize.value = px; }
}
