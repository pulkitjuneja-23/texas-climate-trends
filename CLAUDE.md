# CLAUDE.md — Texas Climate Trends

Working context for this repo. **Read this first in a new session.** Update the
[Progress log](#progress-log) as work lands.

---

## The goal

A **farmer-usable** website (mobile app later) showing what consumer weather apps leave out:
**historical weather trends** for a specific point in Texas. 25 years of history (2000–present),
selectable individual years, a three-tier forecast, and analog-year matching.

Origin: the user is an agronomist who builds crop models / decision support systems. A farmer told
them that weather apps (Google, Apple, Microsoft) only ever show the next few days — never a 10, 20,
or 30-year trend, and never an individual past year.

A landscape scan (2026-08-19) confirmed the gap. Nothing combines all three of:
1. farmer-grade UI,
2. deep historical trends,
3. a **visible, user-selectable data source**.

Farmer-facing tools (Cornell Climate Smart Farming, MRCC Ag Climate Tools, AgroClimate, AgSite) each
lock you to one hidden source and one region. Multi-source selection exists only in researcher tools
(Climate Engine, climateR, raw APIs).

**User's own reference points**, which define the target:
- **AgroClimate** — best farmer-friendly example, but maps only, no graphs/trends, not an app.
- **Climate Engine** — right data and source-switching, but unusable for a farmer because it's a
  Google Earth Engine console.

The product is the gap between those two.

---

## The thesis — do not optimise this away

Every other farmer-facing climate tool silently picks a dataset for you, while
[dataset choice alone measurably changes crop-yield/climate conclusions](https://iopscience.iop.org/article/10.1088/1748-9326/ab5ebb).

So these are **load-bearing features, not decoration**. Removing them to "simplify" defeats the point:

| Feature | Why it exists |
|---|---|
| Source picker showing **planned sources as disabled** | The grower should see the choice exists |
| Gap-fill days tagged `gapfill` and called out in the UI | Sources genuinely disagree at the seam |
| **r² always shown next to any trend slope** | A 25-yr record is short; weak fits must not read as findings |
| Analog panel showing the **spread** of outcomes, not one winner | A wide spread is itself the answer |
| Season-to-date accumulation as the default for rain/GDD | Daily rainfall normals are the mean of mostly-zeros |
| Neutral gray climatology band | "Normal" is context, not a series competing for attention |

---

## Decisions already made (do not relitigate)

| Decision | Choice | When |
|---|---|---|
| Stack | **Next.js 14 + React 18, Vercel** | user chose, 2026-08-20 |
| v1 historical source | **NASA POWER** | user chose, 2026-08-20 |
| Location input | **Map click + address search** | user chose, 2026-08-20 |
| Scope | **Texas first**, app later | user, 2026-08-20 |
| Units | Metric internally, imperial at render only | 2026-08-20 |
| Charts | Recharts + validated data-viz palette | 2026-08-20 |

---

## Architecture

```
app/
  page.tsx                  dashboard (client) — owns all state
  layout.tsx                imports globals.css + leaflet css
  api/history/route.ts      full daily series + gap-fill splice
  api/forecast/route.ts     three tiers, each failing independently
  api/geocode/route.ts      Nominatim proxy (server-side, UA policy)
lib/
  types.ts                  DailyRecord — the one contract everything speaks
  geo.ts                    Texas bounds, region presets
  sources/                  swappable WeatherSource adapters
    registry.ts             live + planned source list
    nasapower.ts  openmeteo.ts  nws.ts  cpc.ts
  agro/
    climatology.ts          MM-DD normals, percentile bands, accumulation, OLS
    analog.ts               analog-year matching (level + shape + what-happened-next)
    gdd.ts                  simple & modified GDD, crop presets
    units.ts                conversion, at render time only
components/
  LocationPicker  MapCanvas  SourcePicker
  ClimateChart  AnnualTrendChart  AnalogPanel  ForecastStrip
```

**Adding a data source** = implement `WeatherSource` (`lib/types.ts`), add to `LIVE_SOURCES` in
`registry.ts`, remove its `PLANNED` entry. Nothing downstream changes. This is the whole point of
the adapter layer.

---

## Accounts, keys, and usage limits

**Nothing currently in the app requires an account or API key.** Verified by calling every endpoint
with zero credentials. There is no `.env` file and there should not be one.

| Service | Account? | Limit | Watch out for |
|---|---|---|---|
| NASA POWER | No | Unpublished throttle; we make 1 call per location | Fine — one request covers 25 years |
| Open-Meteo | No | 600/min · 5,000/hr · 10,000/day | **Free tier is NON-COMMERCIAL only.** Subscriptions or ads on the site = paid plan required |
| NWS api.weather.gov | No | Fair use | Must send a real User-Agent with contact info |
| NOAA CPC | No | Plain file download | None |
| Nominatim (geocoding) | No | **1 req/sec** | **Auto-complete is explicitly forbidden**; reselling geocoding forbidden; must cache repeats |
| OpenStreetMap tiles | No | Fair use | Heavy traffic needs a paid tile host |

Planned sources: PRISM, gridMET, Daymet, and IEM/ASOS are all open with no account. **OpenET is the
exception — it requires a free account plus an API key**, capped at 20 req/min and 500/hr, with a
monthly quota that resets on the 1st. When OpenET lands it will be the first service needing a
secret, so it needs an env var and must never be called from the browser.

**Nominatim compliance (fixed 2026-08-21):** the location search originally ran debounced
search-as-you-type, which is exactly the auto-complete pattern the policy forbids. Changed to submit
only (Enter or the Search button) with per-query caching. Do not reintroduce as-you-type search
against the public Nominatim instance — self-host or use a paid geocoder first.

**If this ever becomes commercial**, two things change: Open-Meteo needs a paid plan (it powers
gap-fill and the 8–16 day forecast), and map tiles/geocoding should move off the free OSM
infrastructure. NASA POWER, NWS, and CPC are US government data and stay free either way.

---

## Hard-won facts (verified empirically, not from docs)

Re-verify before assuming any of these changed.

### NASA POWER
- Endpoint: `power.larc.nasa.gov/api/temporal/daily/point`, `community=AG`. No key.
- **All of 2000→present in ONE request, ~1.5 s**, ~9,700 rows. Do not paginate by year.
- **Missing values are the literal number `-999.0`, not null.** Unmapped, they destroy every mean.
- **~5-day lag.** A request ending "today" returns `-999` for the last several days.
- Max 20 parameters per point request. Dates are `YYYYMMDD`. Response is keyed by date string.
- Resolution ~0.5° × 0.625° (**~55 km**) — one cell spans several Texas counties.

### Open-Meteo — THREE endpoints, NOT interchangeable
| Use | Endpoint | Note |
|---|---|---|
| Deep history | `archive-api.open-meteo.com/v1/archive` | ERA5, back to 1940 |
| Gap fill | `historical-forecast-api.open-meteo.com/v1/forecast` | current to yesterday; **400s on old dates** |
| Forecast | `api.open-meteo.com/v1/forecast` | 16 days |

Using the gap-fill endpoint for deep history is a hard 400 — this bug was hit and fixed on
2026-08-20. Metric by default. Wind is 10 m (POWER is 2 m); we scale by 0.748.

### NOAA / NWS
- Two hops: `/points/{lat},{lon}` → `/gridpoints/{office}/{x},{y}/forecast`.
- **Requires a real User-Agent with contact info.**
- Returns **14 periods = 7 days** (day/night). Temps in °F for US offices.

### NOAA CPC
- **No JSON API.** Only KMZ/shapefile on `ftp.cpc.ncep.noaa.gov/GIS/us_tempprcpfcst/`.
- `{product}_latest.kmz` where product ∈ `610temp 610prcp 814temp 814prcp wk34temp wk34prcp`.
- KMZ is a zip; parse the KML inside. Probability lives in the Placemark **`<name>`**, e.g.
  `"50.0&#37; Chance of Above Normal Temperature"`. Contours are nested — **highest probability wins**.
- The Created/Valid dates are on the **`<Document>` `<name>`, not a Placemark**. (Bug fixed 2026-08-20.)
- Point in domain but in no contour = CPC "Equal Chances".

### gridMET (added 2026-08-21)
- OPeNDAP ASCII at `thredds.northwestknowledge.net/thredds/dodsC/agg_met_{var}_1979_CurrentYear_CONUS.nc.ascii`
- **Values are RAW PACKED UInt16 — scale/offset are NOT applied by the server**, and the offset
  DIFFERS BY VARIABLE: `tmmx` +220 K, `tmmn` **+210 K**, `pr` +0. All scale 0.1. Using one offset
  for both temperatures produces min > max. Values read from the served `.das`.
- **365-day request cap.** One year returns in ~0.5 s; larger ranges are rejected with a misleading
  414. The NCSS CSV endpoint accepts a full range but took **275 s for one variable** — unusable.
  So: one request per (variable, year), pooled at concurrency 8. Cold load ≈ 4.7 s for 25 years.
- **Must clamp the end index to the `day` dimension length** (read from `.dds`). Asking past the end
  makes THREDDS reject the chunk, and since failed chunks are tolerated, an unclamped index silently
  drops the entire current year. This bug shipped and was caught only because `lastObserved` read
  2025-12-31. Bracket URL chars must be percent-encoded (`%5B`/`%5D`).
- Grid: lat0 49.4, lon0 −124.76666, step 1/24°, 585×1386.

### Daymet (added 2026-08-21)
- `daymet.ornl.gov/single-pixel/api/data` — CSV, whole range in ~2 s, no key. Cheapest source here.
- **No day 366: Daymet discards 31 DECEMBER in leap years, NOT 29 February.** So yday maps straight
  onto the calendar and naive leap-year "correction" shifts every date after February by one.
- **~8 month lag** (checked 2026-08-21: latest = 2025-365). Cannot show the current season.
- Overshooting the available range makes the API **ignore the range and return everything** — clamp
  the end year, and filter the result to the requested window.
- `srad` is W/m² over the daylight period; multiply by `dayl` (seconds) / 1e6 for MJ/m²/day.

### Airport stations / IEM (added 2026-08-21)
- Station list: `mesonet.agron.iastate.edu/api/1/network/{NETWORK}.json` — fields are
  **`latitude`/`longitude`** (not lat/lon), plus `online`, `archive_begin`, `county`.
  `TX_ASOS` has 238 stations. The `geojson/network/...` endpoint returns only 1 feature — don't use it.
- Data: `cgi-bin/request/daily.py?network=&stations=&year1=..&format=json` — 25 years in ~5 s.
  Returns °F, inches, knots — convert. `srad_mj` can be the string `"None"`.
- This is the only real-instrument source; everything else is modelled. Distance to station is
  surfaced in the UI, never hidden.
- **Weather Underground was requested for this and cannot be used**: `api.weather.com` returns 401,
  and keys are issued only to operators of a registered personal weather station.
- **TexMesonet** publishes `/api/Stations` (138 stations) but no discoverable public data endpoint —
  every plausible data path 404s, and the site exposes no API paths in its markup. Revisit if TWDB
  documents one.

### Measured source disagreement (Waco, the thesis in one table)
Annual rainfall, inches. Published Waco normal ≈ 36 in. `stations` = actual ASOS gauge 11 km away.

| source | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 |
|---|---|---|---|---|---|---|---|
| gridMET | 36.4 | 54.0 | 39.1 | 24.8 | 33.5 | 43.2 | 45.6 |
| NASA POWER | 31.5 | 41.3 | 32.2 | 24.2 | 30.2 | 42.1 | 36.7 |
| stations (gauge) | 32.5 | 45.6 | 32.7 | 20.8 | 29.3 | 37.5 | 36.4 |
| Open-Meteo | 43.0 | 42.2 | 43.4 | 35.8 | 48.2 | 45.2 | 41.6 |
| Daymet | 33.4 | 45.7 | 36.0 | 23.7 | 33.5 | 42.0 | 42.6 |

Season-to-date 2026 (1 Jan – 19 Aug) spans **19.3 to 25.0 in** depending on source — a 30% spread on
the same field. Daymet tracks the gauge best; Open-Meteo runs consistently wettest and badly misses
the 2022 drought (35.8 vs the gauge's 20.8). gridMET runs ~15% above the gauge, which is expected
for an areal average versus a point gauge (wind undercatch), and its inter-annual pattern correlates
with the gauge — so the packing conversion is right, not biased by a units error.

### Environment
- Node 24.19.0 / npm 11.17.0 installed via winget on 2026-08-20.
- **`git` is NOT installed.** `winget install Git.Git` before any Vercel push.
- PowerShell 5.1: no `&&`, no ternary, no inline `try` expressions. Refresh PATH in each new shell:
  `$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")`
- **Never run `npm run build` while `npm run dev` is running** — it overwrites `.next` under the dev
  server and serves a blank/500 page. This exact thing wasted a debugging cycle on 2026-08-20.
  Kill node and `rm -rf .next` to recover.
- No browser MCP tool, but **headless Chrome works for visual checks** — this is the only way to
  confirm the UI actually renders. Chrome is at
  `C:\Program Files\Google\Chrome\Application\chrome.exe`.

  Post-hydration DOM (reliable, fast):
  ```powershell
  & $chrome --headless --disable-gpu --no-sandbox --virtual-time-budget=25000 --dump-dom "http://localhost:3000/"
  ```

  Screenshot — **use old `--headless` (not `=new`), an ABSOLUTE `--screenshot` path, and then
  `Start-Sleep -Seconds 12`**. Chrome returns exit 0 before the PNG is flushed, so checking for the
  file immediately reports "no screenshot" even on success. `--headless=new` silently wrote nothing
  here.
  ```powershell
  & $chrome --headless --disable-gpu --no-sandbox --hide-scrollbars `
    --window-size=1400,1560 --virtual-time-budget=45000 `
    --screenshot="$tmp\shot.png" "http://localhost:3000/" 2>$null
  Start-Sleep -Seconds 12
  ```
  Crop tall pages with `System.Drawing` to inspect one chart at readable resolution.

---

## Domain rules that must not regress

- **Normals key on MM-DD, never day-of-year.** DOY misaligns leap/non-leap years after Feb 28,
  smearing normals by a day for ~3/4 of the record.
- **Accumulation percentiles come from per-year curves**, never from accumulating daily percentiles
  (that would describe a year at p90 every single day — absurdly wide band).
- **`accumulate()` must stop at the last real observation.** Carrying the total forward draws a flat
  line to 31 Dec that reads as "no more rain this year". Interior gaps (02-29) still carry forward.
  Fixed 2026-08-20.
- **Temperature *differences* use quantity `tempDelta`, not `temp`** — the +32 offset turns
  "2 °C warmer" into "35.6 °F warmer".
- **Normals exclude the in-progress year**; annual aggregates exclude it too (a partial year would
  draw a false collapse at the right edge).
- **Daily rainfall normals are near-meaningless** — measured at Waco, July 1: mean 2.72 mm, median
  0.27 mm, p10 = 0. Accumulation is the default for rain and GDD for this reason.
- GDD `modified` caps Tmax at 30 °C and floors Tmin at base. At 38/24 °C: simple 21, modified 17.

### Colour
Uses the validated data-viz reference palette. The five categorical slots were run through the
validator in both modes: **all checks pass, with a light-mode contrast WARN on aqua/yellow/magenta.**
That WARN obligates relief — hence **direct end-labels on every series and a table view on every
chart**. Do not remove either. Re-run the validator if the palette changes.

---

## Sanity values (Waco 31.549, −97.147)

Use these to spot a regression fast:

| Check | Expected |
|---|---|
| Rows, 2000→now | ~9,728 across 27 years, **zero** values < −100 |
| Annual rainfall normal | ~929 mm / **36.6 in** (published Waco normal ≈ 36 in) |
| Rainfall trend, 25 yr | ≈ −31.75 mm/decade, **r² ≈ 0.013** (i.e. noise) |
| Feb 29 sample size | n ≈ 371 (±7-day window keeps it from starving) |
| GDD 38/24 °C | simple **21**, modified **17**; cold day (8/2) → 0 |
| Analog spread, Aug 2026 | 2009 → 338 mm next 60 d vs 2000 → 63.5 mm — a **5× spread** |

---

## Commands

```bash
npm run dev        # http://localhost:3000
npm run build      # NOT while dev is running
npm run typecheck  # tsc --noEmit
```

No API keys, no `.env`. Every upstream service is free and unauthenticated.

---

## Progress log

### 2026-08-19 — Landscape scan
Researched existing tools. Conclusion: the farmer-grade + deep-history + source-choice combination
does not exist. Identified five gaps: invisible source disagreement, no ensemble with an honest
uncertainty band, climatologist metrics instead of decision metrics, no analog-year browsing, and
almost no non-US coverage.

### 2026-08-20 — v1 built
Stack/source/location decided by the user. Installed Node 24 (winget). Built and verified:

- Source-adapter layer with 2 live + 5 planned sources.
- `/api/history` — full 25-yr series + labelled gap-fill splice.
- `/api/forecast` — NWS 1–7, Open-Meteo 8–16, CPC weeks 2–4 via point-in-polygon on KMZ contours.
- `/api/geocode` — Nominatim proxy.
- Season tracker, analog panel, forecast strip, year-by-year trend, map with grid-cell footprint.
- Typecheck + production build clean. APIs verified live at Waco, Lubbock, Weslaco, Dalhart.

Bugs found and fixed same day:
1. CPC valid/created dates were on `<Document>`, not a Placemark → dates came back empty.
2. `openmeteo.fetchDaily` used the gap-fill endpoint → hard 400 for any year before its archive.
   Split into `fetchDaily` (archive) / `fetchRecent` (gap fill).
3. Ran `npm run build` while dev server was live → corrupted `.next` → **blank white page**.
   Recovered by killing node + deleting `.next`. Verified fixed via headless-Chrome DOM dump.
4. `accumulate()` carried the running total to 31 Dec, drawing a flat line implying no further rain
   for the rest of the year. Now stops at the last real observation.
5. Rotated y-axis unit labels collided with tick values → unit moved to a header badge.

**Verified visually** via headless-Chrome screenshot: full page renders — map with grid-cell
footprint, source picker, season-so-far tiles, gap-fill warning, season tracker, analog table,
three forecast tiers, trend chart. Re-screenshotted after fixes 4 and 5 to confirm the 2026 line
now terminates at the last observed day and the axis no longer collides.

Dev server left running on :3000.

---

### 2026-08-21 — Four sources added, UI reworked
Per user direction:
- Added **gridMET (4 km)**, **Daymet (1 km)**, **Airport stations (IEM ASOS)**. gridMET is now the
  default. Ensemble deliberately deferred — needs a real weighting design, not a mean.
- **PRISM investigated and declined**: its public service serves only whole-CONUS daily rasters
  (~800 KB per variable per day), so a 25-year point series would be ~36,000 downloads. Listed in
  the picker as unavailable with that reason. gridMET is the substitute — same 4 km, built on PRISM.
- Source picker is now a **dropdown**; resolution/record-start tiles shrunk; data-lag tile replaced
  by which station is supplying the latest days.
- **Season so far** tiles compacted, each with a **date picker** (default 1 Jan) so accumulation can
  start at planting instead of New Year.
- **All yellow warning boxes removed** at user request. The lag they warned about is now solved
  rather than announced: recent days come from the nearest real station.
- Location input: **address/town search, coordinate entry** (decimal and DMS), **device GPS**, and
  map click. Leaflet's default flag-glyph attribution prefix removed.
- Fixed: search-as-you-type violated the Nominatim policy (now submit-only + cached).

### 2026-08-22 — Source control moved to topbar, panels tightened
- **Source dropdown moved into the sticky topbar** (`components/SourceSelect.tsx`) beside the unit
  and theme toggles, so it can be changed from anywhere while scrolling. The standalone
  `SourcePicker` card was deleted; its resolution/record/currency detail now lives inside the menu,
  where it is relevant at the moment of choosing.
- **Fixed "changing source sometimes shows the old data".** Two independent causes:
  1. The skeleton only rendered when `history` was null, so switching source left the PREVIOUS
     source's chart on screen for the whole load. gridMET is ~5 s cold but <1 s warm, which is why
     it looked intermittent. `history` is now cleared the moment `sourceId` changes.
  2. Out-of-order responses could let a slow earlier request overwrite a faster later one. Every
     request now carries a sequence number and only the newest may write state.
  Also added `max-age=0, must-revalidate` to the history route so the browser cannot serve a
  heuristically-cached body while the CDN still caches via `s-maxage`.
  `availableSources` is kept in its own `sourceList` state so the topbar picker keeps its options
  while `history` is intentionally null mid-switch.
- Forecast panel renamed **"Next month prediction"**, all tiers on compact tiles.
- Year-by-year trend: **r² removed** (farmers don't read it). Change-per-decade and N-year-average
  moved inline beside the title via `.head-stats`. The reliability information survives as a plain
  sentence when r² < 0.15: "the swing between years is far bigger than the long-term drift, so read
  the bars, not the line." Keep that — it is the honest content of r² without the jargon.
- `.tiles.stack` added for narrow side columns; `.grid-2` is now 1.3fr/1fr with `align-items: start`.

**Note on trend sign:** gridMET gives Waco rainfall **+2.17 in/decade**, NASA POWER gives
**−1.25 in/decade** (−31.75 mm). Same field, opposite direction. Another reason r²-free trend lines
must carry the plain-language caveat.

**NEVER EDIT SOURCE FILES THROUGH POWERSHELL. USE THE Edit/Write TOOLS.**

This has now corrupted files twice.

- `Get-Content | Set-Content -Encoding utf8` mangled every non-ASCII char in ForecastStrip.tsx.
- The *read* side is equally dangerous: `Get-Content -Raw` decodes with the system ANSI codepage
  in PowerShell 5.1, so a UTF-8 file comes back already mojibake. Writing it out "correctly" with
  `[System.IO.File]::WriteAllText(..., UTF8Encoding)` then double-encodes it. This corrupted
  openet.ts, page.tsx and CLAUDE.md (180 bad sequences) during a simple path rename.

Detect with: `[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($f))` then grep for
`â€"|Â°|Ã—`. Recover with `git checkout -- <files>` — which is the practical argument for
committing before any bulk edit.

### 2026-08-22 (later) — Interface cleanup from user review
- Removed the "Search, type coordinates…" line under **Your location** and the long "Compares the
  last 150 days…" line under the analog panel, plus the forecast panel's subtitle. All read as
  jargon to the intended audience.
- Removed the city preset chips (Lubbock/Amarillo/…) under the map.
- **Map zoom buttons moved to bottom-right** and two z-index fixes: `.topbar` raised to 1200 (above
  Leaflet's 1000 control layer) and `.map-shell` given `isolation: isolate; z-index: 0` so nothing
  inside the map can ever compete with page chrome. The reported symptom was the +/- buttons
  bleeding through the sticky header while scrolling.
- **Address search was broken in two ways.** `shortLabel()` in the geocode route discarded the
  street line and returned only city + county, so searching a street address gave back a list of
  towns with no way to tell them apart. It now keeps `house_number + road`. Separately, a search
  returning zero hits rendered nothing at all — silent failure — so there is now an explicit
  "No matches" row.
- Station provenance is visible again as a `LATEST DAYS FROM` row in the Season so far card, not
  only inside the source dropdown.
- Season so far reworked: two tiles side by side instead of full-width stacked rows; GDD base and
  station moved to compact `.foot-row` label/value rows. `.tiles.stack` removed.
- **Added a "Last 7 days" card** in the right column (rain, wet days, hottest, days over 95°F).
  It reads the tail of the series already in memory, so it costs nothing, and it fills the empty
  space beside the map. That gap was a byproduct of the two-column layout, not a mobile decision —
  side-by-side is what keeps the page short, and the empty column was the price.

### 2026-08-24 — Airport-source bugs, source list trimmed, analog table reworked

**Two real bugs behind "the airport data has issues":**

1. **"Rain since" showed a dash.** `makeStat` indexed the accumulation array at `lastObserved`,
   which is the last day with ANY reading. A station reports today's temperature hours before the
   day's rainfall total is closed out, so precip was null on that exact index and the tile silently
   blanked. It now walks back to the last day that variable actually has, and reads the normal at
   the same calendar day so the comparison stays honest. **Any new accumulation tile must do the
   same — do not index at `lastObserved`.**
2. **Missing bars in the 25-year chart.** `annualAggregate` drops years below 90% coverage — correct,
   since summing a year with 119 reported days would draw a fake drought — but it dropped them
   SILENTLY. Reproduced at Big Bend (29.30, −103.30), where the nearest long-record ASOS has
   2019 = 119 days and 2020 = 209 days, so four bars vanished with no explanation. Waco (ACT) has
   full coverage, which is why it never showed up in earlier testing. The chart now names the
   excluded years and points at the gridded sources. **Coverage-based filtering must always be
   disclosed, never silent.**

**Source list:** PRISM removed entirely (whole-CONUS rasters only — see earlier note). Open-Meteo
removed from the picker but `lib/sources/openmeteo.ts` is still used for the days 8–16 forecast; as a
historical source it duplicated the others while reading consistently wettest and missing the 2022
drought by ~15 in against the gauge. Live list is now gridMET, Daymet, stations, NASA POWER.

**Analog table:** `hotDays` column dropped from display (still drives the matching maths — see
`DISPLAYED_FEATURES`). Added a grouped two-band header — "Already happened" in grey vs "What came
next" in a blue band behind a 2px divider — because the flat table gave no clue where the past
stopped and the future began. Short column labels (`FEATURE_SHORT_LABELS`) were needed: the long
ones pushed the what-came-next columns off the right edge, hiding the whole point of the table.

**URL parameters** `?lat=&lon=&source=&place=` added for shareable links and headless testing.
**Trap hit while doing it:** reading `window.location` inside a `useState` initialiser is a
hydration mismatch — the server renders defaults, the client renders the URL values, React throws.
Apply URL state in a `useEffect` after mount and gate the fetch on a `urlReady` flag so a shared
link does not fire a throwaway request for the default location.

### 2026-08-24 (later) — Water layer, Phase 1

**Decisions (user):** free/noncommercial → Earth Engine free tier; buffer sampling; ET + water
balance together.

**Why Earth Engine, not the OpenET REST API.** OpenET publishes its ensemble as a native EE
ImageCollection (`projects/openet/assets/ensemble/conus/gridmet/monthly/v2_1`, CC-BY-4.0). EE meters
compute, not request counts, so the REST tier's 400 queries/month cap disappears. The REST key stays
as the fallback if this ever needs a commercial licence — hence the adapter shape.

**Two ET layers, never interchangeable:**
| | Source | Record | Lag | Resolution | Meaning |
|---|---|---|---|---|---|
| `eto` | gridMET `pet` | 1979– | ~3 d | 4 km | DEMAND — what a reference crop would use |
| `et` | OpenET via EE | 2015-10– | 1–2 mo | 30 m (buffered) | ACTUAL — what this field measurably used |

They must never be summed or drawn as one line. Reference ET describes an idealised crop; actual ET
includes the stress and irrigation reference ET assumes away.

**Verified working today (no EE key needed):** `/api/et` returns 9,731 days of ETo for Waco,
0.3–13.4 mm/day, 2024 annual = 1,643 mm (65 in) against ~929 mm rain. The accumulated-ETo band is
strikingly *tight* versus rainfall — demand is predictable, supply is not.

**OpenET degrades gracefully:** no key → `{available:false, reason:"…see readme_for_user/SETUP-EARTHENGINE.md"}`;
the UI shows `n/a`, never an error.

**Key implementation notes:**
- `monthlyEtToDaily` spreads monthly ET evenly across days so it lines up with daily rainfall. An
  approximation — real ET varies daily — but necessary, and the error largely cancels over 90+ day
  windows.
- ET is shown in the analog table but deliberately **excluded from the matching maths**. It only
  exists from 2016, so scoring on it would make pre-2016 years incomparable and bias the ranking.
- `waterBalanceForWindow` returns ET only at ≥85% window coverage. A partly-covered window
  understates ET and flatters the deficit — failing in the dangerous direction for irrigation.
- Balance = rainfall − ET, and **inherits the rainfall source's error**: at Waco, gridMET 25.0 in vs
  gauge 19.8 in against ~24 in ET is the difference between a surplus and a 4.7 in deficit. Always
  label which rainfall source produced it. It is a deficit indicator, not a soil-water budget — no
  runoff, percolation, starting moisture, or applied irrigation.
- `@google/earthengine` ships no types; `types/earthengine.d.ts` declares it `any` and the boundary
  is kept inside `lib/sources/openet.ts`.
- URL params extended: `?variable=` alongside `?lat/lon/source/place`.

**Analog table:** ET + Deficit added to BOTH groups (4 new columns), so four weather columns came out
to hold the width — `tminMean`, `dryDays`, `maxDrySpell` (user reported it as confusing) and the
future avg-high. All still drive the matching maths; only the display changed.

**Still to do (needs the key):** verify the EE query end to end, tune buffer sizing, add the
model-spread band and low-`et_ensemble_mad_count` greying.

### 2026-08-24 (later still) — OpenET live via Earth Engine

**Connected and verified.** 130 months, 2015-10 → 2026-07, 100 m buffer (7.8 acres), ~7 s cold.

**Setup traps hit (both now fixed in readme_for_user/SETUP-EARTHENGINE.md):**
1. **Two IAM roles are required**, not one: `Earth Engine Resource Viewer` AND
   `Service Usage Consumer`. Missing the second gives *"Caller does not have required permission
   to use project …"*, which reads like a bad key when the key is fine. The error handler now
   extracts and quotes whatever `roles/*` string Google names.
2. **Double file extension.** Windows hides known extensions, so renaming the download to
   `earthengine-key.json` produced `earthengine-key.json.json`. It looked correct in Explorer,
   the app couldn't find it, and — worse — it did **not** match the exact-name `.gitignore` rule,
   leaving a private key unprotected. `.gitignore` is now prefix-matched (`earthengine-key*`,
   `*-key.json*`, `*.json.json`) and `install-key.ps1` does the whole step.
3. `ee.initialize` needs the project as its **6th** argument — `(baseurl, tileurl, success,
   error, xsrfToken, project)`. Without it modern EE refuses.

**ET IS EXTREMELY LAND-COVER SENSITIVE — the headline caveat.** 2024 annual ET at 30 m:

| Point | Annual | July |
|---|---|---|
| Waco city centre | 355 mm (14 in) | 53 mm |
| Dalhart town | 457 mm | 56 mm |
| Weslaco town | 326 mm | 57 mm |
| **Blackland cropland (31.30, −97.40)** | **926 mm (36 in)** | **144 mm** |

A pin in town reads roughly a third of a pin in a field. **The region presets are all CITIES**, and
the default landing point is Waco city centre — so a first-time visitor sees urban ET that means
nothing agriculturally. Worth moving the default onto farmland.

**Data-gap handling (the dangerous-direction bug).** OpenET drops whole months when cloud defeats
its interpolation — observed at 2021-04, 2021-05, 2026-04, 2026-05: **always in the growing
season**. Carrying a cumulative curve flat across two missing months and resuming would understate
season ET by ~10 in and make an irrigation deficit look comfortable when it is not. So:
- `accumulate(ys, startIdx, maxGapDays)` — a gap longer than `maxGapDays` **stops** the curve.
  Water fields use 5 days; weather fields keep `Infinity` so 29 February still carries forward.
- The chart names the missing months in plain language rather than leaving a silent blank.
- `waterBalanceForWindow` already required ≥85% coverage; that guard is what makes the analog
  table show `n/a` rather than a flattering number.

**Two accumulation-band artifacts, both fixed** — worth understanding, because any future
partial-record variable will hit them:
- `hasLongGap` — a year with an interior hole terminates mid-curve, silently leaving the
  cross-year percentile pool, so "normal" **steps down** at that date. Exclude such years.
- `startsWithin` — a partial FIRST year is just as damaging and is *not* a gap. OpenET opens on
  1 Oct 2015, so 2015's cumulative curve starts at zero in October and dragged every percentile
  down with a visible step. Exclude late-starting years too.
- Report the band's real sample ("Normal from 9 years (2016–2025), 2 more left out as
  incomplete"). Counting the 15 pre-2016 years as "left out" was alarming and wrong — they simply
  predate the record.

**Model spread is genuinely informative:** 2024-07 = 144 mm with a 125–166 mm spread (tight), but
2024-08 = 59 mm with a 28–89 mm spread — the six models diverge sharply once a crop is stressed or
senescing. Not yet drawn on the chart; that is the next ET task.

### 2026-08-24 (final) — Table restored, monthly view, ET tiles

- **Analog table columns restored**: `tminMean` and `dryDays` are back (the table scrolls rather
  than dropping information), along with the future avg-high. Now 13 columns and still fits 1400px.
  `maxDrySpell` stays out (user called it confusing) and `hotDays` stays out (duplicates avg-high);
  both still drive the matching maths.
- **View toggle adapts to the source cadence.** OpenET publishes once a month, so for `et`/`balance`
  the second view is labelled and rendered **"Monthly"** rather than "Day by day" — showing a flat
  daily line would imply precision the data lacks. `toMonthlyTotals` re-sums the prorated daily
  values, recovering OpenET's original monthly figure exactly, and the monthly climatology uses
  `window: 0` so a ±7-day smooth cannot bleed one month into the next.
- **"Estimated ET" everywhere, never bare "ET"** — the daily figures are a monthly value divided
  across its days, and the label should say so.
- **Season-so-far gained Estimated ET and Deficit tiles** with a shared date picker.

**THE GAP RULE MUST BE APPLIED EVERYWHERE, NOT JUST THE CHART.** `makeStat` still ran the
accumulation straight through the April/May hole and reported *14.8 in of ET "through Jul 31"* when
those two months were absent — roughly 9 in short, and the deficit correspondingly flattering. Same
class of bug as the chart one, fixed separately, found only because rain 21.9 − ET 14.8 should be a
+7.1 surplus yet the tile read −4.4. **Any new place that accumulates a water variable needs
`maxGapDays = 5` plus the `hasLongGap` / `startsWithin` filter on its baseline.** Arithmetic that
disagrees across tiles is the tell.

Tiles now report how far they actually got ("only through Apr 5 — data gap"), because ET and rain
covering different periods side by side is unreadable otherwise.

### 2026-08-24 — Reference ET made opt-in; water variables in the trend chart

- **Reference ET is now lazy.** It was 26 years of DAILY values (~355 KB, ~27 upstream requests)
  shipped on every page load to serve one dropdown option. `/api/et` now takes `reference=1` and
  the client requests it only when a reference-ET view is selected in *either* chart. Default
  payload dropped **370.7 KB → 16 KB (23x)**. Once loaded for a location it is retained, so
  toggling back is instant; changing location invalidates it.
- **`AnnualTrendChart`'s field was lifted to the page** so the lazy fetch can be triggered from the
  trend dropdown too. It is now a controlled component (`field` / `onFieldChange`).
- **Water variables added to the year-by-year trend**: annual ET, annual water balance, annual
  reference ET. Years with no satellite coverage simply have no bar — `annualAggregate`'s existing
  90% rule handles it, and the dropped-years note is now variable-aware ("satellite water data
  doesn't cover the whole of those years" instead of the weather-station wording).
- **Legend labels are per-variable** (`high`/`low` on each aggregate). "Wetter/Drier" is wrong for
  most of them. ET is deliberately labelled "More/Less water used" rather than good/bad — a high-ET
  year can mean a thriving crop or a thirsty one and the chart must not imply which. The balance is
  unambiguous, so negative keeps the warm pole and reads "Deficit".
- **Fixed a false label:** the header read "25-year average" (the window setting) even when only 9
  years of data existed. It now reports `data.length`, i.e. the actual number of bars. Same fix in
  the subtitle and tooltip. **Any figure describing a sample must count the sample, not the
  requested range** — the water variables make this visible where the weather ones never did.
- URL params extended with `?trend=` alongside `?variable=`.

### 2026-08-24 — One water-balance convention, enforced

**The confusion, and it was real.** The app computed one quantity — `rainfall − ET` — but labelled
it two ways. A column headed **"Deficit"** displaying that *signed* value produced
**"Deficit: −1.6"**, which reads equally as "short by 1.6" or "the deficit is negative, so there
isn't one". Meanwhile the line-chart variable called the same number "Water balance". Two names,
one of them inverted in feel.

**The rule, now stated at the top of `lib/agro/water.ts`:**

```
balance = rainfall - ET          (always this way round)
  positive -> SURPLUS   more rain fell than the crop used
  negative -> SHORT     crop used more than it rained; irrigation made up the gap
```

**Never label a signed balance "deficit".** The word implies its own sign and fights the number's.

`balanceWording()` and `BALANCE_LEGEND` in `lib/agro/water.ts` are the single source of truth —
every surface derives its text from them so no two can drift:

| Surface | Before | Now |
|---|---|---|
| Analog table header | `Deficit` | `Balance` |
| Analog table cell | `-10.0` | `10.0 short` (red) / `2.1 surplus` (blue) |
| Season-so-far tile | `Deficit since · -1.6 in` | `Water balance since · 1.6 in short` |
| Trend legend | `Surplus` / `Deficit` | `Surplus — more rain than used` / `Short — used more than it rained` |
| Line chart | (nothing) | hint line explaining above/below zero |

**Where the sign may still be relied on:** charts only, because a zero line plus a legend makes
direction visible. Anywhere with room for words, the magnitude is shown UNSIGNED and the word
carries the meaning. Internal `deficitStat` renamed `balanceStat` so the vocabulary cannot creep
back in from the code side.

### 2026-08-25 — Shipped

- **Live: https://texas-climate-trends.vercel.app** (public, no auth)
- **Repo: https://github.com/pulkitjuneja-23/texas-climate-trends** (private, `main`)
- Vercel auto-deploys on push to `main`. There is no manual deploy step.

**Production verified end to end**, not assumed: history 1.7 s / 9,734 rows, forecast, geocode, and
`/api/et` with **Earth Engine working (130 months)**. Credentials are supplied as
`GEE_PROJECT_ID` + `GEE_KEY_JSON` env vars in Vercel — the file path variant obviously cannot work
on a server, so this path was proven locally first by running `npm run start` with `GEE_KEY_JSON`
set before deploying.

**Vercel URL gotcha:** the SHORT `texas-climate-trends.vercel.app` is production and public; the
longer `...-pulkitjuneja-23.vercel.app` forms are preview builds behind Vercel's login and return a
Vercel login page. Don't mistake that for a broken deployment.

**Free-tier limits that matter:** Vercel Hobby allows 300 s per function (our slowest is ~7 s, so
ample) and is **non-commercial only** — the same condition Earth Engine's free tier carries, so both
change together if this is ever monetised.

**Git setup notes:** `gh auth setup-git` is required or pushes fail with
"could not read Username" in a non-interactive shell. A `.githooks/pre-commit` hook blocks any
commit containing a private key or service-account JSON by CONTENT (tested with a fake key);
enabled via `git config core.hooksPath .githooks`.

**A stray `env.local` (no leading dot) once slipped past a `.env*.local` rule** and was staged. It
held no credentials, but the ignore rules are now matched with and without the dot. Always list what
is actually staged before a first commit, and verify the REMOTE file list after pushing.

### 2026-08-25 — Sparse-station bug (user-reported), default moved to farmland

**The bug: "many places keep showing 1 inch of rain".** Reported from the live site. The API data
was fine — the fault was in `makeStat`.

An accumulation sums only the days that reported. Airport stations drop days routinely. Measured
across Texas for 2026:

| Place | Days with rain data | Season total shown |
|---|---|---|
| Lubbock | 236 / 237 | 8.65 in (correct) |
| **Muleshoe** | **173 / 237** | **1.81 in** ← the reported "1 inch" |
| **Pecos** | **23 / 237** | 4.5 in |
| Uvalde | 208 / 237 | 11.65 in |

That partial total was then compared against a **complete** 25-year normal and rendered as
"−13.2 vs normal" — a fabricated catastrophic drought, stated with total confidence. Note Muleshoe
lost ~80% of its rainfall from only ~27% missing days: **rain arrives on a few days, so missing days
hide a disproportionate share of the total.** Temperature degrades gracefully; rainfall does not.

**Fix:** `makeStat` counts days actually present between `startIdx` and the read index and returns
`coverage`/`daysPresent`/`daysExpected`/`sparse`. Below 90% the tiles **drop the vs-normal
comparison** and say "incomplete — only 173 of 194 days reported" instead. The total is still shown
because it is honestly what the station measured; the COMPARISON was the lie.

Threshold tuned to 0.9 deliberately: 0.95 flagged an ordinary 90/96-day window on good data, and a
warning that cries wolf gets ignored when it matters.

**THE GENERAL RULE, now hit three times (chart, tiles, and this):** anywhere a partial series is
summed and compared against a complete baseline, the comparison must be gated on coverage. Assume
any new accumulation surface needs this.

**Default location moved off Waco city centre** to Blackland Prairie cropland (31.30, −97.40),
exported as `DEFAULT_PLACE` in `lib/geo.ts`. City pixels read roughly a third of cropland ET
(355 mm vs 926 mm in 2024), so landing a first-time visitor on pavement made their first impression
of the water figures wrong with no way to know it.

### 2026-08-25 — Mobile layout

User-reported on a real phone: the source dropdown was cut off on the left, and the season chart
was too tall.

- **Chart heights moved out of inline styles** into `.chart-main` / `.chart-trend` so they can
  respond: 420px→250px and 260px→190px under 700px. A 420px plot on a phone is taller than it is
  wide and stops reading as one year.
- **Dropdown**: given its own full-width row under 700px, so the menu spans that row exactly
  (`left:0; right:0; min-width:0`). Previously `right:0` anchored it to a trigger sitting mid-row
  and the left half hung off-screen.
- **`.tile { min-width: 0 }`** — grid/flex children default to `min-width:auto` and refuse to
  shrink below their content. `input[type="date"]` has a large intrinsic minimum, so three date
  tiles forced every card wider than the screen. This is the one that actually mattered.
- Mobile query also: 2-column tiles, wrapping `.seg`, smaller chips, tighter padding.

**TESTING MOBILE — DO NOT TRUST `--window-size`.** Chrome enforces a **~485px minimum window
width**, so `--window-size=390` renders a 485px layout into a 390px image. That *looks* exactly like
horizontal overflow and sent me chasing a bug that did not exist.

Use CDP `Emulation.setDeviceMetricsOverride` instead — real viewport, no dependencies, since Node 22+
has a global `WebSocket`. Working scripts are in the session scratchpad
(`mobile-check.mjs`, `mobile-dropdown.mjs`): launch Chrome with
`--headless=new --remote-debugging-port=9222`, then set device metrics, navigate, and evaluate.

The reliable overflow test is **`document.documentElement.scrollWidth === clientWidth`**, ignoring
elements inside `overflow-x` containers (the map and the analog table legitimately exceed the
viewport inside their own scroll boxes). Verified clean at 390, 360 and 320 px.

### 2026-08-26 — gridMET moved to Earth Engine (10-20x faster)

**The problem.** Idaho's THREDDS server caps a request at 365 days (731 returns 414), so a 25-year
point series cost 3 vars x 27 years = **81 HTTP requests**. ~5 s from a laptop; **73-131 s from
Vercel**, and before the maxDuration bump it 504'd outright — on what was then the default source.

**The fix.** gridMET is in the Earth Engine catalog as `IDAHO_EPSCOR/GRIDMET` (1979-present, daily,
4 km, bands `tmmx` `tmmn` `pr` `eto` `etr`). `getRegion` returns a point series in one call because
the extraction happens beside the data. **Now 6-14 s.**

Three further wins:
- **Real units.** EE serves Kelvin and mm. The packed-integer trap is gone — the THREDDS feed
  returned raw UInt16 with per-variable scale/offset (tmmx +220 K, **tmmn +210 K**), and one offset
  applied to both produced a minimum above the maximum.
- **Reference ET is free.** The `eto` band rides along in the same request, deleting a separate
  ~27-request THREDDS fetch. `fetchReferenceEt` now shares the call.
- **Five parallel 5-year spans** beat one big call: 13.7 s single vs 10.6 s chunked. No cap forces
  this — purely speed. Ends are exclusive; verified zero duplicate dates at the seams.

**KNOWN DISCREPANCY — verified day by day against Idaho.** 9,731 of 9,732 days agree within
0.04 degC / 0.03 mm. The exception is **2026-01-01**, where EE reads ~11.8 degC low across northern
and central Texas (a cold dip between two warm days). The Lubbock airport gauge recorded 25.6 degC,
so **EE is the wrong one** — an ingestion artifact at the year boundary. One winter day in 9,732
(0.01%), outside the growing season, accepted to remove a timeout. Re-check if more appear.

**THE BUILD TRAP THIS EXPOSED — typecheck will NOT catch it.** `app/page.tsx` is a client component
and imported `DEFAULT_SOURCE_ID` from `registry.ts`. Registry imports every source; gridMET now
reaches `earthengine.ts`, which reaches `node:fs`. Webpack traced Node APIs into the browser bundle
and `next build` failed:

```
node:fs/promises -> lib/sources/earthengine.ts -> gridmet.ts -> registry.ts -> app/page.tsx
```

`tsc --noEmit` passed cleanly throughout. **Run `npm run build` after any change to what a client
component imports.** The constant now lives in `lib/sources/defaults.ts`, which must stay free of
server-only imports; `registry.ts` re-exports it for server code.

EE connection extracted to `lib/sources/earthengine.ts` and shared by OpenET and gridMET.

## Next up

Roughly in value order:

1. **gridMET or PRISM (4 km) as a source** — biggest accuracy win. NASA POWER's ~55 km cell cannot
   separate one field from the next, and Texas rain is convective and patchy. The adapter layer means
   this is one new file.
2. **Ensemble source** — mean across sources with spread as an uncertainty band. Nothing in the
   farmer-facing space does this; it is the strongest differentiator. Needs ≥3 live sources.
3. Planting-date / crop-stage overlays on the season tracker.
4. OpenET evapotranspiration integration.
5. Freeze/frost date drift — first/last frost by year with trend.
6. React Native / Expo app sharing `lib/` unchanged.
7. Ship: install git, push, import to Vercel.

### Open questions for the user
- Which crops/planting windows matter most for the Texas rollout? (drives #3)
- Is the farmer who gave the feedback available to test the analog panel? It is the most novel piece
  and the least validated against how a grower actually reasons.
