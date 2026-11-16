// Interactive mode (off by default): point at a vehicle or a route line to see what it is.
// The route under the pointer brightens and the rest of the network recedes; a small card
// says which line it is, who runs it, and (for a vehicle) whether it's live or timetabled,
// how fresh its position is and how fast it's going. On touch: tap to inspect, tap empty map
// to dismiss.
//
// Picking happens on the CPU in each city's own coordinates: the point under the pointer is
// found once (exact, through the globe-to-map morph), then vehicles (placed by the same motion
// model the shader uses) and route segments are measured in metres. No GPU readback.

import type { GlobeCamera } from '../engine/camera.ts';
import { D2R, R, mercY, wrapPi } from '../engine/geo.ts';
import type { CityManager, CityEntry } from '../city/manager.ts';
import type { LiveClient } from '../data/live.ts';
import type { Mode, RouteInfo } from '../data/city.ts';

const KEY = 'afterglow.interactive';
const MODE_LABEL: Record<Mode, string> = { subway: 'Subway / metro', rail: 'Rail', bus: 'Bus', tram: 'Tram, ferry or cable car' };

type Hit =
  | { kind: 'vehicle'; e: CityEntry; route: number; key: string; v: number; ageS: number; stopped: boolean; scheduled: boolean }
  | { kind: 'route'; e: CityEntry; route: number };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class Inspector {
  enabled = false;
  private card: HTMLElement;
  private pointer: { x: number; y: number; touch: boolean } | null = null;
  private dirty = false;
  private lastPick = 0;
  private lit: { e: CityEntry; route: number } | null = null;
  onChange: (on: boolean) => void = () => {};

  constructor(private canvas: HTMLCanvasElement, private cam: GlobeCamera, private cities: CityManager, private live: LiveClient, private look: () => 'dark' | 'light') {
    try { this.enabled = localStorage.getItem(KEY) === 'on'; } catch { /* default off */ }
    this.card = document.createElement('div');
    this.card.id = 'card';
    this.card.className = 'panel';
    this.card.hidden = true;
    this.card.setAttribute('role', 'status');
    document.body.appendChild(this.card);

    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.pointer = { x: e.offsetX, y: e.offsetY, touch: false };
      this.dirty = true;
    });
    canvas.addEventListener('pointerleave', () => { if (!this.pointer?.touch) { this.pointer = null; this.dirty = true; } });
    // Touch: a tap (not a drag) inspects; tapping empty map dismisses.
    let down: { x: number; y: number; t: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') down = { x: e.offsetX, y: e.offsetY, t: performance.now() }; });
    canvas.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'mouse' || !down) return;
      if (Math.hypot(e.offsetX - down.x, e.offsetY - down.y) < 8 && performance.now() - down.t < 350) {
        this.pointer = { x: e.offsetX, y: e.offsetY, touch: true };
        this.dirty = true;
      }
      down = null;
    });
  }

  set(on: boolean) {
    this.enabled = on;
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
    if (!on) this.show(null);
    else this.dirty = true;
    this.onChange(on);
  }

  toggle() { this.set(!this.enabled); }

  /** Per frame: re-pick when the pointer moved (or a few times a second, as vehicles move). */
  update(now: number) {
    if (!this.enabled) return;
    if (!this.dirty && now - this.lastPick < 150) return;
    this.dirty = false;
    this.lastPick = now;
    this.show(this.pointer ? this.pick(this.pointer.x, this.pointer.y) : null);
  }

  private pick(x: number, y: number): Hit | null {
    const e = this.cities.focused();
    const d = e?.detail;
    if (!e || !d || e.fade < 0.5) return null;
    const g = this.cam.pick(x, y);
    if (!g) return null;
    const o = e.info.origin;
    const rx = wrapPi(g.lon - o.lon * D2R), ry = mercY(g.lat) - mercY(o.lat * D2R);
    const k = R * Math.cos(g.lat);
    const mpp = this.cam.metresPerPixel();
    const modes = this.cities.modes;
    const touch = this.pointer?.touch ? 2 : 1;

    // Vehicles first: they sit on top of the lines.
    const dotPx = d.vehicles.dotSize;
    const v = d.vehicles.nearest(rx, ry, this.live.now(), k, Math.max(8, dotPx * 0.6) * touch * mpp, modes);
    if (v) return { kind: 'vehicle', e, route: v.route, key: v.key, v: v.v, ageS: v.ageS, stopped: v.stopped, scheduled: v.scheduled };

    // Then the nearest route segment within a few pixels.
    const L = d.data.lines, C = d.data.chains, routes = d.data.routes;
    const maxM = 6 * touch * mpp;
    let best = -1, bestD = maxM;
    for (let c = 0; c < C.length; c += 3) {
      const r = C[c + 2];
      if (!modes[routes[r].mode]) continue;
      const s = C[c], n = C[c + 1];
      for (let i = s + 1; i < s + n; i++) {
        const ax = (L[i * 2 - 2] - rx) * k, ay = (L[i * 2 - 1] - ry) * k, bx = (L[i * 2] - rx) * k, by = (L[i * 2 + 1] - ry) * k;
        // Distance from the pointer (origin) to segment a–b, in metres.
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
        const dist = Math.hypot(ax + dx * t, ay + dy * t);
        if (dist < bestD) { bestD = dist; best = r; }
      }
    }
    return best >= 0 ? { kind: 'route', e, route: best } : null;
  }

  private highlight(e: CityEntry | null, route: number) {
    if (this.lit && (this.lit.e !== e || this.lit.route !== route) && this.lit.e.detail) {
      this.lit.e.detail.routes.highlight = -1;
      this.lit.e.detail.routes.update(this.cities.modes);
    }
    this.lit = e && route >= 0 ? { e, route } : null;
    if (this.lit && e?.detail && e.detail.routes.highlight !== route) {
      e.detail.routes.highlight = route;
      e.detail.routes.update(this.cities.modes);
    }
  }

  private show(hit: Hit | null) {
    this.highlight(hit?.e ?? null, hit?.route ?? -1);
    this.canvas.style.cursor = hit ? 'pointer' : '';
    if (!hit || !this.pointer || !hit.e.detail) { this.card.hidden = true; return; }
    const data = hit.e.detail.data;
    const r: RouteInfo = data.routes[hit.route];
    const agency = data.feeds?.find((f) => f.id === r.feed)?.agency ?? "";
    const col = (this.look() === 'light' ? r.ink : r.light).map((c) => Math.round(c * 255)).join(',');
    const title = r.short && r.long ? `<b>${esc(r.short)}</b> ${esc(r.long)}` : `<b>${esc(r.short || r.long || r.id)}</b>`;
    const rows: string[] = [`<p class="card-sub">${esc(MODE_LABEL[r.mode])}${agency ? ' · ' + esc(agency) : ''}</p>`];
    if (hit.kind === 'vehicle') {
      const age = hit.ageS < 90 ? `${Math.round(hit.ageS)} s ago` : `${Math.round(hit.ageS / 60)} min ago`;
      const speed = hit.stopped || hit.v < 0.5 ? 'stopped' : `${Math.round(hit.v * 3.6)} km/h`;
      rows.push(hit.scheduled
        ? '<p class="card-row mono">Scheduled · placed from the timetable</p>'
        : `<p class="card-row mono">Live · ${age} · ${speed}</p>`);
      const vid = hit.key.slice(hit.key.indexOf(':') + 1).replace(/^sched:/, '');
      if (!hit.scheduled) rows.push(`<p class="card-row faint mono">Vehicle ${esc(vid.split('/').pop() ?? vid)}</p>`);
    } else {
      const n = hit.e.detail.routes.active[hit.route] ?? 0;
      rows.push(`<p class="card-row mono">${n ? `${n} vehicle${n === 1 ? '' : 's'} running now` : 'Nothing running right now'}</p>`);
    }
    this.card.innerHTML = `<p class="card-title"><span class="swatch" style="background:rgb(${col})"></span>${title}</p>${rows.join('')}`;
    this.card.hidden = false;
    // Beside the pointer, kept on screen.
    const w = this.card.offsetWidth, h = this.card.offsetHeight;
    const W = innerWidth, H = innerHeight, p = this.pointer;
    const x = p.x + 18 + w > W - 8 ? p.x - 18 - w : p.x + 18;
    const y = Math.min(H - h - 8, Math.max(8, p.y - h / 2));
    this.card.style.transform = `translate(${Math.max(8, x)}px, ${y}px)`;
  }
}
