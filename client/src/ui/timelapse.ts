// Time-lapse: replay the last hour of the city in view, sped up. The server keeps every place's
// recent live positions; this fetches them (already snapped to routes, exactly as live data is)
// and plays them through the same vehicle layer on a virtual clock. Scrub anywhere in the hour;
// reaching the end, or pressing Live, returns to the live stream.

import type { CityManager, CityEntry } from '../city/manager.ts';
import type { LiveClient } from '../data/live.ts';
import type { WireVehicle } from '../layers/vehicles.ts';

const SPEEDS = [30, 60, 120, 240];
/** When jumping to a moment, replay this much just before it so the dots are already there. */
const PRIME_S = 150;

interface Recording {
  keys: string[];
  from: number;
  to: number;
  n: number;
  key: Uint32Array; route: Uint32Array; shape: Int32Array; d: Float32Array; v: Float32Array;
  ts: Uint32Array; rx: Float32Array; ry: Float32Array; flags: Uint32Array;
}

async function fetchRecording(id: string): Promise<Recording> {
  const r = await fetch(`/api/city/${encodeURIComponent(id)}/history.bin`);
  if (!r.ok) throw new Error(`history: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  const dv = new DataView(buf);
  const hl = dv.getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  const n = (buf.byteLength - 4 - hl) / 36;
  const rec: Recording = {
    keys: head.keys, from: head.oldest ? Math.max(head.from, head.oldest) : head.from, to: head.to, n,
    key: new Uint32Array(n), route: new Uint32Array(n), shape: new Int32Array(n), d: new Float32Array(n), v: new Float32Array(n),
    ts: new Uint32Array(n), rx: new Float32Array(n), ry: new Float32Array(n), flags: new Uint32Array(n),
  };
  for (let i = 0, o = 4 + hl; i < n; i++, o += 36) {
    rec.key[i] = dv.getUint32(o, true); rec.route[i] = dv.getUint32(o + 4, true); rec.shape[i] = dv.getInt32(o + 8, true);
    rec.d[i] = dv.getFloat32(o + 12, true); rec.v[i] = dv.getFloat32(o + 16, true); rec.ts[i] = dv.getUint32(o + 20, true);
    rec.rx[i] = dv.getFloat32(o + 24, true); rec.ry[i] = dv.getFloat32(o + 28, true); rec.flags[i] = dv.getUint32(o + 32, true);
  }
  return rec;
}

export class TimeLapse {
  /** The city being replayed, or null when live. */
  city: CityEntry | null = null;
  playing = false;
  speed = 60;
  /** Virtual time (epoch seconds). */
  t = 0;
  private rec: Recording | null = null;
  private next = 0;
  private loading = false;
  private panel: HTMLElement;
  private range: HTMLInputElement;
  private label: HTMLElement;
  private playBtn: HTMLButtonElement;
  private speedBtn: HTMLButtonElement;
  onChange: (active: boolean) => void = () => {};

  constructor(private cities: CityManager, private live: LiveClient, private tz: () => string) {
    this.panel = document.createElement('div');
    this.panel.id = 'timelapse';
    this.panel.className = 'panel hud-keep';
    this.panel.hidden = true;
    this.panel.setAttribute('role', 'group');
    this.panel.setAttribute('aria-label', 'Time-lapse');
    this.panel.innerHTML = `
      <button class="tl-play mode on" aria-label="Pause"></button>
      <input class="tl-range" type="range" min="0" max="1000" value="0" aria-label="Replay time">
      <span class="tl-time mono">--:--</span>
      <button class="tl-speed mono" aria-label="Replay speed">×60</button>
      <button class="tl-live eyebrow" aria-label="Back to live">Live</button>`;
    document.body.appendChild(this.panel);
    this.range = this.panel.querySelector('.tl-range')!;
    this.label = this.panel.querySelector('.tl-time')!;
    this.playBtn = this.panel.querySelector('.tl-play')!;
    this.speedBtn = this.panel.querySelector('.tl-speed')!;
    this.playBtn.onclick = () => { this.playing = !this.playing; this.renderPlay(); };
    this.speedBtn.onclick = () => { this.speed = SPEEDS[(SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length]; this.speedBtn.textContent = `×${this.speed}`; };
    this.panel.querySelector<HTMLButtonElement>('.tl-live')!.onclick = () => this.stop();
    this.range.oninput = () => { if (this.rec) this.seek(this.rec.from + (this.rec.to - this.rec.from) * (Number(this.range.value) / 1000)); };
    this.renderPlay();
  }

  get active() { return !!this.city; }

  /** Seconds on the client time base for the vehicle layer (virtual while replaying). */
  localNow(): number { return this.active ? this.live.toLocal(this.t) : this.live.now(); }

  /** Start replaying a city's last hour (from its beginning). */
  async start(e: CityEntry) {
    if (this.loading || !e.detail) return;
    this.loading = true;
    try {
      const rec = await fetchRecording(e.info.id);
      if (!e.detail || rec.n === 0) throw new Error('nothing recorded yet');
      if (this.city) this.stop();
      this.city = e;
      this.rec = rec;
      this.cities.paused.add(e.info.id);
      this.playing = true;
      this.panel.hidden = false;
      this.renderPlay();
      this.seek(rec.from + Math.min(PRIME_S, (rec.to - rec.from) / 4));
      this.onChange(true);
    } catch (err) {
      console.warn('time-lapse:', err);
      throw err;
    } finally {
      this.loading = false;
    }
  }

  /** Back to live: clear the replayed dots and take a fresh snapshot of the city. */
  stop() {
    const e = this.city;
    if (!e) return;
    this.city = null;
    this.rec = null;
    this.playing = false;
    this.panel.hidden = true;
    this.cities.paused.delete(e.info.id);
    e.detail?.vehicles.clear();
    this.live.unsubscribe(e.info.id);
    this.live.subscribe(e.info.id);
    this.onChange(false);
  }

  /** Jump to a moment: replay the couple of minutes before it at once, then carry on. */
  private seek(t: number) {
    const rec = this.rec, d = this.city?.detail;
    if (!rec || !d) return;
    this.t = Math.min(rec.to, Math.max(rec.from, t));
    d.vehicles.clear();
    let i = 0, lo = 0, hi = rec.n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (rec.ts[mid] < this.t - PRIME_S) lo = mid + 1; else hi = mid; }
    i = lo;
    this.next = i;
    this.feed();
  }

  /** Hand every recorded fix up to the virtual time to the vehicle layer. */
  private feed() {
    const rec = this.rec, d = this.city?.detail;
    if (!rec || !d) return;
    const batch: WireVehicle[] = [];
    while (this.next < rec.n && rec.ts[this.next] <= this.t) {
      const i = this.next++;
      batch.push([rec.keys[rec.key[i]], rec.route[i], rec.shape[i], rec.d[i], rec.v[i], rec.ts[i], rec.rx[i], rec.ry[i], rec.flags[i]]);
    }
    if (batch.length) d.vehicles.update(batch, this.live.toLocal(this.t), this.live.toLocal);
  }

  private renderPlay() {
    this.playBtn.innerHTML = this.playing
      ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5v10M13 5v10"/></svg>'
      : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5l8 5-8 5Z"/></svg>';
    this.playBtn.setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
  }

  private lastFrame = 0;

  /** Per frame. Advances by real elapsed time (not the animation's capped step), so the replay
   *  keeps its speed even on a device drawing few frames a second. */
  update(nowMs: number) {
    const dt = this.lastFrame ? Math.min(1, (nowMs - this.lastFrame) / 1000) : 0;
    this.lastFrame = nowMs;
    const rec = this.rec, e = this.city;
    if (!rec || !e) return;
    // The city was left (unloaded): nothing to replay into.
    if (!e.detail) { this.stop(); return; }
    if (this.playing) {
      this.t += dt * this.speed;
      if (this.t >= rec.to) { this.stop(); return; } // caught up with now
    }
    this.feed();
    this.range.value = String(Math.round(((this.t - rec.from) / Math.max(1, rec.to - rec.from)) * 1000));
    this.label.textContent = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: this.tz() }).format(new Date(this.t * 1000));
  }
}
