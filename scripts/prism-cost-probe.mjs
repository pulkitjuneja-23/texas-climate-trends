/**
 * What would a PRISM archive actually cost to build?
 *
 * The web service has no regional subsetting — every request returns the whole
 * continental US for one variable on one day. So a Texas archive means
 * downloading ~99% data we discard, ~46,000 times. This measures the real file
 * size and throughput so the decision is made on numbers rather than on the
 * word "infeasible".
 */
import { unzipSync } from "fflate";

const BASE = "https://services.nacse.org/prism/data/get";
const VARS = ["ppt", "tmax", "tmin", "tdmean"];

let totalBytes = 0;
let totalSecs = 0;

for (const v of VARS) {
  const t = Date.now();
  const res = await fetch(`${BASE}/us/4km/${v}/20240701`);
  const buf = Buffer.from(await res.arrayBuffer());
  const secs = (Date.now() - t) / 1000;
  totalBytes += buf.length;
  totalSecs += secs;

  // What is actually inside the zip? The archive would have to parse it.
  let inner = "";
  try {
    const files = unzipSync(new Uint8Array(buf));
    inner = Object.entries(files)
      .map(([n, d]) => `${n} (${(d.length / 1048576).toFixed(1)} MB)`)
      .join(", ");
  } catch (e) {
    inner = `could not unzip: ${e instanceof Error ? e.message : e}`;
  }

  console.log(`${v.padEnd(7)} ${(buf.length / 1048576).toFixed(2)} MB in ${secs.toFixed(1)}s`);
  console.log(`        contains: ${inner.slice(0, 200)}`);
}

const avgMb = totalBytes / VARS.length / 1048576;
const avgSecs = totalSecs / VARS.length;
const days = 11560; // 1995-01-01 to now
const requests = days * VARS.length;

console.log(`\naverage ${avgMb.toFixed(2)} MB in ${avgSecs.toFixed(1)}s per file\n`);
console.log(`a 1995-present Texas archive from this service would need:`);
console.log(`  requests          ${requests.toLocaleString()}`);
console.log(`  downloaded        ${((requests * avgMb) / 1024).toFixed(0)} GB`);
console.log(`  serial time       ${((requests * avgSecs) / 3600).toFixed(0)} hours`);
console.log(`  at 8 in parallel  ${((requests * avgSecs) / 3600 / 8).toFixed(1)} hours`);
console.log(`\nof which the Texas fraction actually kept is roughly 9%.`);
