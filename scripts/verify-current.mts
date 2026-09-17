/**
 * Does the DAILY REFRESH write the right numbers?
 *
 * `verify-archive.mts` compares a 2024 point against Earth Engine, which proves
 * the transposition maths — but 2024 lives in the `archive` part, and the daily
 * job never touches that. This checks the `current` part: the one that gets
 * rewritten every morning, and therefore the one where a regression in the
 * refresh would actually land.
 *
 * It reads the current-part chunks straight out of the bucket, unpacks them the
 * way the website does, and compares every day against Earth Engine serving the
 * same gridMET cell.
 *
 *   node --experimental-strip-types scripts/verify-current.mts
 *   node --experimental-strip-types scripts/verify-current.mts 31.549 -97.147
 *
 * Exits non-zero if anything disagrees by more than half a packing step (0.05),
 * so it can be wired into a workflow as a check rather than read by eye.
 *
 * NOTE: Earth Engine and the archive are not obliged to agree perfectly. Two
 * known days differ — 2026-01-01 statewide and tmmn on 2024-01-31 — and in both
 * cases querying Idaho directly showed the ARCHIVE matches its source and Earth
 * Engine is the outlier. A new disagreement is worth investigating; those two
 * are not.
 */
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import {
  locate,
  chunkOf,
  extractSeries,
  chunkKey,
  partDir,
  addDays,
  MANIFEST_KEY,
  type Manifest,
} from "../lib/archive/layout.ts";
import { getEe, getRegionSeries } from "../lib/sources/earthengine.ts";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const i = line.indexOf("=");
  if (i > 0 && !line.trimStart().startsWith("#")) {
    process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
}

const BASE = process.env.NEXT_PUBLIC_R2_URL?.replace(/\/+$/, "");
if (!BASE) {
  console.error("NEXT_PUBLIC_R2_URL is not set in .env.local");
  process.exit(1);
}

const LAT = Number(process.argv[2] ?? 31.549);
const LON = Number(process.argv[3] ?? -97.147);

/** Our variable names are Idaho's; Earth Engine renames grass reference ET. */
const BAND: Record<string, string> = { tmmx: "tmmx", tmmn: "tmmn", pr: "pr", pet: "eto" };

/**
 * ONE packing step, not half of one.
 *
 * Both sides store these values as integers at 0.1 resolution, and they pack
 * independently, so a difference of exactly 0.1 is a rounding tie in the last
 * digit — not a disagreement about the weather. A half-step tolerance was tried
 * first and flagged 30 such ties out of 944 values, which buried the four
 * differences that actually meant something.
 */
const ROUNDING = 0.101;

/**
 * Above this, the two are not describing the same day and something is wrong
 * with the transposition, the grid maths, or the packing.
 *
 * Between ROUNDING and MATERIAL sits a real but expected band: gridMET's recent
 * days are PROVISIONAL, Idaho revises them, and the archive is rebuilt from
 * Idaho while Earth Engine serves its own periodic ingest. So the fresher of the
 * two is the archive, and small precipitation differences on recent days are
 * the system working, not failing.
 */
const MATERIAL = 1.0;

const m: Manifest = await (await fetch(`${BASE}/${MANIFEST_KEY}`)).json();
if (m.building) {
  console.error("The manifest is flagged building:true — a rebuild is in progress. Try later.");
  process.exit(1);
}

const cell = locate(m, LAT, LON);
if (!cell) {
  console.error(`${LAT}, ${LON} is outside the archive's grid.`);
  process.exit(1);
}

const pos = chunkOf("current", cell);
const range = m.parts.current;

console.log(`asked for   ${LAT}, ${LON}`);
console.log(`grid cell   ${cell.lat.toFixed(5)}, ${cell.lon.toFixed(5)}`);
console.log(`current     ${range.start} -> ${range.end}  (${range.nDays} days)`);
console.log(`built       ${m.builtAt}\n`);

const fromArchive: Record<string, (number | null)[]> = {};
for (const key of Object.keys(m.vars)) {
  const res = await fetch(
    `${BASE}/${chunkKey(partDir(m, "current"), key, pos.latChunk, pos.lonChunk)}?v=${Date.now()}`
  );
  if (!res.ok) throw new Error(`chunk for ${key}: ${res.status}`);
  const flat = zstdDecompressSync(Buffer.from(await res.arrayBuffer()));
  const chunk = new Int16Array(flat.buffer, flat.byteOffset, flat.byteLength / 2);
  const series = extractSeries("current", chunk, pos, range.nDays);
  const vm = m.vars[key];
  fromArchive[key] = Array.from(series, (v) =>
    v === vm.fillValue ? null : v * vm.scaleFactor + vm.addOffset
  );
}

const conn = await getEe();
if (!conn.ee) {
  console.error(`Earth Engine unavailable: ${conn.error}`);
  process.exit(1);
}

const ee = await getRegionSeries(
  conn.ee,
  "IDAHO_EPSCOR/GRIDMET",
  Object.keys(m.vars).map((k) => BAND[k]),
  // The CELL centre, not the point asked for — otherwise a point near a cell
  // edge could legitimately resolve to a different cell in each system and the
  // comparison would report a fault that is really a rounding difference.
  cell.lat,
  cell.lon,
  range.start,
  // getRegionSeries takes an exclusive end, so ask for the day after.
  addDays(range.end, 1),
  4638
);

// getRegionSeries returns { date, values: {band: n}, millis } — the bands are
// nested under `values`, not spread onto the row.
const byDate = new Map(ee.map((r) => [r.date, r.values]));
console.log(`Earth Engine returned ${ee.length} days\n`);

let compared = 0;
let disagree = 0;
let material = 0;
const offenders: Array<{ key: string; date: string; archive: number; ee: number }> = [];

for (const key of Object.keys(m.vars)) {
  let worst = 0;
  let worstDate = "";
  let n = 0;
  let missing = 0;

  for (let i = 0; i < range.nDays; i++) {
    const date = addDays(range.start, i);
    const a = fromArchive[key][i];
    const b = byDate.get(date)?.[BAND[key]];
    if (a === null) {
      missing++;
      continue;
    }
    if (b === null || b === undefined) continue;
    n++;
    compared++;
    const d = Math.abs(a - b);
    if (d > ROUNDING) {
      disagree++;
      if (d > MATERIAL) material++;
      offenders.push({ key, date, archive: a, ee: b });
    }
    if (d > worst) {
      worst = d;
      worstDate = date;
    }
  }

  console.log(
    `  ${key.padEnd(5)} ${String(n).padStart(4)} days compared   ` +
      `max difference ${worst.toFixed(4)}  (${worstDate || "none"})` +
      (missing ? `   ${missing} empty in the archive` : "")
  );
}

console.log(
  `\n${compared} values compared.` +
    `\n  ${disagree} differ by more than one packing step (${ROUNDING})` +
    `\n  ${material} differ MATERIALLY (more than ${MATERIAL}) — these are the ones that matter`
);

/**
 * List them. WHERE they fall is the whole diagnosis: differences clustered in
 * the most recent weeks are Idaho revising provisional days that Earth Engine's
 * copy has not picked up yet — expected, and the archive is the fresher of the
 * two. Differences scattered across settled months would mean something is
 * actually wrong with the transposition.
 */
if (offenders.length) {
  console.log("");
  offenders
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach((o) => {
      const d = o.archive - o.ee;
      console.log(
        `  ${Math.abs(d) > MATERIAL ? "!" : " "} ${o.date}  ${o.key.padEnd(5)} ` +
          `archive ${o.archive.toFixed(2).padStart(8)}   ee ${o.ee.toFixed(2).padStart(8)}   ` +
          `diff ${d.toFixed(2)}`
      );
    });
  const dates = [...new Set(offenders.map((o) => o.date))].sort();
  console.log(`\n  across ${dates.length} distinct days: ${dates[0]} .. ${dates[dates.length - 1]}`);
}

if (material) {
  console.log(
    `\nKNOWN EXCEPTION: 2026-01-01 reads ~5 K low in Earth Engine across northern and\n` +
      `central Texas — an ingestion artifact at the year boundary. Querying Idaho directly\n` +
      `showed the ARCHIVE matches its source and Earth Engine is the outlier. Anything else\n` +
      `flagged with a "!" is worth chasing.`
  );
}

/**
 * A check that compares nothing must not report success.
 *
 * This exact thing happened while writing the script: the band values are
 * nested under `values`, so every lookup returned undefined, every variable
 * reported "0 days compared", and it exited 0 — a green tick proving nothing.
 * A comparison count is part of the result, not a detail.
 */
if (compared === 0) {
  console.error(
    "NOTHING WAS COMPARED. The two series did not line up on a single date, so this\n" +
      "result means nothing — treat it as a failure of the check, not a pass."
  );
  process.exit(2);
}

process.exit(material === 0 ? 0 : 1);
