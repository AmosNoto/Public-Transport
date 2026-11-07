// Shared shapes of data that flow through the server.

export type Mode = 'subway' | 'rail' | 'bus' | 'tram';

export interface FeedDef {
  id: string;
  agency: string;
  /** GTFS static zip. */
  static: string;
  /** GTFS-Realtime VehiclePositions endpoint. */
  vehicles?: string;
  headers?: Record<string, string>;
  /** Minimum seconds between realtime polls for this feed. */
  minIntervalS?: number;
  license: { name: string; url?: string };
  attribution: string;
}

export interface CityDef {
  id: string;
  name: string;
  tz: string;
  /** Point everything in the city is stored relative to. */
  origin: { lon: number; lat: number };
  feeds: FeedDef[];
}

export interface RouteInfo {
  id: string;
  feed: string;
  short: string;
  long: string;
  mode: Mode;
  /** Colour tuned to glow on the dark map (sRGB 0–1). */
  light: [number, number, number];
  /** Colour tuned as ink for the light theme. */
  ink: [number, number, number];
  /** True when the colour comes from the agency; false when Afterglow assigned a spectral hue. */
  official: boolean;
}

export interface ShapeInfo {
  id: string;
  route: number;
  start: number;
  count: number;
  length: number;
}

/** One normalised live position from any source adapter. */
export interface VehicleFix {
  feed: string;
  vid: string;
  label?: string;
  tripId?: string;
  routeId?: string;
  directionId?: number;
  lat: number;
  lon: number;
  bearing?: number;
  /** m/s, when the source reports it. */
  speed?: number;
  /** Epoch seconds when the position was measured. */
  ts: number;
  stopId?: string;
  stopped?: boolean;
}

export type FeedState = 'starting' | 'ok' | 'stale' | 'empty' | 'http-error' | 'decode-error' | 'network-error' | 'no-key';

export interface FeedHealth {
  feed: string;
  city: string;
  state: FeedState;
  detail?: string;
  lastOk?: number;
  lastPoll?: number;
  headerAge?: number;
  vehicles: number;
  polls: number;
  failures: number;
}
