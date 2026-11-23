// Follow your ride: pick a departure in "Near you" and the camera rides along with that vehicle.
// Its route lights up; a small card says where it's going and when it reaches your stop. If the
// trip hasn't set out yet, we wait for it to appear. Any pan, zoom or key releases the camera
// (the ride stays picked; "Follow" takes the camera back).

import type { GlobeCamera } from '../engine/camera.ts';
import { D2R, invMercY, mercY } from '../engine/geo.ts';
import type { CityManager, CityEntry } from '../city/manager.ts';
import type { Mode } from '../data/city.ts';

export interface Ride {
  place: string;
  feed: string;
  trip: string;
  route: string;
  mode: Mode;
  label: string;
  dest: string;
  colour: string;
  stopName: string;
  /** When it reaches the viewer's stop (epoch s), and whether that's a live prediction. */
  t: number;
  live: boolean;
}

/** Ask the server for the trip's vehicle this often until it appears. */
const LOOK_MS = 8_000;
/** Street level, but with some of the route around the vehicle in view. */
const FOLLOW_ALT = 1_800;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class Follow {
  ride: Ride | null = null;
  onChange: (ride: Ride | null) => void = () => {};
  private key: string | null = null;
  private scheduled = false;
  private looking = false;
  private lookedAt = 0;
  /** The camera is on the vehicle (false after the viewer takes over). */
  private locked = false;
  /** Flown to the vehicle once (then we glide with it). */
  private arrived = false;
  private lit: { e: CityEntry; route: number } | null = null;
  private card: HTMLElement;
  private renderedAt = 0;

  constructor(private cam: GlobeCamera, private cities: CityManager, private clock: () => number) {
    this.card = document.createElement('section');
    this.card.id = 'follow';
    this.card.className = 'panel';
    this.card.hidden = true;
    this.card.setAttribute('aria-live', 'polite');
    this.card.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b?.dataset.act === 'close') this.stop();
      if (b?.dataset.act === 'follow') { this.locked = true; this.arrived = false; this.render(); }
    });
    document.body.appendChild(this.card);
    const prev = cam.onInput;
    cam.onInput = () => { prev(); if (this.locked) { this.locked = false; this.render(); } };
  }

  start(ride: Ride) {
    this.stop(false);
    this.ride = ride;
    this.key = null;
    this.locked = true;
    this.arrived = false;
    this.lookedAt = 0;
    this.card.hidden = false;
    this.render();
    this.onChange(ride);
  }

  stop(notify = true) {
    this.unlight();
    this.ride = null;
    this.key = null;
    this.locked = false;
    this.card.hidden = true;
    if (notify) this.onChange(null);
  }

  /** Newer times for the ride from a refreshed departures list. */
  retime(t: number, live: boolean) {
    if (!this.ride) return;
    this.ride.t = t;
    this.ride.live = live;
  }

  private entry(): CityEntry | undefined { return this.ride ? this.cities.cities.get(this.ride.place) : undefined; }

  private async look() {
    const r = this.ride;
    if (!r || this.looking) return;
    this.looking = true;
    this.lookedAt = performance.now();
    try {
      const q = new URLSearchParams({ feed: r.feed, trip: r.trip });
      const res = await fetch(`/api/city/${encodeURIComponent(r.place)}/vehicle?${q}`);
      const m = res.ok ? await res.json() as { key: string | null; scheduled: boolean | null } : null;
      if (this.ride === r && m?.key) { this.key = m.key; this.scheduled = !!m.scheduled; }
    } catch { /* try again shortly */ } finally {
      this.looking = false;
      this.render();
    }
  }

  private light() {
    const e = this.entry(), d = e?.detail, r = this.ride;
    if (!e || !d || !r || this.lit) return;
    const i = d.data.routes.findIndex((x) => x.feed === r.feed && x.id === r.route);
    if (i < 0) return;
    d.routes.highlight = i;
    d.routes.update(this.cities.modes);
    this.lit = { e, route: i };
  }

  private unlight() {
    const l = this.lit;
    this.lit = null;
    if (l?.e.detail && l.e.detail.routes.highlight === l.route) {
      l.e.detail.routes.highlight = -1;
      l.e.detail.routes.update(this.cities.modes);
    }
  }

  /** Per frame: find the vehicle, keep the camera on it, keep the card current. */
  update(dt: number, now: number) {
    const r = this.ride;
    if (!r) return;
    const e = this.entry(), d = e?.detail;
    if (!this.lit) this.light();
    if (!this.key && performance.now() - this.lookedAt > LOOK_MS) void this.look();
    const pos = this.key && d ? d.vehicles.position(this.key, this.clock()) : null;
    if (this.key && d && !pos) { this.key = null; this.lookedAt = 0; } // ended or lost: look again
    if (pos && e && this.locked) {
      const o = e.info.origin;
      const lon = o.lon + pos.x / D2R, lat = invMercY(pos.y + mercY(o.lat * D2R)) / D2R;
      if (!this.arrived) {
        this.arrived = true;
        this.cam.flyTo({ lon, lat, alt: Math.min(Math.max(this.cam.view.alt, 900), FOLLOW_ALT), pitch: 0.55 });
      } else if (!this.cam.flightTarget) {
        // Glide after it: close the gap quickly but without snapping.
        const k = 1 - Math.exp(-dt * 4);
        this.cam.view.lon += (lon - this.cam.view.lon) * k;
        this.cam.view.lat += (lat - this.cam.view.lat) * k;
      }
    }
    if (now - this.renderedAt > 1000) this.render();
  }

  private render() {
    this.renderedAt = performance.now();
    const r = this.ride;
    if (!r) return;
    const now = Date.now() / 1000, m = Math.round((r.t - now) / 60);
    const eta = r.t < now - 60 ? `left ${esc(r.stopName)}`
      : m <= 0 ? `at ${esc(r.stopName)} now`
      : `reaches ${esc(r.stopName)} in ${m} min${r.live ? '' : ' (timetabled)'}`;
    const where = this.key
      ? (this.scheduled ? 'Placed from the timetable' : '<span class="nb-live"></span>Live position')
      : r.t > now + 60 ? 'Not on the road yet: waiting for it to set out' : 'No position for this trip right now';
    const btn = this.key && !this.locked ? '<button class="fw-btn" data-act="follow">Follow</button>' : '';
    this.card.innerHTML = `
      <p class="fw-title"><span class="nb-route" style="--c:${r.colour}">${esc(r.label)}</span><span class="fw-dest">→ ${esc(r.dest || r.label)}</span>
        <button class="nb-close" data-act="close" aria-label="Stop following">×</button></p>
      <p class="fw-row mono small">${where} · ${eta}</p>${btn}`;
  }
}
