import 'dotenv/config';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

export const config = {
  root,
  port: Number(process.env.PORT ?? 8787),
  cacheDir: path.resolve(root, process.env.CACHE_DIR ?? './data/cache'),
  pollIntervalS: Math.max(5, Number(process.env.POLL_INTERVAL_S ?? 10)),
  userAgent: `Afterglow/0.1 (live transit visualisation${process.env.USER_AGENT_CONTACT ? '; ' + process.env.USER_AGENT_CONTACT : ''})`,
  production: process.env.NODE_ENV === 'production' || process.argv.includes('--production'),
  /** Read an API key from the environment; undefined when not configured. */
  key(name: string): string | undefined {
    const v = process.env[name];
    return v && v.trim() ? v.trim() : undefined;
  },
};
