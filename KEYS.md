# API keys

**None are needed right now.** Every city in the current build uses feeds that need no key; each was checked live (see `PLAN.md`).

Two sources that looked like they'd need keys turned out not to:

- **Sound Transit (Seattle Link light rail):** its live positions are published keylessly at `feeds.sound-transit.continuousgtfs.io`, linked from Sound Transit's open-data page, so the OneBusAway Puget Sound key the catalog lists isn't needed.
- **Entur (Norway):** keyless; it only asks for an identifying `ET-Client-Name` header, which Afterglow sends.

## Coming with milestone 3

Milestone 3 brings in the global feed catalogs. In the Mobility Database catalog, 133 of the 365 active vehicle-position feeds need a key (73 in a header, 60 in a query parameter). This file will then list each key, what it unlocks and where to sign up, ordered by how much light it adds to the map. Each one will be verified live before it is listed. Keys go in `.env`, never in client code or git, and a keyed city lights up as soon as its key is added.
