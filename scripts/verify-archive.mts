/**
 * Does the archive hold the RIGHT numbers?
 *
 * The ingest turns "all of Texas on one day" into "one field across thirty
 * years". Every bug in that transposition produces a file of plausible weather
 * from the wrong place or the wrong day, and nothing downstream can tell. So
 * this reads a point back out of the store and compares it, day by day, against
 * Earth Engine serving the same gridMET cell.
 *
 * Agreement here means the whole chain is right: the NetCDF reader, the
 * band alignment, the chunk transposition, the compression, and the layout
 * maths that finds a cell again.
 *
 * Run against a local trial slice, or against the live bucket:
 *   node --experimental-strip-types scripts/verify-archive.mts ./tmp/zarr 31.55 -97.15
 *   node --experimental-strip-types scripts/verify-archive.mts --r2 31.55 -97.15
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import {
  locate,
  chunkOf,
  extractSeries,
  chunkKey,
  addDays,
  PREFIX,
  MANIFEST_KEY,
  type Manifest,
  type Part,
} from "../lib/archive/layout.ts";
import { getEe, getRegionSeries } from "../lib/sources/earthengine.ts";

const [source, latArg, lonArg] = process.argv.slice(2);
if (!source) {
  console.error("usage: verify-archive.mts <dir>|--r2 [lat] [lon]");
  process.exit(1);
}
const LAT = Number(latArg ?? 36.3);
const LON = Number(lonArg ?? -101.8);

// Credentials for the Earth Engine cross-check, and the public bucket address.
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const i = line.indexOf("=");
  if (i > 0 && !line.trimStart().startsWith("#")) {
    process.env[line.slice(0, i).trim()] ||= line.slice(i + 1).trim();
  }
}

/**
 * Read a stored object from either a local trial directory or the live bucket.
 * Reading over the public URL exercises the exact path the website uses — no
 * credentials, plain HTTPS — rather than a stand-in for it.
 */
const FROM_R2 = source === "--r2";
const R2_BASE = process.env.NEXT_PUBLIC_R2_URL?.replace(/\/+$/, "");
if (FROM_R2 && !R2_BASE) {
  console.error("NEXT_PUBLIC_R2_URL is not set in .env.local");
  process.exit(1);
}

async function readKey(key: string): Promise<Buffer> {
  if (!FROM_R2) return readFileSync(join(source, key));
  const res = await fetch(`${R2_BASE}/${key}`);
  if (!res.ok) throw new Error(`${res.status} for ${key}`);
  return Buffer.from(await res.arrayBuffer());
}

console.log(FROM_R2 ? `reading from ${R2_BASE}\n` : `reading from ${source}\n`);
const manifest: Manifest = JSON.parse((await readKey(MANIFEST_KEY)).toString("utf8"));
const cell = locate(manifest, LAT, LON);
if (!cell) {
  console.error(`(${LAT}, ${LON}) is outside the archive's coverage.`);
  process.exit(1);
}

console.log(`asked for   ${LAT}, ${LON}`);
console.log(`grid cell   ${cell.lat.toFixed(5)}, ${cell.lon.toFixed(5)}  (index ${cell.latIdx}, ${cell.lonIdx})`);

const PART: Part = "archive";
const pos = chunkOf(PART, cell);
const range = manifest.parts[PART];

// --- read the point out of the store ---
const series: Record<string, (number | null)[]> = {};
for (const [key, vm] of Object.entries(manifest.vars)) {
  let raw: Buffer;
  try {
    raw = zstdDecompressSync(await readKey(chunkKey(PART, key, pos.latChunk, pos.lonChunk)));
  } catch (e) {
    console.log(`  ${key}: not available (${(e as Error).message.slice(0, 70)})`);
    continue;
  }
  const chunk = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const packed = extractSeries(PART, chunk, pos, range.nDays);
  series[key] = Array.from(packed, (v) =>
    v === vm.fillValue ? null : v * vm.scaleFactor + vm.addOffset
  );
}

if (!Object.keys(series).length) {
  console.error("Nothing to verify — that point is not inside the ingested slice.");
  process.exit(1);
}

// --- the same cell, from Earth Engine ---
const CHECK_START = "2024-01-01";
const CHECK_END = "2024-12-31";
const conn = await getEe();
if (!conn.ee) {
  console.error(`Earth Engine unavailable: ${conn.error}`);
  process.exit(1);
}

const eeBands = Object.keys(series).map((k) => (k === "pet" ? "eto" : k));
const rows = await getRegionSeries(
  conn.ee,
  "IDAHO_EPSCOR/GRIDMET",
  eeBands,
  cell.lat,
  cell.lon,
  CHECK_START,
  addDays(CHECK_END, 1),
  4638
);
console.log(`\nEarth Engine returned ${rows.length} days for ${CHECK_START}..${CHECK_END}\n`);

// --- compare, day by day ---
const KELVIN_VARS = new Set(["tmmx", "tmmn"]);
let worst = 0;
let worstAt = "";
let compared = 0;
let mismatches = 0;

for (const key of Object.keys(series)) {
  const eeBand = key === "pet" ? "eto" : key;
  let n = 0;
  let maxDiff = 0;
  let maxAt = "";

  for (const r of rows) {
    const idx = Math.round(
      (Date.parse(`${r.date}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)) / 86_400_000
    );
    if (idx < 0 || idx >= range.nDays) continue;
    const mine = series[key][idx];
    const theirs = r.values[eeBand];
    if (mine === null || theirs === null) continue;

    // Earth Engine unpacks temperature to Kelvin; we store it that way too.
    const diff = Math.abs(mine - theirs);
    n++;
    if (diff > maxDiff) {
      maxDiff = diff;
      maxAt = r.date;
    }
    // gridMET is packed at 0.1, so anything above half a step is a real
    // disagreement rather than rounding.
    if (diff > 0.051) mismatches++;
  }

  compared += n;
  if (maxDiff > worst) {
    worst = maxDiff;
    worstAt = `${key} on ${maxAt}`;
  }
  const unit = KELVIN_VARS.has(key) ? "K" : manifest.vars[key].units;
  console.log(
    `  ${key.padEnd(5)} ${String(n).padStart(4)} days compared   max difference ${maxDiff.toFixed(4)} ${unit}` +
      (maxAt ? `  (${maxAt})` : "")
  );
}

// A spot value, so the numbers are visible rather than only summarised.
const julyIdx = Math.round(
  (Date.parse("2024-07-01T00:00:00Z") - Date.parse(`${range.start}T00:00:00Z`)) / 86_400_000
);
console.log("\n1 July 2024 at this cell, read from the archive:");
for (const key of Object.keys(series)) {
  const v = series[key][julyIdx];
  const extra = KELVIN_VARS.has(key) && v !== null ? `  = ${(v - 273.15).toFixed(2)} degC` : "";
  console.log(`  ${key.padEnd(5)} ${v === null ? "null" : v.toFixed(2)} ${manifest.vars[key].units}${extra}`);
}

console.log(
  `\n${compared} values compared, ${mismatches} disagree by more than half a packing step.`
);
console.log(mismatches === 0 ? "ARCHIVE MATCHES EARTH ENGINE" : `WORST: ${worstAt} (${worst})`);
process.exit(mismatches === 0 ? 0 : 1);
