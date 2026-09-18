# CLAUDE.md — Texas Weather Explorer

> **Renamed 2026-08-28** from "Texas Climate Trends", then **2026-09-01** from
> the acronym "TWIRE" to the plain name. Only the DISPLAY NAME
> changed. The Vercel URL (`texas-climate-trends.vercel.app`), the GitHub repo
> slug, `GEE_PROJECT_ID` and the Supabase project name are all unchanged — they
> are identifiers other systems resolve, and renaming them breaks live links and
> credentials while gaining nothing. Do not "tidy" them.

Working context for this repo. **Read this first in a new session.** Update the
[Progress log](#progress-log) as work lands.

---

## The goal

A **farmer-usable** website (mobile app later) showing what consumer weather apps leave out:
**historical weather trends** for a specific point in Texas. 30 years of history (1996–present),
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
| Rows, 1996→now | ~11,197 across 31 years, **zero** values < −100 |
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

### 2026-08-27 — Cache layer, then our own gridMET archive on R2

**Why:** with ~10-15 people looking at different fields the site timed out. Measured raw,
one user, no concurrency: **a 25-year gridMET point query from Earth Engine took 18-82 s**,
wildly variable, 2-7x slower than the ~11 s recorded on 26 Aug. Not a 429/concurrency
problem — zero retries fired. EE is simply slow for this shape of query, and caching alone
cannot fix a *cold* cell.

**Parallelised `/api/history`.** It ran three upstream stages in sequence: fetchDaily
(~11 s) THEN the station lookup THEN the station's observations. The station chain needs
only the coordinates, so it now starts immediately and fetches a trailing window sized from
the source's declared `latencyDays`, trimmed once the gridded source answers. If a source
lags further than it declares, it says so rather than serving a short fill.
`findNearestStation` also walked five state networks sequentially with an early break —
cheap in central Texas, up to five round trips near a state line. Now all five at once,
which also returns the genuinely nearest station rather than the first acceptable one.

**Earth Engine retries were silent.** Every attempt now logs, and any call over 20 s logs
as slow. Without this the only symptom of a bad day at Google is "the site is slow
sometimes".

#### Supabase cache (`lib/cache/`)

Keyed by **year**, not by date range — because a completed past year never changes. 26 of
27 years store permanently; only the year in progress expires (3 h). A revisit whose current
year has gone stale re-fetches ONE year, not twenty-seven.

- **No dependency.** Supabase is PostgREST over HTTPS, so `fetch` is enough — which also
  allows a hard 2.5 s deadline on reads. A slow cache must never be slower than no cache.
- Nothing in `store.ts` throws. Missing config, network failure, timeout and corrupt row all
  produce a miss followed by a live fetch.
- An upstream failure is no longer automatically fatal: if the cache holds the years, an
  Earth Engine outage is invisible to the visitor.
- **`SUPABASE_URL` may be pasted with or without a trailing `/rest/v1/`** — the dashboard
  shows it both ways. The code strips it. Getting this wrong produced PGRST125 "Invalid path"
  on every call, silent by design, so the only symptom was a cache that never hit.
- Supabase renamed its keys in 2026: **`sb_secret_...` replaces `service_role`**. Both work.
  The `apikey` and `Authorization` headers must carry the SAME value — new-style keys are
  rejected in `Authorization` otherwise.
- Measured: **~11 kB per stored year on disk**, ~1,700 locations inside the free 500 MB.

**Float noise, found while measuring cache size.** Storage was 52 kB/year against a 5-10 kB
estimate, because values read `19.749993896484398` — 17 significant digits on data gridMET
stores at 0.1 degC. Kelvin subtraction and Fahrenheit conversion both manufacture digits.
`lib/sources/precision.ts` rounds to 2 dp, which is *exactly* gridMET's real precision (see
below). Also cut the browser payload ~24%.

**Dropping `origin` and `tmean` from stored rows saved 35% of the JSON — and nothing on
disk.** Postgres was already compressing away the repeated `"origin":"gridmet"` strings, so
removing them made the remainder compress worse (3.4x -> 2.3x). Kept for the client-side
parse saving, but **do not expect encoding tricks to beat Postgres at compression.**
The trap it nearly caused: **NASA POWER's `tmean` is T2M, an independent measurement, NOT
the midpoint of tmax/tmin.** It is dropped only where it demonstrably equals the midpoint,
and an explicitly-null `tmean` stays null rather than being invented.

#### The gridMET archive (`lib/archive/`, `scripts/ingest-gridmet.mts`)

Texas gridMET, 1995-present, four variables, transposed from "all of Texas on one day" into
"one field across thirty years", stored as **Zarr on Cloudflare R2**.

**Result: a cold lookup went from 18-82 s to 1.6-1.8 s**, verified at Waco, Lubbock,
Weslaco, Dalhart and East Texas. Earth Engine is off the critical path for the default
source entirely, so its 40-concurrent cap no longer applies to normal traffic.

- **1.39 GB, 20,820 objects, 24 minutes** to build. R2's free tier is 10 GB.
- **The website needs no credentials.** The bucket is public-read (gridMET is freely
  redistributable); only the ingest script holds a key, and it runs on a laptop.
- `lib/archive/read.ts` returns **null, never throws** — outside Texas, before 1995, or a
  missing chunk all fall back to Earth Engine. The archive can only make the site faster.
- **The manifest is written LAST.** Until it exists the reader treats the archive as absent,
  so a half-finished upload can never be served as complete.

**THREDDS NCSS facts (verified 2026-08-27, all contradict something):**
- **`accept=netcdf4` is BROKEN** on northwestknowledge.net — "NetCDF: HDF error". Only
  `accept=netcdf` (classic) works. `accept=csv` is refused for grid requests.
- **The 365-day cap does NOT apply to NCSS.** 31 years came back in one request, 148 MB in
  15 s. That limit is an OPeNDAP behaviour only.
- Grass reference ET is **`pet`** (`daily_mean_reference_evapotranspiration_grass`), not
  `eto` as Earth Engine names it. `etr` is the alfalfa reference.
- Variables are `short` with **scale/offset declared in the header**, so the per-variable
  offset trap (tmmx +220 K, tmmn +210 K) is read, never hardcoded.
- `day` is a FIXED dimension, not unlimited — so data is contiguous. An unlimited dimension
  would interleave by record and a contiguous read would scramble it silently.

**THE BAND ALIGNMENT TRAP — this one shipped and was caught only by an assertion.**
Downloads are 16-row latitude bands (16 divides both chunk widths, 4 and 16; a band
straddling a chunk boundary writes half-filled chunks that the next band overwrites, losing
rows). Requesting a band with **half a cell of padding lands exactly on the cell boundary**,
and NCSS selects every cell its box touches — so band 1 asked for 16 rows and got 18, while
band 0 escaped because the grid edge clamped it. Now: quarter-cell padding, AND the wanted
rows are located inside whatever comes back by matching latitude values. **Never assume the
server returns the shape you asked for.**

**Chunk shape is different per part, deliberately.** `archive` (1995-last year) uses 4x4
pixel blocks — written once a year, read constantly, so small downloads win. `current` (this
year) uses 16x16 — rewritten on every refresh, so the OBJECT COUNT is what matters. At a
uniform 4x4 a daily refresh costs ~624,000 uploads/month against a 1,000,000 free allowance;
at 16x16 it is ~41,000, leaving room for a second source.

**Compression varies enormously by variable** — rainfall 15% of source (mostly zeros),
temperature 38%, reference ET 19%. Any estimate from one variable will be wrong.

**Node 24 has zstd built in** (`zstdCompressSync`), which is why the reader needs no
dependency. `@types/node@20` does not know it — declared in `types/node-zstd.d.ts`. The
compression-level option key is **`zlib.constants.ZSTD_c_compressionLevel` = 100**, not a
small number.

**Verified, not assumed:** 1,464 values at Waco compared against Earth Engine day by day —
**1,463 exact**. The one exception, `tmmn` 2024-01-31, differs by 0.5 K, and querying
THREDDS directly showed **the archive matches its source and Earth Engine is the outlier** —
the same class as the 2026-01-01 discrepancy above. Annual rainfall 2019-2025 matches the
independently measured gridMET row in the table above to within 0.05 in every year.

**Sanity-value clarification:** the "~929 mm / 36.6 in" Waco normal in the table above is
**NASA POWER's**, not gridMET's. gridMET gives **970 mm / 38.2 in** at the same point, which
is consistent with the source-disagreement table showing gridMET ~15% wetter than POWER
there. Always state which source a sanity value belongs to.

### 2026-08-27 (later) — Record extended to 1996; the archive now refreshes itself

Two user decisions drove this: **start the record at 1996** (so 1996-2025 is exactly thirty
complete years) and **schedule the archive refresh**, with the annual rollover held back a month
rather than firing on 1 January.

#### 1996, not 2000

`HISTORY_START_YEAR` lives in `lib/sources/defaults.ts` — the client-safe file, alongside
`DEFAULT_SOURCE_ID`, for the same bundling reason. The page, `/api/history` and `/api/et` all read
it; nothing hardcodes a start year any more. The trend window gained a **30 yr** option and
defaults to it.

- **The R2 archive already held 1995**, so this cost nothing upstream — the four new years came
  straight from it. Measured at the default location: 11,197 rows, 31 years, 6.9 s cold with
  27 years already cached.
- **1995 is deliberately left in the archive.** One spare year is ~45 MB of a 10 GB allowance and
  means the window can move back a year without a 25-minute rebuild.
- It is **not** the WMO 1991-2020 normal period, and every user-facing surface now says so rather
  than implying an official normal.
- `historyYears(currentYear)` is a FUNCTION, not a constant. Computing it from `new Date()` at
  module scope evaluates separately on server and client, and around the new year those disagree —
  the same hydration trap the URL parameters hit on 2026-08-24.

#### The scheduled jobs (`.github/workflows/`)

| Job | Cron | Command | Cost |
|---|---|---|---|
| `gridmet-refresh` | daily 09:20 UTC | `--r2 --part current` | 1,371 uploads, **85 s measured** |
| `gridmet-rollover` | 2 Feb | `--r2` (both parts) | ~22,200 uploads, ~25 min |

**~41,700 uploads/month against Cloudflare's free 1,000,000 — 4%.** Storage does not grow; every
object is overwritten in place. Needs five GitHub secrets (the four `R2_*` plus
`NEXT_PUBLIC_R2_URL` for the rollover's verify step). Plain-language setup is in
`readme_for_user/SETUP-AUTOMATION.md`.

**The daily job re-downloads the WHOLE current part rather than appending a day.** gridMET revises
its recent days; an append-only refresh would keep the first, provisional version of every day
forever.

**The 60-day rule is scoped to PUBLIC repos** — GitHub's docs say scheduled workflows are disabled
after 60 days of inactivity "in a public repository", and this repo is private, so it should not
apply. Community reports are not unanimous; GitHub emails on disabling and re-enabling is one click.
Check it before suspecting the code if the data goes stale.

**A BOM in a secret cost a debugging cycle — the PowerShell trap again, in a new place.** Setting the
repo secrets by piping a value into `gh secret set` from PowerShell 5.1 prefixes it with U+FEFF,
because the pipe to a native command encodes with a BOM. The stored `R2_ACCOUNT_ID` then began with
an invisible character and the first CI run died with

```
TypeError: Cannot convert argument to a ByteString because the character at index 0
has a value of 65279
```

thrown from `fetch` — naming neither the credential nor the cause (the account id builds the `host`
header, hence "index 0"). **Use `gh secret set NAME --body $value`, never a pipe.** `r2ConfigFromEnv`
now strips a leading BOM and surrounding whitespace, so neither this nor a trailing space from a
sloppy paste can produce an opaque signature failure again. The check is written as a code-point
comparison, not a literal or an escape: a raw BOM in source is invisible in every editor.

The existing "NEVER EDIT SOURCE FILES THROUGH POWERSHELL" rule should be read as covering **piping to
native commands**, not just file reads and writes.

#### THE YEAR-BOUNDARY LANDMINE — found before it shipped, would have been silent

`--part current` rewrote the manifest with **both** parts' ranges recomputed from `thisYear`. Today
that is harmless. On the first run of 2027 it would have written *"archive covers 1995-2026"* into
the manifest while the archive chunks still held 1995-2025 — and `readArchivePoint` takes its
slicing offsets straight from the manifest's `nDays`. Every date in the record would have shifted,
returning a complete, plausible, entirely wrong series with no error anywhere.

**A partial run must never invent the ranges of the parts it did not write.** The ingest now reads
the existing manifest back (new `getObject` in `r2.ts`, a signed GET so it needs only the four
credentials it already has) and preserves them. Same rule applied to `vars`: a `--vars` run merges
rather than replaces, because the reader iterates that list and a dropped entry would silently
remove a variable from every lookup while its chunks sat there intact.

#### The rollover waits a month — `ARCHIVE_ROLLOVER_MONTH`

`settledThroughYear(today)` in `layout.ts` returns `year - 1` from February onward, `year - 2`
before it. So a year is only sealed into the never-rewritten archive once it has had a month of
Idaho's revisions. Sealing 31 December on 1 January would freeze the least settled month in the
record and lose every later correction to it, silently.

**The current part is therefore allowed to span more than one calendar year**, and does through
January (~13 months, chunks ~70% bigger for a few weeks). `current.start` is now derived as
`archive.end + 1 day`, so the two parts are contiguous **by construction** and a year can never fall
between them. Nothing downstream needed changing: every reader already works from the manifest's
actual `start`/`nDays` rather than assuming a part is one year long.

#### `building: true` — the flag that stops a mid-rebuild misread

Writing the manifest LAST protects a FIRST build; it does nothing for a REBUILD, where a valid
manifest is already live and describing chunks being overwritten underneath it — and where the
rollover changes each part's `nDays`, so offsets go *wrong* rather than merely stale. A rebuild now
raises `building` before touching a chunk and clears it by publishing the real manifest at the end.
`getManifest()` returns null while it is up, so the site falls back to Earth Engine for ~25 minutes
once a year. **Slow, never wrong.** Re-checked after 60 s rather than the usual 10 min so the fast
path returns promptly.

Two guards around it: a failed rebuild prints what to run (the flag stays up, and a permanently slow
site is otherwise invisible), and a **current-only refresh refuses to run while the flag is set** —
it ends by publishing a clean manifest, which would turn a half-rewritten archive back on.

#### Also

- **Skip-if-unchanged.** Idaho's feed stalls for days; the job compares the manifest against the
  dataset's latest date and exits 0 with zero uploads. Verified: it correctly skipped at
  `latest = 2026-08-26`. A green tick and a 20-second run is the job working, not skipping.
- **`scripts/verify-current.mts`** (new) checks the part the daily job actually writes.
  `verify-archive.mts` compares 2024, which lives in the archive part and the refresh never
  touches — so it could not have caught a regression in the refresh at all.

  **Run after the forced refresh: 944 values at Waco, 934 identical.** Ten differ by more than one
  packing step, of which **one is material** — 2026-01-01 `tmmx`, the already-documented Earth
  Engine year-boundary artifact where the archive matches Idaho and EE is the outlier. The other
  nine are 0.2-0.6 mm precipitation revisions, which is Idaho revising provisional days that Earth
  Engine's copy has not picked up. **The archive is the fresher of the two, by design.**

  **Two tolerance traps this exposed, worth remembering for any future comparison:**
  1. **Half a packing step is the WRONG tolerance.** Both sides store at 0.1 and pack
     independently, so a 0.1 difference is a rounding tie in the last digit. At 0.051 it flagged
     30 ties out of 944 and buried the four differences that meant something. One full step.
  2. **A check that compares nothing must not pass.** The first version looked up bands directly
     on the row when `getRegionSeries` nests them under `.values`, so every lookup returned
     undefined, every variable reported "0 days compared", and it exited 0 — a green tick proving
     nothing. It now exits 2 on a zero comparison count. **A sample size is part of a result, not
     a detail.**
- **`--bands N` no longer publishes a manifest to R2** — a band-limited trial would have advertised
  a store full of holes as complete.
- **`tsconfig.json` was not typechecking any `.mts` file** — `"**/*.ts"` does not match `.mts`, so
  every script in `scripts/`, including the ingest that writes the archive, was outside
  `npm run typecheck`. Added `"**/*.mts"` plus `allowImportingTsExtensions` (safe only because
  `noEmit` is set; the scripts import each other with explicit `.ts` extensions because Node's type
  stripping runs them with no bundler to resolve extensionless paths).

### 2026-08-27 — Going public: history audited, one landmine fixed

The user intends to **make the repo public once it is finalised**. Two things change, and the
history was audited before either.

**SECRET AUDIT — history is clean.** All 15 commits scanned, both by path and by content:
- `.env.local` and `earthengine-key.json` have **never** been committed. 107 distinct paths have
  existed in history; the only sensitive-sounding one is `install-key.ps1`, which contains no key
  material — it reads and copies a file.
- No PEM private-key header, no service-account key id field, no `eyJhbGciOi` JWT prefix anywhere.
  (Those first two patterns are deliberately NOT spelled out literally here: `.githooks/pre-commit`
  greps the staged diff for them, so writing them out blocks the commit that documents the audit.
  That is the hook working — do not weaken it to allow prose about keys, because that is precisely
  the gap a real key would later slip through. Describe the pattern, never reproduce it.)
- Three values from `.env.local` DO appear in history and all three are **non-secret**:
  `R2_BUCKET` = `texas-climate-data` (a bucket name, documented on purpose), `GEE_PROJECT_ID` =
  `texas-climate-trends` (identical to the repo name, hence hits in `package.json` and
  `package-lock.json`), and `GEE_KEY_FILE` = `./earthengine-key.json` (a path, in the setup docs by
  design). The `sb_secret_` / `service_role` hits are documentation showing the prefix with `...`
  placeholders.

**The audit's one real limit:** it compares against the values CURRENTLY in `.env.local`. A
credential that was rotated at some point could have an OLD value sitting in history that this
would not catch. Nothing suggests that happened, but re-run the scan if any key is ever rotated
before publishing.

**THE 60-DAY RULE WILL THEN APPLY.** It is scoped to public repositories, so going public turns a
non-issue into a real one — and precisely when it bites: a *finalised* project stops receiving
commits, which is exactly the condition that disables the schedule. Any push resets the 60-day
clock. A keepalive is not yet built; note that a commit authored by `GITHUB_TOKEN` is widely
reported NOT to count as repository activity, so a keepalive needs a PAT-authored commit or an
equivalent.

**Going public is a benefit for Actions minutes:** public repositories get GitHub-hosted runners
free and unmetered, so the ~75 min/month the refresh costs stops counting against anything.

**No `LICENSE` file.** A public repo without one is "all rights reserved" — nobody may legally
reuse or cite it. Decide before publishing, not after.

**`install-key.ps1` OVERWROTE `.env.local` — fixed.** It rebuilt the file from scratch with only
the two `GEE_*` lines. That was harmless when Earth Engine was the only thing needing settings;
it is not now that the same file holds the R2 and Supabase entries. Re-running it would have
silently deleted them, and the failure is quiet in the worst way — the site keeps working, just
slowly and with no cache, and nothing says why. It now merges: existing keys are updated in place,
missing ones appended, everything else left alone. Verified against a stand-in file (4 unrelated
settings preserved, comment kept). **A setup script must never destroy other setup.**

### 2026-08-27 — Crop yield in the analog table (USDA NASS)

User request: a final column in "Which year is this one tracking like?" showing county crop yield,
so a grower can see what the harvest actually did in the years whose weather matched. Column heading
is the **crop dropdown itself** (user's specification), practice toggle beside the other controls.

**Hosted, not called live.** The user asked whether we could host it "like gridMET" because NASS is
sometimes down. Yes — and it is ~1,500x smaller: **two JSON files, 601 KB total, 2 uploads a
quarter**, against gridMET's 1.39 GB / 20,820 objects / ~41,700 uploads a month. This is NOT the
archive pattern; do not reach for chunking. **The site never calls NASS**, so Quick Stats outages
cannot reach a page load, and a failed refresh leaves the previous files serving.

`NASS_API` (free key, quickstats.nass.usda.gov/api) is the second service needing a secret after
Earth Engine. It is used ONLY by the ingest — never the website, never the browser.

#### THE THING THAT WOULD HAVE MADE THIS COLUMN A LIE

Raw yield over thirty years is dominated by genetics and agronomy, not weather. Measured statewide
from the real record: **cotton +1.57%/yr (r² 0.51), rice +1.25% (r² 0.74), wheat +1.00%, corn
+0.60%**. Drop raw bushels into the table and 1998 reads as a catastrophe beside 2023 — when it may
have been a good season *for its time*. Every cell therefore carries **both** the actual yield and
that yield as a **% of the fitted trend for its year**. At Bell County: 1998 corn 29.5 bu/ac = 47%
of trend, 2011 33.0 = 42%, 2019 105.8 = 119%. The percentage is what answers the question the panel
asks.

**Presented as a SIGNED deviation** (`-7%`, `+35%`), not a percent-of (`93%`) — user call,
2026-08-28, and a good one: "93%" makes the reader subtract from a hundred before it means anything.
The baseline is unchanged, still the fitted trend for that year. **Hidden until hover or tap**, so
the column reads as plain yields; it is a `<button>` rather than a `title` because a phone has no
hover, and `@media (hover: none)` adds a dotted underline so the affordance is discoverable on
touch. Revealed with `opacity`, not `display`, so nothing shifts.

#### YIELD IGNORED THE UNIT TOGGLE — and one multiplier would not have fixed it

Reported by the user: every other variable responded to °F/°C, yield did not. It cannot share
`lib/agro/units.ts` because NASS reports three different US units here and **a bushel is a unit of
VOLUME**, so converting it to mass needs each crop's own legal test weight:

| NASS unit | Crops | To t/ha |
|---|---|---|
| `LB / ACRE` | cotton, peanuts, rice, sunflower | x 0.00112085 |
| `TONS / ACRE` | sugarcane (US **short** tons, 2000 lb) | x 2.2417 |
| `BU / ACRE` | corn, sorghum **56 lb**; wheat, soybeans **60 lb**; oats **32 lb** | test weight x 0.00112085 |

**Using one bushel factor for all of them would overstate an oat crop by 88%.** `lib/yield/units.ts`
returns **null** for a bushel crop with no known test weight and the UI falls back to US units,
rather than inventing a plausible wrong number. Verified against published equivalences: 150 bu/ac
corn = 9.415 t/ha, 50 bu/ac soybeans = 3.363, 30 short tons/ac sugarcane = 67.25, and the
oats:wheat factor ratio is exactly 60/32.

**t/ha not Mg/ha** — identical values, but t/ha is what extension services and FAO print. Cotton
lands near 0.6 t/ha (it is lint, not seed cotton); two decimals keep it readable rather than
switching that one crop to kg/ha and putting two metric units in one column.

Same trap in the **"Typical year" row**: averaging the analog years' raw yields spans three decades
of changing genetics and would reintroduce exactly that bias. It shows the **trend value at the
current year** instead — what a normal year yields *now*.

#### NASS PUBLISHES OVERLAPPING SERIES — MERGING THEM DOUBLE-COUNTS

Measured against all 32,819 Texas county-year records, not inferred from docs. `lib/yield/crops.ts`
is the single definition:

| Trap | What the data showed |
|---|---|
| WHEAT | `ALL CLASSES` (1996-2007) and `WINTER` (1996-2025) — **all 1,927** ALL CLASSES county-years also appear as WINTER. WINTER is a strict superset. |
| CORN | grain BU/ACRE and silage TONS/ACRE share county-years. Different harvests, different units. Grain only; silage has 14 county-years statewide. |
| COTTON | UPLAND 2,988 county-years; PIMA 61, of which **56 duplicate** an UPLAND one. |
| SUNFLOWER | three variants (all/oil/non-oil) with heavy mutual overlap. Deterministic rank order, never summed. |
| **practice** | `NON-IRRIGATED, CONTINUOUS CROP` and `...FOLLOWING SUMMER FALLOW` — **470 rows, every single one duplicating a plain NON-IRRIGATED county-year.** Exact-match the three practices; drop the rest. |

Also: NASS **omits** suppressed rows rather than flagging them — 0 of 32,819 values were non-numeric.
So absent means absent. County codes >= 998 are "combined counties" aggregates, not places, and must
never be matched to a point.

#### The statewide-rate fallback

Only 54% of all-practice series and **31% of dryland** series clear 12 years — so a strict own-trend
rule left the irrigated/dryland toggle the user asked for showing mostly blanks. Fixed by a real
distinction: **the rate of improvement is statewide** (genetics, agronomy) while **the level is
local** (soil, rainfall). Fit the rate once across Texas, anchor it to each county's own average.
Coverage went **43% -> 65%** (all 73%, dry 59%, irr 53%). Borrowed trends carry `borrowed: true` and
the UI marks them with a dotted underline plus an explanation on hover — it is an assumption, not a
measurement.

#### County lookup: simplified polygons, not a raster

Census TIGERweb GeoJSON, no key. 23.6 MB of full-resolution geometry -> **243 KB at 0.003° (2.0% of
vertices)**. Verified **12/12 against the FCC block service** at points across Texas, and correctly
returns **null** outside the state — a field in New Mexico is not "nearly Hudspeth".

Rejected the obvious alternative of precomputing a county per gridMET cell (83 KB, array index):
**a 4 km cell straddling a county line puts a real field in the wrong county and the error is
invisible** — the farmer gets a confident yield from next door. Polygons are the same size and
decouple this from the weather grid.

#### Honesty rules carried over

- The note under the table states plainly that yield is a **county average** against weather matched
  at the grid cell containing the pin — a much coarser thing than the columns beside it.
- The in-progress year reads **"not yet"**, not "—". NASS publishes a county yield the spring after
  harvest; a pending harvest is not a gap in the record.
- Crops a county never reports are absent from the dropdown; a practice toggle is only offered when
  that crop publishes the split (6 of 10 do).

#### 2026-08-28 follow-ups — sparse counties, and NASS's zeros

**User report: "south west of Austin showed only wheat, and only one of the top 5 years."** Checked
our store against NASS row by row for those counties: **not a bug.** The Hill Country is ranch land.

| County | What NASS actually holds |
|---|---|
| Bandera | wheat **1 year**, oats 8 |
| Blanco | wheat 2, oats 6 |
| Kendall | wheat 4, oats 12 |
| Williamson (contrast) | corn 30, cotton 29, wheat 27 |

Statewide, **16 counties have one crop, 31 have none**. Two real UX faults behind the confusion,
both fixed:

1. **The dropdown opened on the first crop in STATEWIDE importance order**, not the best-reported
   one here — so Bandera opened on wheat's single year while oats' eight sat unseen in the
   dropdown. It now opens on whichever crop has the longest record in that county. The dropdown
   ORDER stays statewide-importance (predictable); only the default changed.
2. **An empty column said nothing.** Now: *"Only 0 of the 5 matched years have a reported oats
   yield here — NASS published one for 8 of the last 30 years in Bandera County."* Same rule as the
   trend chart's dropped years and the sparse-station tiles — **coverage-based emptiness must be
   disclosed, never silent.** That is the fourth time this class has come up.

**NASS PUBLISHES LITERAL ZERO YIELDS — 133 of 23,544 values (0.57%),** clustered in drought years
(2000, 2006). Verified against the source; not a parsing fault. A zero is a crop that failed or was
never taken to harvest.

- **Kept in the series and shown as "none"**, not "0.0". A bare 0 beside "-100%" reads as a broken
  cell rather than the outcome it is, and the percentage adds nothing — a zero is -100% every time
  regardless of what normal was.
- **Excluded from the trend fit**, including the statewide rate and the anchor mean. A total failure
  is the *absence* of a yield, not a low one. Left in, three zeros dragged Blanco County's oat
  normal to 31 bu/ac when the years that actually produced ran 21-60 — an understated baseline that
  then flatters every other year's comparison. Blanco oats now correctly reports **no trend at all**:
  strip the zeros and only three harvested years remain, below `MIN_ANCHOR_YEARS`. Refusing is
  better than a fabricated baseline. Cost across the store: 891 own trends (was 895), 444 borrowed
  (was 446).

**"Typical year" renamed "30-year Normal"** (user). Rendered from `candidateYears.length`, not a
hardcoded 30, so a sparse source cannot be labelled with a sample size it does not have — the same
rule as the trend chart's N-year average.

Quarterly refresh in `.github/workflows/nass-refresh.yml`, verified end to end by
`scripts/verify-nass.mts`, which **fails the run** if the default location has no crops, if fewer
than 150 counties are present, or if a boundary check disagrees. The FCC cross-check is *skipped*
rather than failed when unreachable — someone else's outage must not mark our data bad.

### 2026-08-28 — CSV and figure downloads on both charts

`lib/export/` + `components/ChartExport.tsx`. Both charts get **CSV** and **Figure** buttons.

**Exports are defined as "what is on screen"** — same variable, units, view mode, chosen years,
trend window. Built at click time from the same `rows`/`data` the chart renders, never a cached
snapshot. A download that silently gave metric while the screen said inches would be wrong in a
spreadsheet, far from anything that could correct it.

**Provenance travels with every file** (`lib/export/context.ts`). Source name, the requested point,
and **the grid cell actually read after snapping** — a gridMET export is a 4 km cell and NASA POWER
is 55 km, so a file labelled with the clicked coordinates would imply precision that was never
there. This is the project's whole thesis; an anonymous export would undercut it. CSV carries it as
`#` comment lines (R's `comment.char`, pandas' `comment=`, and Excel just shows them as rows); the
figure prints it under the plot. The trend figure also carries the weak-fit warning, so the caveat
cannot be separated from the picture.

#### THE PNG TRAP — why `lib/export/figure.ts` is long

Serialising a Recharts SVG and rasterising it looks like three lines and produces a **blank or black
rectangle**. Two silent reasons:

1. **Every colour here is a CSS custom property** (`var(--series-1)`, `var(--gridline)`). Those are
   resolved by the DOCUMENT's stylesheet. A serialised SVG handed to an `<img>` is a separate
   document with no stylesheet, so every `var()` resolves to nothing — as does Recharts' own
   class-based styling.
2. Fonts and stroke widths are inherited CSS and vanish the same way.

Fix: clone the SVG, walk it node-for-node against the live element, and write the **computed** value
of every presentational property inline (`INLINED_PROPERTIES`). Anything missing from that list is
lost on export.

Related: **the on-screen legend is HTML outside the SVG**, so it does not serialise either. It is
redrawn onto the canvas — without it the exported season chart shows two unexplained grey bands, and
those bands are the context that makes a single year mean anything. Legend colours are passed as CSS
var NAMES and resolved against the live container, because **canvas has no idea what `var(--x)`
means and, unlike SVG, fails silently rather than visibly.**

Other decisions: PNG at 3x rather than SVG (SVG lands badly in Word and PowerPoint); an explicit
background painted first, since an SVG is transparent and a dark-mode chart on transparency is
unreadable in a white document; CSV written with a **UTF-8 BOM** or Excel on Windows turns degree
signs into mojibake; the object URL revoked on the next frame, because Safari cancels the download
if it is freed in the same tick as the click.

**Verified in a real browser, not assumed** — the CSS-var trap is invisible to `tsc`. Both charts
exported, pixels inspected (274 distinct colours sampled, i.e. not a blank rectangle), and both
images read back and eyeballed.

### 2026-08-28 (later) — Export fixes, one band, and GDD from planting

#### THE FIGURE EXPORT WAS SOFT — a real bug, not a low setting

An `<img>` rasterises an SVG **once, at the size the SVG itself declares**. The export declared the
on-screen size (~700x420) and then drew that into a 3x canvas, so the browser rasterised small and
**bitmap-scaled it up** — producing exactly the softness of a screenshot. Nothing errored.

Fix: the clone declares `width`/`height` at the FULL OUTPUT SIZE (`w * scale`) while keeping
`viewBox` at the original coordinates, so the vector rasterises at full resolution. Default scale
3x -> 4x. Verified by cropping the PNG at 1:1 — glyph edges are cleanly antialiased rather than
enlarged pixels. **If an exported figure ever looks soft again, check the declared SVG size first.**

CSV dropped the percentile columns at the user's request: long-term average plus the plotted years.

#### ONE BAND — the middle half (p25-p75)

User: the 50%/80% pair was confusing. **There is no single industry convention** — Cornell's Climate
Smart Farming GDD tool shades the full record range, NOAA defines "near normal" as the middle
*third* (the tercile the CPC outlooks use), and box plots use the middle half. User chose the middle
half. p10/p90 are still computed by `dailyClimatology`/`accumClimatology` and simply are not drawn.

Worth knowing for any future revisit: the middle half means **half of all normal years fall outside
the band by construction**, so "outside the band" is not by itself unusual. The subtitle states the
quartiles explicitly for that reason.

#### GDD NOW STARTS AT PLANTING, NOT 1 JANUARY

A user asked what crop the degree days were for, and separately said Beeville's 5,571 "seems high".
Checked: **the arithmetic was right** (5,706 degF-days today, and the 30 degC cap is applied — max
daily contribution 18.4 of a theoretical 20.0). But a corn crop needs roughly **2,400-2,800**
degF-days planting to black layer, so the tile was showing about **two crops' worth of heat**.
Counting heat units from New Year is arithmetically fine and agronomically meaningless.

`plantingStart()` in `lib/agro/gdd.ts`: corn/sorghum 1 Mar, cotton 1 Apr, wheat 1 Oct. Beeville corn
now reads 4,813 from 1 March. The default follows the crop until the grower edits the date, then
stays put — their planting date is a fact about their field, not something a crop change should
overwrite. The tile says the date is an assumption until they set it.

**WINTER WHEAT DOES NOT FIT and the code says so.** It is planted in autumn and harvested the
following summer, so its window crosses the year boundary — which `makeStat` cannot represent, since
it accumulates within one calendar year off a day-of-year index. October is its true planting month;
for most of the year that lies in the future, and `plantingStart` falls back to 1 January rather
than showing an empty tile. **That fallback is a limitation, not a recommendation** — fixing it
properly needs cross-year accumulation.

#### The crop is now named wherever GDD appears

Chart badge, variable label, season tile, trend chart. The crop selector also moved into the season
chart's own control row whenever GDD is the selected variable. `GDD_PRESETS` gained `short` and
`planting`. **Growing degree days without a stated base temperature are an unanswerable number** —
the user had to start writing a question before finding the setting.

#### Search no longer offers "Address"

A user typed a rural street address, got nothing, and was told to use a city. Rural addresses often
are not in OpenStreetMap, so the label promised what the geocoder cannot deliver outside towns. Now
"Town or city", placeholder "Town and state — e.g. Beeville, TX", and the empty result explains it
and points at clicking the map. **The capability still works where the address exists — the PROMISE
was the bug.**

Also reworded the season subtitle, which was ungrammatical ("the dashed line *is* each calendar
day"). The stale `2000–2025` the user saw was the pre-1996 deployment; that string is built from
`availableYears[0]` and was already correct.

**NOTE:** `components/ClimateChart.tsx` was edited once through PowerShell during this work
(`[IO.File]::ReadAllText` + `WriteAllText` with `UTF8Encoding($false)`). It survived — 0 mojibake
sequences, no BOM, em-dashes intact — but this violates the standing rule. Use Edit/Write.

### 2026-08-28 — Analog table rebuilt, forecast gets symbols, sources trimmed

All from one user review. **Not deployed** — still in the aesthetics pass.

#### "Were there any similar years in past?" (was "Which year is this one tracking like?")

Six changes, four of which were removing something:

- **UNITS MOVED TO THE HEADING ROW.** Every cell repeated `in` / `°F`, which
  trebled each column's width for information that never changes down it and
  pushed the numbers so far apart they were hard to compare by eye — the only
  thing the table is for. `.th-unit` renders it quieter and lower-case so it
  reads as a unit, not part of the name. Two headings deliberately carry none:
  "Dry days" is already a count of days, and "GDD (GDD °F)" is nonsense.
- **One decimal place at most; none for GDD or day counts.** Two decimals of
  rainfall implies a hundredth-of-an-inch agreement between sources that
  measurably differ by six inches a year. Metric yield went 2 dp → 1 dp with
  **one exception: cotton.** It is reported as LINT, so a county's whole range
  sits between about 0.45 and 1.35 t/ha and one decimal collapses it onto ten
  values. Every other crop spans tens of units where a second decimal is noise.
- **The Match column is gone; the year swatches carry the ranking instead**, as
  one green ramp running dark (closest) to light. Five unrelated hues said
  "five different series" — true only while plotting, and they carried no
  ranking at all, so the numeric column had to spell out what the colours were
  contradicting. The score survives on the swatch's tooltip. The ramp is fixed
  hex, not theme tokens: these are small solid blocks read against each other,
  and a `color-mix` toward `--surface` would run dark-to-light in one theme and
  dark-to-dark in the other.
- **The 2026 row was being read as a heading.** Both causes fixed: it had a rule
  below and none above, so it looked attached to the header block; and its tint
  competed with the banded header. Now fenced on both sides with the same
  neutral rule, tint halved.
- **Plot draws EVERY matched year and opens the chart BELOW the table.** The
  four-year cap was a palette limit dressed up as a feature — the chart had four
  compare colours so the button silently dropped the fifth match, which is
  exactly backwards here: the five matches ARE the spread and the spread is the
  finding. **`--series-6` (violet) was added** and `MAX_COMPARE` raised to 5.
  Slots 1–5 remain the validated data-viz instance; slot 6 was contrast-checked
  by hand (4.6:1 light, 5.4:1 dark) and has NOT been through the validator.
  Violet is also the slot most confusable with the blue current-year line for a
  colour-blind reader — the direct end-labels and table view are the relief, and
  are now load-bearing for a second reason.
- **The chart opens under the table rather than replacing it, starts closed on
  every visit, and the same button removes it** ("Remove plot"). Replacing the
  table would answer the question and delete the evidence in one gesture — the
  point is to see 2011's line while reading 2011's row. State lives in
  `AnalogPanel`, so leaving the panel and returning resets it for free. The
  chart element is built once in `page.tsx` and handed down as `chartSlot`, so
  the two placements cannot drift apart. An effect keeps the plotted years in
  step when the look-back window re-ranks them — otherwise the chart would draw
  the previous set beside a table showing a new one.

#### Forecast

- Panel renamed **"Forecast for next month"**; each tier is now **one row**
  (`.fc-strip`, `--fc-n` set from the number of days the provider actually
  returned, because NWS sends six daytime periods rather than seven late in the
  day). Scrolls sideways rather than wrapping: a tier is a SEQUENCE, and
  wrapping puts Thursday under Monday where it reads as a second week.
- **Weather symbols, two per day** (`components/WeatherIcon.tsx`): sky beside
  the temperature, water beside the chance of rain. Not one combined glyph — a
  sunny day carrying a 40% afternoon storm is the commonest Texas summer day
  there is and needs both. Vocabulary is the NWS's own, which is also what
  Google and Apple print.
- **Drawn, not fetched.** NWS ships an `icon` URL, but they are fixed-colour
  PNGs that look wrong on a dark ground, a third-party request per tile, and
  Open-Meteo ships none at all — so half the panel would have pictures. Added
  `weather_code` (WMO 4677) to the Open-Meteo forecast request so days 8–16 get
  the same symbols. Mapping from NWS is by PHRASE and **order matters**:
  "Chance Showers And Thunderstorms" contains both words and the thunderstorm is
  the one that changes a spray decision, so thunder is tested first.
- Two icon bugs found only by looking at the rendered pixels: the thunderstorm
  bolt was tucked in the 5px below the cloud and was invisible at 22px (now
  overlaps the cloud, filled not stroked), and the high/low pair collided with
  the rain figure (unit moved to the end, "99/78 °F").
- **Mobile tiles are WIDER, not narrower** — the opposite of the instinct, and
  the first attempt got it wrong. The row scrolls on a phone regardless, so
  squeezing buys nothing and costs legibility.

#### Sources hidden, not removed

`HIDDEN_FROM_PICKER` in `registry.ts` filters `listSources()` **and only that**,
so `getSource("daymet")` still works and `?source=daymet` still resolves — an
existing shared link keeps working and re-listing is a one-line change. Verified
live: the picker offers gridMET and NASA POWER; `?source=daymet` still returns
931 rows. Withheld because neither serves a grower well right now — Daymet lags
~8 months so it cannot show the season anyone is standing in, and airport
stations drop days routinely (Pecos: 23 of 237 days in 2026), so their headline
figure usually needs a warning. **Station data itself is untouched**; the nearest
ASOS still fills the trailing days behind every gridded source, via
`findNearestStation`, not this registry.

#### One date convention — `lib/format/date.ts`

**August 27, 2026** everywhere a person reads a date. `2026-08-27` is a storage
format that reached the screen in four places because it was what the API
returned, and `8/27` is ambiguous outside the US with nothing on the page saying
which convention is in force. Parsed at UTC noon throughout: `new Date("2026-08-27")`
is midnight UTC, which in Texas is the evening of the 26th, so a naive local
format silently prints the day before.

**ISO stays where a machine reads it** — CSV exports, URL parameters, filenames,
and the `<input type="date">` controls (whose display belongs to the browser and
the reader's own locale). The one deliberate shortening is forecast tiles:
"Mon, Sep 1", because "September 1, 2026" does not fit in one of seven tiles and
the year is never in question two weeks out.

Also: the **"Hottest" tile in Last 7 days had no unit** — a bare `95°` with no
way to tell °F from °C.

#### Cover photographs

Season cover is now **the curve, the water, the crop** (drawn chart +
irrigation drops over Batesville cotton + corn tassels). Similar-years is a 2×2
of **rain, sun, drought, harvest** — four seasons one field can have, which is
what the table ranks past years between; a single photograph could only show
one. Five of seven images are now Texas, three from the same farm as the hero.

**Two images that had already SHIPPED were replaced on inspection**: the
"standing crop" was a top-down aerial that reads as brown corduroy at thumbnail
size, and the drought photograph was young corn on dry ground that read as a
healthy young crop beside the burnt Texas corn now in its place. Commons
keyword search is poor for this — categories and bulk-upload filename prefixes
found everything the free-text queries missed.

**New trap for the credits file:** Commons renders a PNG source as a PNG
thumbnail regardless of the extension requested, so a photograph arrived as a
231 KB PNG named `.jpg`. Check the magic bytes; re-encoded to 33 KB.

Verified: typecheck clean, `npm run build` clean, plot interaction driven
through CDP (6 lines drawn, swatches switch, table survives, state resets on
leaving the panel), and no horizontal overflow at 390/360/320 px across all
four panels.

### 2026-08-28 (later) — Sticky masthead, average line, and the toggle that had to go

Second user review of the same day. **Not deployed.**

#### The masthead is fixed to the top now

It was on the photograph, which looked better and scrolled away — and the source
picker is the one control that has to be reachable from anywhere, because it
changes every number below it. A source you cannot see or change while looking
at a chart is exactly the hidden default this project exists to argue against.

- **`position: sticky`, not `fixed`, and self-sizing.** A fixed bar needs a body
  offset that exactly matches its height, and that height changes at the mobile
  breakpoint where the source picker takes its own row. Sticky stays in flow, so
  it measures itself and nothing can end up underneath it. `z-index: 1200`
  clears Leaflet's control layer as before.
- **Deliberately dark in both themes.** It is chrome, sitting directly above a
  photograph, so a light bar in light mode would cut a bright stripe between the
  page and the picture. It also keeps the masthead's literal light colours
  correct — they were written for a dark scrim.
- **The hero scrim is now much lighter and the photo shorter** (`clamp(150px,
  17vw, 240px)`): the heavy top-down gradient existed to carry white text that
  has moved out.
- **Mobile: 162px → ~92px.** Left alone it stacked into three rows and took a
  fifth of an 844px screen permanently. The tagline is hidden, the units control
  keeps its natural width instead of obeying the global `.seg { width: 100% }`
  phone rule, and `.topbar-source` gets `order: 2` so the two short items share
  the first row. The source picker keeps its own full-width row — that is what
  stops its menu hanging off the edge (see the 2026-08-25 note).
- **The photo credit line is gone.** USDA public domain requires no attribution;
  the provenance lives in `public/img/CREDITS.md`. A caption on a decorative
  photograph is furniture, not information.
- The source badge is also gone from **Season so far** — the picker is on screen
  at all times now, so repeating it was clutter.
- **"Find your field by" removed** from the location card. The card is headed
  "Your location" and the buttons say "Town or city" and "Coordinates"; a third
  line saying it again cost a whole row. The row is `align-items: flex-end` so
  it still sits level with the crop select, which does keep its label.

#### The average line was invisible

User: *"the dotted line is a trend but looks like mean."* It was drawn — as a
1px hairline in `--baseline`, the faintest colour on the page — so the only
visible horizontal line was the dashed trend, and reading it as the average was
the reasonable conclusion.

- Now `--normal-line` at 2px, and **declared AFTER the `<Line>`**. Declaration
  order is paint order in Recharts, and where the trend is nearly flat — the
  common case for rainfall, and itself the finding — the two coincide and
  whichever is painted second survives. The average is what every bar is
  measured against, so it is the one that must stay continuous.
- Both lines are named in the legend with **line marks, not swatches** — the
  distinction is solid-versus-dashed and a square cannot carry it. Solid means
  measured, dashed means fitted, same as the season chart. The figure export
  legend gained the average for the same reason.
- Verified on `?trend=tmax`, where the two separate visibly.

#### Comparison figures: brackets, and green up / red down

`(+2.0)` / `(−7.2)` beside each analog value, green where that year ran higher,
red where lower. Brackets because the delta is an annotation on the number to
its left, not a second measurement beside it.

**GREEN AND RED MEAN HIGHER AND LOWER HERE, NOT GOOD AND BAD** — and that is a
deliberate trade, stated under the table because it has to be. More rain than
this year reads correctly as green; a higher August average high reads as green
too, and nobody wants a hotter August. The alternative was per-column semantics
(green for wetter, green for cooler), which is truer cell by cell and much worse
to read: the reader would have to know which convention each column was on
before a colour meant anything. As a pure direction indicator the whole table
scans in one pass.

New `--up` / `--down` tokens rather than reusing `--div-warm`/`--div-cool`:
those encode HOT across the app, and red meaning "hotter" in one place and
"less" in another is exactly the collision to avoid. Set for text contrast
(5.8:1 and 4.7:1 light, 7.5:1 and 5.7:1 dark) — `--good` was not reused because
it is tuned as a fill for the confidence bar and is too light as small type.

#### The irrigated / dryland toggle is gone

User: *"I looked at irrigated, it was blank, dryland, blank again but all had
values populated, so what is it, it must be either irrigated or dryland."*

The toggle was not broken — it was offering options that county does not
publish. NASS reports the practice split for only some crops in some counties,
so in most places "All production practices" is the only series that exists and
the other two buttons were an invitation to empty columns. **A control whose
options are usually empty is worse than no control: it makes a complete answer
look like a broken feature.**

`bestPractice()` now picks the series with the most reported years, and the
choice is named — in the dropdown option and in the note — **only when it is not
the plain county-wide figure**. Writing "· all" on nine options in ten would be
noise; naming the exception is what carries meaning.

**Measured across the whole store rather than assumed:** of 1,035 crop series in
223 Texas counties, **1,032 have an all-practices record at least as complete as
either split** — which is structural, since a county that publishes a split
publishes the combined figure too and the split is a subset. The three
exceptions are real and are exactly why this is a function and not a hardcoded
`"all"`: **Somervell County wheat has ONLY a dryland series** (one year, no
all-acres figure at all) and **Washington County wheat has 4 all-acres years
against 5 dryland**. Hardcoding would blank one and understate the other.

Worth recording why this cannot be solved by asking the grower whether their
field is irrigated: the constraint is what USDA published for their county, not
what they do on their own acres.

### 2026-08-28 (later still) — Two covers rebuilt from user references

User supplied reference images: a split field (cracked earth beside standing
wheat) and a calendar illustration. **Not deployed.**

**Season tracker — one field, two outcomes, water falling between them.** Corn
standing on the left, the SAME crop burnt on the right, split down the middle
with a droplet-and-down-arrow mark on the seam. Two frames rather than one
because no real photograph shows a field in both states at once; the seam is the
honest join and doubles as the reading order. Using the same crop on both sides
is the point — two different crops would have read as two different fields.
A hairline divider rather than a gap: at 92px a gap reads as two pictures, a
line reads as one picture with a boundary.

**Similar years — a shelf of past seasons, one pulled out.** Drawn, and ONE
figure rather than four photographs. The subject of that panel is not a field,
it is the *comparison*: four weathers in a grid said the panel was about what
the weather did, when it is about which past year it did it in, and nothing
photographic can state "we looked through thirty years and this one matches".
Six calendar-style cards each carrying its own season curve — because the
trajectory is what the matching actually scores on, not the totals — with one
lifted and accented.

`YEAR_CURVES` is hand-set, not random: `Math.random()` in a render is a
hydration mismatch, and this is decoration rather than data.

**Four photographs deleted** (`crop-water`, `wx-rain`, `wx-sun`, `wx-harvest`) —
nothing references them now. Their exact Commons filenames are recorded in
`public/img/CREDITS.md` under "Removed, and how to get them back", so any can be
restored precisely rather than re-searched. Image payload is now **466 KB across
three files**, down from 731 KB across six.

### 2026-08-28 — Rainfall validated against the state's own map

User reported complaints that numbers looked off and supplied the **TexMesoNet
"Year to Date Precipitation" map** (NOAA/NWS Office of Dissemination gridded
precipitation via TWDB, 28 Aug 2026). Full write-up in
`readme_for_user/VALIDATION-RAINFALL.md`.

**Verdict: gridMET is fine. The airport-station source was the problem, and it
was already hidden from the picker earlier the same day.**

| vs the state map, 32 sites | exact band | within one band | bias | MAE | r |
|---|---|---|---|---|---|
| gridMET | 21/32 | **32/32** | −0.51 in | 2.14 | 0.963 |
| NASA POWER | 17/32 | 31/32 | −1.65 in | 2.55 | 0.958 |
| stations | 10/32 | 21/32 | **−7.21 in** | 7.42 | 0.341 |

**Reading a banded map has an error floor.** Bins are 5 in wide, so a perfect
match still scores 5/√12 = 1.5 in RMSE against a midpoint. gridMET's excess over
that floor is 2.37 in; NASA POWER's is 3.16 in. **Never quote a midpoint-based
MAE from a binned reference without subtracting this** — it makes a good match
look mediocre.

**THE MAP IS NOT TRUTH, so gauges arbitrated.** At the 20 sites with ≥95% gauge
coverage, all three estimates read HIGH by about the same amount — gridMET +2.0,
NASA POWER +1.5, and **NOAA's own map +2.4**. Expected: gauge wind undercatch is
5–15%, and a point gauge is not an areal average. Closest-to-gauge tally:
gridMET 7, POWER 7, map 6. A three-way tie — our default is not measurably worse
than the source the state publishes.

#### Extracting the map — reusable method

The PDF is a **geospatial PDF**: `/Viewport /Measure /GEO` with `/GPTS` corners
and a Web Mercator `/WKT`. The raster is one grid split into six image XObjects
(5 × 3301×635 plus a 3301×125 tail); the page transform chain composes to the
identity, so raster pixel (col,row) is at page point
`(0.24(col+0.5), 792−0.24(row+0.5))`. **Latitude is NOT linear down the image —
Mercator-y is.** Treating it as linear shifts points by up to ~20 km at the ends.

The 17 legend swatches are also images, each inside its own Form XObject, so the
colour→bin pairing is *read* rather than eyeballed off a screenshot. Self-check:
the last two must come out white and grey.

**GEOREFERENCING WAS VERIFIED BEFORE ANY NUMBER WAS TRUSTED,** using the map's
own vector Texas outline: Panhandle meridians land 0.4 and 1.0 km from
−103.0417 and −100.0000, and the two straight parallels 0.2 and 0.1 km from
36.5°N and 32.0°N. A rainfall comparison alone could NOT have caught a bad
mapping — rainfall varies smoothly, so a 50 km offset would still correlate well.
An attempted check using "where does data stop at the Mexican border" was
useless: the QPE grid is not clipped to Texas.

Neither poppler nor headless Chrome will render this PDF here, so the raster is
carved out of the object streams directly (`zlib.inflateSync` on the image
XObjects, hand-rolled PNG writer to look at it).

#### THE NEW BUG THIS FOUND — coverage counting is not enough

**A gauge can report every day and still be wrong.** Paris, Texas reported 95% of
days and totalled **2.1 in** where both the map and gridMET say ~30 — a dead
tipping bucket logging 0.00 rather than logging nothing. `makeStat`'s sparse
guard counts days PRESENT, so it cannot see this. Half of the 32 stations checked
failed some quality test.

This is not confined to the hidden station source: **`findNearestStation` also
fills the trailing days behind every gridded source**, so a dead gauge can inject
a few days of false zeros into the default. Bounded (a handful of days out of
238) but real, and not yet guarded.

A first attempt at filtering used mean depth per wet day ≥ 0.3 in, which
**wrongly dropped Amarillo, Lubbock and El Paso** — 0.23 in per rain day is
normal in semi-arid west Texas, not a fault. Any gauge-quality rule has to be
regional or it will discard the driest real data.

**FIXED the same day — `gaugeLooksDead` in `app/api/history/route.ts`.** The fill
window already over-fetches, so there is a long OVERLAP where the station and
the gridded source both have data; over that, a working gauge and a 4 km cell
should roughly agree. Below a fifth, the gauge's precip is nulled and its
temperature kept — the failure is one instrument, not the station, and a null
reads through the app as "not measured" so accumulation stops rather than
adding a false zero.

- **The 45-day fill window was too short to judge on** and had to go to 120.
  Paris in Jul–Aug had a gauge at 3% of the grid — unmistakably broken — but
  only 14.7 mm of grid rain behind it, which cannot separate a dead gauge from a
  storm that missed one field. `fillDays` now floors at 120 for that reason
  alone; the fill itself still only uses the days after `lastObserved`.
- **Threshold placed from a measured distribution, not picked.** Across 30
  sites: 0.111 Paris and 0.186 Temple (both independently confirmed broken by
  their whole-year totals), then a gap, then 0.243 Muleshoe (station in New
  Mexico, 60 km off — a DISTANCE fault, deliberately not handled here), and the
  25 healthy sites in one cluster from 0.70 to 1.38.
- **`gaugeCheck` is returned whether or not it rejects.** A guard whose numbers
  only appear when it fires cannot be tuned and cannot be seen to have broken.
- **Temple is the DEFAULT PIN**, so the default location was serving false zeros
  in its most recent days until this landed.

### 2026-08-29 — Analytics: Vercel for traffic, our own table for locations

User wanted to know whether anyone is using the site, what locations they look
up, and how to not count themselves. Plain-language setup in
`readme_for_user/SETUP-ANALYTICS.md`.

**THE FACT THAT DECIDED THE DESIGN: custom events are Pro-only on Vercel.** The
Hobby plan gives page views, visitors, referrers, devices and the VISITOR's
city — but the one question worth answering, *which field did they look up*,
needs a custom event, which Hobby does not have. Hobby also keeps only a
**1-month rolling window**, so history is lost. Verified against the pricing
table 2026-08-29; re-check before quoting.

So: **Vercel for traffic, Supabase for locations.** The database was already
there for the cache, so the answer Vercel charges $20/month for costs nothing,
keeps forever, and stays out of a third party.

#### `/api/visit` — its own route, and that is the important part

**`/api/history` is CDN-cached for 3 hours, so a counter there would silently
miss repeat interest** — a second visitor at the same field inside that window
is served from the edge and the route function never runs. It would undercount
the popular locations worst of all. `/api/visit` is `force-dynamic`,
`no-store`, and does no upstream work: one point-in-polygon test against an
index already in memory. Measured ~100 ms after the first call.

**Always returns 204**, including on a bad body, an out-of-range point, or a
database that is down. It is a fire-and-forget beacon from an already-rendered
page; there is no failure here worth telling a browser about.

**COUNTY ONLY — the user's call, and the right one.** A typed coordinate is
someone's field. The server resolves it to a county and DISCARDS it; nothing
finer is ever written. No IP, no user agent, no session id, no cookie. Two
visits by one person are indistinguishable from two people, which is a real
limitation and the price of not tracking anyone.

Fires on **location change only**, not per page view — flipping source, variable
or panel at one spot is one lookup, because it is.

#### "Don't count me" — `lib/analytics/self.ts`

`?notme=1` marks the browser in localStorage; Vercel's `beforeSend` returns null
for it and the visit log records `self = true` rather than dropping the row —
**kept on purpose, because seeing your own visits flagged is how you confirm the
exclusion works.** `isSelf()` reads the URL as well as the stored flag: an
effect would run too late, and the first event on the very page that sets the
flag is exactly the one you are trying not to record.

Honest limits, documented for the user: per browser and per device, cleared with
site data, and never retroactive. `isRealVisit()` also excludes localhost and
preview deployments so ordinary development pollutes nothing.

#### Two numbers that will be misread if not stated

- **Vercel "visitors" is unique PER DAY, not per person.** The identifier is a
  hash of the request, discarded after 24 h — that is how it avoids cookies. One
  grower on five days counts as five.
- **The visit log counts LOOKUPS, not people.** One person moving the pin around
  five fields in a county registers five.

Verified: 14/14 counties resolved correctly and correctly null outside Texas;
the flag sets, persists and clears; malformed bodies all return 204; localhost
fires no beacon.

### 2026-09-17 — Idaho served a broken 2026; gridMET rainfall flat at zero statewide

**User report: cumulative rainfall for 2026 was a flat line at every Texas location on gridMET.**

**Cause: upstream, not our code.** The University of Idaho's own 2026 files (`pr_2026.nc`,
`tmmx_2026.nc`, and the `agg_met_*_CurrentYear` aggregations over them) began serving
**January–July 2026 as nonsense**: zero rain in every cell on every day, July highs of −3 °C, and a
daily high only ~1.5 °C above the low. August onward was fine. The time axis, shape and coordinates
were all correct, so every existing ingest check passed, and the 14:19 UTC refresh on 17 Sep
overwrote a good current part with it in 77 s. The 16 Sep run was healthy. Earth Engine's copy of
gridMET was unaffected (`verify-current.mts` showed the archive, not EE, was wrong this time).

**The tell in the refresh log:** rainfall compressed to "0% of source" instead of ~12%. An all-zero
variable compresses to nothing.

**Fix, three parts:**
1. **`lib/archive/plausibility.ts`** — before uploading anything the refresh takes a 1-in-8
   statewide sample (~1 MB/variable, a few seconds) and rejects any month that is physically
   impossible. Thresholds sit deep inside the measured gap:

   | monthly, ~1,000 land cells | healthy 2025 | broken 2026 Jan–Jul |
   |---|---|---|
   | mean daily range | 12.4–17.0 K | 1.1–2.2 K |
   | cell-days ≥ 1 mm rain | 4.9–30.5 % | 0.0–0.7 % |
   | mean high, Jun–Aug | 32–34 °C | 0–1 °C |

   Deliberately coarse: it catches a broken FILE, not an extreme season. A false alarm would
   withhold real data in exactly the year a grower most wants to see. It does not catch one bad day.
2. **`parts.current.withheld`** in the manifest. On failure nothing is uploaded, the live manifest
   is republished with the reason, and the run exits 1 (GitHub emails). The reader declines anything
   touching a withheld part. Unlike `building`, the other part stays in service: `gridmet.ts`
   `withArchive` **splits** the request, so 1996–2025 still come from the archive and only 2026
   goes to Earth Engine. Verified cold, no cache: 31 years in 11 s, no duplicate dates at the seam.
   The next refresh whose download passes the check, rewriting all variables, clears the flag.
3. **The check runs BEFORE the "nothing new upstream" exit.** The bad copy was already stored and
   Idaho's latest date had not moved, so a check placed after that exit would have looked at
   nothing. A withheld part is also never "already current".

`--allow-implausible` overrides, for use only after checking the data by hand. A rollover also
checks the year being sealed, because nothing ever rewrites the archive part afterwards.

**Cache:** the 3 h Supabase TTL on the in-progress year would have kept the flat line on screen for
hours after the fix, so the `hist:gridmet:*:2026` entries were purged after deploying. Purge AFTER
the deploy, not before: the old code ignores `withheld` and would re-cache the bad chunks.

#### Same day, later — stage, read back, promote; hold and retry; check the website

User (who had just shown the site to growers): *check every day that values are realistic; if not,
hold on to the good data, retry in a few hours, and only update the website when it's good.*
Built as GitHub Actions, not an AI agent: the rules are fixed numbers, and a scheduled job applies
them identically every time, for free.

**The refresh never writes the live copy any more.** The current part alternates between two
folders, `current` and `current-b` (`partDir()`, manifest `parts.current.dir`). Each run:
1. exits in ~20 s with no uploads if Idaho has nothing new and nothing is on `hold`;
2. **check 1** — Idaho's statewide sample (above); also holds if Idaho's latest day went BACKWARDS;
3. uploads to the spare folder;
4. **check 2** — reads 35 of 340 stored chunks back from R2 (every 4th cell, ~560 cells), unpacks
   them the way the site does, and runs the same rules. Catches faults between download and disk
   that check 1 cannot see;
5. only then points the manifest at the new folder, stamps `writtenAt`, and clears `hold`.

Anything failing → `holdAndExit`: the live copy keeps serving, `hold` {since, lastTry, reason,
upstreamEnd, lastAlert} goes in the manifest, a summary goes on the run page. **A hold stays GREEN**
(nothing to fix, and a few hours are invisible since the station fills recent days) and goes **RED
(→ email) only after 24 h, at most once a day**. Schedule moved from daily to **every 3 hours**
(`20 */3 * * *`), so a hold retries itself.

**Traps handled:**
- The folders are reused on alternate refreshes, so a cache could hand back a two-day-old chunk
  from the same key. Current-part chunks are no longer `immutable` (5 min), and the reader appends
  `?v=<writtenAt>` to every current-part chunk URL. R2 ignores the query string; every cache keys on it.
- `--vars` with the current part is refused: it would stage a folder with days-old, different-length
  variables beside the new one and then promote it.
- A hold during a rollover keeps `building: true`. Publishing the pre-rebuild manifest would switch
  the archive back on over half-rewritten chunks. It always alerts.
- `--stage-only` uploads to the spare folder and runs both checks, but never writes the manifest.
  Safe against the live bucket. **Verified with it:** staged Idaho's broken data to `current-b`;
  check 2's statistics matched check 1's independent sample (Jan range 1.8 K both; Aug 14.9 vs
  15.3), August and September passed, January–July were rejected, and the live manifest was
  byte-identical afterwards. The hold path was then run for real: hold recorded, exit 0, withheld kept.
- `withheld` (set only by the first version of this fix) is still honoured and cleared by the next
  promotion. Nothing sets it any more: the live copy is now always one that passed.

**Website check — `scripts/check-live-site.mts`, `.github/workflows/site-check.yml`, daily 18:40
UTC.** Asks the LIVE site for 8 inland places across Texas and judges the current year's gridded
days together: monthly range and summer rules (not the statewide dry rule — 8 points can
legitimately have a dry month), a **shared dry spell** (`longestSharedDrySpell` — consecutive days
with no rain at ANY of the 8), and freshness (newest gridMET day ≤ 10 days old). It only alerts. It
covers what the refresh cannot see: the Supabase cache, Earth Engine, the station splice.
**Back-tested 1996–2025 for the same 8 places:** longest real shared dry spell 22 days (2024)
against an alarm at 45; smallest monthly range 9.6 K against 6; coolest summer month 30.7 °C against
20. This morning's broken copy scored 237 days, 0.7 K and 0.3 °C.

**If a refresh goes red:** read the summary on the run page. The site is still correct: it is
either on the last good copy or, while `withheld` is set, on Earth Engine. If Idaho's data is
genuinely right (checked by hand, e.g. `scripts/verify-current.mts`), re-run with
`--allow-implausible`. Otherwise do nothing; the next run that passes publishes by itself.
**If the website check goes red** while the refresh is green, suspect the cache or Earth Engine,
not Idaho.

### 2026-09-18 — The visit log was never switched on; private insights page added

**The visit log had recorded nothing since it shipped on 29 August.** The `visits` table
was never created in Supabase — the one manual step in `SETUP-ANALYTICS.md`. Every write
returned `PGRST205 Could not find the table 'public.visits'`, which `logVisit` handles
exactly as designed: one `console.warn` into the Vercel function log, and on with the page.
Three weeks of lookups are gone and cannot be backfilled.

**The lesson is about which side stays quiet.** The write side must never break a page load,
so silence there is correct and stays. The READ side is the opposite — it exists to say what
the log holds, and an empty map is indistinguishable from a broken database unless something
says which. `lib/analytics/summary.ts` therefore returns an `error` STRING rather than
throwing or returning zeros, and the page prints it: "the table does not exist yet", "the
database did not answer within ten seconds". **Any telemetry that fails silently on write
needs a reader that fails loudly.**

#### `/insights` — private, server-rendered, no client JavaScript

Guarded by `INSIGHTS_KEY` in a query parameter, compared with `timingSafeEqual`, and
**`notFound()` on any mismatch** — a 404 rather than a 401, so the page's existence is not
advertised. Unset key also 404s: it fails closed. The honest limit (a secret in the URL lands
in history) is documented for the user rather than hidden; what is behind it is county counts
with nothing personal in it, so the exposure is small and stated.

- **546 B of client JS** — it is one server component. Keeping it that way is not tidiness:
  the map needs the ~1 MB county boundary index, and a client component touching that is the
  26 August bundling trap again, which `tsc` cannot see. A page with no client component
  cannot hit it.
- `readAllCounties()` added to `lib/yield/read.ts`, reusing the same cached index as the
  point lookup.
- `lib/analytics/choropleth.ts` projects to SVG on the server: **243 KB of stored geometry
  becomes 53 KB of path data.** A second Douglas-Peucker pass at 0.01° is not redundant with
  the stored 0.003° — one governs whether a field lands in the right county, the other
  whether the outline looks like Texas at 900 px. Equirectangular with longitude squeezed by
  cos(mid-latitude); dropping that term makes Texas visibly too wide.
- **Bins double (1, 2-3, 4-7, …, 32+) and zero is not a bin.** Visit counts are heavily
  skewed, so equal-width bins would put nearly every county in the first one; doubling needs
  no tuning as the numbers grow from single digits to thousands. A county nobody looked at is
  a different statement from one looked at once.
- **The page paints its own light ground and ignores the theme.** Same reasoning as the
  analog year swatches: a sequential ramp is only legible against one end of the lightness
  range, and on a dark surface the deepest bins — the busiest counties — would vanish.
- CSS module rather than `globals.css`, so one private page adds nothing to every grower's
  download.

**Verified, not assumed.** Build clean. Guard checked live: no key → 404, wrong key → 404,
right key → 200. Projection checked by rendering all 254 counties to PNG and looking at it —
the outline is Texas, and Dallam/El Paso/Cameron/Newton land at the four extremes (x=31%/y=2%,
x=3%/y=45%, x=70%/y=97%, x=98%/y=54%). Aspect ratio 900×854 matches the bbox arithmetic.

**Two numbers on that page will be misread if the caveats are ever dropped**, so they are
printed on it: it counts LOOKUPS not people (no visitor id of any kind exists), and it is
COUNTY resolution and can never be finer, because the coordinate is resolved and discarded.

### 2026-09-18 (later) — Counting people, and what they came for

User wanted breadth: distinct users, new versus returning, graphs, "so we can understand what
areas need more extension work". The first of those could not be answered at all, because the
original design stored no identifier of any kind — deliberately. Put to the user as an
explicit decision; they chose a persistent anonymous code.

**`lib/analytics/visitor.ts` — a random code in localStorage.** Derived from nothing: no IP,
no user agent, no fingerprint. It identifies a BROWSER, never a person, and there is nothing
else stored that it could be joined to. The cost is real and is stated rather than buried —
**a plain sentence in the site's own footer says the site does this**, and that sentence is
part of the feature. Do not delete it while the module exists.

County-only is UNCHANGED and must stay: the coordinate is still resolved and discarded.

**A second table, `events`,** for what people do rather than where they look — panel,
variable, crop, dataset, units, downloads. **Deduplicated per session in the browser**, so a
row means "in this sitting, somebody opened the forecast" rather than counting clicks. The
reader counts DISTINCT SESSIONS for the same reason, so a privacy-mode browser that cannot
dedupe locally does not get extra weight.

#### THE MIGRATION TRAP, AND THE FALLBACK BOTH SIDES NOW HAVE

Code deploys the instant it is pushed; an `alter table` is a human pasting SQL into a
dashboard, possibly days later. In that window every insert carrying a new column is rejected
with PGRST204 and **every lookup in it would be lost — the same failure that had just cost
three weeks, wearing a different error code.** So:

- **Write side:** a rejected insert is retried ONCE with only the columns that have always
  existed. New detail is lost for those rows; the visit is not.
- **Read side:** a select that fails with Postgres 42703 drops to the legacy column list and
  restarts paging, and the page says *the database is older than the site* with the fix.

**Verified against the real database in exactly that state** — new columns absent, `events`
absent: beacons returned 204, the row landed in `visits` via the fallback, and the page
rendered with both warnings and correct county figures. **Any future column added here needs
the same pair.**

#### THE REGION ROLLUP WAS BUILT AND THEN DELETED — do not rebuild it naively

A by-part-of-Texas chart is the obvious thing to want and every mechanical version of it lies:
- **Equal thirds of the bounding box** put Bell County in "East Texas", because El Paso drags
  the western edge out.
- **Thirds by county density** fixed Bell and Lubbock but filed **Austin, Corpus Christi and
  the Rio Grande Valley together as "South Central"**, and El Paso as "West Central".

The correct grouping is the AgriLife extension districts, which are a published 254-county
list this repository does not have; writing one from memory would be right for most counties
and quietly wrong for some. A confident wrong answer is worse than a coarse right one, so the
map is the geographic answer and the county card states only what can be counted: the share in
the top five counties, and how many of the 254 have never been looked at. **If districts are
ever wanted, ingest the real list to R2 beside the county index.**

#### Also

- Screen class is measured from the VIEWPORT at the site's own 620 px breakpoint, so it reports
  the layout the visitor actually saw, not the hardware they own.
- Hour and weekday come from the VISITOR's clock, sent with the beacon. Texas spans two time
  zones, so UTC — or assuming Central — puts El Paso's morning in the wrong place.
- Referrer is stored as a HOST, never a full URL: a referring address can carry a search query
  or a private path.
- New-versus-returning is **labelled unreadable for its first 30 days**, because until then
  nobody can be returning and a 100% "new" share is a fact about the calendar, not a finding.
- Still no client component on `/insights` — 794 B of JS, every chart plain markup.
- `fold()` is exported and pure, and was checked against a synthetic log covering a returning
  visitor, a new one, a deep session, a privacy browser with no code, an out-of-Texas click and
  a self-marked visit.

### 2026-09-18 — Vercel silently skipped a push

Two commits went up forty minutes apart. The first deployed; **the second never appeared in the
Deployments list at all** — no failed build, no queued build, nothing. There is no `vercel.json`
and no Ignored Build Step in this project, so nothing asked for it to be skipped: the GitHub
webhook was simply missed.

**How it was diagnosed without dashboard access**, which is the reusable part. Probe the live
site for something that exists ONLY in the missing commit:

```
POST /api/event   -> 404   (route added in the missing commit)
GET  /            -> no "What we record" paragraph (footer added in the missing commit)
git rev-parse origin/main -> the commit IS on GitHub
```

Together those separate the three candidates — push failed, build failed, deploy skipped —
without seeing a single Vercel screen. **A missing feature on a live site is not evidence of a
bad build; check the deployed COMMIT first.**

**The fix is another commit.** A `Redeploy` from the dashboard re-runs the deployment it is
attached to, which is the OLD commit, so it cannot recover from this — that is the trap. Only a
new push pulls the newer tree.

**Also note the ordering rule this exposed:** `INSIGHTS_KEY` and any other environment variable
must exist in Vercel BEFORE the deployment that needs it. Vercel binds project settings at
deploy time, so adding a variable afterwards does nothing until the next build. A page guarded
by an unset key fails closed and returns a plain 404, which is correct security and indistinguishable
from a route that was never deployed — so check both together.

## Next up

Items 1, 4 and 7 of the original list are done (gridMET as a source, OpenET, shipped to Vercel).
What remains, roughly in value order:

1. **Ensemble source** — mean across sources with spread as an uncertainty band. Nothing in the
   farmer-facing space does this; it is the strongest differentiator. Needs a real weighting design,
   not a mean of whatever happens to be live.
2. **PRISM** — parked by the user on 2026-08-27, not abandoned. The public service only serves
   whole-CONUS daily rasters (~36,000 downloads for one 25-year point series), so it needs the same
   ingest-and-transpose treatment gridMET just got. Probe scripts already exist in `scripts/`.
3. React Native / Expo app sharing `lib/` unchanged.

### Parked, to be designed with the user (raised 2026-08-27)

Both were deferred deliberately — the user wants to discuss the agronomy before either is built.
Do not implement either without that conversation.

- **Freeze / frost date drift.** First and last frost date per year, with the trend. The decision
  metric a grower actually plans a planting window around, and the one thing a 30-year record is
  genuinely long enough to say something about — unlike a rainfall slope. Design questions that
  must be settled first: which threshold counts as a frost (0 °C, −2 °C, and a hard-freeze −4 °C
  are all in normal use and give different answers), whether the "year" runs Jan–Dec or
  July–June (a Dec frost and the following Feb frost belong to one season, not two), and how to
  report a year that never froze at all — which happens in the Valley and must not be drawn as
  a zero.
- **Planting-date / crop-stage overlays** on the season tracker. Mark planting, emergence and
  growth stages so GDD and rainfall accumulation read against the crop calendar instead of against
  1 January. Blocked on the open question below — the stage thresholds are crop-specific, so this
  cannot be built generically without picking crops first.

### Open questions for the user
- Which crops/planting windows matter most for the Texas rollout? (drives #3)
- Is the farmer who gave the feedback available to test the analog panel? It is the most novel piece
  and the least validated against how a grower actually reasons.
