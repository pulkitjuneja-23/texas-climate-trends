/**
 * Can gridMET come from Earth Engine instead of 81 requests to Idaho?
 *
 * Run from the project root:  node scripts/gridmet-ee-test.mjs
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
console.log("connected to Earth Engine\n");

const point = ee.Geometry.Point([LON, LAT]);

/** getRegion returns [id, lon, lat, millis, ...bands] rows — one per image. */
async function tryRange(label, start, end) {
  const t0 = Date.now();
  try {
    const col = ee
      .ImageCollection("IDAHO_EPSCOR/GRIDMET")
      .filterDate(start, end)
      .select(["tmmx", "tmmn", "pr"]);

    const rows = await new Promise((resolve, reject) =>
      col.getRegion(point, 4638).evaluate((v, err) => (err ? reject(new Error(err)) : resolve(v)))
    );

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const data = rows.slice(1);
    const first = data[0];
    const last = data[data.length - 1];
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    console.log(
      `${label.padEnd(18)} OK  ${secs.padStart(6)}s  ${String(data.length).padStart(5)} days  ` +
        `${iso(first[3])} -> ${iso(last[3])}`
    );
    // Sanity: convert and print one day.
    console.log(
      `${" ".repeat(20)}sample ${iso(last[3])}: tmax=${(last[4] - 273.15).toFixed(1)}C ` +
        `tmin=${(last[5] - 273.15).toFixed(1)}C pr=${last[6]}mm`
    );
    return data.length;
  } catch (e) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${label.padEnd(18)} FAIL ${secs.padStart(5)}s  ${String(e.message).slice(0, 140)}`);
    return 0;
  }
}

await tryRange("1 year", "2025-01-01", "2026-01-01");
await tryRange("5 years", "2021-01-01", "2026-01-01");
await tryRange("FULL 2000-now", "2000-01-01", "2026-08-25");

process.exit(0);
