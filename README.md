# Afterglow

A live, glowing map of public transit. Every real vehicle is a glowing dot; routes are thin lines of coloured light. It opens on a dark 3D globe where each city is a glowing cluster; zooming in (or clicking a city) flies down and the globe unrolls into a flat map, in one continuous camera.

**Status: milestone 2 of 4** (globe + several cities). See `PLAN.md` for the plan and milestones.

## Cities

| City | Feeds | Live positions |
|---|---|---|
| Boston | MBTA | live (GTFS-Realtime) |
| Toronto | TTC buses & streetcars; TTC subway | live; subway from the timetable (TTC publishes no subway positions) |
| Seattle | King County Metro; Sound Transit (Link) | live; live |
| Brisbane | Translink SEQ | live |
| Helsinki | HSL | live, ~1 update per vehicle per second (MQTT high-frequency positioning) |
| Amsterdam | OVapi national feed, every route through the Amsterdam area | live |
| Oslo | Ruter (via Entur) | from the timetable (Ruter publishes no open vehicle positions) |

No API keys are needed for any of these. See `KEYS.md`.

**Live or scheduled.** Each feed shows live positions while it has them. If a feed's live data stops, goes stale or is empty for two minutes (or the agency publishes no live feed at all), its vehicles are placed from the GTFS timetable instead: they move along their real route shapes at timetabled pace, drawn as dimmer hollow rings with no flowing light, and counted separately ("+ N scheduled").

## Run locally

Requires Node 22+.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173.

The **first start downloads about 470 MB of timetables** (the Netherlands national feed alone is 194 MB) and builds each city; cities light up on the globe one by one over a minute or two. Everything is cached in `data/cache/` (timetables are revalidated daily and only re-downloaded when they change; built cities and basemap tiles are reused), so later starts take seconds.

Optional configuration goes in `.env` (copy `.env.example`).

### Navigating

- Drag to move; scroll or pinch to zoom toward the pointer; double-click or double-tap to zoom in.
- Right-drag (or ctrl/shift-drag, or two fingers) to rotate and tilt. Tilt unlocks once the globe has unrolled into the map.
- Click a city's glow on the globe, or pick it in the switcher (top left; type to search), to fly there.
- Arrow keys pan, `+` / `-` zoom.

### Diagnostics

- `?debug` shows frame rate, display refresh, quality tier, GPU, view and which cities are loaded.
- `?quality=low|medium|high|ultra` overrides the automatic quality tier.
- `/api/health` lists every city and feed: state, vehicles, live or scheduled.
- `FORCE_SCHEDULED=mbta npm run dev` shows a feed from its timetable instead of live data.

If your machine reaches the internet through an HTTPS proxy, run with `NODE_USE_ENV_PROXY=1` so the server's requests use it (the MQTT stream picks up `HTTPS_PROXY` by itself).

## Deploy

Build the client and serve everything (API, live stream and the built page) from one Node process:

```bash
npm run build
```

```bash
npm start
```

It listens on `PORT` (default 8787). Keep `CACHE_DIR` on persistent storage.

Or with Docker (the image runs the same two steps; not yet built in CI):

```bash
docker compose up --build
```

## How it works

- **Server** (`server/src`, Node + TypeScript): downloads and streams GTFS static straight out of the zip (national feeds never sit in memory as text), simplifies shapes, merges each route's variants into one network, tunes colours in OKLCH, and caches the result on disk. Live sources are adapters (`server/src/adapters/`, one file each: GTFS-Realtime, HSL MQTT); every position is snapped to its route shape with an estimated speed and streamed to browsers over one WebSocket, per city, only to clients near that city. Water for the basemap comes from OpenFreeMap vector tiles, triangulated and subdivided per tile (`/api/water/z/x/y`).
- **Client** (`client/src`, Three.js + custom shaders): every layer — Earth, water, routes, photons, vehicles, city glows — goes through one shader projection that blends each point's position on the globe and on the flat map by camera altitude, so they unroll together. Positions are relative to the camera's focus, so precision holds from the whole globe to street level. Vehicles move on the GPU along their route shapes between updates. Only the light layer blooms (UnrealBloomPass 0.85 / 0.35 / 0.04 on a separate HDR buffer, composited additively), as in the lens. Day and night come from the real sun position.

## Data and licences

Credits for the city in view are in the (i) panel; publishers who require a displayed legend (King County, City of Toronto) get it shown whenever their city is in view.

- Boston: MBTA (MBTA Developers License Agreement)
- Toronto: Toronto Transit Commission (Open Government Licence – Toronto)
- Seattle: King County Metro (King County transit data terms of use); Sound Transit (Sound Transit transit data terms of use)
- Brisbane: Translink, Queensland Government (CC BY 4.0)
- Helsinki: Helsinki Region Transport, HSL (CC BY 4.0)
- Amsterdam: OVapi / NDOV Loket (CC0 1.0; shapes ODbL, © OpenStreetMap contributors)
- Oslo: Ruter via Entur (NLOD)
- Basemap: OpenFreeMap © OpenMapTiles, data © OpenStreetMap contributors (ODbL)
