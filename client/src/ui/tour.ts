// Auto-tour: a hands-off drift around the world. Flies to a busy place (weighted by how many
// vehicles are running right now, never one of the last few), lingers while the camera slowly
// circles, then moves on. Any touch, drag, scroll or key hands control back. With reduced
// motion it cuts between places and holds still instead of circling.

import type { GlobeCamera } from '../engine/camera.ts';
import type { CityManager, CityEntry } from '../city/manager.ts';

/** Seconds spent at each place once it has arrived and loaded. */
const DWELL_S = 24;
/** Degrees per second of slow orbit while lingering. */
const ORBIT_DEG_S = 2.2;

export class Tour {
  active = false;
  private current: CityEntry | null = null;
  private recent: string[] = [];
  private arrivedAt = 0;
  private flewAt = 0;
  onChange: (on: boolean) => void = () => {};

  constructor(private cam: GlobeCamera, private cities: CityManager) {
    const prev = cam.onInput;
    cam.onInput = () => { prev(); if (this.active) this.stop(); };
    addEventListener('keydown', (e) => { if (this.active && !(e.target as HTMLElement)?.closest?.('button')) this.stop(); });
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.next(performance.now());
    this.onChange(true);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.current = null;
    this.onChange(false);
  }

  toggle() { if (this.active) this.stop(); else this.start(); }

  /** A busy place to visit: weighted by vehicles running, skipping recent ones. */
  private pick(): CityEntry | null {
    const c = [...this.cities.cities.values()].filter((e) => e.info.state === 'ready' && e.info.live + e.info.scheduled > 0 && !this.recent.includes(e.info.id));
    if (!c.length) return null;
    // Square root: big systems come up more often without crowding out the rest.
    const w = c.map((e) => Math.sqrt(e.info.live + e.info.scheduled));
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < c.length; i++) { r -= w[i]; if (r <= 0) return c[i]; }
    return c[c.length - 1];
  }

  private next(now: number) {
    const e = this.pick();
    if (!e) { this.recent = []; return; }
    this.current = e;
    this.recent = [...this.recent, e.info.id].slice(-8);
    this.arrivedAt = 0;
    this.flewAt = now;
    const alt = Math.min(60_000, Math.max(9_000, e.radius * 0.9));
    this.cam.flyTo({ lon: e.info.origin.lon, lat: e.info.origin.lat, alt, pitch: this.cam.reducedMotion ? 0.3 : 0.62, bearing: (Math.random() - 0.5) * 1.1 });
  }

  update(dt: number, now: number) {
    if (!this.active) return;
    const e = this.current;
    if (!e) { if (now - this.flewAt > 5000) this.next(now); return; }
    if (this.cam.flightTarget) return; // still flying
    // Arrived: wait (briefly) for the city to load and fade in, then start the clock.
    if (!this.arrivedAt) {
      if (e.fade > 0.8 || now - this.flewAt > 15_000) this.arrivedAt = now;
      return;
    }
    if (!this.cam.reducedMotion) this.cam.view.bearing += ORBIT_DEG_S * (Math.PI / 180) * dt;
    if (now - this.arrivedAt > DWELL_S * 1000) this.next(now);
  }
}
