// Cities, streamed by proximity. At globe level each city is only a glow (a few thousand sample
// points). As the camera comes down near a city, its full geometry loads and its vehicles are
// subscribed; the detailed city fades in as the glow fades out. Leaving unloads both again.

import * as THREE from 'three';
import { layerUniforms, type CityUniforms, type LayerUniforms, type SharedUniforms } from '../engine/engine.ts';
import type { GlobeCamera } from '../engine/camera.ts';
import { R, D2R, arc, layerOffsets, worldOf, subsolar, sunCos } from '../engine/geo.ts';
import { listCities, loadCity, loadGlow, type CityData, type CityInfo, type Mode } from '../data/city.ts';
import type { LiveClient } from '../data/live.ts';
import { RouteState } from '../layers/routeState.ts';
import { routeLines } from '../layers/routes.ts';
import { Vehicles, type WireVehicle } from '../layers/vehicles.ts';
import { Photons } from '../layers/photons.ts';
import { cityGlow } from '../layers/glow.ts';
import { buildRibbon } from '../layers/ribbon.ts';

/** Below this altitude a nearby city's detail is loaded. */
const DETAIL_ALT = 1_600_000;
/** Altitudes over which glow crossfades into detail. */
const FADE_FAR = 1_400_000, FADE_NEAR = 450_000;
/** Keep a city loaded this long after leaving it, in case the camera comes back. */
const LINGER_MS = 15_000;

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

class CityDetail {
  readonly group = new THREE.Group();
  readonly routes: RouteState;
  readonly lines: ReturnType<typeof routeLines>;
  readonly vehicles: Vehicles;
  readonly photons: Photons;
  readonly cu: CityUniforms = { uAlpha: { value: 0 }, uBoost: { value: 1 } };
  private lastActivity = 0;

  constructor(readonly data: CityData, u: SharedUniforms, lu: LayerUniforms, modes: Record<Mode, boolean>) {
    this.routes = new RouteState(data);
    this.routes.update(modes);
    this.lines = routeLines(data.ribbon, u, lu, this.cu, this.routes.texture);
    this.photons = new Photons(data, u, lu, this.cu, this.routes.texture);
    this.vehicles = new Vehicles(data, u, lu, this.cu, this.routes.texture);
    this.group.add(this.lines, this.photons.mesh, this.vehicles.mesh);
  }

  /** Service levels drive route brightness and photon density. */
  refresh(now: number, modes: Record<Mode, boolean>, photonBudget: number, force = false) {
    if (!force && performance.now() - this.lastActivity < 3000) return;
    this.lastActivity = performance.now();
    this.vehicles.sweep(now);
    const act = this.vehicles.activity(now);
    this.routes.active.fill(0);
    for (const [r, n] of act.perRoute) this.routes.active[r] = n;
    this.routes.update(modes);
    this.photons.rebuild(act.perShape, photonBudget);
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) (m.material as THREE.Material).dispose();
    });
    this.routes.texture.dispose();
    this.data.shapePts.dispose();
    this.data.shapeTab.dispose();
  }
}

export interface CityEntry {
  info: CityInfo;
  lu: LayerUniforms;
  glowCu: CityUniforms;
  glow?: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  glowN: number;
  radius: number; // metres
  detail?: CityDetail;
  loading: boolean;
  leftAt: number;
  nearSince: number;
  fade: number;
  night: number;
  /** Distance from the view focus (m), updated each frame. */
  dist: number;
}

export class CityManager {
  readonly group = new THREE.Group();
  readonly cities = new Map<string, CityEntry>();
  modes: Record<Mode, boolean> = { subway: true, rail: true, bus: true, tram: true };
  photonBudget = 20000;
  private lastSun = 0;
  onChange: () => void = () => {};

  constructor(private u: SharedUniforms, private cam: GlobeCamera, private live: LiveClient) {
    this.warmUp();
    this.refreshList();
    setInterval(() => this.refreshList(), 20_000);
  }

  /**
   * Compile the city shaders up front with a tiny invisible stand-in city, so the first real
   * city to appear doesn't stall a frame on shader compilation. It stays (fully transparent)
   * so the compiled programs stay alive.
   */
  private warmUp() {
    const tex = (w: number) => { const t = new THREE.DataTexture(new Float32Array(w * 4), w, 1, THREE.RGBAFormat, THREE.FloatType); t.needsUpdate = true; return t; };
    const pts = tex(2048), tab = tex(1024);
    (pts.image.data as Float32Array).set([0, 0, 0, 0, 1e-5, 0, 100, 0]);
    (tab.image.data as Float32Array).set([0, 2, 100, 0]);
    const data: CityData = {
      id: '_warmup', name: '', country: '', tz: 'UTC', origin: { lon: 0, lat: 0 }, bbox: [0, 0, 0, 0],
      routes: [{ id: 'w', feed: 'w', short: '', long: '', mode: 'bus', light: [1, 1, 1], ink: [0, 0, 0], official: false }],
      shapes: [{ id: 'w', route: 0, start: 0, count: 2, length: 100 }], attribution: [],
      ribbon: buildRibbon(new Float32Array([0, 0, 1e-5, 0]), new Uint32Array([0, 2, 0])),
      shapePts: pts, shapeTab: tab,
    };
    const d = new CityDetail(data, this.u, layerUniforms(), this.modes);
    d.cu.uAlpha.value = 0;
    this.group.add(d.group);
  }

  private async refreshList() {
    let list: CityInfo[];
    try { list = await listCities(); } catch { return; }
    for (const info of list) {
      let e = this.cities.get(info.id);
      if (!e) {
        e = { info, lu: layerUniforms(), glowCu: { uAlpha: { value: 1 }, uBoost: { value: 1 } }, glowN: 0, radius: 20_000, loading: false, leftAt: 0, nearSince: 0, fade: 0, night: 0, dist: Infinity };
        this.cities.set(info.id, e);
      } else e.info = { ...e.info, ...info, live: e.info.live, scheduled: e.info.scheduled };
      if (info.bbox) {
        const [a, b, c, d] = info.bbox;
        e.radius = (arc(a * D2R, b * D2R, c * D2R, d * D2R) * R) / 2;
      }
      if (info.state === 'ready' && !e.glow && e.glowN === 0) {
        e.glowN = -1; // loading
        loadGlow(info.id).then((g) => {
          e!.glow = cityGlow(g, this.u, e!.lu, e!.glowCu);
          e!.glowN = g.length / 5;
          this.group.add(e!.glow);
        }).catch(() => { e!.glowN = 0; });
      }
    }
    this.onChange();
  }

  /** Live counts from the server's stats message. */
  setCounts(per: Record<string, { live: number; scheduled: number }>) {
    for (const [id, c] of Object.entries(per)) { const e = this.cities.get(id); if (e) { e.info.live = c.live; e.info.scheduled = c.scheduled; } }
  }

  vehicles(id: string, list: WireVehicle[]) {
    const d = this.cities.get(id)?.detail;
    if (d) d.vehicles.update(list, this.live.now(), this.live.toLocal);
  }

  gone(id: string, keys: string[]) {
    this.cities.get(id)?.detail?.vehicles.end(keys, this.live.now());
  }

  setModes(m: Record<Mode, boolean>) {
    this.modes = m;
    for (const e of this.cities.values()) e.detail?.routes.update(m);
  }

  private async load(e: CityEntry) {
    e.loading = true;
    try {
      const data = await loadCity(e.info.id);
      e.detail = new CityDetail(data, this.u, e.lu, this.modes);
      this.group.add(e.detail.group);
      this.live.subscribe(e.info.id);
      this.onChange();
    } catch (err) {
      console.warn('city load failed', e.info.id, err);
    } finally {
      e.loading = false;
    }
  }

  private unload(e: CityEntry) {
    if (!e.detail) return;
    this.live.unsubscribe(e.info.id);
    this.group.remove(e.detail.group);
    e.detail.dispose();
    e.detail = undefined;
    e.fade = 0;
    this.onChange();
  }

  /** Per-frame: proximity streaming, crossfades, placement, brightness. */
  update(dt: number, now: number, linesGain: number) {
    const cam = this.cam, f = cam.focus, alt = cam.view.alt;
    if (now - this.lastSun > 10_000) {
      const sun = subsolar(new Date());
      for (const e of this.cities.values()) {
        const c = sunCos(sun, e.info.origin.lon * D2R, e.info.origin.lat * D2R);
        e.night = 1 - smooth(-0.12, 0.08, c);
      }
      this.lastSun = now;
    }
    const mpp = cam.metresPerPixel();
    const tNow = this.live.now();
    for (const e of this.cities.values()) {
      const o = e.info.origin;
      e.dist = arc(f.lon, f.lat, o.lon * D2R, o.lat * D2R) * R;
      const near = alt < DETAIL_ALT && e.dist < Math.max(alt * 0.9, 120_000) + e.radius;
      // Don't load cities a flight merely passes; load the destination early, others once the
      // camera has settled near them.
      const dest = cam.flightTarget;
      const destNear = !!dest && arc(dest.lon * D2R, dest.lat * D2R, o.lon * D2R, o.lat * D2R) * R < e.radius + 60_000;
      if (near) e.nearSince ||= now; else e.nearSince = 0;
      const settled = near && (dest ? destNear : now - e.nearSince > 350);
      if ((near || destNear) && e.info.state === 'ready') {
        e.leftAt = 0;
        if (!e.detail && !e.loading && (settled || destNear)) this.load(e);
      } else if (e.detail) {
        if (!e.leftAt) e.leftAt = now;
        else if (now - e.leftAt > LINGER_MS) this.unload(e);
      }
      const target = e.detail && near ? smooth(FADE_FAR, FADE_NEAR, alt) : 0;
      e.fade += (target - e.fade) * Math.min(1, dt * 2.5);
      if (Math.abs(target - e.fade) < 0.002) e.fade = target;

      // Placement relative to the focus (double precision on the CPU).
      const lo = layerOffsets(f, o.lon, o.lat);
      e.lu.uDLon.value = lo.dLon; e.lu.uM0.value = lo.m0; e.lu.uOff.value.set(lo.off[0], lo.off[1]);

      // Night cities glow brighter; cities with nothing running dim to a faint outline.
      const night = this.u.uDayNight.value * e.night;
      const nightBoost = 0.85 + 0.35 * night;
      const running = e.info.live + e.info.scheduled;
      const activity = running ? Math.min(1.3, Math.max(0.45, Math.sqrt(running / 250))) : 0.3;
      if (e.glow) {
        // Normalise by how many samples pile into each pixel, so far-away cities don't saturate.
        // Average number of sprites (≈5 px² each) covering each pixel of the city's disc.
        const rPx = Math.max(1, e.radius / mpp);
        const coverage = (e.glowN * 5) / (Math.PI * rPx * rPx);
        e.glow.material.uniforms.uGain.value = Math.min(1, Math.max(0.015, 0.6 / Math.max(0.6, coverage)));
        e.glowCu.uAlpha.value = 1 - e.fade;
        e.glowCu.uBoost.value = nightBoost * activity;
        e.glow.visible = e.glowCu.uAlpha.value > 0.002;
      }
      if (e.detail) {
        e.detail.cu.uAlpha.value = e.fade;
        e.detail.cu.uBoost.value = nightBoost;
        e.detail.group.visible = e.fade > 0.002;
        e.detail.lines.material.uniforms.uGain.value = linesGain;
        e.detail.photons.tick(dt, mpp, cam.reducedMotion);
        e.detail.vehicles.setZoom(mpp);
        e.detail.refresh(tNow, this.modes, this.photonBudget);
      }
    }
  }

  /** The city the view is in, if close enough to call it "in a city". */
  focused(): CityEntry | null {
    let best: CityEntry | null = null;
    for (const e of this.cities.values()) {
      if (e.fade < 0.5 || e.dist > e.radius * 1.3 + 20_000) continue;
      if (!best || e.dist < best.dist) best = e;
    }
    return best;
  }

  /** City whose glow is under a screen point (globe view), for click-to-fly. */
  cityAt(x: number, y: number, maxPx = 26): CityEntry | null {
    const cam = this.cam, w = cam.el.clientWidth || innerWidth, h = cam.el.clientHeight || innerHeight;
    let best: CityEntry | null = null, bestD = maxPx;
    const v = new THREE.Vector3();
    for (const e of this.cities.values()) {
      if (e.info.state !== 'ready') continue;
      const p = worldOf(cam.focus, e.info.origin.lon * D2R, e.info.origin.lat * D2R, cam.morph);
      // Hidden behind the globe?
      if (cam.morph < 0.6) {
        const n = [p[0] / R, (p[1] + R) / R, p[2] / R], c = cam.camera.position;
        if (n[0] * (c.x - p[0]) + n[1] * (c.y - p[1]) + n[2] * (c.z - p[2]) < 0) continue;
      }
      v.set(p[0], p[1], p[2]).project(cam.camera);
      const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - x, sy - y) - Math.min(40, e.radius / cam.metresPerPixel());
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /** Fly into a city. */
  flyTo(e: CityEntry) {
    const alt = Math.min(90_000, Math.max(14_000, e.radius * 1.4));
    this.cam.flyTo({ lon: e.info.origin.lon, lat: e.info.origin.lat, alt, pitch: 0.5, bearing: 0 });
  }
}
