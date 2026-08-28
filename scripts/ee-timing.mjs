/**
 * Times the raw Earth Engine calls in isolation, outside Next.js.
 *
 * /api/history was measured at 24-73 s on localhost with ONE user, against the
 * ~11 s recorded when gridMET moved to Earth Engine. This separates "Earth
 * Engine is slow" from "our request path is slow".
 */
import { readFileSync } from "node:fs";
import ee from "@google/earthengine";

const key = JSON.parse(readFileSync("./earthengine-key.json", "utf8"));
const project = process.env.GEE_PROJECT_ID || key.project_id;

const t0 = Date.now();
await new Promise((resolve, reject) =>
  ee.data.authenticateViaPrivateKey(
    key,
    () => ee.initialize(null, null, resolve, reject, null, project),
    reject
  )
);
console.log(`auth + init            ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const point = (lat, lon) => ee.Geometry.Point([lon, lat]);

function timeIt(label, fn) {
  const t = Date.now();
  return new Promise((resolve) =>
    fn((v, err) => {
      const secs = (Date.now() - t) / 1000;
      const n = Array.isArray(v) ? v.length - 1 : v?.features?.length ?? 0;
      console.log(`${label.padEnd(22)} ${secs.toFixed(1)}s  rows=${n}${err ? `  ERR ${err}` : ""}`);
      resolve(secs);
    })
  );
}

// The exact call lib/sources/gridmet.ts makes.
for (const [lat, lon] of [
  [31.55, -97.15],
  [32.78, -96.8],
  [33.58, -101.86],
]) {
  await timeIt(`gridmet ${lat},${lon}`, (cb) =>
    ee
      .ImageCollection("IDAHO_EPSCOR/GRIDMET")
      .filterDate("2000-01-01", "2026-08-28")
      .select(["tmmx", "tmmn", "pr", "eto"])
      .getRegion(point(lat, lon), 4638)
      .evaluate(cb)
  );
}

// Does asking for fewer bands help? gridmet.ts always requests four.
await timeIt("gridmet 3 bands", (cb) =>
  ee
    .ImageCollection("IDAHO_EPSCOR/GRIDMET")
    .filterDate("2000-01-01", "2026-08-28")
    .select(["tmmx", "tmmn", "pr"])
    .getRegion(point(31.55, -97.15), 4638)
    .evaluate(cb)
);

// Does a shorter range scale linearly, or is there fixed overhead?
await timeIt("gridmet 5 years", (cb) =>
  ee
    .ImageCollection("IDAHO_EPSCOR/GRIDMET")
    .filterDate("2021-01-01", "2026-01-01")
    .select(["tmmx", "tmmn", "pr", "eto"])
    .getRegion(point(31.55, -97.15), 4638)
    .evaluate(cb)
);

process.exit(0);
