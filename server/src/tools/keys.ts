// Regenerates KEYS.md from the live Mobility Database catalog: every API key that would add
// vehicle-position feeds, what it unlocks and where to sign up. Run: npm run keys

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';
import { cityDefs } from '../cities/index.ts';
import { discover } from '../catalog/mobilitydb.ts';

const covered = new Set(cityDefs().flatMap((c) => c.feeds.flatMap((f) => f.mdb ?? [])));
const d = await discover(covered, config.maxStaticBytes);
const date = new Date().toISOString().slice(0, 10);
const keyless = d.cities.filter((c) => c.feeds.some((f) => f.realtime?.some((r) => !r.key))).length;
const total = d.keyed.reduce((n, k) => n + k.feeds.length, 0);

const lines = [
  '# API keys',
  '',
  '**None are needed.** Afterglow runs on keyless feeds out of the box. Keys only add more places with live',
  `positions. Without a key, a keyed place still appears, drawn from its timetable (hollow, dimmer dots).`,
  '',
  'Keys go in `.env` (copy `.env.example`), never in client code or git. Restart the server after adding one.',
  'Its feeds start polling right away, and the diagnostics view (`#diagnostics`) shows whether each one works.',
  '',
  `## What the catalog lists (generated ${date})`,
  '',
  `From the [Mobility Database](https://mobilitydatabase.org) catalog: ${d.cities.length} places with vehicle positions beyond the curated cities,`,
  `${keyless} of them keyless. ${total} more feeds need one of the ${d.keyed.length} keys below. One key usually covers every feed on its host.`,
  '',
  'These come from the catalog and have **not** been tested with real keys (I have none). Treat the sign-up links',
  "and feed counts as the catalog's claim; the diagnostics view is the check once a key is set.",
  '',
  'Regenerate this file from the current catalog with `npm run keys`.',
  '',
  '| Variable | Feeds | Host | Sign up |',
  '|---|---:|---|---|',
  ...d.keyed.map((k) => `| \`${k.env}\` | ${k.feeds.length} | ${k.host} | ${k.info ? `[link](${k.info})` : '–'} |`),
  '',
  '## Feeds per key',
  '',
  ...d.keyed.flatMap((k) => [
    `### \`${k.env}\``,
    '',
    ...[...new Map(k.feeds.map((f) => [`${f.provider}|${f.place}|${f.country}`, f])).values()]
      .map((f) => `- ${f.provider}${f.place || f.country ? ` (${[f.place, f.country].filter(Boolean).join(', ')})` : ''}`),
    '',
  ]),
  '## Not keys, but worth knowing',
  '',
  '- **Sound Transit (Seattle Link light rail):** the catalog lists a keyed OneBusAway feed, but Sound Transit also publishes keyless',
  '  positions at `feeds.sound-transit.continuousgtfs.io`, which the curated Seattle city uses.',
  '- **Entur (Norway):** keyless; it asks for an identifying `ET-Client-Name` header, which Afterglow sends.',
  '- **Transitland** (a second catalog) needs a key and is not wired in yet.',
  '',
];
await fs.writeFile(path.join(config.root, 'KEYS.md'), lines.join('\n'));
console.log(`KEYS.md: ${d.keyed.length} keys covering ${total} feeds`);
