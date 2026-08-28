/**
 * Is the yield store right, and does the county lookup put a field in the
 * county it is actually in?
 *
 * The county question is the one that can fail silently. A simplified boundary
 * that misplaces a point returns a completely plausible yield figure from the
 * county next door, and nothing downstream can tell. So every test point is
 * checked against the FCC's block-lookup service, which is an independent
 * authority on which county a coordinate falls in.
 *
 *   node --experimental-strip-types scripts/verify-nass.mts ./tmp
 *   node --experimental-strip-types scripts/verify-nass.mts --r2
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { locateCounty, type CountyIndex } from "../lib/yield/county.ts";
import {
  percentOfTrend,
  yieldAt,
  MIN_TREND_YEARS,
  YIELD_STORE_KEY,
  COUNTY_INDEX_KEY,
  type YieldStore,
} from "../lib/yield/types.ts";

const src = process.argv[2];
if (!src) {
  console.error("usage: verify-nass.mts <dir>|--r2");
  process.exit(1);
}

// .env.local is how a laptop supplies the bucket URL; CI supplies it as an
// environment variable and has no such file. Missing is normal, not an error.
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#")) {
      const k = line.slice(0, i).trim().replace(/^﻿/, "");
      if (!process.env[k]) process.env[k] = line.slice(i + 1).trim();
    }
  }
} catch {
  /* no .env.local - environment variables only */
}

/** Anything that makes the published store wrong, rather than merely unlucky. */
const failures: string[] = [];

async function load<T>(key: string): Promise<T> {
  if (src === "--r2") {
    const base = process.env.NEXT_PUBLIC_R2_URL!.replace(/\/+$/, "");
    const r = await fetch(`${base}/${key}`);
    if (!r.ok) throw new Error(`${key}: ${r.status}`);
    return (await r.json()) as T;
  }
  return JSON.parse(readFileSync(join(src, key), "utf8")) as T;
}

const index = await load<CountyIndex>(COUNTY_INDEX_KEY);
const store = await load<YieldStore>(YIELD_STORE_KEY);

console.log(`counties ${index.counties.length}, tolerance ${index.toleranceDeg} deg`);
console.log(`store built ${store.builtAt}, ${Object.keys(store.data).length} counties\n`);

// ---------------------------------------------------------------------------
// 1. County lookup against an independent authority
// ---------------------------------------------------------------------------
const POINTS: Array<[string, number, number]> = [
  ["Blackland cropland (default)", 31.3, -97.4],
  ["Waco", 31.549, -97.147],
  ["Lubbock", 33.5779, -101.8552],
  ["Amarillo", 35.222, -101.8313],
  ["Weslaco", 26.1595, -97.9908],
  ["Dalhart", 36.0595, -102.5132],
  ["El Paso", 31.7619, -106.485],
  ["Beaumont", 30.0802, -94.1266],
  ["Uvalde", 29.2097, -99.7862],
  ["Muleshoe", 34.2273, -102.7241],
  ["Corpus Christi", 27.8006, -97.3964],
  ["Big Bend", 29.3, -103.3],
];

console.log("--- county lookup vs the FCC block service ---");
let agree = 0;
let checked = 0;
let unreachable = 0;
for (const [label, lat, lon] of POINTS) {
  const mine = locateCounty(index, lat, lon);

  // The FCC service is a convenience, not the thing under test. If it is down
  // the boundary check is SKIPPED, never failed - otherwise someone else's
  // outage marks our data bad.
  let theirs: string | undefined;
  let theirName = "?";
  try {
    const res = await fetch(
      `https://geo.fcc.gov/api/census/area?lat=${lat}&lon=${lon}&format=json`,
      { signal: AbortSignal.timeout(10_000) }
    );
    const a = (await res.json())?.results?.[0];
    theirs = a?.county_fips?.slice(2);
    theirName = (a?.county_name ?? "?").replace(/ County$/, "");
  } catch {
    unreachable++;
    console.log(`  skip ${label.padEnd(28)} FCC unreachable`);
    continue;
  }

  const ok = mine?.fips === theirs;
  checked++;
  if (ok) agree++;
  else failures.push(`${label}: we say ${mine?.name ?? "none"}, FCC says ${theirName}`);
  console.log(
    `  ${ok ? "ok  " : "MISS"} ${label.padEnd(28)} ` +
      `mine=${(mine ? `${mine.name} (${mine.fips})` : "none").padEnd(24)} fcc=${theirName} (${theirs})`
  );
  await new Promise((r) => setTimeout(r, 250));
}
console.log(
  `  ${agree}/${checked} agree` + (unreachable ? `, ${unreachable} skipped (FCC unreachable)` : "") + "\n"
);

// ---------------------------------------------------------------------------
// 2. Outside Texas must return null, not the nearest county
// ---------------------------------------------------------------------------
console.log("--- outside Texas ---");
for (const [label, lat, lon] of [
  ["New Mexico", 32.5, -106.5],
  ["Oklahoma", 35.5, -97.5],
  ["Gulf of Mexico", 27.0, -95.0],
] as Array<[string, number, number]>) {
  const c = locateCounty(index, lat, lon);
  if (c) failures.push(`${label} resolved to ${c.name} County instead of null`);
  console.log(`  ${c === null ? "ok  " : "MISS"} ${label.padEnd(18)} ${c ? c.name : "null"}`);
}

// ---------------------------------------------------------------------------
// 3. Trend coverage, by practice
// ---------------------------------------------------------------------------
console.log("\n--- series and trend coverage by practice ---");
const tally: Record<string, { series: number; trend: number; years: number[] }> = {};
for (const byCrop of Object.values(store.data)) {
  for (const entry of Object.values(byCrop)) {
    for (const [p, s] of Object.entries(entry.series)) {
      tally[p] ??= { series: 0, trend: 0, years: [] };
      tally[p].series++;
      tally[p].years.push(s.v.filter((x) => x !== null).length);
      if (entry.trend[p]) tally[p].trend++;
    }
  }
}
for (const [p, t] of Object.entries(tally)) {
  const med = t.years.sort((a, b) => a - b)[Math.floor(t.years.length / 2)];
  console.log(
    `  ${p.padEnd(4)} ${String(t.series).padStart(5)} series, ` +
      `${String(t.trend).padStart(5)} trended (${((t.trend / t.series) * 100).toFixed(0)}%), ` +
      `median ${med} observed years  [threshold ${MIN_TREND_YEARS}]`
  );
}

// ---------------------------------------------------------------------------
// 4. A real county, end to end
// ---------------------------------------------------------------------------
const bell = locateCounty(index, 31.3, -97.4);
console.log(`\n--- ${bell?.name} County (${bell?.fips}), the default location ---`);
const cc = bell ? (store.data[bell.fips] ?? {}) : {};
console.log(`  crops present: ${Object.keys(cc).join(", ") || "NONE"}`);

// The landing point having no crops means every first-time visitor sees an
// empty column, which is the one outcome that must never ship.
if (!Object.keys(cc).length) {
  failures.push("the default location's county has no crops in the store");
}
if (Object.keys(store.data).length < 150) {
  failures.push(`only ${Object.keys(store.data).length} counties in the store, expected ~220`);
}

for (const cropId of ["corn", "cotton", "wheat"]) {
  const e = cc[cropId];
  if (!e) continue;
  const crop = store.crops.find((c) => c.id === cropId)!;
  const s = e.series.all;
  const t = e.trend.all;
  console.log(`\n  ${crop.label} (${crop.unitShort}), all practices`);
  console.log(
    `    ${s.v.filter((x) => x !== null).length} years from ${s.y0}` +
      (t
        ? `, trend ${t.slope >= 0 ? "+" : ""}${t.slope.toFixed(2)} ${crop.unitShort}/yr, r2 ${t.r2.toFixed(2)}`
        : ", no trend")
  );
  for (const y of [1998, 2011, 2019, 2023]) {
    const v = yieldAt(s, y);
    const pct = v === null ? null : percentOfTrend(t, y, v);
    console.log(
      `    ${y}  ${v === null ? "no data" : v.toFixed(crop.decimals).padStart(7)}` +
        (pct === null ? "" : `   ${pct.toFixed(0)}% of trend`)
    );
  }
}

if (failures.length) {
  console.error(`\nFAILED — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nall checks passed");
