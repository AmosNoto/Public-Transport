import { config } from '../config.ts';
import type { RealtimeDef } from '../types.ts';

/** The URL and headers to request a realtime source with, its API key applied; null if the key isn't set. */
export function sourceRequest(src: RealtimeDef): { url: string; headers: Record<string, string> } | null {
  let url = src.url;
  const headers: Record<string, string> = { ...src.headers };
  if (src.key) {
    const key = config.key(src.key.env);
    if (!key) return null;
    if (src.key.param) { const u = new URL(url); u.searchParams.set(src.key.param, key); url = u.toString(); }
    if (src.key.header) headers[src.key.header] = key;
  }
  return { url, headers };
}
