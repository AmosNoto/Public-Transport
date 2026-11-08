// Shared shapes of data that flow through the server.

export type Mode = 'subway' | 'rail' | 'bus' | 'tram';

/** Where a feed's live positions come from. */
export type RealtimeDef =
  | { kind: 'gtfs-rt'; url: string; headers?: Record<string, string>; minIntervalS?: number }
  | { kind: 'hsl-mqtt'; url: string; topic: string };

export interface FeedFilter {
  /** Keep only shapes (and so routes and trips) that pass through this box: [minLon, minLat, maxLon, maxLat]. */
  bbox?: [number, number, number, number];
  /** Keep only routes of these GTFS route_type values. */
  routeTypes?: number[];
}

export interface FeedDef {
  id: string;
  agency: string;
  /** GTFS static zip. */
  static: string;
  staticHeaders?: Record<string, string>;
  /** Live positions; absent means the feed is shown from its timetable. */
  realtime?: RealtimeDef;
  filter?: FeedFilter;
  license: { name: string; url?: string };
  attribution: string;
  /** Wording the publisher requires to be displayed with the data. */
  legend?: string;
  /** Why there's no realtime, shown in diagnostics (e.g. "needs ONEBUSAWAY_KEY"). */
  note?: string;
}

export interface CityDef {
  id: string;
  name: string;
  country: string;
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

export type FeedState = 'starting' | 'ok' | 'stale' | 'empty' | 'http-error' | 'decode-error' | 'network-error' | 'no-key' | 'timetable';

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
