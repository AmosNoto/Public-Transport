// Themes. Dark: light on a dark map. Light: ink on paper (engine.setInk). Auto follows the sun
// where you're looking: a city in daylight is drawn as ink on paper, one at night as light on
// the dark map, and flying across the terminator crossfades between them.

import type { Engine } from '../engine/engine.ts';
import type { GlobeCamera } from '../engine/camera.ts';
import { subsolar, sunCos } from '../engine/geo.ts';

export type ThemeMode = 'auto' | 'dark' | 'light';
export const THEME_MODES: ThemeMode[] = ['auto', 'dark', 'light'];
const KEY = 'afterglow.theme';

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Theme {
  mode: ThemeMode = 'auto';
  private ink = -1;
  private sun = subsolar(new Date());
  private sunAt = 0;
  private applied: 'dark' | 'light' | null = null;
  onChange: (mode: ThemeMode, look: 'dark' | 'light') => void = () => {};

  constructor(private engine: Engine, private cam: GlobeCamera) {
    try {
      const saved = localStorage.getItem(KEY) as ThemeMode | null;
      if (saved && THEME_MODES.includes(saved)) this.mode = saved;
    } catch { /* storage unavailable: default */ }
  }

  set(mode: ThemeMode) {
    this.mode = mode;
    try { localStorage.setItem(KEY, mode); } catch { /* ignore */ }
    this.onChange(this.mode, this.look);
  }

  next() { this.set(THEME_MODES[(THEME_MODES.indexOf(this.mode) + 1) % THEME_MODES.length]); }

  get look(): 'dark' | 'light' { return this.ink >= 0.5 ? 'light' : 'dark'; }

  /** Ink the current mode wants: Auto is daylight at the view's focus (civil twilight eased). */
  private target(now: number): number {
    if (this.mode !== 'auto') return this.mode === 'light' ? 1 : 0;
    if (now - this.sunAt > 30_000) { this.sun = subsolar(new Date()); this.sunAt = now; }
    const f = this.cam.focus;
    return smooth(-0.06, 0.1, sunCos(this.sun, f.lon, f.lat));
  }

  update(dt: number, now: number) {
    const t = this.target(now);
    // First frame (or reduced motion): jump. Otherwise ease over about a second.
    if (this.ink < 0 || this.cam.reducedMotion) this.ink = t;
    else this.ink += (t - this.ink) * Math.min(1, dt * 2.2);
    if (Math.abs(t - this.ink) < 0.002) this.ink = t;
    this.engine.setInk(this.ink);
    const look = this.look;
    if (look !== this.applied) {
      this.applied = look;
      document.body.dataset.theme = look;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', look === 'light' ? '#e4e8ec' : '#090d12');
      this.onChange(this.mode, look);
    }
  }
}
