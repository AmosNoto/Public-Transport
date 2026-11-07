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
- `/api/health` lists every feed's status.

## Data

- Boston live positions and timetable: MBTA (MBTA Developers License Agreement).
- Basemap water: OpenFreeMap / OpenMapTiles, © OpenStreetMap contributors (ODbL).
