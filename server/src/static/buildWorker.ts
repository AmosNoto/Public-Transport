// Runs one city build (or one national-feed split) off the main thread, so downloading and
// indexing timetables (seconds of CPU for big feeds) never stalls the live stream. One worker per
// job: its memory goes back to the system as soon as it's done.

import { parentPort, workerData } from 'node:worker_threads';
import { prepareCity, TooLargeError } from './gtfs.ts';
import { splitRegions } from './split.ts';
import type { CityDef } from '../types.ts';

const { city, job, maxBytes, exclude } = workerData as { city: CityDef; job?: 'split'; maxBytes?: number; exclude?: [number, number, number, number][] };
(job === 'split' ? splitRegions(city, maxBytes!, exclude ?? []) : prepareCity(city))
  .then((result) => parentPort!.postMessage({ ok: true, ...(job === 'split' ? { split: result } : { summary: result }) }))
  .catch((e: Error) => parentPort!.postMessage({ ok: false, error: e.message, tooLarge: e instanceof TooLargeError }));
