// Names for regions split out of national feeds, from OpenStreetMap's Nominatim reverse
// geocoder (https://nominatim.org, data © OpenStreetMap contributors, ODbL). Used sparingly, as
// its usage policy asks: one request at a time at most once a second, an identifying
// User-Agent, and every answer cached on disk for good.

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.ts';

const file = path.join(config.cacheDir, 'catalog', 'region-names.json');
let cache: Record<string, string> | null = null;
let queue = Promise.resolve();
let last = 0;

export const GEONAMES_ATTRIBUTION = { name: 'Region names: OpenStreetMap Nominatim', license: 'ODbL', url: 'https://www.openstreetmap.org/copyright' };

/** The town or city at a point (or null if the lookup fails). */
export function placeName(lat: number, lon: number): Promise<string | null> {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const run = async (): Promise<string | null> => {
    cache ??= JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}'));
    if (cache![key]) return cache![key];
    // City level first; where that only finds the state (rural Australia), look closer.
    try {
    for (const zoom of [10, 12, 14]) {
      const wait = last + 1100 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=${zoom}&accept-language=en`;
      const res = await fetch(url, { headers: { 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return null;
      const j = await res.json() as { name?: string; address?: Record<string, string> };
      const a = j.address ?? {};
      // The settlement if there is one; never the state or country.
      const name = a.city || a.town || a.village || a.municipality || a.suburb || a.locality || a.hamlet || a.city_district || a.county
        || (j.name && j.name !== a.state && j.name !== a.country ? j.name : null) || null;
      if (name) {
        cache![key] = name;
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(cache));
        return name;
      }
    }
    return null;
    } catch { return null; }
  };
  const p = queue.then(run, run);
  queue = p.then(() => undefined, () => undefined);
  return p;
}
