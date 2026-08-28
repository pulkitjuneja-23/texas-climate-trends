/**
 * Build the Texas county-yield store and the county boundary index, and upload
 * both to R2.
 *
 * WHY WE HOST IT
 * The site never calls NASS. Quick Stats has been unreliable in practice, and a
 * farmer waiting on a page load should not be exposed to that. Everything NASS
 * knows about Texas county yields since 1996 is ~33,000 numbers - under a
 * megabyte - so it is pulled once a quarter, reshaped, and served as one static
 * file. A failed refresh changes nothing: the previously published file keeps
 * serving until the next run succeeds.
 *
 * This is NOT the gridMET archive pattern. gridMET is 1.39 GB across 20,820
 * objects because it is a 4 km grid of daily values. This is two JSON blobs
 * rewritten whole. Do not reach for chunking here.
 *
 * USAGE
 *   node --experimental-strip-types scripts/ingest-nass.mts --out ./tmp
 *   node --experimental-strip-types scripts/ingest-nass.mts --r2
 *   node --experimental-strip-types scripts/ingest-nass.mts --r2 --skip-counties
 *
 *   --out DIR          write locally instead of uploading (for inspection)
 *   --r2               upload to R2 using credentials from .env.local
 *   --skip-counties    reuse the published boundary index; county lines do not
 *                      move, so the quarterly refresh does not rebuild it
 *   --tolerance N      boundary simplification, degrees (default 0.003)
 *
 * NEEDS: NASS_API in .env.local (free key from quickstats.nass.usda.gov/api).
 * The key is used ONLY here. It never reaches the website or the browser.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CROPS,
  PRACTICE_FROM_NASS,
  type NassRow,
  type PracticeId,
} from "../lib/yield/crops.ts";
import {
  fitTrend,
  anchorTrend,
  YIELD_STORE_VERSION,
  YIELD_STORE_KEY,
  COUNTY_INDEX_KEY,
  type YieldStore,
  type CountyCropData,
  type YieldSeries,
  type StateTrendRate,
} from "../lib/yield/types.ts";
import {
  simplifyRing,
  COUNTY_INDEX_VERSION,
  type CountyIndex,
  type CountyShape,
  type Ring,
} from "../lib/yield/county.ts";
import { r2ConfigFromEnv, putMany, type R2Config } from "../lib/archive/r2.ts";

// ---------------------------------------------------------------------------
// Arguments and environment
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (n: string) => argv.includes(`--${n}`);

const OUT_DIR = arg("out");
const TO_R2 = flag("r2");
const SKIP_COUNTIES = flag("skip-counties");
const TOLERANCE = Number(arg("tolerance") ?? 0.003);

if (!OUT_DIR && !TO_R2) {
  console.error("Choose an output: --out <dir> or --r2");
  process.exit(1);
}

function loadEnv(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(".env.local", "utf8")
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          // Strip a BOM off the first key - PowerShell writes one and it is
          // invisible; see the note in lib/archive/r2.ts.
          return [l.slice(0, i).trim().replace(/^﻿/, ""), l.slice(i + 1).trim()];
        })
    );
  } catch {
    return {};
  }
}

const env = { ...process.env, ...loadEnv() } as Record<string, string>;
const NASS_KEY = env.NASS_API || env.NASS_API_KEY;
if (!NASS_KEY) {
  console.error(
    "No NASS key. Put NASS_API=... in .env.local — free from quickstats.nass.usda.gov/api"
  );
  process.exit(1);
}

let r2: R2Config | null = null;
if (TO_R2) {
  r2 = r2ConfigFromEnv(env);
  if (!r2) {
    console.error("R2 credentials missing — see readme_for_user/SETUP-R2.md");
    process.exit(1);
  }
}

const STATE_FIPS = "48";
const START_YEAR = 1996;

interface Blob {
  key: string;
  body: Buffer;
}

async function emit(blobs: Blob[]) {
  if (r2) {
    await putMany(
      r2,
      blobs.map((b) => ({
        key: b.key,
        body: b.body,
        // Short cache: this file changes quarterly and the reader keeps its own
        // in-process cache, so there is no value in a long CDN lifetime.
        opts: { contentType: "application/json", cacheControl: "public, max-age=900" },
      }))
    );
  } else {
    for (const b of blobs) {
      const p = join(OUT_DIR as string, b.key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, b.body);
    }
  }
  for (const b of blobs) {
    console.log(`  wrote ${b.key}  ${(b.body.length / 1024).toFixed(0)} KB`);
  }
}

// ---------------------------------------------------------------------------
// 1. County boundaries
// ---------------------------------------------------------------------------

const TIGER =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query";

async function buildCountyIndex(): Promise<CountyIndex> {
  const qs = new URLSearchParams({
    where: `STATE='${STATE_FIPS}'`,
    outFields: "NAME,COUNTY",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
  });

  console.log("fetching Texas county boundaries from Census TIGERweb ...");
  const res = await fetch(`${TIGER}?${qs}`);
  if (!res.ok) throw new Error(`TIGERweb ${res.status}`);
  const text = await res.text();
  console.log(`  ${(text.length / 1048576).toFixed(1)} MB of full-resolution geometry`);

  const gj = JSON.parse(text);
  const counties: CountyShape[] = [];
  let vertsIn = 0;
  let vertsOut = 0;

  for (const f of gj.features) {
    // ArcGIS returns Polygon or MultiPolygon; flatten to outer rings only.
    const polys =
      f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];

    const rings: Ring[] = [];
    for (const poly of polys) {
      // poly[0] is the outer ring; later entries are holes, which do not occur
      // between counties.
      const flat: Ring = [];
      for (const [lon, lat] of poly[0]) flat.push(lon, lat);
      vertsIn += flat.length / 2;
      const simple = simplifyRing(flat, TOLERANCE);
      vertsOut += simple.length / 2;
      // A ring simplified below a triangle cannot contain anything.
      if (simple.length >= 8) rings.push(simple.map((n) => Number(n.toFixed(5))));
    }
    if (!rings.length) continue;

    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    for (const r of rings) {
      for (let i = 0; i < r.length; i += 2) {
        if (r[i] < w) w = r[i];
        if (r[i] > e) e = r[i];
        if (r[i + 1] < s) s = r[i + 1];
        if (r[i + 1] > n) n = r[i + 1];
      }
    }

    counties.push({
      fips: String(f.properties.COUNTY),
      name: String(f.properties.NAME).replace(/ County$/, ""),
      bbox: [w, s, e, n],
      rings,
    });
  }

  console.log(
    `  ${counties.length} counties, ${vertsIn} vertices -> ${vertsOut} ` +
      `(${((vertsOut / vertsIn) * 100).toFixed(1)}%) at ${TOLERANCE} deg`
  );

  return {
    version: COUNTY_INDEX_VERSION,
    builtAt: new Date().toISOString(),
    toleranceDeg: TOLERANCE,
    counties,
  };
}

// ---------------------------------------------------------------------------
// 2. Yield data
// ---------------------------------------------------------------------------

async function fetchCrop(commodity: string): Promise<NassRow[]> {
  const qs = new URLSearchParams({
    key: NASS_KEY,
    commodity_desc: commodity,
    state_alpha: "TX",
    agg_level_desc: "COUNTY",
    statisticcat_desc: "YIELD",
    year__GE: String(START_YEAR),
    format: "JSON",
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://quickstats.nass.usda.gov/api/api_GET/?${qs}`);
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
      const j = await res.json();
      return (j.data ?? []) as NassRow[];
    } catch (e) {
      if (attempt === 2) throw e;
      console.log(`    retrying ${commodity} (${e instanceof Error ? e.message : e})`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  return [];
}

const started = Date.now();
console.log(`NASS county yield, Texas, ${START_YEAR}-present\n`);

const blobs: Blob[] = [];

if (!SKIP_COUNTIES) {
  const idx = await buildCountyIndex();
  blobs.push({ key: COUNTY_INDEX_KEY, body: Buffer.from(JSON.stringify(idx)) });
} else {
  console.log("skipping the boundary index (--skip-counties); county lines do not move\n");
}

console.log("\nfetching yields ...");

/** countyFips -> cropId -> practice -> year -> value */
const bag = new Map<string, Map<string, Map<PracticeId, Map<number, number>>>>();
const countyNames: Record<string, string> = {};
let kept = 0;
let dropped = 0;

for (const crop of CROPS) {
  const rows = await fetchCrop(crop.commodity);

  /**
   * Rank-aware insertion.
   *
   * Sunflower publishes overlapping class variants for the same county-year.
   * Taking whichever arrived last would make the figure depend on NASS's row
   * order; summing them would invent a harvest that did not happen. So the
   * lowest `rank` wins deterministically, and everything else is dropped.
   */
  const chosen = new Map<string, { rank: number; row: NassRow }>();

  for (const r of rows) {
    if (!crop.select(r)) {
      dropped++;
      continue;
    }
    const practice = PRACTICE_FROM_NASS[r.prodn_practice_desc];
    if (!practice) {
      // "NON-IRRIGATED, CONTINUOUS CROP" and friends: every one of them
      // duplicates a plain NON-IRRIGATED county-year, verified against the
      // full record. Folding them in would double-count.
      dropped++;
      continue;
    }
    const value = Number(String(r.Value).replace(/,/g, ""));
    if (!Number.isFinite(value)) {
      dropped++;
      continue;
    }

    const k = `${r.county_code}|${practice}|${r.year}`;
    const rank = crop.rank ? crop.rank(r) : 0;
    const prev = chosen.get(k);
    if (prev && prev.rank <= rank) {
      dropped++;
      continue;
    }
    if (prev) dropped++;
    chosen.set(k, { rank, row: r });
  }

  for (const [k, { row }] of chosen) {
    const [county, practice, yearStr] = k.split("|") as [string, PracticeId, string];
    // NASS uses "998"/"999" for combined and other-county aggregates, which are
    // not places and must not be matched to a point.
    if (Number(county) >= 998) continue;

    countyNames[county] = row.county_name
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());

    if (!bag.has(county)) bag.set(county, new Map());
    const byCrop = bag.get(county)!;
    if (!byCrop.has(crop.id)) byCrop.set(crop.id, new Map());
    const byPractice = byCrop.get(crop.id)!;
    if (!byPractice.has(practice)) byPractice.set(practice, new Map());

    byPractice.get(practice)!.set(Number(yearStr), Number(String(row.Value).replace(/,/g, "")));
    kept++;
  }

  console.log(`  ${crop.label.padEnd(18)} ${String(rows.length).padStart(6)} rows`);
}

console.log(`\n  kept ${kept} county-year values, dropped ${dropped} duplicate/variant rows`);

// ---------------------------------------------------------------------------
// 3. Statewide rate of improvement, per crop and practice
// ---------------------------------------------------------------------------
/**
 * Most county series are too short to fit their own technology trend — only
 * 54% of all-practice series and 31% of dryland ones clear twelve years. Left
 * there, the irrigated/dryland toggle would show blanks in most cells, which
 * removes the very comparison the panel exists for.
 *
 * The fix rests on a real distinction: the rate of improvement is a STATEWIDE
 * phenomenon (better genetics and agronomy arrive everywhere), while the LEVEL
 * is local (soil, rainfall, elevation). So fit the rate once across Texas and
 * anchor it to each county's own average.
 *
 * The state series is the unweighted mean across reporting counties, not an
 * acreage-weighted total. For estimating a SLOPE that is fine and it keeps the
 * aggregation consistent with the data already in hand; it would be the wrong
 * choice if the number itself were being displayed, and it never is.
 */
const thisYear = new Date().getUTCFullYear();
const stateRates = new Map<string, StateTrendRate>();

{
  const acc = new Map<string, Map<number, number[]>>();
  for (const byCrop of bag.values()) {
    for (const [cropId, byPractice] of byCrop) {
      for (const [practice, byYear] of byPractice) {
        const k = `${cropId}|${practice}`;
        if (!acc.has(k)) acc.set(k, new Map());
        const years = acc.get(k)!;
        for (const [y, v] of byYear) {
          if (y >= thisYear) continue;
          // See ZERO YIELDS below — a failed harvest is not a point on a
          // productivity trend.
          if (v <= 0) continue;
          if (!years.has(y)) years.set(y, []);
          years.get(y)!.push(v);
        }
      }
    }
  }

  for (const [k, byYear] of acc) {
    const years = [...byYear.keys()].sort((a, b) => a - b);
    const means = years.map((y) => {
      const xs = byYear.get(y)!;
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    });
    const t = fitTrend(years, means);
    if (!t) continue;
    const mean = means.reduce((a, b) => a + b, 0) / means.length;
    if (!(mean > 0)) continue;
    stateRates.set(k, { relSlope: t.slope / mean, n: t.n, r2: t.r2 });
  }

  console.log(`\n  statewide improvement rates fitted for ${stateRates.size} crop/practice pairs`);
  for (const crop of CROPS) {
    const r = stateRates.get(`${crop.id}|all`);
    if (r) {
      console.log(
        `    ${crop.label.padEnd(18)} ${(r.relSlope * 100).toFixed(2)}% per year ` +
          `(${r.n} yrs, r2 ${r.r2.toFixed(2)})`
      );
    }
  }
}

// --- reshape into compact series + fitted trends ---
const data: YieldStore["data"] = {};
let seriesCount = 0;
let trended = 0;
let borrowed = 0;

for (const [county, byCrop] of bag) {
  data[county] = {};
  for (const [cropId, byPractice] of byCrop) {
    const entry: CountyCropData = { series: {}, trend: {} };

    for (const [practice, byYear] of byPractice) {
      const years = [...byYear.keys()].sort((a, b) => a - b);
      const y0 = years[0];
      const last = years[years.length - 1];
      const v: (number | null)[] = [];
      for (let y = y0; y <= last; y++) v.push(byYear.get(y) ?? null);

      entry.series[practice] = { y0, v } as YieldSeries;
      seriesCount++;

      /**
       * Fit on COMPLETE years only. The in-progress year has no harvest, and
       * NASS would not publish one - but excluding it explicitly means a
       * mid-season refresh can never drag the trend line down.
       *
       * ZERO YIELDS ARE EXCLUDED FROM THE FIT, AND KEPT IN THE SERIES.
       *
       * NASS really does publish 0 - 133 times in 23,544 values, clustered in
       * drought years like 2000 and 2006. Verified against the source, not a
       * parsing fault. A zero is a failed or unharvested crop, and it belongs
       * in the table: "in a year like this one, the oat crop came to nothing"
       * is exactly what the analog panel is for.
       *
       * But it is NOT a point on a yield TREND. The trend answers "what would a
       * normal year give", and a total failure is the absence of a yield rather
       * than a low one. Left in, three zeros dragged Blanco County's oat normal
       * to 31 bu/ac when the years that actually produced a crop ran 21-60.
       * That understated baseline then flatters every other year's comparison.
       */
      const fitYears = years.filter((y) => y < thisYear && byYear.get(y)! > 0);
      const fitValues = fitYears.map((y) => byYear.get(y)!);

      // Its own slope where the record supports one; the statewide rate
      // anchored to this county's level where it does not.
      let t = fitTrend(fitYears, fitValues);
      if (t) {
        trended++;
      } else {
        const rate = stateRates.get(`${cropId}|${practice}`);
        if (rate) {
          t = anchorTrend(rate, fitYears, fitValues);
          if (t) borrowed++;
        }
      }
      if (t) entry.trend[practice] = t;
    }

    data[county][cropId] = entry;
  }
}

const store: YieldStore = {
  version: YIELD_STORE_VERSION,
  builtAt: new Date().toISOString(),
  attribution: "USDA National Agricultural Statistics Service, Quick Stats",
  crops: CROPS.map((c) => ({
    id: c.id,
    label: c.label,
    unit: c.unit,
    unitShort: c.unitShort,
    decimals: c.decimals,
  })),
  countyNames,
  data,
};

console.log(
  `\n  ${Object.keys(data).length} counties, ${seriesCount} series\n` +
    `  ${trended} fitted their own trend, ${borrowed} borrowed the statewide rate, ` +
    `${seriesCount - trended - borrowed} have none`
);

blobs.push({ key: YIELD_STORE_KEY, body: Buffer.from(JSON.stringify(store)) });

console.log("");
await emit(blobs);
console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(0)}s`);
