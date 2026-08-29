# TWIRE — Texas Weather and Irrigation Resource Explorer

> Renamed from "Texas Climate Trends" on 28 Aug 2026. The **name** changed; the
> deployment URL, the repository slug, the Google Cloud project id and the
> Supabase project name did not — those are identifiers other systems resolve,
> and renaming them would break live links and credentials for no gain.

A farmer-facing view of **30 years of weather history** for any point in Texas — the thing every
consumer weather app leaves out. Normals, individual years, a three-tier forecast, and analog-year
matching, all on one page.

Built after a landscape scan found that no existing tool combines farmer-grade UI, deep historical
trends, and a visible choice of data source. Farmer-facing tools (Cornell Climate Smart Farming,
MRCC Ag Climate Tools, AgroClimate, AgSite) each lock you to one hidden source and one region;
multi-source selection exists only in researcher tools like Climate Engine.

---

## Quick start

```bash
npm install
npm run dev      # http://localhost:3000
```

No API keys. No accounts. No `.env` file. Every upstream service used here is free and unauthenticated.

```bash
npm run build     # production build
npm run typecheck # tsc --noEmit
```

---

## What it does

### 1. Season tracker
One calendar year on the x-axis with the 1996–2025 normal drawn behind it as a distribution band
(the middle half of years), and any years you pick drawn on top. Variables: daily high /
low / mean temperature, rainfall, and growing degree days.

Rainfall and GDD default to **season-to-date accumulation** rather than daily values. This is
deliberate — measured at Waco, the "normal" rainfall for July 1 is a mean of 2.72 mm but a *median*
of 0.27 mm with a 10th percentile of zero. A daily-rainfall normal is the mean of mostly-zeros and
tells a grower almost nothing. The accumulated curve — am I ahead or behind on moisture — is the
number that drives decisions.

### 2. Analog years — "which year is this one tracking like?"
Compares the trailing 90/120/150/180 days against the same calendar window in every prior year, on
two axes:

- **Level** — where the season ended up: rain total, mean high/low, accumulated GDD, dry days,
  longest dry spell, days ≥ 35 °C.
- **Shape** — *how it got there*, compared day by day. Two years can both finish a window at 180 mm:
  one from steady weekly rain, one from a single 150 mm event after a two-month drought. To a grower
  those are completely different years, and a level-only match would call them identical.

Both are standardised against the spread of the candidate years, so distance is measured in "how
unusual is this difference here" rather than in millimetres — otherwise rainfall would dominate every
comparison purely by having larger numbers.

The payoff is **what happened next**: for each matching year, what the following 30/60/90 days
actually delivered. At Waco in August 2026 the top matches split hard — 2009 started nearly
identically (341 mm vs 398 mm) and then produced 338 mm in the next 60 days, while 2000 produced
63.5 mm. The panel surfaces that spread as a warning rather than hiding it behind a single
"most similar year" verdict, because a wide spread is itself the answer: the current state does not
constrain what comes next.

### 3. Three-tier forecast
Kept visibly separate rather than merged into one smooth curve, because a day-25 number does not
deserve the same weight as a day-2 number:

| Tier | Days | Source | Confidence |
|---|---|---|---|
| Short | 1–7 | NOAA/NWS gridpoint forecast | High |
| Extended | 8–16 | Open-Meteo GFS/ECMWF blend | Moderate |
| Outlook | weeks 2–4 | NOAA CPC tercile probabilities | Probabilistic |

CPC publishes no JSON API — only KMZ on its GIS mirror. This app unzips it and runs point-in-polygon
against the probability contours, so you get *your* location's outlook ("70% odds of above-normal
temperature") instead of a national map to squint at.

### 4. Year-by-year trend
One bar per completed year, colored diverging around the period mean, with an OLS fit over a
selectable 10/15/20/25/30-year window, defaulting to the full 30. Where the fit is weak the chart
says so in plain words instead of printing r². Even 30 years is short for climate work: Waco's
rainfall trend is −31.75 mm/decade with an r² of 0.013 — noise, not a trend — and reporting the
slope alone would invite exactly that misreading.

---

## The source picker

The premise of this project is that every other farmer-facing climate tool silently picks a dataset
for you, while [dataset choice alone measurably changes crop-yield/climate
conclusions](https://iopscience.iop.org/article/10.1088/1748-9326/ab5ebb). So the source is a
first-class control, and **sources that aren't wired up yet are shown disabled rather than hidden** —
the grower should be able to see that the choice exists.

| Source | Resolution | Status |
|---|---|---|
| NASA POWER | ~55 km | **Live** — default |
| Open-Meteo (ERA5/IFS) | ~11 km | **Live** — also used for gap-fill |
| PRISM | 4 km | Planned — needs a BIL/COG reader + tile cache |
| gridMET | 4 km | Planned — best ag variables (VPD, ETo); THREDDS/netCDF |
| Daymet | 1 km | Planned — finest grid, but ~1 year lag |
| Airport / ASOS | point | Planned — the only true observations here |
| Ensemble | — | Planned — mean across sources with spread as an uncertainty band |

Adding one means implementing the `WeatherSource` interface in `lib/types.ts` and registering it.
Nothing downstream changes.

### The gap-fill seam, and why it's labelled

NASA POWER runs a **~5-day processing lag** — a request ending "today" returns `-999` for the last
several days, right where the grower is looking. Those days are backfilled from Open-Meteo and
**tagged `gapfill`**, never silently blended.

That matters because the sources genuinely disagree. Measured over 2026-08-10..14 at Waco:

| Date | NASA POWER | Open-Meteo |
|---|---|---|
| 2026-08-11 | 0.43 mm | 0.00 mm |
| 2026-08-12 | 1.98 mm | 0.00 mm |
| 2026-08-14 | 5.02 mm | 0.00 mm |

Hiding that seam would reproduce the exact failure this project exists to fix.

---

## Architecture

```
app/
  page.tsx                  dashboard (client) — holds all state
  api/history/route.ts      full daily series + gap-fill splice
  api/forecast/route.ts     three tiers, each failing independently
  api/geocode/route.ts      Nominatim proxy (server-side for the UA policy)
lib/
  types.ts                  DailyRecord — the one contract everything speaks
  sources/                  swappable WeatherSource adapters + registry
  agro/
    climatology.ts          MM-DD normals, percentile bands, accumulation, OLS
    analog.ts               analog-year matching (level + shape + what-happened-next)
    gdd.ts                  simple & modified GDD, crop presets
    units.ts                metric internally, imperial at render time only
components/                 map, charts, panels
```

**Internal units are always metric.** Conversion to °F/inches happens at render time only, never
before a statistic is computed. `tempDelta` is a distinct quantity from `temp` so a temperature
*difference* never picks up the +32 offset.

**Normals are keyed on MM-DD, not day-of-year.** Day-of-year silently misaligns leap from non-leap
years — after Feb 28, DOY 100 is a different calendar date depending on the year, smearing every
normal by a day for three-quarters of the record.

**Accumulation percentiles are taken across per-year curves**, not by accumulating the daily
percentiles. Accumulating a daily p90 would describe a year that sat at the 90th percentile every
single day, which has never happened and would make the band absurdly wide.

### Colour

Charts use the validated data-viz reference palette. The five categorical series slots were run
through the palette validator in both light and dark mode: all checks pass, with a light-mode
contrast WARN on aqua/yellow/magenta. That WARN obligates relief, which is why **every series carries
a direct end-label and every chart has a table view**.

The climatology band is deliberately **neutral gray, not a hue** — it is context, not a series, and
giving it a colour would make "normal" compete with the years you actually chose.

---

## Deploying to Vercel

`git` is **not currently installed on this machine** — install it (`winget install Git.Git`) before
the first push.

```bash
git init && git add -A && git commit -m "Texas Climate Trends"
# push to GitHub, then import the repo at vercel.com/new
```

No environment variables to configure. API routes cache upstream responses
(`s-maxage=10800` for history, `3600` for forecast), so repeat visits to the same point are served
from Vercel's data cache rather than re-hitting NASA.

---

## Known limits

- **NASA POWER is ~55 km.** One cell spans several Texas counties, and Texas rainfall is convective
  and patchy. Fine for climate trends; it will not separate one field from the next. The map draws
  the actual grid cell so this is visible rather than assumed. Wiring up gridMET or PRISM is the
  highest-value next step.
- **Normals are 1996–present at a grid point**, not the official NOAA 1991–2020 station normals.
  1996 is chosen so that 1996–2025 is exactly thirty complete years, the conventional length for a
  normal — but it is not the WMO period and will not match a NWS climate report exactly.
- **Analog years are not a forecast.** They rank past seasons against the current one. Similar starts
  have frequently been followed by very different finishes — see the 2009-vs-2000 split above.
- **Not validated against on-farm rain gauges.** Nothing here should be the only input to an
  irrigation or planting decision.
- **The rendered UI has not been visually verified in a browser in this environment** (no browser
  tooling available). Build, typecheck, and all API routes are verified against live data; the
  visual layer needs a human look on first run.

## Roadmap

- gridMET or PRISM as a 4 km source — the single biggest accuracy win
- Ensemble source: mean across sources with spread drawn as an uncertainty band (nothing else in the
  farmer-facing space does this)
- Planting-date and crop-stage overlays on the season tracker
- OpenET evapotranspiration integration
- Freeze/frost date drift — first/last frost by year with trend
- React Native / Expo app sharing `lib/` unchanged

## Attribution

NASA POWER (Langley Research Center) · Open-Meteo (CC BY 4.0, ECMWF ERA5/IFS) · NOAA/NWS
api.weather.gov · NOAA Climate Prediction Center · Nominatim / OpenStreetMap contributors
