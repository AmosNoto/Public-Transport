import 'dotenv/config';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

export const config = {
  root,
  port: Number(process.env.PORT ?? 8787),
  cacheDir: path.resolve(root, process.env.CACHE_DIR ?? './data/cache'),
  /** Seconds between polls of a feed someone is watching. */
  pollIntervalS: Math.max(5, Number(process.env.POLL_INTERVAL_S ?? 10)),
  /** Seconds between polls of feeds nobody is watching (they still feed the globe and counters). */
  idlePollIntervalS: Math.max(10, Number(process.env.IDLE_POLL_INTERVAL_S ?? 30)),
  /** Discover feeds from the Mobility Database catalog (CATALOG=off: curated cities only). */
  catalog: (process.env.CATALOG ?? 'on').toLowerCase() !== 'off',
  /** Timetables larger than this are not downloaded (memory needed to index them grows with size). */
  maxStaticBytes: Math.max(1, Number(process.env.MAX_STATIC_MB ?? 200)) * 1e6,
  /** Heap limit for each timetable build (worker thread), in MB. */
  buildMemoryMb: Math.max(256, Number(process.env.BUILD_MEMORY_MB ?? 1536)),
  userAgent: `Afterglow/0.1 (live transit visualisation${process.env.USER_AGENT_CONTACT ? '; ' + process.env.USER_AGENT_CONTACT : ''})`,
  production: process.env.NODE_ENV === 'production' || process.argv.includes('--production'),
  /** Read an API key from the environment; undefined when not configured. */
  key(name: string): string | undefined {
    const v = process.env[name];
    return v && v.trim() ? v.trim() : undefined;
  },
};
