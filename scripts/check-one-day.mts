/**
 * Settle a disagreement between the archive and Earth Engine by asking the
 * original source directly.
 *
 * The archive is built from Idaho's THREDDS server; Earth Engine holds its own
 * ingestion of the same dataset. CLAUDE.md already records one day where the
 * two genuinely differ (2026-01-01, where the airport gauge proved Earth Engine
 * wrong). So a mismatch is not automatically our bug — but it has to be
 * attributed rather than assumed either way.
 *
 * Run: node --experimental-strip-types scripts/check-one-day.mts tmmn 2024-01-31 31.56667 -97.14167
 */
import { parseNetCDF3, readShorts, dataVariable, readDoubles } from "../lib/archive/netcdf3.ts";

const [varFile = "tmmn", date = "2024-01-31", latS = "31.56667", lonS = "-97.14167"] =
  process.argv.slice(2);
const lat = Number(latS);
const lon = Number(lonS);

const GRIDS: Record<string, string> = {
  tmmn: "daily_minimum_temperature",
  tmmx: "daily_maximum_temperature",
  pr: "precipitation_amount",
  pet: "daily_mean_reference_evapotranspiration_grass",
};

// A quarter-cell box around the point, so exactly one cell comes back.
const pad = 1 / 24 / 4;
const url =
  `https://thredds.northwestknowledge.net/thredds/ncss/agg_met_${varFile}_1979_CurrentYear_CONUS.nc` +
  `?var=${GRIDS[varFile]}&north=${lat + pad}&south=${lat - pad}&west=${lon - pad}&east=${lon + pad}` +
  `&time_start=${date}T00:00:00Z&time_end=${date}T00:00:00Z&accept=netcdf`;

const nc = parseNetCDF3(Buffer.from(await (await fetch(url)).arrayBuffer()));
const dv = dataVariable(nc);
const raw = readShorts(nc, dv.name);
const lats = readDoubles(nc, "lat");
const lons = readDoubles(nc, "lon");

const scale = Number(dv.attrs.scale_factor ?? 1);
const offset = Number(dv.attrs.add_offset ?? 0);
const value = raw[0] * scale + offset;

console.log(`THREDDS — the archive's own source`);
console.log(`  cell      ${lats[0].toFixed(5)}, ${lons[0].toFixed(5)}   (${raw.length} cell(s) returned)`);
console.log(`  ${varFile} on ${date}`);
console.log(`  raw packed value  ${raw[0]}`);
console.log(`  unpacked          ${value.toFixed(2)} ${dv.attrs.units}`);
if (String(dv.attrs.units).includes("K")) {
  console.log(`                    ${(value - 273.15).toFixed(2)} degC`);
}
