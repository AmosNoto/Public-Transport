// Water, streamed as tiles for whatever the camera sees, at a zoom matched to altitude.
// Land is the Earth mesh underneath; these draw over it, just darker, so geography reads
// faintly and never competes with the light. Tiles stay until their replacements arrive.

import * as THREE from 'three';
import { COMMON, SUN } from '../engine/glsl.ts';
import type { SharedUniforms } from '../engine/engine.ts';
import type { GlobeCamera } from '../engine/camera.ts';
import { layerOffsets, D2R, wrapPi } from '../engine/geo.ts';

const MAX_Z = 12, MAX_TILES = 36, MAX_PARALLEL = 6;

const tileLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileLat = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
const lonToX = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const latToY = (lat: number, z: number) => {
  const r = Math.max(-85.0511, Math.min(85.0511, lat)) * D2R;
  return Math.min(2 ** z - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)));
};

interface Tile { key: string; z: number; x: number; y: number; mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>; used: number }

export class WaterTiles {
  readonly group = new THREE.Group();
  private tiles = new Map<string, Tile>();
  private loading = new Set<string>();
  private queue: string[] = [];
  private failed = new Map<string, number>();
  private wanted = new Set<string>();
  private shown = new Set<string>();
  private lastPlan = 0;
  private proto: THREE.ShaderMaterial;

  constructor(private u: SharedUniforms, colors: { day: THREE.Color; night: THREE.Color }) {
    this.proto = new THREE.ShaderMaterial({
      uniforms: { ...u, uDay: { value: colors.day }, uNight: { value: colors.night } },
      side: THREE.DoubleSide, depthTest: false, depthWrite: false,
      vertexShader: COMMON + /* glsl */ `
        attribute vec2 rel;
        varying vec2 vGeo;
        varying float vVis;
        varying float vRim;
        void main() {
          gl_Position = clipOf(rel);
          vVis = gVis;
          vGeo = geoOf(rel);
          vRim = (1.0 - uMorph) * pow(1.0 - clamp(gFacing, 0.0, 1.0), 3.0);
        }`,
      fragmentShader: SUN + /* glsl */ `
        uniform vec3 uDay, uNight;
        varying vec2 vGeo;
        varying float vVis;
        varying float vRim;
        void main() {
          if (vVis < 0.5) discard; // far side of the globe
          float n = nightOf(vGeo);
          vec3 c = mix(uDay, uNight, n) + vec3(0.055, 0.075, 0.1) * vRim * (1.0 - 0.6 * n);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    // Draw after the Earth mesh (group order sorts before object order in three.js).
    this.group.renderOrder = 10;
  }

  /** Choose tiles for the current view (throttled), and re-place visible tiles every frame. */
  update(cam: GlobeCamera, now: number) {
    if (now - this.lastPlan > 200) { this.plan(cam); this.lastPlan = now; }
    for (const key of this.shown) {
      const t = this.tiles.get(key);
      if (!t) continue;
      const o = layerOffsets(cam.focus, tileLon(t.x, t.z), tileLat(t.y, t.z));
      const un = t.mesh.material.uniforms;
      un.uDLon.value = o.dLon; un.uM0.value = o.m0; (un.uOff.value as THREE.Vector2).set(o.off[0], o.off[1]);
      t.used = now;
    }
  }

  private zoomFor(cam: GlobeCamera): number {
    const mpp = cam.metresPerPixel();
    const circ = 2 * Math.PI * 6371008.8 * Math.cos(cam.focus.lat);
    return Math.max(2, Math.min(MAX_Z, Math.round(Math.log2(circ / (mpp * 512)))));
  }

  private plan(cam: GlobeCamera) {
    const w = cam.el.clientWidth || innerWidth, h = cam.el.clientHeight || innerHeight;
    // Sample the view: a screen grid, plus the visible hemisphere when part of the view is space.
    const pts: { lon: number; lat: number }[] = [];
    let missed = 0;
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
      const g = cam.pick((w * i) / 8, (h * j) / 8);
      if (g) pts.push(g); else missed++;
    }
    if (missed && cam.morph < 0.5) {
      const horizon = Math.acos(6371008.8 / (6371008.8 + cam.view.alt));
      for (let a = 0; a < 16; a++) for (const f of [0.35, 0.7, 1]) {
        const ang = (a / 16) * 2 * Math.PI, d = horizon * f;
        const lat0 = cam.focus.lat, lon0 = cam.focus.lon;
        const lat = Math.asin(Math.sin(lat0) * Math.cos(d) + Math.cos(lat0) * Math.sin(d) * Math.cos(ang));
        const lon = lon0 + Math.atan2(Math.sin(ang) * Math.sin(d) * Math.cos(lat0), Math.cos(d) - Math.sin(lat0) * Math.sin(lat));
        pts.push({ lon, lat });
      }
    }
    if (!pts.length) return;
    let dlMin = Infinity, dlMax = -Infinity, latMin = Infinity, latMax = -Infinity;
    for (const p of pts) {
      const dl = wrapPi(p.lon - cam.focus.lon);
      dlMin = Math.min(dlMin, dl); dlMax = Math.max(dlMax, dl);
      latMin = Math.min(latMin, p.lat); latMax = Math.max(latMax, p.lat);
    }
    const padL = (dlMax - dlMin) * 0.08, padT = (latMax - latMin) * 0.08;
    const lon0 = (cam.focus.lon + dlMin - padL) / D2R, lon1 = (cam.focus.lon + dlMax + padL) / D2R;
    const la0 = (latMin - padT) / D2R, la1 = (latMax + padT) / D2R;

    let z = this.zoomFor(cam), keys: string[] = [];
    for (; z >= 2; z--) {
      keys = [];
      const n = 2 ** z;
      const x0 = lonToX(lon0, z), x1 = lonToX(lon1, z), y0 = latToY(la1, z), y1 = latToY(la0, z);
      const xs = Math.min(n, x1 - x0 + 1);
      if (xs * (y1 - y0 + 1) > MAX_TILES) continue;
      for (let dx = 0; dx < xs; dx++) for (let y = y0; y <= y1; y++) keys.push(`${z}/${(((x0 + dx) % n) + n) % n}/${y}`);
      break;
    }
    this.wanted = new Set(keys);
    for (const k of keys) if (!this.tiles.has(k) && !this.loading.has(k) && !this.queue.includes(k) && (this.failed.get(k) ?? 0) < Date.now()) this.queue.push(k);
    // Nearest-first: the queue keeps request order, which follows the screen grid scan; good enough.
    this.queue = this.queue.filter((k) => this.wanted.has(k));
    this.pump();
    this.refreshShown();
  }

  private pump() {
    while (this.loading.size < MAX_PARALLEL && this.queue.length) {
      const key = this.queue.shift()!;
      this.loading.add(key);
      fetch(`/api/water/${key}`)
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
        .then((buf) => { this.add(key, new Float32Array(buf)); })
        .catch(() => { this.failed.set(key, Date.now() + 30_000); })
        .finally(() => { this.loading.delete(key); this.pump(); this.refreshShown(); });
    }
  }

  private add(key: string, tri: Float32Array) {
    const [z, x, y] = key.split('/').map(Number);
    const g = new THREE.BufferGeometry();
    g.setAttribute('rel', new THREE.BufferAttribute(tri, 2));
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((tri.length / 2) * 3), 3));
    const m = this.proto.clone();
    // Clone copies uniform values; re-link the shared ones so they keep updating.
    for (const k of Object.keys(this.u) as (keyof SharedUniforms)[]) m.uniforms[k] = this.u[k];
    m.uniforms.uDLon = { value: 0 }; m.uniforms.uM0 = { value: 0 }; m.uniforms.uOff = { value: new THREE.Vector2() };
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.group.add(mesh);
    this.tiles.set(key, { key, z, x, y, mesh, used: performance.now() });
  }

  /** Show wanted tiles that are loaded; keep showing old ones until everything wanted is in. */
  private refreshShown() {
    const ready = [...this.wanted].filter((k) => this.tiles.has(k));
    const complete = ready.length === this.wanted.size;
    const next = new Set(ready);
    if (!complete) for (const k of this.shown) if (this.tiles.has(k)) next.add(k);
    for (const [k, t] of this.tiles) t.mesh.visible = next.has(k);
    this.shown = next;
    // Evict long-unused tiles.
    if (this.tiles.size > 220) {
      const old = [...this.tiles.values()].filter((t) => !next.has(t.key)).sort((a, b) => a.used - b.used);
      for (const t of old.slice(0, this.tiles.size - 180)) {
        this.group.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh.material.dispose();
        this.tiles.delete(t.key);
      }
    }
  }
}
