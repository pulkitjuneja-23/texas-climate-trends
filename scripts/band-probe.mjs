/**
 * Can NCSS serve the FULL 31-year range for a narrow latitude band?
 *
 * This decides the ingest's shape. A chunk spans the whole time axis, so
 * building one needs every year for that block of pixels. Two ways to get there:
 *
 *   by year   download all of Texas one year at a time  -> needs the whole
 *             transposed array in memory, ~1.9 GB per variable. Too big.
 *   by band   download a narrow strip of latitude for ALL years at once ->
 *             ~150 MB at a time, which fits comfortably.
 *
 * Bands are only workable if the server will serve 31 years in one request. It
 * refuses >365 days on the OPeNDAP endpoint (recorded in CLAUDE.md), and NCSS
 * has been tested only to 5 years so far.
 */
const BASE =
  "https://thredds.northwestknowledge.net/thredds/ncss/agg_met_pr_1979_CurrentYear_CONUS.nc";

// 20 rows of latitude at gridMET's 1/24 degree step, full Texas width.
const north = 36.6;
const south = north - 20 / 24;
const bbox = `north=${north}&south=${south}&west=-106.7&east=-93.4`;

for (const [label, start, end] of [
  ["10 years", "2016-01-01", "2025-12-31"],
  ["31 years", "1995-01-01", "2026-08-25"],
]) {
  const url = `${BASE}?var=precipitation_amount&${bbox}&time_start=${start}T00:00:00Z&time_end=${end}T00:00:00Z&accept=netcdf`;
  const t = Date.now();
  try {
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    const secs = (Date.now() - t) / 1000;
    if (!res.ok) {
      console.log(`${label.padEnd(9)} ${res.status}  ${buf.toString("utf8").replace(/\s+/g, " ").slice(0, 200)}`);
      continue;
    }
    const mb = buf.length / 1048576;
    console.log(
      `${label.padEnd(9)} OK  ${secs.toFixed(1).padStart(6)}s  ${mb.toFixed(1).padStart(6)} MB  ${(mb / secs).toFixed(1)} MB/s`
    );
  } catch (e) {
    console.log(`${label.padEnd(9)} ERR ${e.message}`);
  }
}
