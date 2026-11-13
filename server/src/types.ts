// Shared shapes of data that flow through the server.

export type Mode = 'subway' | 'rail' | 'bus' | 'tram';

/** One source of live positions for a feed. A feed may have several (e.g. one per mode). */
export interface RealtimeDef {
  /** Unique id; the feed-health record is keyed by it. */
  id: string;
  kind: 'gtfs-rt' | 'hsl-mqtt';
  url: string;
  /** MQTT topic (hsl-mqtt). */
  topic?: string;
  headers?: Record<string, string>;
  minIntervalS?: number;
  /** Who publishes it, for diagnostics. */
  provider?: string;
  /** An API key this source needs: the environment variable that holds it and how to send it. */
  key?: { env: string; param?: string; header?: string; info?: string };
}

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
  /** An API key the timetable download needs (same shape as a realtime source's key). */
  staticKey?: { env: string; param?: string; header?: string };
  /** Tried when `static` fails (e.g. the catalog's mirror is missing a file: use the publisher's URL). */
  staticAlt?: string;
  /** Live positions; empty or absent means the feed is shown from its timetable. */
  realtime?: RealtimeDef[];
  /** Refuse timetables larger than this (bytes); see MAX_STATIC_MB. */
  maxBytes?: number;
  /** Mobility Database ids (static and realtime) this feed covers, so discovery skips them. */
  mdb?: string[];
  filter?: FeedFilter;
  license: { name: string; url?: string };
  attribution: string;
  /** Wording the publisher requires to be displayed with the data. */
  legend?: string;
  /** Link the publisher requires with the legend. */
  legendUrl?: string;
  /** Why there's no realtime, shown in diagnostics (e.g. "needs ONEBUSAWAY_KEY"). */
  note?: string;
}

export interface CityDef {
  id: string;
  name: string;
  /** State, province or metro area, when known. */
  region?: string;
  country: string;
  /** IANA time zone. For discovered places it is read from the timetable's agency.txt. */
  tz: string;
  /** Point everything in the city is stored relative to. For discovered places it starts as the
   *  catalog's bounding-box centre and is replaced by the median stop once the timetable is read. */
  origin: { lon: number; lat: number };
  /** Discovered places work out origin and time zone from their own timetable. */
  auto?: boolean;
  /** Environment variables (API keys) this city needs; without them it's left out entirely. */
  requires?: string[];
  source: 'curated' | 'catalog';
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

export type FeedState = 'starting' | 'ok' | 'stale' | 'empty' | 'http-error' | 'decode-error' | 'network-error' | 'no-key' | 'timetable' | 'skipped';

export interface FeedHealth {
  /** Realtime source id (or the feed id, for timetable-only feeds). */
  feed: string;
  city: string;
  provider?: string;
  /** Licence URL, or null when the catalog lists none. */
  license?: string | null;
  state: FeedState;
  detail?: string;
  lastOk?: number;
  lastPoll?: number;
  headerAge?: number;
  vehicles: number;
  polls: number;
  failures: number;
}
