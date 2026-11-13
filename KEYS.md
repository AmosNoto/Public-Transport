# API keys

**None are needed.** Afterglow runs on keyless feeds out of the box. Keys only add more places with live
positions. Without a key, a keyed place still appears, drawn from its timetable (hollow, dimmer dots).

Keys go in `.env` (copy `.env.example`), never in client code or git. Restart the server after adding one.
Its feeds start polling right away, and the diagnostics view (`#diagnostics`) shows whether each one works.

## Curated cities that need a key

Checked by hand: each key below was tested live, and its licence read.

### San Francisco Bay Area: `KEY_API_511_ORG`

- 511 SF Bay (regional). Sign up: https://511.org/open-data/token
- Licence: [511 Data Disseminator Agreement](https://511.org/sites/default/files/pdfs/511_Data_Agreement_Final.pdf); shows “Data provided by 511.org” whenever the city is in view, as required

**San Francisco Bay Area details.** One 511 key gives the regional timetable and one realtime feed for about 38 agencies
(Muni, BART, AC Transit, VTA, Caltrain, SamTrans, Golden Gate, the ferries and more), about 2,100 vehicles when tested.
511's default limit is 60 requests an hour per key, so Afterglow polls every 75 s (48 an hour) plus one timetable
download a day. Run only one copy of the app per key, or ask 511 for a higher limit. With the key set, this city replaces
the catalog's separate Bay Area entries (Muni, Caltrain, VTA, Marin Transit, SF Bay Ferry and others).

## What the catalog lists (generated 2026-11-13)

From the [Mobility Database](https://mobilitydatabase.org) catalog: 288 places with vehicle positions beyond the curated cities,
187 of them keyless. 120 more feeds need one of the 19 keys below. One key usually covers every feed on its host.

These come from the catalog and have **not** been tested with real keys (I have none). Treat the sign-up links
and feed counts as the catalog's claim; the diagnostics view is the check once a key is set.

Regenerate this file from the current catalog with `npm run keys`.

| Variable | Feeds | Host | Sign up |
|---|---:|---|---|
| `KEY_API_GOSWIFT_LY` | 52 | api.goswift.ly | [link](https://goswift.ly/realtime-api-key) |
| `KEY_OPENDATA_SAMTRAFIKEN_SE` | 30 | opendata.samtrafiken.se | [link](https://developer.trafiklab.se/register) |
| `KEY_EXO_CHRONO_SAEIV_COM` | 9 | exo.chrono-saeiv.com | [link](https://exo.quebec/fr/a-propos/donnees-ouvertes/FormulaireDemandeAcces) |
| `KEY_DATA_WALTTI_FI` | 4 | data.waltti.fi | [link](https://opendata.waltti.fi/getting-started#api-tokens) |
| `KEY_API_OPENDATA_TRANSPORT_VIC_GOV_AU` | 4 | api.opendata.transport.vic.gov.au | [link](https://data-exchange.vicroads.vic.gov.au/signin) |
| `KEY_OPENDATA_EXO_QUEBEC` | 3 | opendata.exo.quebec | [link](https://exo.quebec/fr/a-propos/donnees-ouvertes/FormulaireDemandeAcces) |
| `KEY_API_PUGETSOUND_ONEBUSAWAY_ORG` | 3 | api.pugetsound.onebusaway.org | [link](https://www.soundtransit.org/help-contacts/business-information/open-transit-data-otd/otd-downloads) |
| `KEY_API_TRANSPORT_NSW_GOV_AU` | 3 | api.transport.nsw.gov.au | [link](https://opendata.transport.nsw.gov.au/data/user/register) |
| `KEY_API_WMATA_COM` | 2 | api.wmata.com | [link](https://developer.wmata.com/signup/) |
| `KEY_API_AT_GOVT_NZ` | 1 | api.at.govt.nz | [link](https://dev-portal.at.govt.nz/) |
| `KEY_DEVELOPER_TRIMET_ORG` | 1 | developer.trimet.org | [link](https://developer.trimet.org/GTFS.shtml) |
| `KEY_GO_BKK_HU` | 1 | go.bkk.hu | [link](https://fiok.bkk.hu/auth) |
| `KEY_TRANSPORT_API_ACT_GOV_AU` | 1 | transport.api.act.gov.au | [link](https://www.transport.act.gov.au/__data/assets/pdf_file/0005/2865398/MyWayPlus-GTFS-developer-access-guide-v1.1.pdf) |
| `KEY_METROLINK_GTFSRT_GBSDIGITAL_US` | 1 | metrolink-gtfsrt.gbsdigital.us | [link](https://metrolinktrains.com/about/gtfs/gtfs-rt-access/) |
| `KEY_API_OPENDATA_METLINK_ORG_NZ` | 1 | api.opendata.metlink.org.nz | [link](https://opendata.metlink.org.nz/) |
| `KEY_API_STM_INFO` | 1 | api.stm.info | [link](https://portail.developpeurs.stm.info/apihub/#/) |
| `KEY_GTFSAPI_TRANSLINK_CA` | 1 | gtfsapi.translink.ca | [link](https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/register) |
| `KEY_GTFSPUBLIC_METRARR_COM` | 1 | gtfspublic.metrarr.com | [link](https://metra.com/developers) |
| `KEY_API_MODESHIFT_COM` | 1 | api.modeshift.com | [link](https://forms.office.com/e/EJ8tXaYFmV) |

## Feeds per key

### `KEY_API_GOSWIFT_LY`

- North County Transit District (NCTD) (San Diego, California, United States)
- Suburban Mobility Authority for Regional Transit (SMART) (Michigan, United States)
- City of Corvallis (Corvallis, Oregon, United States)
- ABQ RIDE (Albuquerque, New Mexico, United States)
- Tillamook County Transportation District (Tillamook, Oregon, United States)
- Sunset Empire Transportation District (Tillamook, Oregon, United States)
- City of Banning Pass Transit System (Banning, California, United States)
- Redding Area Bus Authority (Redding, California, United States)
- Lake Transit Authority (California, United States)
- Humboldt Transit (Humboldt County, California, United States)
- Lincoln County Transit (Newport, Oregon, United States)
- Marble Valley Regional Transit District (MVRTD) (Rutland, Vermont, United States)
- Kern Transit (Bakersfield, California, United States)
- The Current (Vermont, United States)
- Green Mountain Community Network (Bennington, Vermont, United States)
- Green Mountain Transit Agency (Burlington, Vermont, United States)
- Merrimack Valley Regional Transit Authority (MVRTA) (Massachusetts, United States)
- TheBus (Hawaii, United States)
- Qline Detroit (Detroit, Michigan, United States)
- LA Metro (Los Angeles, California, United States)
- Gunnison Valley Transportation Authority (RTA) (Colorado, United States)
- Ellensburg Central Transit (Ellensburg, Washington, United States)
- Bay Town Trolley (Panama City, Florida, United States)
- Advance Transit (AT) (New Hampshire, United States)
- Tahoe Transportation District (TTD) (Nevada, United States)
- Regional Transportation Agency of Central Maryland (RTA) (Maryland, United States)
- Regional Transportation Commission of Southern Nevada (RTC) (Nevada, United States)
- Nevada County Connects (Gold Country Stage) (Nevada County, California, United States)
- Capital Transit (Juneau, Alaska, United States)
- Seattle Children's Hospital Shuttle (Seattle, Washington, United States)
- Rural Community Transportation (RCT) (Vermont, United States)
- Kansas City Area Transportation Authority (KCATA) (Kansas City, Missouri, United States)
- San Joaquin Regional Transit District (RTD) (Stockton, California, United States)
- Turlock Transit (Turlock, California, United States)
- MOOver! (Wilmington, Vermont, United States)
- DC Streetcar (Washington, District of Columbia, United States)
- Avalon Transit (Long Beach, California, United States)
- Charleston Area Regional Transportation Authority (Charleston, South Carolina, United States)
- Miami Dade Transit (Miami, Florida, United States)
- Washington Park Shuttle (Portland, Oregon, United States)
- Williamsburg Area Transit Authority (WATA) (Williamsburg, Virginia, United States)
- Linn Shuttle (Sweet Home, Oregon, United States)
- Tri-Valley Transit (Burlington, Vermont, United States)
- Madera County Connection (Madera, California, United States)
- Eastern Sierra Transit Authority (Bishop, California, United States)
- Benton Area Transportation (Corvallis, Oregon, United States)
- Asheville Rides Transit (Asheville, North Carolina, United States)
- Alexandria Transit Company (DASH) (Alexandria, Virginia, United States)
- Maryland Transit Administration (MTA) Metro (Maryland, United States)
- Maryland Transit Administration (MTA) Commuter Bus (Maryland, United States)
- Maryland Transit Administration (MTA) Light Rail (Maryland, United States)
- Maryland Transit Administration (MTA) Local Bus (Maryland, United States)

### `KEY_OPENDATA_SAMTRAFIKEN_SE`

- Stockholm Länstrafik (Sweden)
- Uppsala Länstrafik (Sweden)
- Östgötatrafiken (Sweden)
- Jönköpings Länstrafik (Sweden)
- Kronoberg (Sweden)
- Kalmar Länstrafik (Sweden)
- Gotland (Sweden)
- Skånetrafiken (Sweden)
- Värmlandstrafik (Sweden)
- Örebro (Sweden)
- Västmanland (Sweden)
- Dalatrafik (Sweden)
- X-trafik (Sweden)
- Din Tur - Västernorrland (Sweden)
- SL (Sweden)
- UL (Sweden)
- JLT (Sweden)
- KLT (Sweden)
- Blekingetrafiken (Sweden)
- Hallandstrafiken (Sweden)

### `KEY_EXO_CHRONO_SAEIV_COM`

- Exo La Presqu'île (Québec, Canada)
- Exo Sorel-Varennes (Varennes, Québec, Canada)
- Exo Sud-ouest (Québec, Canada)
- Exo Vallée du Richelieu (La Vallée-du-Richelieu, Québec, Canada)
- Exo L'Assomption (L'Assomption, Québec, Canada)
- Exo Terrebonne-Mascouche (Québec, Canada)
- Exo (Québec, Canada)
- Exo Chambly-Richelieu-Carignan (Québec, Canada)
- Exo Laurentides (Québec, Canada)

### `KEY_DATA_WALTTI_FI`

- Tampereen joukkoliikenne (JOLI) (Finland)
- Haarasilta Toivo Samuli, Järvisen Liikenne Oy, Koiviston Auto Oy, Lehtimäen Liikenne Oy, Bus Travel Oy Reissu Ruoti, Tilausliikenne Kuisma Ky (Lahti, Päijät-Häme, Finland)
- Linja-Karjala Oy, Savo-Karjalan Linja Oy (Joensuu, Pohjois-Karjala, Finland)
- Jyväskylän Liikenne Oy, Koivuranta Oy, Uuraisten Liikenne Ky, Savo-Karjalan Linja Oy, Linja-Karjala Oy, Oulun taksipalvelut Oy, Oubus Oy, Suorsan Liikenne Ky, Koskilinjat Oy, Oy Pohjolan liikenne Ab, Kuopion Liikenne Oy, Autolinjat Oy, ML-Charter Oy, Etelä-Suomen Linjaliikenne Oy, Linjaliikenne Martti Laurila Oy, Kari Väisänen Ky, Matkatoimisto Matka-Majuri Ky, Linja-autoliikenne P. Puolakka Ky, Elimäen Liikenne Oy, Anjalankosken Linja Oy, Savonlinja Oy, Liikenne M. Heikura Oy, Jääskeläisen Auto Oy, Kilpailutus käynnissä, TILAUSAJOT MENNÄÄN BUSSILLA OY, Revon Turistiliikenne Oy, Matkamestarit Oy, R-Kioski, A. Valppu Oy, Invataksi Niemi Oy, Oy Wiik & Ström Ab, Oravaisten Liikenne Oy, Vaasan Paikallisliikenne Oy, Koiviston Auto Oy, Lehtimäen Liikenne Oy, Järvisen Liikenne Oy, Niemisen Linjat Oy, Bus Travel Oy Reissu Ruoti, Taksi- ja linja-autoliikenne Timo Lahtinen, SL-Autoyhtymä Oy, Linja-autoliike E Ahonen Ky, Lehdon Liikenne Oy, HämeBus Oy, Tuuri Jaakko Juhani, Pekolan Liikenne Oy, Mikkolan Liikenne Oy, Vekka Liikenne Oy, Inter Kuljetus Oy, Valkeakosken Liikenne Oy, Matkahuolto Oy, ELY, Ventoniemi Oy, Yhdysliikenne Oy, MIKA K. NISKANEN OY, Kantamatkat, LINJA-AUTOLIIKE YRJÖ MAKKONEN & KUMPP, SOISALON LIIKENNE OY, Pohjolan Matka, HENKILÖKULJETUS RISSANEN OY, V.Alamäki Oy, Kai Heikkinen Oy, Savo Kainuun Tilausmatkat Ky, Kajaanin Tila-autot Oy, A Kyllönen Oy, Puolangan Bussipalvelu Ky, Kainuun Tilausliikenne P. Jääskeläinen Ky, Matka-Kyllönen Oy, Jyrkilä Oy, Liikenne Vuorela Oy, Pyhtään Kuljetuspalvelut Oy, Erkki Itkonen Oy, Ihastjärven Linja Oy, Tilausliikenne Himanen, Mikkelin Palvelutaksit Oy, Tuplataxi, Matka Mäkelä Oy, Tilausliikenne Hokkinen Ky, S. J. TOIVONEN OY, E. RANTANEN OY, Kuljetus Mikkonen KY, Linja-autoliike Veljekset Laitinen Oy, TILAUSLIIKENNE HÄNNINEN OY, JOUTSENON AUTO- JA KULJETUSPALVELU OY, TOIMI VENTO KY, NINA´S ERIKOISTAKSIPALVELUT OY, Tarkiainen Matti Olavi, Anssin Tilausliikenne Oy, Rautalammin Auto Oy, Oy Rytkönen & Co, SAIMAAN TURISTILIIKENNE OY, Studio Ticket Pusatec-DO-NOT-USE, Studio Ti (Jyväskylä, Keski-Suomi, Finland)

### `KEY_API_OPENDATA_TRANSPORT_VIC_GOV_AU`

- Public Transport Victoria (PTV) Metro Train (Melbourne, Victoria, Australia)
- Public Transport Victoria (PTV) Yarra Trams (Melbourne, Victoria, Australia)
- Public Transport Victoria (PTV) Metro Bus (Melbourne, Victoria, Australia)
- Public Transport Victoria (PTV) V/Line Regional Train (Melbourne, Victoria, Australia)

### `KEY_OPENDATA_EXO_QUEBEC`

- Exo Haut-Saint-Laurent (Québec, Canada)
- Exo Ville de Sainte-Julie (Sainte-Julie, Québec, Canada)
- Exo Le Richelain et Roussillon (Québec, Canada)

### `KEY_API_PUGETSOUND_ONEBUSAWAY_ORG`

- Pierce Transit (Washington, United States)
- City of Seattle - Streetcar (Washington, United States)
- Washington State Ferries (Washington, United States)

### `KEY_API_TRANSPORT_NSW_GOV_AU`

- Transport for New South Wales - Sydney Trains (New South Wales, Australia)
- Transport for New South Wales - Metro (New South Wales, Australia)
- Transport for New South Wales - Light Rail (New South Wales, Australia)

### `KEY_API_WMATA_COM`

- Washington Metropolitan Area Transit Authority (WMATA) (Washington, District of Columbia, United States)

### `KEY_API_AT_GOVT_NZ`

- SeaLink Pine Harbour, Waikato Regional Council, Pavlovich Transport Solutions, AT Metro (New Zealand)

### `KEY_DEVELOPER_TRIMET_ORG`

- TriMet (Portland, Oregon, United States)

### `KEY_GO_BKK_HU`

- Budapesti Közlekedési Központ (BKK) (Budapest, Hungary)

### `KEY_TRANSPORT_API_ACT_GOV_AU`

- Transport Canberra (Canberra, Australian Capital Territory, Australia)

### `KEY_METROLINK_GTFSRT_GBSDIGITAL_US`

- MetroLink (California, United States)

### `KEY_API_OPENDATA_METLINK_ORG_NZ`

- Metlink (Wellington, New Zealand)

### `KEY_API_STM_INFO`

- STM (Montréal, Québec, Canada)

### `KEY_GTFSAPI_TRANSLINK_CA`

- TransLink Vancouver (Vancouver, British Columbia, Canada)

### `KEY_GTFSPUBLIC_METRARR_COM`

- Metra (Chicago, Illinois, United States)

### `KEY_API_MODESHIFT_COM`

- Blagoevgrad Municipality Modeshift (Blagoevgrad, Blagoevgrad, Bulgaria)

## Not keys, but worth knowing

- **Sound Transit (Seattle Link light rail):** the catalog lists a keyed OneBusAway feed, but Sound Transit also publishes keyless
  positions at `feeds.sound-transit.continuousgtfs.io`, which the curated Seattle city uses.
- **Entur (Norway):** keyless; it asks for an identifying `ET-Client-Name` header, which Afterglow sends.
- **Transitland** (a second catalog) needs a key and is not wired in yet.
