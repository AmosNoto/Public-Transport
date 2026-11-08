// Runs one city build off the main thread, so downloading and indexing timetables (seconds of
// CPU for big feeds) never stalls the live stream. One worker per build: its memory goes back
// to the system as soon as the build is done.

import { parentPort, workerData } from 'node:worker_threads';
import { prepareCity, TooLargeError } from './gtfs.ts';
import type { CityDef } from '../types.ts';

const city = workerData.city as CityDef;
prepareCity(city)
  .then((summary) => parentPort!.postMessage({ ok: true, summary }))
  .catch((e: Error) => parentPort!.postMessage({ ok: false, error: e.message, tooLarge: e instanceof TooLargeError }));
