# Afterglow: plan

Status: research done, no app code written yet. Everything below marked **verified** was checked live from this session on 2026-11-07. Anything marked **to verify** gets checked live before I rely on it.

## 1. What the research found

### Feed catalog
- **Mobility Database catalog CSV** (`storage.googleapis.com/storage/v1/b/mdb-csv/o/sources.csv?alt=media`). **Verified:** keyless, 1.2 MB, 3,617 feeds (2,540 GTFS static, 1,077 GTFS-RT).
  - 402 GTFS-RT feeds publish **vehicle positions**. 365 of them are not deprecated.
  - Auth on those 365: 210 keyless, 73 need an API-key header, 60 need an API-key query parameter, 22 unspecified.
  - RT rows have no location of their own. You get the location through `static_reference`, which points to the static feed (country, city, bounding box). The server joins the two.
- **Transitland**: needs an API key. It's the second catalog and fills gaps (feeds Mobility Database lacks, operator metadata). **To verify** once you add a key.

### Live feeds spot-checked (keyless, all HTTP 200)
| Feed | Size | Notes |
|---|---|---|
| Boston MBTA `cdn.mbta.com/realtime/VehiclePositions.pb` | 56 KB | official line colors, shapes |
| Norway Entur `api.entur.io/realtime/v1/gtfs-rt/vehicle-positions` | 627 KB | whole country; send `ET-Client-Name` header |
| Netherlands OVapi `gtfs.ovapi.nl/nl/vehiclePositions.pb` | 239 KB | whole country |
| Brisbane/SEQ Translink | 45 KB | |
| Toronto TTC `bustime.ttc.ca/gtfsrt/vehicles` | 109 KB | |
| Kraków ZTP | 20 KB | |
| Lisbon Carris | 17 KB | |
| Adelaide Metro | 5 KB | |
| NYC MTA subway (ACE) | 74 KB | **has no lat/lon**: the subway feeds carry only trip progress, so positions must come from stop-to-stop interpolation |
| Rome Roma Mobilità | 301 redirect | URL in catalog is stale; follow the redirect |

Earlier, with a smaller sample (Seattle King County Metro 408 vehicles, Community Transit 86, Metro Bilbao 14, Boise 10), feeds were decoded and timestamps were 4–54 s old.
- **CORS:** none of the feeds I checked send `Access-Control-Allow-Origin`, so a backend is required (as the spec assumed).
- **Not yet swept:** all ~232 keyless vehicle-position feeds. A bulk probe from this session was blocked by the sandbox's permission policy. In the app, the feed-health checker does this sweep continuously and shows the results in diagnostics, so the real count comes from the running app, not from my estimate.
- **To verify:** Helsinki HSL MQTT (`mqtt.hsl.fi`, keyless, very high-frequency positions) as the first non-GTFS-RT adapter.

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Rendering | **Three.js** (current release, ES modules) with custom shaders | It's the same engine as `lens.html`, so the look carries over exactly: the same `UnrealBloomPass`, additive blending and point sprites. Full shader control is needed for the globe-to-flat morph and for GPU-side motion. |
| Not chosen | MapLibre / deck.gl / Cesium | MapLibre's globe→mercator is nice, but selective bloom inside its custom layers fights its render loop. deck.gl has no real selective bloom pipeline. Cesium is heavy and its post-processing stack doesn't match the lens. Our basemap is only coastlines and water, so we don't need a tile-map library's real strength (streets and labels). |
| Front-end build | Vite + TypeScript | fast dev server, one-command run |
| Server | Node 22 + TypeScript, Fastify, `ws` WebSocket | one language end to end; protobuf decode via `gtfs-realtime-bindings`; MQTT via `mqtt` |
| Storage | SQLite (`better-sqlite3`) and an on-disk cache | catalog, feed health, static-GTFS indexes; no external DB to run |
| Static GTFS processing | worker threads, streamed unzip | preprocessing doesn't block live polling |
| Color | OKLCH math (small in-house module, or `culori` server-side) | perceptual lift of route colors |
| Deploy | Dockerfile + `docker compose`, env-based config | runs the same locally and hosted |

## 3. Rendering architecture

**One camera, one coordinate system.** Every geometry vertex stores lon/lat. The vertex shader computes both its position on a sphere and its position on a Web-Mercator plane, and mixes them with a uniform `morph` (0 = globe, 1 = flat). `morph` follows camera altitude, so zooming or clicking a city is one continuous fly-down in which the globe unrolls into the map. At city zoom, coordinates are relative to the focus centre (RTC), so float32 precision doesn't make dots jitter.

**Three render passes, as in the lens but cleaner:**
1. *Base scene:* dark Earth, land/water (different just enough to read), day/night terminator. Never blooms.
2. *Light scene:* route lines, vehicle dots, photons, city glows. Rendered into its own target → `UnrealBloomPass` (strength 0.85, radius 0.35, threshold 0.04; resolution set by the quality tier).
3. *Composite:* base + light + bloom, added together. Real selective bloom with no material swapping.

**Lines:** instanced screen-space quads (hairline width that holds at any pixel ratio), with per-vertex color and additive blending. Shared corridors brighten toward white on their own because the light adds up.

**Motion on the GPU.** All route shapes are packed into a float texture. Each vehicle is one instance holding (shape id, distance at last fix, speed, time of fix, fade). The shader places it along the shape for the current time, so the CPU does no per-frame work per dot, and tens of thousands of dots stay cheap. A new fix eases from the predicted position to the reported one along the line, with no teleporting. Dots fade out over ~60 s once updates stop.

**Photons:** also fully in the shader. Each route gets N photons (N and brightness scale with that route's current vehicle count), spaced with golden-ratio phases (`i·0.618`) as in the lens, flowing in the direction of travel. A soft radial sprite with the lens's falloff.

**Scheduled vehicles:** the same instance buffer with a flag. They render hollow (ring sprite), dimmer and without photons, and the card says "scheduled".

**Basemap:** Natural Earth (public domain) at globe scale. Coastlines at city scale come from OSM-derived land polygons (ODbL, credited), which the server cuts into simplified tiles, because Natural Earth is too coarse at city zoom.

**Day/night:** subsolar point from the NOAA solar-position formulae every frame. The globe shader gets a soft terminator and a darker night side, and city glows get a night boost.

**Light theme:** additive glow vanishes on white, so Light mode isn't an inversion. The background becomes a pale, slightly cool paper tone. Lines and dots draw with normal blending in deeper, more saturated versions of the same OKLCH hues (lightness lowered, chroma kept). The "bloom" becomes a soft colored halo: the same blurred light texture, multiplied onto the background like ink bleeding into paper. Busy corridors deepen instead of whitening. Same mood, readable in daylight. I'll mock this up and show it to you before polishing.

## 4. Data architecture

```
           ┌────────────── adapters (one file each) ──────────────┐
catalogs → │ gtfs-rt (generic) │ hsl-mqtt │ mta-subway │ …        │ → normalizer → region index → WebSocket
           └──────────────────────────────────────────────────────┘        │            │
static GTFS → preprocessor (shapes LOD, route colors, stop_times idx)      history ring  health/diagnostics
```

- **Adapter contract** (`server/src/adapters/<name>.ts`): `{ id, describe(), start(ctx), stop() }`. The adapter emits normalized `VehicleFix {feedId, vehicleId, routeId, tripId, directionId, lat, lon, bearing, ts, …}`. One generic GTFS-RT adapter covers every catalog feed. Special sources (MQTT, agency APIs, MTA subway trip-progress) are one file each.
- **Polling politely:** each feed is polled on its own interval (default 15 s, never faster than the feed's own update cadence; backs off on 429/5xx with jitter; ETag/If-Modified-Since where supported). Keyed feeds are polled only when their key exists in `.env`.
- **Snapping:** the server projects each fix onto its trip's shape (via the `trip_id → shape_id` index), then estimates speed from successive projections. When a feed has no `trip_id`, it matches by route and nearest shape.
- **Missing shapes:** when `shapes.txt` is absent, the server builds the shape from the stop sequence.
- **Scale and levels of detail:**
  - Globe: city glows only (catalog bounding boxes + live counts). Tiny payload.
  - Region: the client subscribes to the visible tiles over WebSocket. The server sends route geometry at that tile's level of detail (Douglas–Peucker simplified at 3 levels), then a stream of vehicle deltas for those tiles only.
  - Static GTFS is fetched **lazily**. Feeds with live data come first, in the background, ordered by vehicle count. Any city you fly to is fetched on demand. Everything is cached on disk and refreshed using the catalog's `latest` URL. Expect a few GB of disk once it's warm.
- **Scheduled fallback:** for a feed with static data but no live data, the server computes today's active trips (`calendar`/`calendar_dates` + `stop_times`) and sends them with the same motion model, flagged as scheduled.
- **Time-lapse:** the server keeps a ring buffer of delta-compressed snapshots per region, ≥ 60 min (configurable by memory). The client requests a window and replays it faster.
- **Feed health:** each feed has a state (ok / stale header timestamp / empty / HTTP error / decode error / auth missing) plus last-success time. A hidden `/#diagnostics` view lists every feed, with a quality-tier override.
- **Licenses:** each feed's license URL comes from the catalog. The attribution panel credits the agencies currently in view. Feeds whose license forbids redistribution are flagged and not shown until reviewed.

## 5. Color
- Take `route_color` (or the agency's published line color), convert to OKLCH, lift lightness to ≥ ~0.72 and chroma to ≥ ~0.12 while keeping the hue (lightness and chroma are lowered for Light mode).
- Routes with no color, or where everything is identical (white/black/one shared color for all buses), get hues spread around the circle. Order follows the routes' geographic layout (a cheap spatial sort), and neighbours are kept ≥ 30° apart, so adjacent lines stay distinguishable and every city reads as a spectrum.

## 6. Device tiers
At startup the app reads the WebGL renderer string, `deviceMemory`, `hardwareConcurrency`, DPR, screen size, touch, `prefers-reduced-motion` and save-data. That picks a tier: bloom resolution, photon budget, max visible dots, DPR cap and frame-rate cap. A frame-time monitor then steps quality down or up while it runs. Touch gets pinch, two-finger tilt and tap gestures, and the layout works at phone width.

## 7. Milestones
1. **One city, end to end** → Boston (MBTA): keyless, official line colors, complete shapes, ~1,000 vehicles across subway, light rail, commuter rail, bus and ferry, so every mode toggle gets exercised. Server, adapter, preprocessing, GPU motion, photons, selective bloom, Dark theme. Screenshots compared with the lens.
2. **Globe + several cities** → the morph camera, day/night, city glows. Add Oslo/Norway, the Netherlands, Toronto, Seattle, Brisbane, Helsinki (MQTT).
3. **Global catalog** → automatic discovery from Mobility Database (and Transitland with a key), region streaming, lazy static, health and diagnostics, `KEYS.md`.
4. **Extras** → time-lapse, auto-tour, Auto/Dark/Light themes, interactive mode and cards, attribution panel, idle fade.

The repo will always have one-command `npm run dev` (server + client), `README.md`, `KEYS.md` and `.env.example`.

## 8. Decisions for you
1. **First city:** Boston (recommended, for the reasons above) or Helsinki (beautiful, high-frequency data, but MQTT-only, so a less typical path).
2. **Stack:** OK with Three.js + custom shaders rather than a map library?
3. **Light theme direction:** the "ink on paper" idea above OK to prototype?

## Status

- **Milestone 1 — one city, end to end:** done (Boston): live and scheduled vehicles, GPU motion, photons, selective bloom.
- **Milestone 2 — globe + several cities:** done. One continuous globe-to-map camera, real day/night, city glows, tiled water basemap, searchable city switcher. Cities: Boston, Toronto (+ scheduled subway), Seattle (+ live Link), Brisbane, Helsinki (MQTT, ~1 Hz), Amsterdam (national OVapi feed, Amsterdam area), Oslo (scheduled; Ruter publishes no open positions). All keyless; licences verified per feed. Streaming GTFS processing with a disk cache handles national feeds.
- **Milestone 3 — global catalog:** done, with the gaps listed below. Places are discovered from the Mobility Database (every active vehicle-positions feed linked to a timetable; ~300 places, 275 built in testing across 21 countries). Timetables are built lazily in a worker thread, busiest first, cached and revalidated daily. Every live feed is polled from startup (slowly while unwatched), and a place's full index is loaded only while someone views it. There is a `#diagnostics` view (feed health, builds, keys, skipped feeds, quality override). `KEYS.md` is generated from the catalog (`npm run keys`).
  - Not done: **Transitland** (needs a key to verify; not wired in). **Finer region streaming inside national feeds**: a place is still one agency timetable, so whole-country feeds over `MAX_STATIC_MB` (Norway's national feed, NSW) are skipped rather than split into regions. **Keyed feeds** are listed from the catalog but untested (no keys here). Realtime feeds with no linked timetable (~30) aren't shown.
- Next: milestone 4 (time-lapse, auto-tour, themes, interactive mode).
