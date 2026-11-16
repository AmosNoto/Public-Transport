import './style.css';
import * as THREE from 'three';
import { Engine, layerUniforms } from './engine/engine.ts';
import { layerOffsets } from './engine/geo.ts';
import { LiveClient } from './data/live.ts';
import { earthMesh } from './layers/earth.ts';
import { WaterTiles } from './layers/water.ts';
import { CityManager } from './city/manager.ts';
import { Hud } from './ui/hud.ts';
import { Diagnostics } from './ui/diagnostics.ts';
import { Theme, type ThemeMode } from './ui/theme.ts';
import { Inspector } from './ui/inspect.ts';
import { Tour } from './ui/tour.ts';
import { TimeLapse } from './ui/timelapse.ts';

/**
 * Start over the user's own longitude (from their time zone), with the whole globe in view.
 * The camera's field of view is vertical, so on a portrait screen the globe must sit further
 * away to fit the narrower width.
 */
function initialView() {
  const lon = Math.max(-170, Math.min(170, -new Date().getTimezoneOffset() / 4));
  const R = 6371008.8, aspect = innerWidth / Math.max(1, innerHeight);
  const t = Math.tan((35 / 2) * Math.PI / 180) * Math.min(1, aspect);
  const alt = Math.max(21_000_000, (R * 1.12) / t - R);
  return { lon, lat: 28, alt, bearing: 0, pitch: 0 };
}

async function main() {
  const canvas = document.getElementById('gl') as HTMLCanvasElement;
  let engine: Engine;
  try {
    engine = new Engine(canvas, initialView());
  } catch (e) {
    document.getElementById('fallback')!.hidden = false;
    throw e;
  }
  const u = engine.uniforms, cam = engine.globe, pal = engine.palette;

  // Base: the dark Earth and its water. Never blooms.
  const earthLu = layerUniforms();
  engine.base.add(earthMesh(u, earthLu, { day: pal.landDay, night: pal.landNight, polarWater: pal.waterDay, polarWaterNight: pal.waterNight }));
  const water = new WaterTiles(u, { day: pal.waterDay, night: pal.waterNight });
  engine.base.add(water.group);

  // Light: cities.
  let worldLive = 0, worldSched = 0, worldFeeds = 0;
  const hud = new Hud(() => cities.setModes({ ...hud.modes }));
  const live = new LiveClient({
    vehicles: (id, v) => cities.vehicles(id, v),
    gone: (id, keys) => cities.gone(id, keys),
    stats: (total, scheduled, feeds, per) => { worldLive = total; worldSched = scheduled; worldFeeds = feeds; cities.setCounts(per); },
  });
  const cities = new CityManager(u, cam, live);
  cities.photonBudget = engine.tier.photonBudget;
  engine.onTier = (t) => { cities.photonBudget = t.photonBudget; };
  new Diagnostics(engine);
  cities.onChange = () => hud.setCities([...cities.cities.values()].map((e) => e.info));
  engine.light.add(cities.group);
  hud.onPick = (id) => { const e = cities.cities.get(id); if (e) cities.flyTo(e); };

  // Click a city's glow on the globe to fly in. (Navigation only; no hover targets.)
  let downAt: { x: number; y: number; t: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.offsetX, y: e.offsetY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.offsetX - downAt.x, e.offsetY - downAt.y) > 5 || performance.now() - downAt.t > 400) return;
    if (cam.view.alt < 250_000) return;
    const c = cities.cityAt(e.offsetX, e.offsetY);
    if (c) cities.flyTo(c);
  });

  // Theme: Auto / Dark / Light, one button cycling through them.
  const theme = new Theme(engine, cam);
  const THEME_ICON: Record<ThemeMode, string> = {
    auto: '<circle cx="10" cy="10" r="6.5"/><path d="M10 3.5a6.5 6.5 0 0 1 0 13Z" fill="currentColor" stroke="none"/>',
    dark: '<path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8Z"/>',
    light: '<circle cx="10" cy="10" r="3.2"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/>',
  };
  const THEME_LABEL: Record<ThemeMode, string> = {
    auto: 'Theme: Auto (ink on paper where it is daytime, light on dark at night)',
    dark: 'Theme: Dark', light: 'Theme: Light (ink on paper)',
  };
  const themeBtn = document.getElementById('theme-btn')!;
  const showTheme = (m: ThemeMode) => {
    themeBtn.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${THEME_ICON[m]}</svg>`;
    themeBtn.title = THEME_LABEL[m];
    themeBtn.setAttribute('aria-label', THEME_LABEL[m]);
  };
  theme.onChange = (m) => showTheme(m);
  showTheme(theme.mode);
  themeBtn.onclick = () => theme.next();

  // Interactive mode (off by default): point at vehicles and lines.
  const inspector = new Inspector(canvas, cam, cities, live, () => theme.look);
  const inspectBtn = document.getElementById('inspect-btn')!;
  const showInspect = (on: boolean) => { inspectBtn.classList.toggle('on', on); inspectBtn.setAttribute('aria-pressed', String(on)); };
  inspector.onChange = showInspect;
  showInspect(inspector.enabled);
  inspectBtn.onclick = () => inspector.toggle();

  // Auto-tour: button, or ?tour in the URL (for a screen left running).
  const tour = new Tour(cam, cities);
  const tourBtn = document.getElementById('tour-btn')!;
  tour.onChange = (on) => { tourBtn.classList.toggle('on', on); tourBtn.setAttribute('aria-pressed', String(on)); };
  tourBtn.onclick = () => tour.toggle();
  if (new URLSearchParams(location.search).has('tour')) setTimeout(() => tour.start(), 4000);

  // Time-lapse: replay the last hour of the city in view.
  const timelapse = new TimeLapse(cities, live, () => hud.zone);
  cities.clock = () => timelapse.localNow();
  const tlBtn = document.getElementById('timelapse-btn')!;
  let hint = '', hintUntil = 0;
  const say = (text: string) => { hint = text; hintUntil = performance.now() + 3500; };
  timelapse.onChange = (on) => { tlBtn.classList.toggle('on', on); tlBtn.setAttribute('aria-pressed', String(on)); if (on) tour.stop(); else hud.clockOverride = null; };
  tlBtn.onclick = () => {
    if (timelapse.active) { timelapse.stop(); return; }
    const f = cities.focused();
    if (!f) { say('fly into a city to replay its last hour'); return; }
    say('loading the last hour…');
    timelapse.start(f).then(() => { hint = ''; }, () => say('nothing recorded here yet'));
  };
  const prevTour = tour.onChange;
  tour.onChange = (on) => { prevTour(on); if (on) timelapse.stop(); };

  let hudAt = 0;
  engine.onFrame((dt, now) => {
    theme.update(dt, now);
    timelapse.update(now);
    inspector.update(now);
    tour.update(dt, now);
    u.uTime.value = timelapse.localNow();
    // The Earth grid is centred on the focus longitude; only its latitude offset moves.
    const eo = layerOffsets(cam.focus, cam.focus.lon * 180 / Math.PI, 0);
    earthLu.uDLon.value = 0; earthLu.uM0.value = 0; earthLu.uOff.value.set(0, eo.off[1]);
    water.update(cam, now);
    // Zoomed out, many lines share each pixel; dim them so the city reads as light, not glare.
    const mpp = cam.metresPerPixel();
    const gain = 0.45 * Math.min(1, Math.max(0.05, Math.pow(6 / mpp, 0.55)));
    cities.update(dt, now, gain);
    if (now - hudAt > 500) {
      hudAt = now;
      const f = cities.focused();
      // Places on the camera's side of the globe (horizon distance), for the credits panel.
      const horizon = Math.acos(6371008.8 / (6371008.8 + cam.view.alt)) * 6371008.8 * (1 + cam.morph * 3);
      hud.setInView(new Set([...cities.cities.values()].filter((e) => e.glow && e.dist < horizon + e.radius).map((e) => e.info.id)));
      const pend = f ? null : cities.pending();
      hud.setFocus(f?.info ?? pend?.info ?? null);
      if (timelapse.active && timelapse.city?.detail) {
        // Replaying: count what's on screen at the replayed moment, and show its time.
        hud.clockOverride = timelapse.t;
        hud.tick();
        hud.setCounts(timelapse.city.detail.vehicles.activity(timelapse.localNow()).total, 0, worldLive, worldSched);
      } else hud.setCounts(f ? f.info.live : null, f ? f.info.scheduled : 0, worldLive, worldSched);
      hud.setStatus(
        performance.now() < hintUntil ? hint
        : timelapse.active ? `replay ×${timelapse.speed}${timelapse.playing ? '' : ' · paused'}`
        : pend ? (pend.info.state === 'error' ? 'timetable unavailable right now' : 'preparing timetable…')
        : f?.info.timetableOnly ? 'from the timetable · no live feed'
        : !f && worldFeeds ? `${worldFeeds} live feeds` : '',
      );
    }
  });
  engine.start();

  // ?debug: frame rate, display refresh, quality tier, GPU, view.
  if (new URLSearchParams(location.search).has('debug')) {
    const el = document.createElement('pre');
    el.id = 'debug';
    document.body.appendChild(el);
    setInterval(() => {
      const st = engine.stats, v = cam.view, loaded = [...cities.cities.values()].filter((c) => c.detail).map((c) => c.info.id);
      el.textContent = [
        `${st.fps.toFixed(0)} fps  (${st.frameMs.toFixed(1)} ms/frame)`,
        `display ${(1000 / st.refreshMs).toFixed(0)} Hz, drawing every ${st.divisor === 1 ? 'refresh' : st.divisor + ' refreshes'}`,
        `quality ${engine.tier.name}  dpr ${u.uDpr.value}`,
        `view ${v.lat.toFixed(3)}, ${v.lon.toFixed(3)}  alt ${(v.alt / 1000).toFixed(1)} km  morph ${cam.morph.toFixed(2)}`,
        `loaded ${loaded.join(', ') || 'none'}  world live ${worldLive} sched ${worldSched} feeds ${worldFeeds}`,
        engine.device.gpu.slice(0, 60),
      ].join('\n');
    }, 500);
  }
  (window as unknown as { afterglow: unknown }).afterglow = { engine, cam, cities, live, water, theme, inspector, tour, timelapse, THREE };
}

main().catch((e) => console.error(e));
