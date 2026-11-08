# Afterglow

A live, glowing map of public transit. Every real vehicle is a glowing dot; routes are thin lines of coloured light.

**Status: milestone 1 in progress (Boston, live, end to end).** See `PLAN.md` for the full plan.

## Run locally

Requires Node 22+.

```bash
npm install
cp .env.example .env   # optional; Boston needs no keys
npm run dev
```

Open http://localhost:5173. The first start downloads MBTA's timetable (~23 MB) and basemap tiles, then caches them in `data/cache/`.

- `?quality=low|medium|high|ultra` overrides the automatic quality tier.
- `?debug` shows frame rate, display refresh rate, quality tier and GPU.
- `/api/health` lists every feed's status and whether it is showing live or scheduled vehicles.

## Live or scheduled

Each feed shows live positions while it has them. If a feed's live data stops, goes stale or
is empty for two minutes (or the agency publishes no live feed at all), its vehicles are placed
from the GTFS timetable instead: they move along their real route shapes at timetabled pace,
drawn as dimmer hollow rings with no flowing light, and counted separately ("+ N scheduled").
When live data returns, the scheduled vehicles fade out and live ones take over.

To see the scheduled view on demand, start with `FORCE_SCHEDULED=mbta npm run dev`.

## Data

- Boston live positions and timetable: MBTA (MBTA Developers License Agreement).
- Basemap water: OpenFreeMap / OpenMapTiles, © OpenStreetMap contributors (ODbL).
