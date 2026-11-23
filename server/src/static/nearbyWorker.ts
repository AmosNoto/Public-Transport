import { parentPort, workerData } from 'node:worker_threads';
import { nearbyDepartures, type NearbyJob } from './departures.ts';

nearbyDepartures(workerData as NearbyJob)
  .then((stops) => parentPort!.postMessage({ ok: true, stops }))
  .catch((e: Error) => parentPort!.postMessage({ ok: false, error: e.message }));
