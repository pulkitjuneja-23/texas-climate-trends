/**
 * Two questions before switching gridMET to Earth Engine:
 *   1. Do parallel chunks beat one big request?
 *   2. Do the numbers match what the Idaho server gives today?
 */
import { readFileSync } from "node:fs";
import ee from "@google/earthengine";

const key = JSON.parse(readFileSync("./earthengine-key.json", "utf8"));
const project = process.env.GEE_PROJECT_ID || key.project_id;
const LAT = 33.58;
const LON = -101.85;

await new Promise((resolve, reject) =>
  ee.data.authenticateViaPrivateKey(
    key,
    () => ee.initialize(null, null, resolve, reject, null, project),
    reject
  )
);

const point = ee.Geometry.Point([LON, LAT]);
const BANDS = ["tmmx", "tmmn", "pr", "eto"];

const fetchRange = (start, end) =>
  new Promise((resolve, reject) =>
    ee
      .ImageCollection("IDAHO_EPSCOR/GRIDMET")
      .filterDate(start, end)
      .select(BANDS)
      .getRegion(point, 4638)
      .evaluate((v, err) => (err ? reject(new Error(err)) : resolve(v)))
  );

// ---- 1. parallel chunks ----
console.log("=== parallel 5-year chunks (incl. reference ET band) ===");
const spans = [
  ["2000-01-01", "2005-01-01"],
  ["2005-01-01", "2010-01-01"],
  ["2010-01-01", "2015-01-01"],
  ["2015-01-01", "2020-01-01"],
  ["2020-01-01", "2026-08-26"],
];
const t0 = Date.now();
const chunks = await Promise.all(spans.map(([s, e]) => fetchRange(s, e)));
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const rows = [];
for (const c of chunks) rows.push(...c.slice(1));
rows.sort((a, b) => a[3] - b[3]);
console.log(`  ${secs}s for ${rows.length} days, 4 bands, in 5 parallel requests\n`);

// ---- 2. cross-check against the live site's current gridMET path ----
console.log("=== do EE values match the Idaho server? ===");
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const eeByDate = new Map(
  rows.map((r) => [iso(r[3]), { tmax: r[4] - 273.15, tmin: r[5] - 273.15, pr: r[6], eto: r[7] }])
);

const live = await (
  await fetch(
    `https://texas-climate-trends.vercel.app/api/history?lat=${LAT}&lon=${LON}&startYear=2000&source=gridmet`
  )
).json();

let checked = 0;
let worstT = 0;
let worstP = 0;
const samples = [];
for (const rec of live.records) {
  if (rec.provenance !== "observed") continue;
  const e = eeByDate.get(rec.date);
  if (!e || rec.tmax === null || rec.precip === null) continue;
  checked++;
  worstT = Math.max(worstT, Math.abs(e.tmax - rec.tmax));
  worstP = Math.max(worstP, Math.abs(e.pr - rec.precip));
  if (samples.length < 4 && rec.precip > 3) {
    samples.push(
      `    ${rec.date}  THREDDS tmax=${rec.tmax.toFixed(2)} pr=${rec.precip.toFixed(2)}` +
        `   EE tmax=${e.tmax.toFixed(2)} pr=${e.pr.toFixed(2)}`
    );
  }
}
console.log(`  compared ${checked} days`);
console.log(`  largest temperature difference: ${worstT.toFixed(4)} C`);
console.log(`  largest rainfall difference:    ${worstP.toFixed(4)} mm`);
samples.forEach((s) => console.log(s));

// Reference ET comes free in the same request.
const withEto = rows.filter((r) => typeof r[7] === "number").length;
console.log(`\n  reference ET present on ${withEto} of ${rows.length} days (free in the same call)`);

process.exit(0);
