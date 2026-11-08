// WebSocket client for the server's normalised vehicle stream, with clock alignment.

import type { WireVehicle } from '../layers/vehicles.ts';

type Handlers = {
  vehicles(city: string, v: WireVehicle[], snapshot: boolean): void;
  gone(city: string, keys: string[]): void;
  /** World totals, live feeds reporting, and [live, scheduled] for each place with anything running. */
  stats(total: number, scheduled: number, feeds: number, perCity: Record<string, [number, number]>): void;
};

export class LiveClient {
  /** serverEpoch ≈ clientEpoch + offset */
  private offset = 0;
  private haveOffset = false;
  /** Epoch second that local shader time counts from (keeps float32 precise). */
  readonly base = Math.floor(Date.now() / 1000);
  private ws?: WebSocket;
  private subs = new Set<string>();
  private retry = 1;

  constructor(private h: Handlers) { this.connect(); }

  /** Seconds on the local time base, aligned to the server clock. */
  now(): number { return Date.now() / 1000 + this.offset - this.base; }
  toLocal = (epoch: number) => epoch - this.base;

  subscribe(city: string) {
    this.subs.add(city);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'sub', city }));
  }

  unsubscribe(city: string) {
    this.subs.delete(city);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'unsub', city }));
  }

  /** Ask the server to prepare a place's timetable next (the camera is heading there). */
  want(city: string) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'want', city }));
  }

  private sync(serverNow: number) {
    const o = serverNow - Date.now() / 1000;
    // Network delay only ever makes the server look behind, so keep the largest offset seen, eased.
    if (!this.haveOffset) { this.offset = o; this.haveOffset = true; }
    else this.offset = o > this.offset ? o : this.offset * 0.98 + o * 0.02;
  }

  private connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => { this.retry = 1; for (const c of this.subs) ws.send(JSON.stringify({ type: 'sub', city: c })); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (typeof m.now === 'number') this.sync(m.now);
      if (m.type === 'snap' || m.type === 'veh') this.h.vehicles(m.city, m.v, m.type === 'snap');
      else if (m.type === 'gone') this.h.gone(m.city, m.keys);
      else if (m.type === 'stats') this.h.stats(m.total, m.scheduled ?? 0, m.feeds ?? 0, m.cities);
    };
    ws.onclose = () => {
      setTimeout(() => this.connect(), Math.min(30, this.retry) * 1000);
      this.retry *= 2;
    };
  }
}
