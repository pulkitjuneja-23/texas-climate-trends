/** Finds exactly which days disagree between Earth Engine and the Idaho server. */
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
const rows = (
  await new Promise((resolve, reject) =>
    ee
      .ImageCollection("IDAHO_EPSCOR/GRIDMET")
      .filterDate("2000-01-01", "2026-08-26")
      .select(["tmmx", "tmmn", "pr"])
      .getRegion(point, 4638)
      .evaluate((v, err) => (err ? reject(new Error(err)) : resolve(v)))
  )
).slice(1);

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const eeMap = new Map(rows.map((r) => [iso(r[3]), { tmax: r[4] - 273.15, tmin: r[5] - 273.15 }]));

const live = await (
  await fetch(
    `https://texas-climate-trends.vercel.app/api/history?lat=${LAT}&lon=${LON}&startYear=2000&source=gridmet`
  )
).json();

const diffs = [];
for (const rec of live.records) {
  if (rec.provenance !== "observed" || rec.tmax === null) continue;
  const e = eeMap.get(rec.date);
  if (!e) continue;
  const d = Math.abs(e.tmax - rec.tmax);
  if (d > 0.5) diffs.push({ date: rec.date, thredds: rec.tmax, ee: e.tmax, d });
}

diffs.sort((a, b) => b.d - a.d);
console.log(`days differing by more than 0.5 C: ${diffs.length} of 9732\n`);
diffs.slice(0, 12).forEach((x) =>
  console.log(`  ${x.date}  THREDDS ${x.thredds.toFixed(2)}  EE ${x.ee.toFixed(2)}  diff ${x.d.toFixed(2)}`)
);

// Is it a date shift? Compare THREDDS day D against EE day D-1 and D+1.
if (diffs.length) {
  const shift = (off) => {
    let hits = 0;
    for (const x of diffs.slice(0, 40)) {
      const d = new Date(x.date + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + off);
      const alt = eeMap.get(d.toISOString().slice(0, 10));
      if (alt && Math.abs(alt.tmax - x.thredds) < 0.5) hits++;
    }
    return hits;
  };
  console.log(
    `\n  do they line up if shifted?  -1 day: ${shift(-1)}   +1 day: ${shift(1)}  (of ${Math.min(40, diffs.length)} checked)`
  );

  const byYear = {};
  diffs.forEach((x) => (byYear[x.date.slice(0, 4)] = (byYear[x.date.slice(0, 4)] || 0) + 1));
  console.log("  differing days per year: " + JSON.stringify(byYear));
}
process.exit(0);
