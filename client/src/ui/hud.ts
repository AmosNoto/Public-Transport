// The minimal interface: small, dim, and gone after a few idle seconds.

import { MODES, type Mode, type CityData } from '../data/city.ts';

const ICONS: Record<Mode, string> = {
  subway: '<path d="M6 3h8a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z"/><path d="M3 10h14"/><circle cx="7" cy="13" r=".6"/><circle cx="13" cy="13" r=".6"/><path d="m6 16-2 3M14 16l2 3"/>',
  rail: '<path d="M7 2h6l2 4v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6Z"/><path d="M5 9h10"/><path d="m7 16-3 3M13 16l3 3M6 19h8"/>',
  bus: '<rect x="3" y="3" width="14" height="12" rx="2"/><path d="M3 9h14"/><path d="M6 15v3M14 15v3"/>',
  tram: '<path d="M8 2h4M10 2v3"/><rect x="4" y="5" width="12" height="10" rx="2"/><path d="M4 11h12"/><path d="m7 15-2 4M13 15l2 4"/>',
};
const LABELS: Record<Mode, string> = { subway: 'Subway / metro', rail: 'Trains / commuter rail', bus: 'Buses', tram: 'Trams, ferries & cable cars' };

export class Hud {
  readonly modes: Record<Mode, boolean> = { subway: true, rail: true, bus: true, tram: true };
  private el = (id: string) => document.getElementById(id)!;
  private tz = 'UTC';
  private idleTimer = 0;

  constructor(private onModes: () => void) {
    const row = this.el('modes');
    for (const m of MODES) {
      const b = document.createElement('button');
      b.className = 'mode on';
      b.title = LABELS[m];
      b.setAttribute('aria-label', LABELS[m]);
      b.setAttribute('aria-pressed', 'true');
      b.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[m]}</svg>`;
      b.onclick = () => {
        this.modes[m] = !this.modes[m];
        b.classList.toggle('on', this.modes[m]);
        b.setAttribute('aria-pressed', String(this.modes[m]));
        this.onModes();
      };
      row.appendChild(b);
    }
    this.el('credits-btn').onclick = () => this.el('credits').toggleAttribute('hidden');

    const wake = () => {
      document.body.classList.remove('idle');
      clearTimeout(this.idleTimer);
      this.idleTimer = window.setTimeout(() => document.body.classList.add('idle'), 4000);
    };
    for (const ev of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'touchstart']) addEventListener(ev, wake, { passive: true });
    wake();
    setInterval(() => this.tick(), 1000);
  }

  setCity(c: CityData) {
    this.tz = c.tz;
    this.el('city-name').textContent = c.name;
    const list = this.el('credits-list');
    list.innerHTML = '';
    for (const a of c.attribution) {
      const li = document.createElement('li');
      li.textContent = a.name + ' · ';
      const link = document.createElement(a.url ? 'a' : 'span');
      link.textContent = a.license;
      if (a.url && link instanceof HTMLAnchorElement) { link.href = a.url; link.target = '_blank'; link.rel = 'noopener'; }
      li.appendChild(link);
      list.appendChild(li);
    }
    this.tick();
  }

  setCounts(city: number, world: number, scheduled = 0) {
    this.el('count-city').textContent = city.toLocaleString('en-US');
    const sch = this.el('count-sched');
    sch.hidden = scheduled === 0;
    sch.textContent = `+ ${scheduled.toLocaleString('en-US')} scheduled`;
    this.el('count-world').textContent = world.toLocaleString('en-US');
  }

  private tick() {
    this.el('city-time').textContent = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: this.tz }).format(new Date());
  }
}
