// One continuous camera from the whole globe down to street level. State is a focus point on
// the surface plus altitude, bearing and pitch; `morph` (globe → flat) follows altitude.
// Every gesture keeps the geographic point under the pointer fixed, on the globe and the map.

import * as THREE from 'three';
import { R, D2R, focusOf, rayToGeo, worldOf, wrap180, arc, type Focus } from './geo.ts';

export const ALT_MIN = 180;
export const ALT_MAX = 48_000_000;
/** Altitudes (m) between which the globe unrolls into the flat map. */
export const MORPH_GLOBE = 3_200_000, MORPH_FLAT = 700_000;
const MAX_PITCH = 1.05;

export interface View { lon: number; lat: number; alt: number; bearing: number; pitch: number } // degrees, metres, radians

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

interface Flight { from: View; to: View; t: number; dur: number; bump: number }

export class GlobeCamera {
  readonly camera: THREE.PerspectiveCamera;
  view: View;
  focus: Focus;
  morph = 0;
  /** Called on any user gesture (cancels flights; wakes the UI). */
  onInput: () => void = () => {};

  private pointers = new Map<number, { x: number; y: number }>();
  private grab: { lon: number; lat: number } | null = null; // radians
  private rotating = false;
  private last = { x: 0, y: 0, t: 0 };
  private vel = { lon: 0, lat: 0 }; // degrees / s
  private zoom: { target: number; x: number; y: number; geo: { lon: number; lat: number } | null } | null = null;
  private flight: Flight | null = null;
  private pinch: { dist: number; angle: number; midY: number } | null = null;
  private lastTap = 0;
  private ray = new THREE.Raycaster();

  constructor(readonly el: HTMLElement, initial: View, readonly reducedMotion: boolean) {
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 1e8);
    this.view = { ...initial };
    this.focus = focusOf(this.view.lon, this.view.lat);
    this.apply();
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e));
    el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('dblclick', (e) => this.zoomAt(e.offsetX, e.offsetY, 0.3));
    addEventListener('keydown', (e) => this.key(e));
  }

  /** Metres per CSS pixel at the view centre. */
  metresPerPixel(): number {
    return (2 * this.view.alt * Math.tan((this.camera.fov * D2R) / 2)) / (this.el.clientHeight || innerHeight);
  }

  // ---------- projection ----------

  /** Place the three.js camera for the current view. */
  apply() {
    const v = this.view;
    v.alt = Math.min(ALT_MAX, Math.max(ALT_MIN, v.alt));
    v.lat = Math.max(-85, Math.min(85, v.lat));
    v.lon = wrap180(v.lon);
    this.morph = smooth(MORPH_GLOBE, MORPH_FLAT, v.alt);
    v.pitch = Math.max(0, Math.min(v.pitch, MAX_PITCH * smooth(0.6, 1, this.morph)));
    this.focus = focusOf(v.lon, v.lat);
    const D = v.alt, b = v.bearing, p = v.pitch;
    const c = this.camera;
    c.position.set(-Math.sin(b) * Math.sin(p) * D, Math.cos(p) * D, Math.cos(b) * Math.sin(p) * D);
    c.up.set(Math.sin(b), 0, -Math.cos(b));
    c.lookAt(0, 0, 0);
    c.near = Math.max(1, D * 0.02);
    c.far = this.morph < 1 ? D + 2.2 * R : D * 60;
    const w = this.el.clientWidth || innerWidth, h = this.el.clientHeight || innerHeight;
    c.aspect = w / h;
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
  }

  /** Geographic point (radians) under a CSS-pixel position, or null (e.g. space). */
  pick(x: number, y: number): { lon: number; lat: number } | null {
    const w = this.el.clientWidth || innerWidth, h = this.el.clientHeight || innerHeight;
    this.ray.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, -(y / h) * 2 + 1), this.camera);
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    let g = rayToGeo(this.focus, this.morph, [o.x, o.y, o.z], [d.x, d.y, d.z]);
    if (!g || this.morph <= 0.001 || this.morph >= 0.999) return g;
    // Mid-unroll the surface is a blend of sphere and plane: refine the first guess (sphere or
    // plane) with Newton steps until the point really projects under the pointer. Without
    // this, picking jumps when the guess switches surfaces, and zooming drags the view.
    const eps = Math.max(1e-7, (this.metresPerPixel() * 2) / R);
    for (let it = 0; it < 5; it++) {
      const s0 = this.toScreen(g.lon, g.lat), sx = this.toScreen(g.lon + eps, g.lat), sy = this.toScreen(g.lon, g.lat + eps);
      if (!s0 || !sx || !sy) break;
      const ex = x - s0.x, ey = y - s0.y;
      if (ex * ex + ey * ey < 0.04) break;
      const a = (sx.x - s0.x) / eps, b = (sy.x - s0.x) / eps, c = (sx.y - s0.y) / eps, dd = (sy.y - s0.y) / eps;
      const det = a * dd - b * c;
      if (Math.abs(det) < 1e-12) break;
      g = { lon: g.lon + (dd * ex - b * ey) / det, lat: Math.max(-1.5, Math.min(1.5, g.lat + (a * ey - c * ex) / det)) };
    }
    return g;
  }

  private v3 = new THREE.Vector3();
  /** Screen position (CSS px) of a geographic point (radians) under the current camera. */
  toScreen(lon: number, lat: number): { x: number; y: number } | null {
    const p = worldOf(this.focus, lon, lat, this.morph);
    const v = this.v3.set(p[0], p[1], p[2]).project(this.camera);
    if (!Number.isFinite(v.x) || v.z > 1) return null;
    const w = this.el.clientWidth || innerWidth, h = this.el.clientHeight || innerHeight;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h };
  }

  /**
   * Move the focus so that geographic point `g` sits under screen position (x, y). `maxStep`
   * (radians) limits how far one call may move the view, so an ill-conditioned anchor near
   * the globe's edge can never fling it.
   */
  private anchor(g: { lon: number; lat: number }, x: number, y: number, maxStep = Infinity) {
    for (let i = 0; i < 3; i++) {
      const h = this.pick(x, y);
      if (!h) return;
      let dLon = wrap180((g.lon - h.lon) / D2R), dLat = (g.lat - h.lat) / D2R;
      if (Math.abs(dLon) < 1e-9 && Math.abs(dLat) < 1e-9) return;
      const step = Math.hypot(dLon * Math.cos(this.focus.lat), dLat) * D2R;
      if (step > maxStep) { const k = maxStep / step; dLon *= k; dLat *= k; }
      this.view.lon += dLon;
      this.view.lat += dLat;
      this.apply();
    }
  }

  /** How squarely the globe faces the camera at a point (1 = centre, 0 = limb); 1 on the flat map. */
  private facing(g: { lon: number; lat: number }): number {
    if (this.morph >= 0.6) return 1;
    const p = worldOf(this.focus, g.lon, g.lat, 0);
    const n = [p[0] / R, (p[1] + R) / R, p[2] / R], c = this.camera.position;
    const to = [c.x - p[0], c.y - p[1], c.z - p[2]], len = Math.hypot(to[0], to[1], to[2]);
    return (n[0] * to[0] + n[1] * to[1] + n[2] * to[2]) / len;
  }

  // ---------- gestures ----------

  private local(e: PointerEvent | WheelEvent | MouseEvent) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private down(e: PointerEvent) {
    this.el.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    this.flight = null; this.zoom = null; this.vel = { lon: 0, lat: 0 };
    this.onInput();
    if (this.pointers.size === 1) {
      this.rotating = e.button === 2 || e.button === 1 || e.ctrlKey || e.shiftKey;
      this.grab = this.rotating ? null : this.pick(p.x, p.y);
      this.last = { ...p, t: performance.now() };
      // Double-tap to zoom in (touch).
      if (e.pointerType === 'touch') {
        const now = performance.now();
        if (now - this.lastTap < 300) this.zoomAt(p.x, p.y, 0.3);
        this.lastTap = now;
      }
    } else if (this.pointers.size === 2) {
      this.startPinch();
    }
  }

  private startPinch() {
    const [a, b] = [...this.pointers.values()];
    this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), angle: Math.atan2(b.y - a.y, b.x - a.x), midY: (a.y + b.y) / 2 };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.grab = this.pick(mid.x, mid.y);
  }

  private move(e: PointerEvent) {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    this.onInput();
    if (this.pointers.size === 1) {
      const now = performance.now();
      if (this.rotating) {
        this.view.bearing += (p.x - this.last.x) * 0.006;
        this.view.pitch -= (p.y - this.last.y) * 0.005;
        this.apply();
      } else if (this.grab) {
        const before = { lon: this.view.lon, lat: this.view.lat };
        this.anchor(this.grab, p.x, p.y);
        const dt = Math.max(1, now - this.last.t) / 1000;
        const k = Math.min(1, dt * 12);
        this.vel.lon = this.vel.lon * (1 - k) + (wrap180(this.view.lon - before.lon) / dt) * k;
        this.vel.lat = this.vel.lat * (1 - k) + ((this.view.lat - before.lat) / dt) * k;
      }
      this.last = { ...p, t: now };
    } else if (this.pointers.size === 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y), angle = Math.atan2(b.y - a.y, b.x - a.x);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dDist = dist / Math.max(1, this.pinch.dist), dMid = mid.y - this.pinch.midY;
      // Both fingers moving vertically together tilts; otherwise pinch zooms and twists rotate.
      if (Math.abs(dDist - 1) < 0.03 && Math.abs(dMid) > 2 && this.morph > 0.6) {
        this.view.pitch -= dMid * 0.006;
      } else {
        this.view.alt /= dDist;
        this.view.bearing -= angle - this.pinch.angle;
      }
      this.apply();
      if (this.grab) this.anchor(this.grab, mid.x, mid.y);
      this.pinch = { dist, angle, midY: mid.y };
    }
  }

  private up(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 1) {
      // Lifting one finger of a pinch: continue as a one-finger drag from here.
      const p = [...this.pointers.values()][0];
      this.grab = this.pick(p.x, p.y);
      this.last = { ...p, t: performance.now() };
      this.pinch = null;
    } else if (this.pointers.size === 0) {
      this.grab = null; this.pinch = null; this.rotating = false;
      if (performance.now() - this.last.t > 80 || this.reducedMotion) this.vel = { lon: 0, lat: 0 };
    }
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    this.onInput();
    this.flight = null;
    const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    const dy = Math.max(-200, Math.min(200, e.deltaY * scale));
    const p = this.local(e);
    const from = this.zoom?.target ?? this.view.alt;
    this.zoomTo(from * Math.exp(dy * 0.0022), p.x, p.y);
  }

  private zoomTo(target: number, x: number, y: number) {
    target = Math.min(ALT_MAX, Math.max(ALT_MIN, target));
    // Zooming in heads toward the pointer; zooming out keeps the view where it is (anchoring
    // on the way out is what slowly dragged the view toward a pole). Points near the globe's
    // edge are too oblique to anchor on.
    let geo = target < this.view.alt ? this.pick(x, y) : null;
    if (geo && this.facing(geo) < 0.35) geo = null;
    this.zoom = { target, x, y, geo };
    if (this.reducedMotion) this.stepZoom(1);
  }

  zoomAt(x: number, y: number, factor: number) {
    this.onInput();
    this.flight = null;
    this.zoomTo(this.view.alt * factor, x, y);
  }

  private key(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;
    const w = this.el.clientWidth, h = this.el.clientHeight;
    const pan = (dx: number, dy: number) => {
      const g = this.pick(w / 2 + dx, h / 2 + dy);
      if (g) this.anchor(g, w / 2, h / 2);
    };
    const step = Math.min(w, h) * 0.12;
    switch (e.key) {
      case 'ArrowLeft': pan(-step, 0); break;
      case 'ArrowRight': pan(step, 0); break;
      case 'ArrowUp': pan(0, -step); break;
      case 'ArrowDown': pan(0, step); break;
      case '+': case '=': this.zoomAt(w / 2, h / 2, 0.5); break;
      case '-': case '_': this.zoomAt(w / 2, h / 2, 2); break;
      default: return;
    }
    this.onInput();
  }

  private stepZoom(k: number) {
    if (!this.zoom) return;
    const { target, x, y, geo } = this.zoom;
    this.view.alt = Math.exp(Math.log(this.view.alt) + (Math.log(target) - Math.log(this.view.alt)) * k);
    this.apply();
    // At most a fifth of the visible span per frame.
    if (geo) this.anchor(geo, x, y, (this.view.alt / R) * 0.2 + 1e-6);
    if (Math.abs(Math.log(this.view.alt / target)) < 0.002) this.zoom = null;
  }

  // ---------- flights ----------

  /** Fly to a view along an arc that rises with distance. */
  flyTo(to: Partial<View>, opts: { duration?: number } = {}) {
    const from = { ...this.view };
    const target: View = { ...from, ...to };
    target.lon = from.lon + wrap180(target.lon - from.lon);
    const d = arc(from.lon * D2R, from.lat * D2R, target.lon * D2R, target.lat * D2R);
    const peak = Math.min(ALT_MAX * 0.8, Math.max(from.alt, target.alt, d * R * 1.1));
    const bump = Math.max(0, Math.log(peak) - (Math.log(from.alt) + Math.log(target.alt)) / 2);
    const dur = opts.duration ?? Math.min(5.5, Math.max(1.4, 1.2 + 0.9 * Math.log10(1 + (d * R) / 30_000) + 0.1 * Math.abs(Math.log(target.alt / from.alt))));
    this.zoom = null; this.vel = { lon: 0, lat: 0 };
    if (this.reducedMotion) { this.view = target; this.apply(); return; }
    this.flight = { from, to: target, t: 0, dur, bump };
  }

  get flying() { return !!this.flight; }
  /** Where the current flight is heading, if any. */
  get flightTarget(): View | null { return this.flight?.to ?? null; }

  private stepFlight(dt: number) {
    const f = this.flight!;
    f.t = Math.min(f.dur, f.t + dt);
    const u = f.t / f.dur, s = easeInOut(u);
    // Great-circle interpolation of the focus.
    const a = f.from, b = f.to;
    const va = [Math.cos(a.lat * D2R) * Math.cos(a.lon * D2R), Math.cos(a.lat * D2R) * Math.sin(a.lon * D2R), Math.sin(a.lat * D2R)];
    const vb = [Math.cos(b.lat * D2R) * Math.cos(b.lon * D2R), Math.cos(b.lat * D2R) * Math.sin(b.lon * D2R), Math.sin(b.lat * D2R)];
    const om = Math.acos(Math.min(1, Math.max(-1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2])));
    let v = va;
    if (om > 1e-9) {
      const k1 = Math.sin((1 - s) * om) / Math.sin(om), k2 = Math.sin(s * om) / Math.sin(om);
      v = [va[0] * k1 + vb[0] * k2, va[1] * k1 + vb[1] * k2, va[2] * k1 + vb[2] * k2];
    }
    this.view.lat = Math.asin(Math.max(-1, Math.min(1, v[2]))) / D2R;
    this.view.lon = Math.atan2(v[1], v[0]) / D2R;
    this.view.alt = Math.exp(Math.log(a.alt) + (Math.log(b.alt) - Math.log(a.alt)) * s + f.bump * 4 * s * (1 - s));
    this.view.bearing = a.bearing + (b.bearing - a.bearing) * s;
    this.view.pitch = a.pitch + (b.pitch - a.pitch) * s;
    if (f.t >= f.dur) this.flight = null;
  }

  /** Advance animations; call once per frame. */
  update(dt: number) {
    if (this.flight) this.stepFlight(dt);
    else if (this.zoom) this.stepZoom(1 - Math.exp(-dt * 11));
    else if (!this.pointers.size && (Math.abs(this.vel.lon) > 1e-6 || Math.abs(this.vel.lat) > 1e-6)) {
      this.view.lon += this.vel.lon * dt;
      this.view.lat += this.vel.lat * dt;
      const k = Math.exp(-dt * 3.5);
      this.vel.lon *= k; this.vel.lat *= k;
      if (Math.hypot(this.vel.lon, this.vel.lat) * (R * D2R) / Math.max(1, this.metresPerPixel()) < 2) this.vel = { lon: 0, lat: 0 };
    }
    this.apply();
  }
}
