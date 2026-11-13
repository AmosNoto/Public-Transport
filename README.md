# Afterglow

A live, glowing map of public transit. Every real vehicle is a glowing dot; routes are thin lines of coloured light. It opens on a dark 3D globe where each city is a glowing cluster; zooming in (or clicking a city) flies down and the globe unrolls into a flat map, in one continuous camera.

**Status: milestone 3 of 4** (global feed catalog). See `PLAN.md` for the plan and milestones.

## Places

Two sources:

- **Discovered.** At startup the server reads the [Mobility Database](https://mobilitydatabase.org) catalog and turns every active vehicle-positions feed linked to a timetable into a place: about 300 of them; in testing, 275 built across 21 countries, 188 with keyless live data. New catalog entries are picked up daily. See *Discovery* below.
- **Curated.** Eight cities checked by hand (licence wording, the right timetable for the realtime feed, filters for national feeds, a non-GTFS-RT source). They take priority over the catalog's entries for the same feeds:

| City | Feeds | Live positions |
|---|---|---|
| Boston | MBTA | live (GTFS-Realtime) |
| Toronto | TTC buses & streetcars; TTC subway | live; subway from the timetable (TTC publishes no subway positions) |
| Seattle | King County Metro; Sound Transit (Link) | live; live |
| Brisbane | Translink SEQ | live |
| Helsinki | HSL | live, ~1 update per vehicle per second (MQTT high-frequency positioning) |
| Amsterdam | OVapi national feed, every route through the Amsterdam area | live |
| Oslo | Ruter (via Entur) | from the timetable (Ruter publishes no open vehicle positions) |
| San Francisco Bay Area | 511 SF Bay regional feed: ~38 agencies (Muni, BART, AC Transit, VTA, Caltrain, SamTrans, ferries…) | live, **needs a free 511 key** (`KEY_API_511_ORG`); left out without one |

No API keys are needed for the first seven. Keys add the Bay Area and live positions for about 120 more feeds; see `KEYS.md` (generated from the catalog: `npm run keys`).

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

The **first start downloads about 2 GB of timetables** in the background (about 3 GB on disk once built) and builds each place: the curated cities first (about 470 MB, a minute or two), then the catalog places, busiest first (about 15 minutes in testing). Places light up on the globe as they're built, and any place you fly to jumps the queue. Everything is cached in `data/cache/` (timetables are revalidated daily and only re-downloaded when they change), so later starts take seconds. For a small machine, `CATALOG=off` keeps just the curated cities.

Optional configuration goes in `.env` (copy `.env.example`).

### Navigating

- Drag to move; scroll or pinch to zoom toward the pointer; double-click or double-tap to zoom in.
- Right-drag (or ctrl/shift-drag, or two fingers) to rotate and tilt. Tilt unlocks once the globe has unrolled into the map.
- Click a city's glow on the globe, or pick it in the switcher (top left; search by city, operator, region or country), to fly there.
- Arrow keys pan, `+` / `-` zoom.

### Diagnostics

- `?debug` shows frame rate, display refresh, quality tier, GPU, view and which cities are loaded.
- `?quality=low|medium|high|ultra` overrides the automatic quality tier.
- **`#diagnostics`** (add it to the URL) opens the diagnostics view: every feed's state, vehicles, data age, last success and licence; build progress; server memory; which API keys would add feeds; catalog entries that couldn't be shown and why; and a quality-tier override.
- `/api/health` is the same as JSON.
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

It listens on `PORT` (default 8787). Keep `CACHE_DIR` on persistent storage (about 3 GB with the catalog on).

Memory: about 300–600 MB at rest, plus the places people are viewing (each loaded for as long as someone is watching, then dropped after three minutes), plus one background build at a time (capped by `BUILD_MEMORY_MB`, default 1536). A 2 GB server is comfortable with the defaults; with `CATALOG=off`, 1 GB is plenty.

Or with Docker (the image runs the same two steps; not yet built in CI):

```bash
docker compose up --build
```

## Discovery

- The catalog's realtime rows carry no location; each points at the static feed it belongs to. The server follows that link (and the catalog's redirects from retired feeds), groups realtime feeds by timetable, and makes one place per timetable, named after the operator. The origin is the median stop and the time zone comes from the timetable's `agency.txt`.
- Timetables come from the catalog's mirror (falling back to the publisher's URL), are refused over `MAX_STATIC_MB`, and are built one at a time in a worker thread so the live stream never stalls.
- Every live feed is polled from startup (every 30 s while nobody's watching, every 10 s when someone is). That drives the counters, and decides which timetables are built first. ETags and backoff keep it polite.
- Not shown, with reasons in diagnostics: realtime feeds the catalog links to no timetable (nothing to draw them on), timetables that need a key, ones over the size or memory limit, and catalog URLs that turn out to be dead or not GTFS-Realtime at all.
- Licences: each place credits its operator and links the licence the catalog lists. About 60 catalog places list no licence. They are shown with their operator credited and flagged "none listed" in diagnostics.

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
- San Francisco Bay Area: Metropolitan Transportation Commission, 511 SF Bay (511 Data Disseminator Agreement; "Data provided by 511.org", linked, shown whenever the Bay Area is in view)
- Discovered places: each operator, with the licence link from the catalog (in the (i) panel and diagnostics)
- Feed catalog: Mobility Database by MobilityData
- Basemap: OpenFreeMap © OpenMapTiles, data © OpenStreetMap contributors (ODbL)
