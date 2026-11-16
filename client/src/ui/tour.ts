// Auto-tour: a hands-off drift around the world. Each leg: pull back out to the whole Earth,
// turn the globe to the next place (a busy one, weighted by how many vehicles are running right
// now, never one of the last few) and name it, dive in, then linger while the camera slowly
// circles. Any touch, drag, scroll or key hands control back. With reduced motion it cuts
// between views and holds still instead of circling.

import type { GlobeCamera, View } from '../engine/camera.ts';
import type { CityManager, CityEntry } from '../city/manager.ts';

/** Seconds spent at each place once it has arrived and loaded. */
const DWELL_S = 24;
/** Seconds to hold on the whole Earth after pulling out, and after turning to the next place. */
const HOLD_OUT_S = 1.2, HOLD_TURN_S = 1.8;
/** Degrees per second of slow orbit while lingering. */
const ORBIT_DEG_S = 2.2;

type Phase = 'out' | 'turn' | 'in' | 'dwell';

export class Tour {
  active = false;
  private current: CityEntry | null = null;
  private target: CityEntry | null = null;
  private phase: Phase = 'out';
  /** When the current phase's flight landed (0 while still flying). */
  private landedAt = 0;
  private phaseAt = 0;
  private recent: string[] = [];
  onChange: (on: boolean) => void = () => {};

  /** `earth(lon, lat)`: the whole-Earth view centred on a point. */
  constructor(private cam: GlobeCamera, private cities: CityManager, private earth: (lon: number, lat: number) => View) {
    const prev = cam.onInput;
    cam.onInput = () => { prev(); if (this.active) this.stop(); };
    addEventListener('keydown', (e) => { if (this.active && !(e.target as HTMLElement)?.closest?.('button')) this.stop(); });
  }

  /** What the tour is doing, for the status line ('' when idle). */
  get label(): string {
    if (!this.active) return '';
    if ((this.phase === 'turn' || this.phase === 'in') && this.target) return `tour · next: ${this.target.info.name}`;
    return 'tour';
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.onChange(true);
    this.leave(performance.now());
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.current = this.target = null;
    this.onChange(false);
  }

  toggle() { if (this.active) this.stop(); else this.start(); }

  /** A busy place to visit: weighted by vehicles running, skipping recent ones. */
  private pick(): CityEntry | null {
    let c = [...this.cities.cities.values()].filter((e) => e.info.state === 'ready' && e.info.live + e.info.scheduled > 0);
    const fresh = c.filter((e) => !this.recent.includes(e.info.id));
    if (fresh.length) c = fresh; else this.recent = [];
    if (!c.length) return null;
    // Square root: big systems come up more often without crowding out the rest.
    const w = c.map((e) => Math.sqrt(e.info.live + e.info.scheduled));
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < c.length; i++) { r -= w[i]; if (r <= 0) return c[i]; }
    return c[c.length - 1];
  }

  private go(phase: Phase, view: Partial<View>, now: number) {
    this.phase = phase;
    this.phaseAt = now;
    this.landedAt = 0;
    this.cam.flyTo(view);
  }

  /** Pull back out to the whole Earth over where we are. */
  private leave(now: number) {
    const v = this.cam.view;
    // Never "next" to the place we're already in.
    const here = this.cities.focused();
    if (here && !this.recent.includes(here.info.id)) this.recent = [...this.recent, here.info.id].slice(-8);
    this.target = this.pick();
    this.go('out', this.earth(v.lon, v.lat), now);
  }

  update(dt: number, now: number) {
    if (!this.active) return;
    if (this.cam.flightTarget) return; // still flying
    if (!this.landedAt) this.landedAt = now;
    const held = (now - this.landedAt) / 1000;

    switch (this.phase) {
      case 'out':
        // On the whole Earth: turn it to show the next place.
        if (held < HOLD_OUT_S) return;
        if (!this.target) { this.target = this.pick(); if (!this.target) { this.landedAt = now; return; } }
        this.go('turn', this.earth(this.target.info.origin.lon, this.target.info.origin.lat), now);
        return;
      case 'turn': {
        if (held < HOLD_TURN_S) return;
        const e = this.target!;
        this.current = e;
        this.recent = [...this.recent, e.info.id].slice(-8);
        const alt = Math.min(60_000, Math.max(9_000, e.radius * 0.9));
        this.go('in', { lon: e.info.origin.lon, lat: e.info.origin.lat, alt, pitch: this.cam.reducedMotion ? 0.3 : 0.62, bearing: (Math.random() - 0.5) * 1.1 }, now);
        return;
      }
      case 'in':
        // Arrived: wait (briefly) for the place to load and fade in, then start the clock.
        if (this.current && this.current.fade < 0.8 && now - this.phaseAt < 15_000) { this.landedAt = 0; return; }
        this.phase = 'dwell';
        this.phaseAt = now;
        return;
      case 'dwell':
        if (!this.cam.reducedMotion) this.cam.view.bearing += ORBIT_DEG_S * (Math.PI / 180) * dt;
        if (now - this.phaseAt > DWELL_S * 1000) this.leave(now);
        return;
    }
  }
}
