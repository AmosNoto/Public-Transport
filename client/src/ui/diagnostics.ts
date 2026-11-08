// Hidden diagnostics view (open with #diagnostics): every feed's health, what the catalog
// discovery found and skipped, which API keys would unlock more, builds, and a quality override.

import type { Engine } from '../engine/engine.ts';
import { TIERS } from '../engine/quality.ts';

interface FeedRow {
  feed: string; city: string; cityName: string; provider?: string; license?: string | null; state: string; detail?: string;
  lastOk?: number; headerAge?: number; vehicles: number; polls: number; failures: number; mode: string; scheduled: number;
}
interface Health {
  now: number;
  server: { uptime: number; rssMB: number; heapMB: number };
  catalog: { enabled: boolean; error: string | null; fetchedAt: number | null; places: number };
  builds: { ready: number; queued: number; failed: number; skipped: number; building: string[] };
  cities: { id: string; name: string; state: string; error: string | null; loaded: boolean; viewers: number; live: number; scheduled: number; timetableMB: number | null }[];
  feeds: FeedRow[];
  skipped: { id: string; provider: string; url: string; reason: string }[];
  keys: { env: string; host: string; info: string | null; feeds: number; set: boolean }[];
}

const STATE_ORDER = ['ok', 'starting', 'empty', 'stale', 'timetable', 'no-key', 'http-error', 'network-error', 'decode-error', 'skipped'];
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const ago = (now: number, t?: number | null) => {
  if (!t) return '–';
  const s = Math.max(0, now - t);
  return s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
};
const link = (url: string | null | undefined, text: string) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text));

export class Diagnostics {
  private el: HTMLElement;
  private timer = 0;
  private filter = '';
  private data: Health | null = null;

  constructor(private engine: Engine) {
    this.el = document.createElement('section');
    this.el.id = 'diag';
    this.el.className = 'panel';
    this.el.hidden = true;
    this.el.setAttribute('aria-label', 'Diagnostics');
    document.body.appendChild(this.el);
    addEventListener('hashchange', () => this.sync());
    this.sync();
  }

  private sync() {
    const open = location.hash === '#diagnostics';
    this.el.hidden = !open;
    document.body.classList.toggle('diag-open', open);
    clearInterval(this.timer);
    if (open) { void this.load(); this.timer = window.setInterval(() => this.load(), 5000); }
  }

  private async load() {
    try { this.data = await (await fetch('/api/health')).json(); } catch { return; }
    this.render();
  }

  private render() {
    const h = this.data;
    if (!h) return;
    const scrollTop = this.el.querySelector('.diag-body')?.scrollTop ?? 0;
    const focused = document.activeElement?.id;
    const states = new Map<string, number>();
    for (const f of h.feeds) states.set(f.state, (states.get(f.state) ?? 0) + 1);
    const q = this.filter.toLowerCase();
    const feeds = h.feeds
      .filter((f) => !q || `${f.cityName} ${f.provider} ${f.state} ${f.detail ?? ''} ${f.feed}`.toLowerCase().includes(q))
      .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || b.vehicles - a.vehicles);
    const t = this.engine.tier.name, pinned = this.engine.tierPinned;
    const live = h.cities.reduce((n, c) => n + c.live, 0);
    const loaded = h.cities.filter((c) => c.loaded);

    this.el.innerHTML = `
      <header class="diag-head">
        <p class="eyebrow">Diagnostics</p>
        <a class="diag-close" href="#" aria-label="Close diagnostics">×</a>
      </header>
      <div class="diag-body">
        <div class="diag-grid">
          <div><p class="eyebrow">Live</p><p class="mono">${live.toLocaleString('en-US')} vehicles · ${states.get('ok') ?? 0} feeds ok</p></div>
          <div><p class="eyebrow">Places</p><p class="mono">${h.builds.ready} ready · ${h.builds.queued} queued · ${h.builds.failed} failed · ${h.builds.skipped} skipped${h.builds.building.length ? ` · building ${esc(h.builds.building.join(', '))}` : ''}</p></div>
          <div><p class="eyebrow">Server</p><p class="mono">up ${ago(0, -h.server.uptime)} · ${h.server.rssMB} MB · loaded ${loaded.length ? esc(loaded.map((c) => c.id).join(', ')) : 'none'}</p></div>
          <div><p class="eyebrow">Catalog</p><p class="mono">${h.catalog.enabled ? `${h.catalog.places} places · fetched ${ago(h.now, h.catalog.fetchedAt)} ago` : 'off (CATALOG=off)'}${h.catalog.error ? ` · <span class="bad">${esc(h.catalog.error)}</span>` : ''}</p></div>
          <div><p class="eyebrow">Quality</p><p class="mono">
            <select id="diag-tier" aria-label="Quality tier">
              <option value="auto"${pinned ? '' : ' selected'}>auto (${esc(t)})</option>
              ${TIERS.map((x) => `<option value="${x.name}"${pinned && x.name === t ? ' selected' : ''}>${x.name}</option>`).join('')}
            </select></p></div>
        </div>
        <p class="mono small">${STATE_ORDER.filter((s) => states.get(s)).map((s) => `<span class="st st-${s}">${s}</span> ${states.get(s)}`).join(' · ')}</p>
        <input id="diag-filter" type="search" placeholder="Filter feeds" value="${esc(this.filter)}" autocomplete="off" aria-label="Filter feeds">
        <table class="diag-table">
          <thead><tr><th>Place</th><th>Source</th><th>State</th><th class="num">Vehicles</th><th class="num">Data age</th><th class="num">Last ok</th><th>Licence</th><th>Detail</th></tr></thead>
          <tbody>${feeds.map((f) => `<tr>
            <td>${esc(f.cityName)}</td>
            <td>${esc(f.provider ?? '')} <span class="faint">${esc(f.feed)}</span></td>
            <td><span class="st st-${f.state}">${esc(f.state)}</span>${f.mode === 'scheduled' && f.scheduled ? ` <span class="faint">→ ${f.scheduled} sched.</span>` : ''}</td>
            <td class="num">${f.vehicles || ''}</td>
            <td class="num">${f.headerAge != null ? ago(0, -f.headerAge) : '–'}</td>
            <td class="num">${ago(h.now, f.lastOk)}</td>
            <td>${f.license ? link(f.license, 'link') : '<span class="warn">none listed</span>'}</td>
            <td class="faint">${esc(f.detail ?? '')}</td></tr>`).join('')}
          </tbody>
        </table>
        <p class="eyebrow">API keys that would add feeds</p>
        <table class="diag-table">
          <thead><tr><th>Variable</th><th>Host</th><th class="num">Feeds</th><th>Set</th><th>Sign up</th></tr></thead>
          <tbody>${h.keys.map((k) => `<tr><td class="mono">${esc(k.env)}</td><td>${esc(k.host)}</td><td class="num">${k.feeds}</td><td>${k.set ? 'yes' : '–'}</td><td>${link(k.info, k.info ? 'info' : '–')}</td></tr>`).join('')}</tbody>
        </table>
        <p class="eyebrow">Catalog feeds not shown</p>
        <table class="diag-table">
          <thead><tr><th>Provider</th><th>Why</th><th>URL</th></tr></thead>
          <tbody>${h.skipped.map((s) => `<tr><td>${esc(s.provider)}</td><td>${esc(s.reason)}</td><td class="faint">${esc(s.url)}</td></tr>`).join('')}
          ${h.cities.filter((c) => c.state === 'skipped' || c.state === 'error').map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.error ?? c.state)}</td><td class="faint">${esc(c.id)}</td></tr>`).join('')}</tbody>
        </table>
      </div>`;

    const body = this.el.querySelector('.diag-body')!;
    body.scrollTop = scrollTop;
    const input = this.el.querySelector('#diag-filter') as HTMLInputElement;
    input.oninput = () => { this.filter = input.value; this.render(); };
    if (focused === 'diag-filter') { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    const sel = this.el.querySelector('#diag-tier') as HTMLSelectElement;
    sel.onchange = () => { this.engine.setTier(sel.value as never); this.render(); };
  }
}
