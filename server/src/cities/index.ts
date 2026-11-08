// Cities for milestone 2, each with feeds verified live (see PLAN.md). From milestone 3,
// cities are discovered from the feed catalogs; this list becomes a set of curated extras.

import type { CityDef } from '../types.ts';

const ENTUR_HEADERS = { 'ET-Client-Name': 'afterglow-transit-map' };

export function cityDefs(): CityDef[] {
  return [
    {
      id: 'boston', name: 'Boston', country: 'United States', tz: 'America/New_York',
      origin: { lon: -71.0589, lat: 42.3601 },
      feeds: [{
        id: 'mbta', agency: 'MBTA',
        static: 'https://cdn.mbta.com/MBTA_GTFS.zip',
        realtime: { kind: 'gtfs-rt', url: 'https://cdn.mbta.com/realtime/VehiclePositions.pb' },
        license: { name: 'MBTA Developers License Agreement', url: 'https://www.mass.gov/files/documents/2017/10/27/develop_license_agree_0.pdf' },
        attribution: 'Massachusetts Bay Transportation Authority',
      }],
    },
    {
      id: 'toronto', name: 'Toronto', country: 'Canada', tz: 'America/Toronto',
      origin: { lon: -79.3832, lat: 43.6532 },
      feeds: [
        {
          id: 'ttc', agency: 'TTC',
          // The surface (bus and streetcar) schedule published to match the TTC's realtime feed.
          static: 'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/bd4809dd-e289-4de8-bbde-c5c00dafbf4f/resource/28514055-d011-4ed7-8bb0-97961dfe2b66/download/SurfaceGTFS.zip',
          realtime: { kind: 'gtfs-rt', url: 'https://bustime.ttc.ca/gtfsrt/vehicles' },
          license: { name: 'Open Government Licence – Toronto', url: 'https://open.toronto.ca/open-data-licence/' },
          attribution: 'Toronto Transit Commission',
          legend: 'Contains information licensed under the Open Government Licence – Toronto.',
        },
        {
          id: 'ttc-subway', agency: 'TTC',
          static: 'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/7795b45e-e65a-4465-81fc-c36b9dfff169/resource/cfb6b2b8-6191-41e3-bda1-b175c51148cb/download/opendata_ttc_schedules.zip',
          filter: { routeTypes: [1] },
          note: 'The TTC publishes no subway vehicle positions; subway trains are shown from the timetable.',
          license: { name: 'Open Government Licence – Toronto', url: 'https://open.toronto.ca/open-data-licence/' },
          attribution: 'Toronto Transit Commission',
          legend: 'Contains information licensed under the Open Government Licence – Toronto.',
        },
      ],
    },
    {
      id: 'seattle', name: 'Seattle', country: 'United States', tz: 'America/Los_Angeles',
      origin: { lon: -122.3321, lat: 47.6062 },
      feeds: [
        {
          id: 'kcm', agency: 'King County Metro',
          static: 'https://metro.kingcounty.gov/GTFS/google_transit.zip',
          realtime: { kind: 'gtfs-rt', url: 'https://s3.amazonaws.com/kcm-alerts-realtime-prod/vehiclepositions.pb' },
          license: { name: 'King County transit data terms of use', url: 'https://kingcounty.gov/en/dept/metro/rider-tools/mobile-and-web-apps' },
          attribution: 'King County Metro',
          legend: 'Transit scheduling, geographic, and real-time data provided by permission of King County',
        },
        {
          id: 'sound-transit', agency: 'Sound Transit',
          static: 'https://www.soundtransit.org/GTFS-rail/40_gtfs.zip',
          realtime: { kind: 'gtfs-rt', url: 'https://feeds.sound-transit.continuousgtfs.io/vehicle_positions.pb' },
          license: { name: 'Sound Transit transit data terms of use', url: 'https://www.soundtransit.org/help-contacts/business-information/open-transit-data-otd/transit-data-terms-use' },
          attribution: 'Sound Transit',
        },
      ],
    },
    {
      id: 'brisbane', name: 'Brisbane', country: 'Australia', tz: 'Australia/Brisbane',
      origin: { lon: 153.0251, lat: -27.4698 },
      feeds: [{
        id: 'seq', agency: 'Translink SEQ',
        static: 'https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip',
        realtime: { kind: 'gtfs-rt', url: 'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions' },
        license: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
        attribution: 'Translink (Queensland Government)',
      }],
    },
    {
      id: 'helsinki', name: 'Helsinki', country: 'Finland', tz: 'Europe/Helsinki',
      origin: { lon: 24.9384, lat: 60.1699 },
      feeds: [{
        id: 'hsl', agency: 'HSL',
        static: 'https://infopalvelut.storage.hsldev.com/gtfs/hsl.zip',
        realtime: { kind: 'hsl-mqtt', url: 'wss://mqtt.hsl.fi:443/', topic: '/hfp/v2/journey/ongoing/vp/#' },
        license: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
        attribution: 'Helsinki Region Transport (HSL)',
      }],
    },
    {
      id: 'amsterdam', name: 'Amsterdam', country: 'Netherlands', tz: 'Europe/Amsterdam',
      origin: { lon: 4.9041, lat: 52.3676 },
      feeds: [{
        id: 'ovapi', agency: 'OVapi (GVB, NS, Connexxion, EBS…)',
        // National feed, limited to every route that passes through the Amsterdam area.
        static: 'https://gtfs.ovapi.nl/nl/gtfs-nl.zip',
        filter: { bbox: [4.72, 52.27, 5.08, 52.44] },
        realtime: { kind: 'gtfs-rt', url: 'https://gtfs.ovapi.nl/nl/vehiclePositions.pb' },
        license: { name: 'CC0 1.0 (shapes: ODbL, © OpenStreetMap contributors)', url: 'https://gtfs.ovapi.nl/' },
        attribution: 'OVapi / NDOV Loket',
      }],
    },
    {
      id: 'oslo', name: 'Oslo', country: 'Norway', tz: 'Europe/Oslo',
      origin: { lon: 10.7522, lat: 59.9139 },
      feeds: [{
        id: 'ruter', agency: 'Ruter',
        static: 'https://storage.googleapis.com/marduk-production/outbound/gtfs/rb_rut-aggregated-gtfs.zip',
        staticHeaders: ENTUR_HEADERS,
        note: 'Ruter publishes no open vehicle positions (checked Entur GTFS-RT, SIRI-VM and the vehicles API); shown from the timetable.',
        license: { name: 'NLOD', url: 'https://data.norge.no/nlod/en/' },
        attribution: 'Ruter via Entur',
      }],
    },
  ];
}
