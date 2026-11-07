// Renderer, camera and the selective-bloom pipeline.
//
// Two scenes, as in the lens: `base` (land, water; never glows) and `light` (routes,
// photons, vehicles). Light is drawn into its own HDR target, UnrealBloomPass runs on that
// target alone, and the result (light + bloom) is added over the base. Nothing outside the
// light scene can ever bloom.

import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { TIERS, FrameGovernor, detectDevice, initialTier, type DeviceInfo, type Tier } from './quality.ts';

// Colours are authored as display values and blended as-is, exactly like the lens (three r128
// without colour management). Additive light in that space is what gives the lens its look.
THREE.ColorManagement.enabled = false;

const R = 6371008.8;

export interface SharedUniforms {
  uScale: { value: number };
  uOff: { value: THREE.Vector2 };
  uTime: { value: number };
  uRes: { value: THREE.Vector2 };
  uDpr: { value: number };
}

export const PALETTE = {
  dark: { land: new THREE.Color('#0b1016'), water: new THREE.Color('#06090d') },
};

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: MapControls;
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
  private lastDraw = 0;
  private hooks: ((dt: number, now: number) => void)[] = [];
  focus = { lon: 0, lat: 0 };

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // colours are authored as display values, like the lens
    this.device = detectDevice(this.renderer.getContext() as WebGL2RenderingContext);
    const t0 = initialTier(this.device);
    this.tier = TIERS[t0];
    this.governor = new FrameGovernor(t0, Math.min(3, t0 + 1), (t) => { this.tier = TIERS[t]; this.resize(); });

    this.camera = new THREE.PerspectiveCamera(35, 1, 10, 1e7);
    this.camera.position.set(0, 30000, 9000);
    this.controls = new MapControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.zoomToCursor = true;
    this.controls.minDistance = 250;
    this.controls.maxDistance = 400000;
    this.controls.maxPolarAngle = 1.05;

    this.uniforms = {
      uScale: { value: R },
      uOff: { value: new THREE.Vector2() },
      uTime: { value: 0 },
      uRes: { value: new THREE.Vector2(1, 1) },
      uDpr: { value: 1 },
    };
    this.base.background = PALETTE.dark.land;

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
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.uniforms.uRes.value.set(W, H);
    this.uniforms.uDpr.value = dpr;
  }

  /** Put the world origin at (lon, lat); geometry is placed relative to it in metres. */
  setFocus(lon: number, lat: number) {
    this.focus = { lon, lat };
    this.uniforms.uScale.value = R * Math.cos((lat * Math.PI) / 180);
  }

  /** Offset (metres) of a city origin from the focus, in double precision. */
  offsetOf(origin: { lon: number; lat: number }): THREE.Vector2 {
    const s = this.uniforms.uScale.value;
    const my = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    return new THREE.Vector2(((origin.lon - this.focus.lon) * Math.PI) / 180 * s, (my(origin.lat) - my(this.focus.lat)) * s);
  }

  /** Metres covered by one CSS pixel at the view centre. */
  metresPerPixel(): number {
    const dist = this.camera.position.distanceTo(this.controls.target);
    return (2 * dist * Math.tan((this.camera.fov * Math.PI) / 360)) / (this.canvas.clientHeight || innerHeight);
  }

  onFrame(fn: (dt: number, now: number) => void) { this.hooks.push(fn); }

  start() {
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      const minGap = 1000 / this.tier.fpsCap - 1;
      if (now - this.lastDraw < minGap) return;
      const raw = (now - (this.lastFrame || now)) / 1000;
      const dt = Math.min(0.1, raw);
      this.lastFrame = now;
      this.lastDraw = now;
      // Frame interval measures CPU + GPU (the GPU paces requestAnimationFrame). Gaps from a
      // hidden tab or a stall are not a quality signal.
      if (raw > 0 && raw < 0.25) this.governor.frame(raw * 1000);
      this.controls.update();
      const dist = this.camera.position.distanceTo(this.controls.target);
      this.camera.near = Math.max(1, dist * 0.02);
      this.camera.far = dist * 40;
      this.camera.updateProjectionMatrix();
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
