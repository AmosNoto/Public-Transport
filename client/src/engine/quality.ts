// Device detection and adaptive quality. The tier is picked from what the device reports and
// then steered by the measured frame time. `?quality=` or the diagnostics view can pin it.

export interface Tier {
  name: 'low' | 'medium' | 'high' | 'ultra';
  dprCap: number;
  /** Bloom buffer size as a fraction of the canvas. */
  bloomScale: number;
  msaa: number;
  photonBudget: number;
  maxDots: number;
  fpsCap: number;
}

export const TIERS: Tier[] = [
  { name: 'low', dprCap: 1, bloomScale: 0.35, msaa: 0, photonBudget: 3000, maxDots: 4000, fpsCap: 30 },
  { name: 'medium', dprCap: 1.5, bloomScale: 0.5, msaa: 2, photonBudget: 10000, maxDots: 15000, fpsCap: 60 },
  { name: 'high', dprCap: 2, bloomScale: 0.6, msaa: 4, photonBudget: 25000, maxDots: 40000, fpsCap: 60 },
  { name: 'ultra', dprCap: 2, bloomScale: 0.75, msaa: 4, photonBudget: 50000, maxDots: 80000, fpsCap: 120 },
];

export interface DeviceInfo {
  gpu: string;
  dpr: number;
  screen: [number, number];
  memory?: number;
  cores?: number;
  touch: boolean;
  reducedMotion: boolean;
  saveData: boolean;
}

export function detectDevice(gl: WebGL2RenderingContext): DeviceInfo {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  return {
    gpu,
    dpr: window.devicePixelRatio || 1,
    screen: [screen.width, screen.height],
    memory: nav.deviceMemory,
    cores: nav.hardwareConcurrency,
    touch: matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    saveData: !!nav.connection?.saveData,
  };
}

export function initialTier(d: DeviceInfo): number {
  const override = new URLSearchParams(location.search).get('quality');
  const oi = TIERS.findIndex((t) => t.name === override);
  if (oi >= 0) return oi;
  const g = d.gpu.toLowerCase();
  let score = 2; // high by default on a laptop/desktop
  if (/swiftshader|llvmpipe|software|basic render/.test(g)) score = 0;
  else if (/rtx|radeon rx|apple m[2-9]|apple m1 (pro|max|ultra)|arc a/.test(g)) score = 3;
  else if (/intel.*(hd|uhd)|mali-[gt]?[0-7]|adreno \(tm\) [1-5]/.test(g)) score = 1;
  if (d.touch && Math.min(...d.screen) < 820) score = Math.min(score, 1);
  if (d.memory !== undefined && d.memory <= 2) score = Math.min(score, 0);
  else if (d.memory !== undefined && d.memory <= 4) score = Math.min(score, 1);
  if (d.cores !== undefined && d.cores <= 2) score = Math.min(score, 0);
  if (d.saveData) score = Math.min(score, 1);
  return score;
}

/** Steps quality down when frames run long, and back up when there's headroom. */
export class FrameGovernor {
  private samples: number[] = [];
  private lastChange = performance.now();
  private goodSince = performance.now();
  constructor(public tier: number, private readonly ceiling: number, private readonly onChange: (t: number) => void) {}
  /** Pinned by the diagnostics override: measure nothing, change nothing. */
  locked = false;

  /** `ms`: time between drawn frames; `targetMs`: the interval this tier aims for on this display. */
  frame(ms: number, targetMs: number) {
    if (this.locked) return;
    this.samples.push(ms / targetMs);
    if (this.samples.length < 90) return;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    this.samples.length = 0;
    const now = performance.now();
    const budget = 1; // samples are ratios of actual to target frame interval
    if (p75 > budget * 1.35 && this.tier > 0 && now - this.lastChange > 3000) {
      this.set(this.tier - 1, now);
    } else if (p75 < budget * 0.6) {
      if (now - this.goodSince > 15000 && this.tier < this.ceiling && now - this.lastChange > 15000) this.set(this.tier + 1, now);
    } else {
      this.goodSince = now;
    }
  }
  private set(t: number, now: number) {
    this.tier = t; this.lastChange = now; this.goodSince = now;
    this.onChange(t);
  }
}
