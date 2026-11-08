// Discovery from the Mobility Database catalog (MobilityData). The catalog lists every known
// GTFS and GTFS-Realtime feed. Realtime rows carry no location; each one points at the static
// feed it belongs to (`static_reference`), and the static row has the country, region and
// bounding box. Every vehicle-positions feed becomes a place, grouped by its static feed.
//
// Catalog: https://mobilitydatabase.org (CSV export, refreshed daily upstream).

import path from 'node:path';
import { config } from '../config.ts';
import { readCsv, type Row } from '../static/csv.ts';
import { fetchCached } from '../static/gtfs.ts';
import type { CityDef, FeedDef, RealtimeDef } from '../types.ts';

export const CATALOG_URL = 'https://storage.googleapis.com/storage/v1/b/mdb-csv/o/sources.csv?alt=media';
export const CATALOG_ATTRIBUTION = { name: 'Feed catalog: Mobility Database (MobilityData)', license: 'Apache-2.0', url: 'https://mobilitydatabase.org' };

/** Hosts that ask clients to identify themselves with a header (documented by the publisher). */
const HOST_HEADERS: Record<string, Record<string, string>> = {
  // https://developer.entur.org/pages-intro-authentication
  'api.entur.io': { 'ET-Client-Name': 'afterglow-transit-map' },
};

export interface SkippedFeed {
  id: string;
  provider: string;
  url: string;
  reason: string;
}

export interface KeyedSource {
  env: string;
  host: string;
  info?: string;
  feeds: { id: string; provider: string; place: string; country: string }[];
}

export interface Discovery {
  cities: CityDef[];
  skipped: SkippedFeed[];
  /** Keyed sources grouped by the environment variable that unlocks them. */
  keyed: KeyedSource[];
  fetchedAt: number;
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (cc: string) => { try { return cc ? regionNames.of(cc.toUpperCase()) ?? cc : ''; } catch { return cc; } };

/** One environment variable per API host: a key for an API usually covers all its feeds. */
export function keyEnv(url: string): string {
  return 'KEY_' + new URL(url).hostname.replace(/^www\./, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** "SEPTA Rail" + "Rail" stays "SEPTA Rail"; "WMATA" + "Bus" becomes "WMATA · Bus". */
const withSuffix = (name: string, sfx: string) => (!sfx || name.toLowerCase().includes(sfx.toLowerCase()) ? name : `${name} · ${sfx}`);
const isDead = (r: Row) => r.status === 'deprecated' || r.status === 'inactive';
const short = (s: string) => {
  // "Sound Transit, Metro Transit, City of Seattle, …" → first operator, so names stay readable.
  const first = s.split(/,(?![^(]*\))/)[0].trim();
  return first.length < s.length ? `${first} +` : s;
};

export async function discover(covered: Set<string>, maxBytes: number): Promise<Discovery> {
  const file = path.join(config.cacheDir, 'catalog', 'mobilitydb-sources.csv');
  const buf = await fetchCached(CATALOG_URL, file, 24 * 3600);
  const rows = [...readCsv(buf.toString('utf8'))];
  const byId = new Map(rows.map((r) => [r.mdb_source_id, r]));

  // Follow a deprecated static feed to its replacement, if the catalog names one.
  const resolveStatic = (id: string): Row | null => {
    let r = byId.get(id);
    for (let hop = 0; r && isDead(r) && r['redirect.id'] && hop < 4; hop++) r = byId.get(r['redirect.id'].split('|')[0]);
    return r && r.data_type === 'gtfs' ? r : null;
  };

  const skipped: SkippedFeed[] = [];
  const groups = new Map<string, { st: Row; rts: Row[] }>();
  for (const r of rows) {
    if (r.data_type !== 'gtfs-rt' || !r.entity_type.split('|').includes('vp') || isDead(r)) continue;
    const url = r['urls.direct_download'];
    if (!url) continue;
    const refs = r.static_reference.split('|').filter(Boolean);
    if (covered.has(r.mdb_source_id) || refs.some((s) => covered.has(s))) continue;
    const st = refs.map(resolveStatic).find((x) => x) ?? null;
    if (!st) { skipped.push({ id: r.mdb_source_id, provider: r.provider, url, reason: 'no timetable linked in the catalog (no routes to draw)' }); continue; }
    if (covered.has(st.mdb_source_id)) continue;
    const staticUrl = st['urls.latest'] || st['urls.direct_download'];
    const stAuth = st['urls.authentication_type'];
    if (!staticUrl || (!st['urls.latest'] && (stAuth === '1' || stAuth === '2'))) {
      skipped.push({ id: r.mdb_source_id, provider: r.provider, url, reason: 'timetable needs an API key or has no download URL' });
      continue;
    }
    let g = groups.get(st.mdb_source_id);
    if (!g) groups.set(st.mdb_source_id, (g = { st, rts: [] }));
    g.rts.push(r);
  }

  const keyed = new Map<string, KeyedSource>();
  const cities: CityDef[] = [];
  const providerCount = new Map<string, number>();
  for (const { st } of groups.values()) providerCount.set(st.provider, (providerCount.get(st.provider) ?? 0) + 1);

  for (const { st, rts } of groups.values()) {
    const sid = st.mdb_source_id;
    const cc = st['location.country_code'];
    const region = [st['location.municipality'], st['location.subdivision_name']].filter(Boolean).join(', ');
    const placeName = rts.length === 1 && rts[0].name ? rts[0].name : short(st.provider || rts[0].provider);
    const realtime: RealtimeDef[] = rts.map((r) => {
      const url = r['urls.direct_download'];
      const host = new URL(url).hostname;
      const auth = r['urls.authentication_type'];
      const def: RealtimeDef = { id: `rt${r.mdb_source_id}`, kind: 'gtfs-rt', url, provider: r.provider, headers: HOST_HEADERS[host] };
      if (auth === '1' || auth === '2') {
        const env = keyEnv(url);
        const name = r['urls.api_key_parameter_name'] || (auth === '2' ? 'Authorization' : 'key');
        def.key = { env, info: r['urls.authentication_info'] || undefined, ...(auth === '1' ? { param: name } : { header: name }) };
        let k = keyed.get(env);
        if (!k) keyed.set(env, (k = { env, host, info: def.key.info, feeds: [] }));
        k.feeds.push({ id: r.mdb_source_id, provider: r.provider, place: region, country: countryName(cc) });
      }
      return def;
    });
    const license = rts.map((r) => r['urls.license']).find(Boolean) || st['urls.license'] || null;
    const feed: FeedDef = {
      id: `s${sid}`,
      agency: st.provider,
      static: st['urls.latest'] || st['urls.direct_download'],
      staticAlt: st['urls.latest'] && st['urls.direct_download'] ? st['urls.direct_download'] : undefined,
      realtime,
      maxBytes,
      mdb: [sid, ...rts.map((r) => r.mdb_source_id)],
      license: license ? { name: 'Licence', url: license } : { name: 'No licence listed in the catalog' },
      attribution: st.provider,
    };
    const b = ['minimum_longitude', 'minimum_latitude', 'maximum_longitude', 'maximum_latitude'].map((k) => Number(st[`location.bounding_box.${k}`]));
    const hasBox = b.every((x) => Number.isFinite(x) && x !== 0) && b[2] > b[0] && b[3] > b[1];
    cities.push({
      id: `mdb-${sid}`,
      name: withSuffix(placeName, (providerCount.get(st.provider) ?? 0) > 1 ? st.name || rts.map((r) => r.name).find(Boolean) || st['location.municipality'] || region : ''),
      region,
      country: countryName(cc),
      tz: 'UTC',
      // Provisional until the timetable is read: centre of the catalog's box, or unknown (NaN).
      origin: hasBox ? { lon: (b[0] + b[2]) / 2, lat: (b[1] + b[3]) / 2 } : { lon: NaN, lat: NaN },
      auto: true,
      source: 'catalog',
      feeds: [feed],
    });
  }
  // Same operator, same label (separate timetables for one network): number them.
  const seen = new Map<string, number>();
  for (const c of cities) { const n = (seen.get(c.name) ?? 0) + 1; seen.set(c.name, n); if (n > 1) c.name += ` (${n})`; }
  return { cities, skipped, keyed: [...keyed.values()].sort((a, b) => b.feeds.length - a.feeds.length), fetchedAt: Date.now() / 1000 };
}
