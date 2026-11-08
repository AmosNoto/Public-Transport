// Renderer, camera and the selective-bloom pipeline.
//
// Two scenes, as in the lens: `base` (land, water; never glows) and `light` (routes,
// photons, vehicles). Light is drawn into its own HDR target, UnrealBloomPass runs on that
// target alone, and the result (light + bloom) is added over the base. Nothing outside the
// light scene can ever bloom.

import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { TIERS, FrameGovernor, detectDevice, initialTier, type DeviceInfo, type Tier } from './quality.ts';
import { GlobeCamera, type View } from './camera.ts';
import { R, subsolar } from './geo.ts';

// Colours are authored as display values and blended as-is, exactly like the lens (three r128
// without colour management). Additive light in that space is what gives the lens its look.
THREE.ColorManagement.enabled = false;

/** Uniforms every layer shares (same objects, so one update reaches all materials). */
export interface SharedUniforms {
  uScale: { value: number };
  uLatC: { value: THREE.Vector2 };
  uLonC: { value: number };
  uMorph: { value: number };
  uCam: { value: THREE.Vector3 };
  uTime: { value: number };
  uRes: { value: THREE.Vector2 };
  uDpr: { value: number };
  uSun: { value: THREE.Vector2 };
  uDayNight: { value: number };
}

/** Per-layer placement relative to the focus (see layerOffsets in geo.ts). */
export interface LayerUniforms {
  uDLon: { value: number };
  uM0: { value: number };
  uOff: { value: THREE.Vector2 };
}

/** Per-city fade (globe glow ↔ detailed city) and brightness (night boost, activity). */
export interface CityUniforms {
  uAlpha: { value: number };
  uBoost: { value: number };
}

export function layerUniforms(): LayerUniforms {
  return { uDLon: { value: 0 }, uM0: { value: 0 }, uOff: { value: new THREE.Vector2() } };
}

export const PALETTE = {
  dark: {
    space: new THREE.Color('#090d12'),
    landDay: new THREE.Color('#0e151d'), landNight: new THREE.Color('#080b10'),
    waterDay: new THREE.Color('#070a0f'), waterNight: new THREE.Color('#030407'),
  },
};

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly globe: GlobeCamera;
  readonly base = new THREE.Scene();
  readonly light = new THREE.Scene();
  readonly uniforms: SharedUniforms;
  readonly device: DeviceInfo;
  tier: Tier;
  private lightRT!: THREE.WebGLRenderTarget;
  private bloom!: UnrealBloomPass;
  private resolveRT!: THREE.WebGLRenderTarget;
  private resolve: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private resolveScene = new THREE.Scene();
  private composite: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private compositeScene = new THREE.Scene();
  private orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private governor: FrameGovernor;
  private lastFrame = 0;
  private hooks: ((dt: number, now: number) => void)[] = [];
  /** Called whenever the quality tier changes. */
  onTier: (t: Tier) => void = () => {};

  /** Pin a quality tier (diagnostics), or 'auto' to let measured frame times decide again. */
  setTier(name: Tier['name'] | 'auto') {
    if (name === 'auto') { this.governor.locked = false; return; }
    const i = TIERS.findIndex((t) => t.name === name);
    if (i < 0) return;
    this.governor.locked = true;
    this.governor.tier = i;
    this.tier = TIERS[i];
    this.resize();
    this.onTier(this.tier);
  }

  get tierPinned() { return this.governor.locked; }

  constructor(readonly canvas: HTMLCanvasElement, initialView: View) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // colours are authored as display values, like the lens
    this.device = detectDevice(this.renderer.getContext() as WebGL2RenderingContext);
    const t0 = initialTier(this.device);
    this.tier = TIERS[t0];
    this.governor = new FrameGovernor(t0, Math.min(3, t0 + 1), (t) => { this.tier = TIERS[t]; this.resize(); this.onTier(this.tier); });

    this.globe = new GlobeCamera(canvas, initialView, this.device.reducedMotion);

    this.uniforms = {
      uScale: { value: R },
      uLatC: { value: new THREE.Vector2(0, 1) },
      uLonC: { value: 0 },
      uMorph: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uRes: { value: new THREE.Vector2(1, 1) },
      uDpr: { value: 1 },
      uSun: { value: new THREE.Vector2() },
      uDayNight: { value: 1 },
    };
    this.base.background = PALETTE.dark.space;

    // Resolve: light accumulates in HDR (so overlaps never clip early), then is compressed to
    // the 0–1 range the lens's 8-bit bloom buffer had. Overflow spills into all channels, so
    // overlapping colours brighten toward white instead of clipping to a flat hue.
    this.resolve = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: { tLight: { value: null } },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D tLight; varying vec2 vUv;
        vec3 softClip(vec3 x) { vec3 k = max(x - 0.75, 0.0); return min(x, 0.75) + 0.25 * (1.0 - exp(-k / 0.25)); }
        void main() {
          vec3 c = texture2D(tLight, vUv).rgb;
          float m = max(c.r, max(c.g, c.b));
          c += vec3(max(m - 0.85, 0.0) * 0.5);
          gl_FragColor = vec4(softClip(c), 1.0);
        }`,
    }));
    this.resolve.frustumCulled = false;
    this.resolveScene.add(this.resolve);
    // Composite: resolved light plus its bloom, added over the base.
    this.composite = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: { tLight: { value: null } },
      depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D tLight; varying vec2 vUv;
        void main() { gl_FragColor = vec4(min(texture2D(tLight, vUv).rgb, 1.0), 1.0); }`,
    }));
    this.composite.frustumCulled = false;
    this.compositeScene.add(this.composite);

    this.buildTargets();
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  private buildTargets() {
    this.lightRT?.dispose();
    this.resolveRT?.dispose();
    this.bloom?.dispose();
    this.lightRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: this.tier.msaa, depthBuffer: false });
    this.resolveRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    // Strength / radius / threshold exactly as the lens.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.35, 0.04);
    this.resolve.material.uniforms.tLight.value = this.lightRT.texture;
    this.composite.material.uniforms.tLight.value = this.resolveRT.texture;
  }

  resize() {
    const dpr = Math.min(this.device.dpr, this.tier.dprCap);
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (this.lightRT.samples !== this.tier.msaa) this.buildTargets();
    this.lightRT.setSize(W, H);
    this.resolveRT.setSize(W, H);
    this.bloom.setSize(Math.round(W * this.tier.bloomScale), Math.round(H * this.tier.bloomScale));
    this.globe.apply();
    this.uniforms.uRes.value.set(W, H);
    this.uniforms.uDpr.value = dpr;
  }

  get camera() { return this.globe.camera; }

  /** Metres covered by one CSS pixel at the view centre. */
  metresPerPixel(): number { return this.globe.metresPerPixel(); }

  private sunAt = 0;
  /** Push camera and sun state into the shared uniforms. */
  private syncUniforms() {
    const g = this.globe, f = g.focus, u = this.uniforms;
    u.uScale.value = f.scale;
    u.uLatC.value.set(f.sinLat, f.cosLat);
    u.uLonC.value = f.lon;
    u.uMorph.value = g.morph;
    u.uCam.value.copy(g.camera.position);
    const now = Date.now();
    if (now - this.sunAt > 10_000) {
      const s = subsolar(new Date(now));
      u.uSun.value.set(s.lat, s.lon);
      this.sunAt = now;
    }
  }

  onFrame(fn: (dt: number, now: number) => void) { this.hooks.push(fn); }

  /** Measured display refresh interval (ms) and recent drawn-frame statistics. */
  readonly stats = { refreshMs: 16.7, frameMs: 16.7, fps: 60, divisor: 1 };

  start() {
    let tick = 0, prevRaf = 0;
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      // Track the display's refresh interval, then draw every Nth refresh so frames stay
      // evenly spaced at or near the tier's cap on any display (60, 90, 120, 144, 165 Hz…).
      const gap = now - (prevRaf || now);
      prevRaf = now;
      if (gap > 2 && gap < 50) this.stats.refreshMs += (gap - this.stats.refreshMs) * 0.05;
      const divisor = Math.max(1, Math.round(1000 / this.tier.fpsCap / this.stats.refreshMs));
      this.stats.divisor = divisor;
      if (tick++ % divisor !== 0) return;

      const raw = (now - (this.lastFrame || now)) / 1000;
      const dt = Math.min(0.1, raw);
      this.lastFrame = now;
      if (raw > 0 && raw < 0.25) {
        // Frame interval measures CPU + GPU (the GPU paces requestAnimationFrame). Gaps from a
        // hidden tab or a stall are not a quality signal.
        this.governor.frame(raw * 1000, this.stats.refreshMs * divisor);
        this.stats.frameMs += (raw * 1000 - this.stats.frameMs) * 0.1;
        this.stats.fps = 1000 / this.stats.frameMs;
      }
      this.globe.update(dt);
      this.syncUniforms();
      for (const h of this.hooks) h(dt, now);
      this.draw(dt);
    };
    requestAnimationFrame(loop);
  }

  private draw(dt: number) {
    const r = this.renderer;
    // 1. Light alone, into HDR.
    r.setRenderTarget(this.lightRT);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(this.light, this.camera);
    // 2. Compress to 0–1, then bloom the light only; the pass blends its glow back onto resolveRT.
    r.setRenderTarget(this.resolveRT);
    r.render(this.resolveScene, this.orthoCam);
    this.bloom.render(r, null as unknown as THREE.WebGLRenderTarget, this.resolveRT, dt, false);
    // 3. Base to the screen, then light + bloom added over it.
    r.setRenderTarget(null);
    r.render(this.base, this.camera);
    r.autoClear = false;
    r.render(this.compositeScene, this.orthoCam);
    r.autoClear = true;
  }
}
