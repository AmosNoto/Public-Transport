import './style.css';
import * as THREE from 'three';
import { Engine, PALETTE } from './engine/engine.ts';
import { loadCity } from './data/city.ts';
import { LiveClient } from './data/live.ts';
import { RouteState } from './layers/routeState.ts';
import { waterMesh } from './layers/water.ts';
import { routeLines } from './layers/routes.ts';
import { Vehicles } from './layers/vehicles.ts';
import { Photons } from './layers/photons.ts';
import { Hud } from './ui/hud.ts';

const CITY = 'boston';

async function main() {
  const canvas = document.getElementById('gl') as HTMLCanvasElement;
  let engine: Engine;
  try {
    engine = new Engine(canvas);
  } catch (e) {
    document.getElementById('fallback')!.hidden = false;
    throw e;
  }
  const city = await loadCity(CITY);
  engine.setFocus(city.origin.lon, city.origin.lat);
  const off = engine.offsetOf(city.origin);
  const u = engine.uniforms;

  const routes = new RouteState(city);
  const hud = new Hud(() => routes.update(hud.modes));
  hud.setCity(city);
  routes.update(hud.modes);

  engine.base.add(waterMesh(city.water, u, off, PALETTE.dark.water));
  const lines = routeLines(city.lineVerts, city.lineChains, u, off, routes.texture);
  engine.light.add(lines);
  const photons = new Photons(city, u, off, routes.texture);
  engine.light.add(photons.mesh);
  const vehicles = new Vehicles(city, u, off, routes.texture);
  engine.light.add(vehicles.mesh);

  let worldTotal = 0;
  const live = new LiveClient({
    vehicles: (id, v) => { if (id === city.id) vehicles.update(v, live.now(), live.toLocal); },
    gone: (id, keys) => { if (id === city.id) vehicles.end(keys, live.now()); },
    stats: (total) => { worldTotal = total; },
  });
  live.subscribe(city.id);

  // Service levels drive route brightness and photon density; refreshed every few seconds.
  const refreshActivity = () => {
    const now = live.now();
    vehicles.sweep(now);
    const act = vehicles.activity(now);
    routes.active.fill(0);
    for (const [r, n] of act.perRoute) routes.active[r] = n;
    routes.update(hud.modes);
    photons.rebuild(act.perShape, engine.tier.photonBudget);
    hud.setCounts(act.total, Math.max(worldTotal, act.total), act.scheduled);
  };
  setInterval(refreshActivity, 3000);
  setTimeout(refreshActivity, 1500);

  engine.onFrame((dt) => {
    u.uTime.value = live.now();
    // Zoomed out, many lines share each pixel; dim them so the city reads as light, not glare.
    const mpp = engine.metresPerPixel();
    lines.material.uniforms.uGain.value = 0.45 * Math.min(1, Math.max(0.2, Math.pow(6 / mpp, 0.55)));
    photons.tick(dt, engine.metresPerPixel(), engine.device.reducedMotion);
  });
  engine.start();
  (window as unknown as { afterglow: unknown }).afterglow = { engine, city, vehicles, live, THREE };
}

main().catch((e) => console.error(e));
