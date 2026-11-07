import type { CityDef } from '../types.ts';

// Milestone 1 city. From milestone 3, cities come from the feed catalogs instead of files like this.
export const boston: CityDef = {
  id: 'boston',
  name: 'Boston',
  tz: 'America/New_York',
  origin: { lon: -71.0589, lat: 42.3601 },
  feeds: [
    {
      id: 'mbta',
      agency: 'MBTA',
      static: 'https://cdn.mbta.com/MBTA_GTFS.zip',
      vehicles: 'https://cdn.mbta.com/realtime/VehiclePositions.pb',
      license: { name: 'MBTA Developers License Agreement', url: 'https://www.mass.gov/files/documents/2017/10/27/develop_license_agree_0.pdf' },
      attribution: 'Massachusetts Bay Transportation Authority',
    },
  ],
};
