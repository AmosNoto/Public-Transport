// The contract every live source implements. Adding a new kind of source is one file
// in this folder that exports a factory returning a SourceAdapter.

import type { FeedDef, FeedHealth, RealtimeDef, VehicleFix } from '../types.ts';

export interface AdapterContext {
  cityId: string;
  feed: FeedDef;
  source: RealtimeDef;
  /** The source URL with any API key applied, and the headers to send. */
  url: string;
  headers: Record<string, string>;
  /** Seconds between polls right now: short while someone is watching, longer otherwise. */
  intervalS(): number;
  /** Deliver a complete snapshot (pollers) or a partial batch (streams) of fixes. */
  emit(fixes: VehicleFix[], complete: boolean): void;
  /** Update this source's health record. */
  health(patch: Partial<FeedHealth>): void;
}

export interface SourceAdapter {
  readonly kind: string;
  start(ctx: AdapterContext): void;
  stop(): void;
  /** Someone started watching: poll soon rather than waiting out a long idle interval. */
  poke?(): void;
}
