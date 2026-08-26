/** Is Earth Engine's gridMET wrong on 2026-01-01 everywhere, or only at one point? */
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

const pts = [
  ["Lubbock", 33.58, -101.85],
  ["Blackland", 31.3, -97.4],
  ["Amarillo", 35.22, -101.83],
  ["Weslaco", 26.16, -97.99],
];

// A week around the suspect date, so a bad day stands out against its neighbours.
for (const [name, lat, lon] of pts) {
  const rows = (
    await new Promise((resolve, reject) =>
      ee
        .ImageCollection("IDAHO_EPSCOR/GRIDMET")
        .filterDate("2025-12-29", "2026-01-06")
        .select(["tmmx"])
        .getRegion(ee.Geometry.Point([lon, lat]), 4638)
        .evaluate((v, err) => (err ? reject(new Error(err)) : resolve(v)))
    )
  ).slice(1);

  const line = rows
    .sort((a, b) => a[3] - b[3])
    .map((r) => {
      const d = new Date(r[3]).toISOString().slice(5, 10);
      const c = (r[4] - 273.15).toFixed(1);
      return `${d}=${c}`;
    })
    .join("  ");
  console.log(`${name.padEnd(10)} ${line}`);
}
process.exit(0);
