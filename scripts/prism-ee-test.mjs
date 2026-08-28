/**
 * PRISM was declined in August because its public web service only serves
 * whole-country daily rasters — a 25-year point series would have been ~36,000
 * downloads. Earth Engine removes that blocker. Does it actually work?
 */
import { readFileSync } from "node:fs";
import ee from "@google/earthengine";

const key = JSON.parse(readFileSync("./earthengine-key.json", "utf8"));
const project = process.env.GEE_PROJECT_ID || key.project_id;

await new Promise((resolve, reject) =>
  ee.data.authenticateViaPrivateKey(
    key,
    () => ee.initialize(null, null, resolve, reject, null, project),
    reject
  )
);

const LAT = 31.3;
const LON = -97.4;
const point = ee.Geometry.Point([LON, LAT]);

const series = (id, bands, scale, start, end) =>
  new Promise((resolve, reject) =>
    ee
      .ImageCollection(id)
      .filterDate(start, end)
      .select(bands)
      .getRegion(point, scale)
      .evaluate((v, err) => (err ? reject(new Error(err)) : resolve(v)))
  );

console.log("=== PRISM daily, full record, one request ===");
const t0 = Date.now();
const rows = (
  await series(
    "OREGONSTATE/PRISM/ANd",
    ["ppt", "tmax", "tmin", "vpdmax"],
    4638,
    "2000-01-01",
    "2026-08-27"
  )
).slice(1);
console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s   ${rows.length} days`);

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
rows.sort((a, b) => a[3] - b[3]);
const last = rows[rows.length - 1];
console.log(
  `  latest ${iso(last[3])}: ppt=${last[4]} mm  tmax=${last[5]} C  tmin=${last[6]} C  vpdmax=${last[7]} hPa`
);

// Annual rainfall sanity — Waco-area normal is ~36 in.
const byYear = {};
for (const r of rows) {
  const y = iso(r[3]).slice(0, 4);
  if (typeof r[4] === "number") byYear[y] = (byYear[y] || 0) + r[4];
}
const full = Object.entries(byYear).filter(([y]) => y >= "2020" && y <= "2025");
console.log("\n=== annual rainfall, inches ===");
full.forEach(([y, mm]) => console.log(`  ${y}  ${(mm / 25.4).toFixed(1)} in`));

// Cross-check against gridMET, which is built on PRISM — they should be close.
console.log("\n=== PRISM vs gridMET, same point ===");
const g = (
  await series("IDAHO_EPSCOR/GRIDMET", ["pr", "tmmx"], 4638, "2024-01-01", "2025-01-01")
).slice(1);
const gMap = new Map(g.map((r) => [iso(r[3]), { pr: r[4], tmax: r[5] - 273.15 }]));

let n = 0;
let sumAbsP = 0;
let sumAbsT = 0;
let pPrism = 0;
let pGrid = 0;
for (const r of rows) {
  const d = iso(r[3]);
  if (!d.startsWith("2024")) continue;
  const gg = gMap.get(d);
  if (!gg || typeof r[4] !== "number" || typeof r[5] !== "number") continue;
  n++;
  sumAbsP += Math.abs(r[4] - gg.pr);
  sumAbsT += Math.abs(r[5] - gg.tmax);
  pPrism += r[4];
  pGrid += gg.pr;
}
console.log(`  ${n} days compared in 2024`);
console.log(`  mean daily rainfall difference: ${(sumAbsP / n).toFixed(2)} mm`);
console.log(`  mean daily tmax difference:     ${(sumAbsT / n).toFixed(2)} C`);
console.log(
  `  2024 total: PRISM ${(pPrism / 25.4).toFixed(1)} in   gridMET ${(pGrid / 25.4).toFixed(1)} in`
);

process.exit(0);
