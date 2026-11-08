import './style.css';
import * as THREE from 'three';
import { Engine, PALETTE, layerUniforms } from './engine/engine.ts';
import { layerOffsets } from './engine/geo.ts';
import { LiveClient } from './data/live.ts';
import { earthMesh } from './layers/earth.ts';
import { WaterTiles } from './layers/water.ts';
import { CityManager } from './city/manager.ts';
import { Hud } from './ui/hud.ts';
import { Diagnostics } from './ui/diagnostics.ts';

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
  const u = engine.uniforms, cam = engine.globe, dark = PALETTE.dark;

  // Base: the dark Earth and its water. Never blooms.
  const earthLu = layerUniforms();
  engine.base.add(earthMesh(u, earthLu, { day: dark.landDay, night: dark.landNight, polarWater: dark.waterDay, polarWaterNight: dark.waterNight }));
  const water = new WaterTiles(u, { day: dark.waterDay, night: dark.waterNight });
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

  let hudAt = 0;
  engine.onFrame((dt, now) => {
    u.uTime.value = live.now();
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
      hud.setCounts(f ? f.info.live : null, f ? f.info.scheduled : 0, worldLive, worldSched);
      hud.setStatus(
        pend ? (pend.info.state === 'error' ? 'timetable unavailable right now' : 'preparing timetable…')
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
  (window as unknown as { afterglow: unknown }).afterglow = { engine, cam, cities, live, water, THREE };
}

main().catch((e) => console.error(e));
