// The contract every live source implements. Adding a new kind of source is one file
// in this folder that exports a factory returning a SourceAdapter.

import type { FeedDef, FeedHealth, VehicleFix } from '../types.ts';

export interface AdapterContext {
  cityId: string;
  feed: FeedDef;
  /** Deliver a complete snapshot (pollers) or a partial batch (streams) of fixes. */
  emit(fixes: VehicleFix[], complete: boolean): void;
  /** Update this feed's health record. */
  health(patch: Partial<FeedHealth>): void;
}

export interface SourceAdapter {
  readonly kind: string;
  start(ctx: AdapterContext): void;
  stop(): void;
}
