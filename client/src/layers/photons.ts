// Photons: decorative light streaming along each route in its direction of travel, as in the
// lens. Count and brightness per shape follow how many vehicles are on it right now, so busy
// lines shimmer and quiet ones barely pulse. Phases are golden-ratio staggered so photons
// never march in lockstep. Positions are computed entirely on the GPU.

import * as THREE from 'three';
import { COMMON, ROUTES, SHAPES, quadCorners } from '../engine/glsl.ts';
import type { SharedUniforms } from '../engine/engine.ts';
import type { CityData } from '../data/city.ts';

const PHI = 0.6180339887;

export class Photons {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.InstancedBufferGeometry();
  private mat: THREE.ShaderMaterial;
  /** Distance (m) photons have travelled; advanced at a constant on-screen speed. */
  private clock = 0;

  constructor(private city: CityData, u: SharedUniforms, off: THREE.Vector2, routeTex: THREE.Texture) {
    const q = quadCorners();
    this.geo.setAttribute('position', new THREE.BufferAttribute(q.position, 3));
    this.geo.setIndex(q.index);
    this.geo.setAttribute('ph', new THREE.InstancedBufferAttribute(new Float32Array(4), 4));
    this.geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        ...u, uOff: { value: off }, uRouteTex: { value: routeTex },
        uShapePts: { value: city.shapePts }, uShapeTab: { value: city.shapeTab },
        uClock: { value: 0 }, uSize: { value: 5 },
      },
      transparent: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: COMMON + ROUTES + SHAPES + /* glsl */ `
        attribute vec4 ph; // shape, phase 0–1, brightness, speed factor
        uniform float uClock, uSize;
        varying vec2 vUv; varying vec3 vColor;
        void main() {
          vec4 info = shapeInfo(ph.x);
          vec4 rs = routeState(info.w);
          float L = info.z;
          float d = mod(ph.y * L + uClock * ph.w, L);
          // Fade in and out at the ends of the line so the wrap never pops.
          float edge = smoothstep(0.0, 120.0, d) * smoothstep(0.0, 120.0, L - d);
          vColor = rs.rgb * rs.a * ph.z * edge;
          vec4 c = clipOf(shapeAt(info, d));
          vec2 corner = position.xy * vec2(2.0, 1.0) - vec2(1.0, 0.0);
          vUv = corner;
          c.xy += corner * uSize * uDpr * 0.5 / (uRes * 0.5) * c.w;
          gl_Position = rs.a * edge > 0.001 ? c : vec4(2.0, 2.0, 2.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vColor;
        void main() {
          float r = length(vUv);
          if (r > 1.0) discard;
          float a = r < 0.25 ? mix(1.0, 0.6, r / 0.25) : mix(0.6, 0.0, (r - 0.25) / 0.75);
          gl_FragColor = vec4(vColor * a, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
  }

  /** Rebuild photon instances from current service levels. */
  rebuild(perShape: Map<number, number>, budget: number) {
    // Photons per km: a quiet line gets a sparse trickle, a busy one a dense stream.
    const want: { s: number; n: number; b: number }[] = [];
    let total = 0;
    for (const [s, veh] of perShape) {
      const km = this.city.shapes[s].length / 1000;
      const perKm = Math.min(2.2, 0.25 + 0.22 * veh);
      const n = Math.max(1, Math.round(km * perKm));
      want.push({ s, n, b: Math.min(1, 0.45 + 0.1 * veh) });
      total += n;
    }
    const scale = total > budget ? budget / total : 1;
    const out: number[] = [];
    for (const w of want) {
      const n = Math.max(1, Math.floor(w.n * scale));
      const offset = (w.s * 0.7548776662) % 1; // per-shape offset (plastic-number sequence)
      for (let i = 0; i < n; i++) {
        // Photon i of a shape always has the same phase and speed, however many photons the
        // shape has: the golden-ratio sequence stays evenly spread as photons are added or
        // removed, so a change in service never makes existing photons jump.
        const phase = (offset + i * PHI) % 1;
        out.push(w.s, phase, w.b, 0.92 + ((offset * 3.1 + i * PHI * 7) % 1) * 0.16);
      }
    }
    const attr = new THREE.InstancedBufferAttribute(Float32Array.from(out), 4);
    this.geo.setAttribute('ph', attr);
    this.geo.instanceCount = out.length / 4;
  }

  /** Advance at a constant speed in screen pixels per second, whatever the zoom. */
  tick(dt: number, metresPerPixel: number, reducedMotion: boolean) {
    if (reducedMotion) return;
    this.clock = (this.clock + dt * 70 * metresPerPixel) % 1e7;
    this.mat.uniforms.uClock.value = this.clock;
  }
}
