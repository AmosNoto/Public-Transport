// "Near me": find the viewer, fly down to street level, mark where they are, and list what
// leaves the nearest stops next and where it goes. Times come from the timetable. The location
// goes to our own server only (to pick the stops) and is not kept.

import type { GlobeCamera } from '../engine/camera.ts';
import { D2R, R } from '../engine/geo.ts';
import type { CityManager } from '../city/manager.ts';
import type { Mode } from '../data/city.ts';

interface Dep {
  /** When it leaves: predicted if `rt` is 'live', else timetabled. */
  t: number;
  /** Timetabled time (null for a trip only the realtime feed knows). */
  sched: number | null;
  rt: 'live' | 'cancelled' | 'skipped' | null;
  trip: string; route: string; short: string; long: string; mode: Mode; color: string | null; dest: string;
}
interface Stop { place: string; feed: string; id: string; name: string; code: string | null; lat: number; lon: number; distM: number; deps: Dep[] }
interface Reply { now: number; places: { id: string; name: string; tz: string }[]; failed: boolean; live: boolean; stops: Stop[] }

/** Refetch this often while open, or when the viewer has moved this far. */
const REFETCH_MS = 30_000;
const REFETCH_M = 120;
const MODE_LABEL: Record<Mode, string> = { subway: 'Metro', rail: 'Rail', bus: 'Bus', tram: 'Tram' };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function distM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export class NearMe {
  active = false;
  onChange: (on: boolean) => void = () => {};
  private panel: HTMLElement;
  private body: HTMLElement;
  private marker: HTMLElement;
  private pos: { lat: number; lon: number; acc: number } | null = null;
  private fetchedAt = 0;
  private fetchedPos: { lat: number; lon: number } | null = null;
  private data: Reply | null = null;
  private watch: number | null = null;
  private timer = 0;
  private busy = false;
  private flown = false;

  constructor(private cam: GlobeCamera, private cities: CityManager, private look: () => 'dark' | 'light') {
    this.panel = document.createElement('section');
    this.panel.id = 'nearby';
    this.panel.className = 'panel';
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'Departures near you');
    this.panel.innerHTML = `<div class="nb-head"><p class="eyebrow">Near you</p><button class="nb-close" aria-label="Close">×</button></div><div class="nb-body" aria-live="polite"></div>`;
    this.body = this.panel.querySelector('.nb-body')!;
    (this.panel.querySelector('.nb-close') as HTMLElement).onclick = () => this.set(false);
    document.body.appendChild(this.panel);
    this.marker = document.createElement('div');
    this.marker.id = 'here';
    this.marker.hidden = true;
    this.marker.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.marker);
  }

  toggle() { this.set(!this.active); }

  set(on: boolean) {
    if (on === this.active) { if (on) this.flyHome(); return; }
    this.active = on;
    this.panel.hidden = !on;
    this.onChange(on);
    if (!on) {
      if (this.watch !== null) navigator.geolocation.clearWatch(this.watch);
      this.watch = null;
      clearInterval(this.timer);
      this.marker.hidden = true;
      return;
    }
    this.flown = false;
    this.data = null;
    this.pos = this.fetchedPos = null;
    if (!('geolocation' in navigator)) { this.message('This browser can’t share your location.'); return; }
    if (!isSecureContext) { this.message('Location needs a secure page: open the app over https or on localhost.'); return; }
    this.message('Finding you…');
    this.watch = navigator.geolocation.watchPosition(
      (p) => this.located(p.coords.latitude, p.coords.longitude, p.coords.accuracy),
      (e) => { if (!this.pos) this.message(e.code === e.PERMISSION_DENIED ? 'Location is blocked for this page. Allow it in the browser’s site settings, then try again.' : 'Couldn’t get your location. Try again in a moment.'); },
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 },
    );
    // Re-render every few seconds (countdowns), refetch every minute.
    this.timer = window.setInterval(() => {
      if (this.pos && performance.now() - this.fetchedAt > REFETCH_MS) void this.fetch();
      else this.render();
    }, 10_000);
  }

  private located(lat: number, lon: number, acc: number) {
    this.pos = { lat, lon, acc };
    if (!this.flown) { this.flown = true; this.flyHome(); }
    const moved = this.fetchedPos ? distM(lat, lon, this.fetchedPos.lat, this.fetchedPos.lon) : Infinity;
    if (moved > REFETCH_M) void this.fetch();
  }

  private flyHome() {
    if (!this.pos) return;
    this.cam.flyTo({ lon: this.pos.lon, lat: this.pos.lat, alt: 2_400, pitch: 0.55, bearing: 0 });
  }

  private async fetch() {
    if (!this.pos || this.busy) return;
    this.busy = true;
    const at = { ...this.pos };
    if (!this.data) this.message('Looking up departures…');
    try {
      const r = await fetch(`/api/nearby?lat=${at.lat.toFixed(5)}&lon=${at.lon.toFixed(5)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.data = await r.json();
      this.fetchedAt = performance.now();
      this.fetchedPos = at;
      this.render();
    } catch {
      if (!this.data) this.message('Couldn’t reach the server for departures.');
    } finally {
      this.busy = false;
    }
  }

  private message(text: string) {
    this.body.innerHTML = `<p class="nb-msg">${esc(text)}</p>`;
  }

  /** The route's colour as drawn on the map when its city is loaded, else the agency's, else neutral. */
  private colour(s: Stop, d: Dep): string {
    const r = this.cities.cities.get(s.place)?.detail?.data.routes.find((x) => x.feed === s.feed && x.id === d.route);
    if (r) return `rgb(${(this.look() === 'light' ? r.ink : r.light).map((c) => Math.round(c * 255)).join(',')})`;
    if (d.color) return `#${d.color}`;
    return 'var(--muted)';
  }

  private render() {
    if (!this.active || !this.data) return;
    const d = this.data;
    if (!d.places.length) {
      this.message(this.nearestCovered());
      return;
    }
    const now = Date.now() / 1000;
    const tz = d.places[0].tz;
    const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz });
    const when = (t: number) => {
      const m = Math.floor((t - now) / 60);
      return m <= 0 ? 'now' : m < 60 ? `${m} min` : clock.format(new Date(t * 1000));
    };
    // Platforms of one station (same name, close together) read as one stop.
    const groups: { name: string; distM: number; items: { s: Stop; d: Dep }[] }[] = [];
    for (const s of d.stops) {
      let g = groups.find((x) => x.name === s.name);
      if (!g) groups.push((g = { name: s.name, distM: s.distM, items: [] }));
      g.distM = Math.min(g.distM, s.distM);
      for (const dep of s.deps) if (dep.t >= now - 30) g.items.push({ s, d: dep });
    }
    const rows = groups.slice(0, 5).map((g) => {
      g.items.sort((a, b) => a.d.t - b.d.t);
      const deps = g.items.slice(0, 5).map(({ s, d: dep }) => {
        const label = dep.short || dep.long || MODE_LABEL[dep.mode];
        const dest = dep.dest ? '→ ' + esc(dep.dest) : esc(MODE_LABEL[dep.mode]);
        let whenHtml: string, note = '';
        if (dep.rt === 'cancelled') {
          whenHtml = `<s class="faint">${when(dep.t)}</s>`;
          note = '<span class="nb-bad">Cancelled</span>';
        } else if (dep.rt === 'skipped') {
          whenHtml = `<s class="faint">${when(dep.t)}</s>`;
          note = '<span class="faint">Skips this stop</span>';
        } else if (dep.rt === 'live') {
          whenHtml = `<span class="nb-live" title="Live prediction"></span>${when(dep.t)}`;
          note = lateness(dep);
        } else {
          whenHtml = `<span title="Timetabled">${when(dep.t)}</span>`;
        }
        return `<li class="nb-dep${dep.rt === 'cancelled' || dep.rt === 'skipped' ? ' nb-off' : ''}">
          <span class="nb-route" style="--c:${this.colour(s, dep)}" title="${esc(MODE_LABEL[dep.mode] + (dep.long && dep.short ? ' · ' + dep.long : ''))}">${esc(label)}</span>
          <span class="nb-dest"><span class="nb-to">${dest}</span>${note}</span>
          <span class="nb-when mono">${whenHtml}</span></li>`;
      }).join('');
      return `<li class="nb-stop"><p class="nb-stop-name"><span>${esc(g.name)}</span><span class="mono small">${fmtDist(g.distM)}</span></p>
        ${deps ? `<ul class="nb-deps">${deps}</ul>` : '<p class="nb-none small">Nothing scheduled in the next few hours</p>'}</li>`;
    }).join('');
    const where = d.places.map((p) => p.name).filter((n, i, a) => a.indexOf(n) === i).slice(0, 2).join(' · ');
    const acc = this.pos && this.pos.acc > 150 ? ` · location ±${fmtDist(this.pos.acc)}` : '';
    const kind = d.live ? '<span class="nb-live"></span>live where marked, timetabled otherwise' : 'Timetabled times';
    this.body.innerHTML = groups.length
      ? `<ul class="nb-stops">${rows}</ul><p class="nb-foot small">${kind} · ${esc(where)}${acc}${d.failed ? ' · some operators unavailable' : ''}</p>`
      : `<p class="nb-msg">No stops within walking distance in ${esc(where)}’s timetable.</p>`;
  }

  /** No place covers the viewer: say which covered place is nearest. */
  private nearestCovered(): string {
    if (!this.pos) return 'No transit data for where you are yet.';
    let best: { name: string; km: number } | null = null;
    for (const e of this.cities.cities.values()) {
      if (e.info.state !== 'ready') continue;
      const km = distM(this.pos.lat, this.pos.lon, e.info.origin.lat, e.info.origin.lon) / 1000;
      if (!best || km < best.km) best = { name: e.info.name, km };
    }
    return best
      ? `No transit data for where you are yet. The nearest covered place is ${best.name}, about ${Math.round(best.km)} km away.`
      : 'No transit data for where you are yet.';
  }

  /** Per frame: keep the "you are here" dot over the viewer's position. */
  update() {
    const p = this.pos, cam = this.cam;
    // Only near the ground: on the globe the dot would float over the far side.
    const s = this.active && p && cam.view.alt < 1_000_000 ? cam.toScreen(p.lon * D2R, p.lat * D2R) : null;
    this.marker.hidden = !s;
    if (s) this.marker.style.transform = `translate(${s.x}px, ${s.y}px)`;
  }
}

/**
 * "4 min late" / "2 min early" against the timetable, for buses, trams and trains. Not for
 * metros: they run by frequency, and some feeds attach their trains to timetable trips only
 * loosely, so the difference would mislead; the predicted time itself is what matters there.
 */
function lateness(d: Dep): string {
  if (d.sched === null || d.mode === 'subway') return '';
  const m = Math.round((d.t - d.sched) / 60);
  if (m >= 2) return `<span class="${m >= 5 ? 'nb-bad' : 'nb-meh'}">${m} min late</span>`;
  // Far early is nearly always a feed pairing a vehicle with a later trip, not a bus running early.
  if (m <= -2 && m > -10) return `<span class="nb-good">${-m} min early</span>`;
  return '';
}

function fmtDist(m: number) {
  return m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}
