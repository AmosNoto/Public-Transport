// The minimal interface: small, dim, and gone after a few idle seconds.

import { MODES, type Mode, type CityInfo, type Credit } from '../data/city.ts';

const ICONS: Record<Mode, string> = {
  subway: '<path d="M6 3h8a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z"/><path d="M3 10h14"/><circle cx="7" cy="13" r=".6"/><circle cx="13" cy="13" r=".6"/><path d="m6 16-2 3M14 16l2 3"/>',
  rail: '<path d="M7 2h6l2 4v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6Z"/><path d="M5 9h10"/><path d="m7 16-3 3M13 16l3 3M6 19h8"/>',
  bus: '<rect x="3" y="3" width="14" height="12" rx="2"/><path d="M3 9h14"/><path d="M6 15v3M14 15v3"/>',
  tram: '<path d="M8 2h4M10 2v3"/><rect x="4" y="5" width="12" height="10" rx="2"/><path d="M4 11h12"/><path d="m7 15-2 4M13 15l2 4"/>',
};
const LABELS: Record<Mode, string> = { subway: 'Subway / metro', rail: 'Trains / commuter rail', bus: 'Buses', tram: 'Trams, ferries & cable cars' };

const fmt = (n: number) => n.toLocaleString('en-US');

export class Hud {
  readonly modes: Record<Mode, boolean> = { subway: true, rail: true, bus: true, tram: true };
  private el = (id: string) => document.getElementById(id)!;
  private tz: string | null = null;
  private idleTimer = 0;
  private cities: CityInfo[] = [];
  private focusedId: string | null = null;
  /** Called when the user picks a city in the switcher. */
  onPick: (id: string) => void = () => {};

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

    // City switcher.
    const sw = this.el('switcher'), input = this.el('city-search') as HTMLInputElement;
    this.el('city-btn').onclick = () => {
      const open = sw.hasAttribute('hidden');
      sw.toggleAttribute('hidden', !open);
      this.el('city-btn').setAttribute('aria-expanded', String(open));
      if (open) { input.value = ''; this.renderList(); input.focus(); }
    };
    input.oninput = () => this.renderList();
    input.onkeydown = (e) => {
      const items = [...this.el('city-list').querySelectorAll('button')];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'Enter') { (items[0] as HTMLButtonElement | undefined)?.click(); e.preventDefault(); }
      if (e.key === 'ArrowDown') { items[Math.min(items.length - 1, i + 1)]?.focus(); e.preventDefault(); }
      if (e.key === 'Escape') this.closeSwitcher();
    };
    this.el('city-list').addEventListener('keydown', (e) => {
      const items = [...this.el('city-list').querySelectorAll('button')];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown') { items[Math.min(items.length - 1, i + 1)]?.focus(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { (i <= 0 ? input : items[i - 1]).focus(); e.preventDefault(); }
      if (e.key === 'Escape') this.closeSwitcher();
    });

    const wake = () => {
      document.body.classList.remove('idle');
      clearTimeout(this.idleTimer);
      this.idleTimer = window.setTimeout(() => {
        if (!this.el('switcher').hasAttribute('hidden') || document.activeElement?.closest('.hud')) return;
        document.body.classList.add('idle');
      }, 4000);
    };
    for (const ev of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'touchstart']) addEventListener(ev, wake, { passive: true });
    wake();
    setInterval(() => this.tick(), 1000);
    this.tick();
  }

  private closeSwitcher() {
    this.el('switcher').setAttribute('hidden', '');
    this.el('city-btn').setAttribute('aria-expanded', 'false');
  }

  private renderList() {
    const q = (this.el('city-search') as HTMLInputElement).value.trim().toLowerCase();
    const list = this.el('city-list');
    list.innerHTML = '';
    const items = this.cities
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.country.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const c of items) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: c.tz }).format(new Date());
      const n = c.live ? `${fmt(c.live)} live` : c.scheduled ? `${fmt(c.scheduled)} sched.` : c.state === 'ready' ? 'quiet' : 'loading';
      b.innerHTML = `<span class="cn"></span><span class="cc"></span><span class="ct mono">${time}</span><span class="cv mono">${n}</span>`;
      (b.querySelector('.cn') as HTMLElement).textContent = c.name;
      (b.querySelector('.cc') as HTMLElement).textContent = c.country;
      b.disabled = c.state !== 'ready';
      b.onclick = () => { this.closeSwitcher(); this.onPick(c.id); };
      li.appendChild(b);
      list.appendChild(li);
    }
    if (!items.length) list.innerHTML = '<li class="empty">No matching city yet</li>';
  }

  setCities(c: CityInfo[]) {
    this.cities = c;
    if (!this.el('switcher').hasAttribute('hidden')) this.renderList();
    this.renderCredits();
  }

  /** The city the view is in, or null on the globe. */
  setFocus(c: CityInfo | null) {
    const id = c?.id ?? null;
    if (id === this.focusedId) return;
    this.focusedId = id;
    this.tz = c?.tz ?? null;
    this.el('city-name').textContent = c ? c.name : 'Earth';
    this.renderCredits();
    this.tick();
  }

  private renderCredits() {
    const focused = this.cities.find((c) => c.id === this.focusedId);
    const credits: Credit[] = [];
    const seen = new Set<string>();
    for (const c of focused ? [focused] : this.cities) for (const a of c.attribution) {
      if (seen.has(a.name)) continue;
      seen.add(a.name); credits.push(a);
    }
    const list = this.el('credits-list');
    list.innerHTML = '';
    for (const a of credits) {
      const li = document.createElement('li');
      li.textContent = a.name + ' · ';
      const link = document.createElement(a.url ? 'a' : 'span');
      link.textContent = a.license;
      if (a.url && link instanceof HTMLAnchorElement) { link.href = a.url; link.target = '_blank'; link.rel = 'noopener'; }
      li.appendChild(link);
      if (a.legend) { const p = document.createElement('div'); p.className = 'legend-text'; p.textContent = a.legend; li.appendChild(p); }
      list.appendChild(li);
    }
    // Publishers that require their legend to be displayed: shown whenever their city is in view.
    const legend = focused?.attribution.find((a) => a.legend)?.legend ?? '';
    const lg = this.el('legend');
    lg.textContent = legend;
    lg.hidden = !legend;
  }

  setCounts(cityLive: number | null, citySched: number, worldLive: number, worldSched: number) {
    this.el('count-label').textContent = cityLive === null ? 'Moving worldwide' : 'In motion';
    this.el('count-city').textContent = fmt(cityLive ?? worldLive);
    const sch = this.el('count-sched');
    const s = cityLive === null ? worldSched : citySched;
    sch.hidden = s === 0;
    sch.textContent = `+ ${fmt(s)} scheduled`;
    const w = this.el('count-world-row');
    w.hidden = cityLive === null;
    this.el('count-world').textContent = fmt(worldLive);
  }

  private tick() {
    const tz = this.tz ?? 'UTC';
    const t = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date());
    this.el('city-time').textContent = this.tz ? t : `${t} UTC`;
  }
}
