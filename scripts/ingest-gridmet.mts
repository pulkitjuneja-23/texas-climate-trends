/**
 * Build the Texas gridMET archive and upload it to R2.
 *
 * WHAT IT DOES
 * Downloads gridMET from the University of Idaho for the Texas bounding box,
 * turns it inside out — from "all of Texas on one day" into "one field across
 * thirty years" — and writes it as a Zarr store. That transposition is the
 * whole point: it changes a farmer's lookup from an 18-82 second Earth Engine
 * computation into a couple of small downloads.
 *
 * USAGE
 *   node --experimental-strip-types scripts/ingest-gridmet.mts --out ./tmp/zarr
 *   node --experimental-strip-types scripts/ingest-gridmet.mts --r2
 *   node --experimental-strip-types scripts/ingest-gridmet.mts --r2 --part current
 *   node --experimental-strip-types scripts/ingest-gridmet.mts --out ./tmp --bands 1 --vars pr
 *
 *   --out DIR    write to a local directory instead of R2 (for verification)
 *   --r2         upload to R2 using credentials from .env.local
 *   --part P     only "archive" or only "current" (default: both)
 *   --bands N    stop after N latitude bands (for a quick trial run)
 *   --vars a,b   only these variables (default: all four)
 *   --start YYYY first year of the archive (default 1995)
 *   --force      refresh even if the archive is already up to date
 *   --allow-implausible
 *                publish even when the plausibility checks fail (see step 2b)
 *   --stage-only upload to the spare folder and run both checks, but never
 *                touch the manifest — safe to run against the live bucket
 *
 * THE TWO SCHEDULED JOBS (see .github/workflows/)
 *   daily   --r2 --part current   ~1,371 uploads, a few minutes
 *   yearly  --r2                  full rebuild, ~22,200 uploads, ~25 minutes
 *
 * The daily job re-downloads the WHOLE current part every time rather than
 * appending a day. That is deliberate: gridMET revises its recent days, so an
 * append-only refresh would keep the first, provisional version of every day
 * forever.
 *
 * MEMORY
 * One latitude band at a time, so peak usage is a few hundred MB rather than
 * the ~7.6 GB the whole state would need. Bands are 16 grid rows tall because
 * that is a multiple of BOTH parts' chunk widths (4 and 16) — a band that
 * straddled a chunk boundary would write half-filled chunks that the next band
 * would then overwrite, silently losing rows.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { zstdCompressSync, zstdDecompressSync, constants as zlibConstants } from "node:zlib";
import {
  parseNetCDF3,
  readShorts,
  readDoubles,
  dataVariable,
} from "../lib/archive/netcdf3.ts";
import {
  ARCHIVE_VARS,
  PART_CHUNK_PX,
  PREFIX,
  MANIFEST_VERSION,
  MANIFEST_KEY,
  ARCHIVE_ROLLOVER_MONTH,
  settledThroughYear,
  addDays,
  dayCount,
  partDir,
  chunkKey,
  CURRENT_DIRS,
  type Manifest,
  type Part,
} from "../lib/archive/layout.ts";
import { r2ConfigFromEnv, putMany, getObject, type R2Config } from "../lib/archive/r2.ts";
import {
  monthlyStats,
  implausibleMonths,
  type PlausibilitySample,
} from "../lib/archive/plausibility.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Texas, generously bounded. Trimmed to gridMET's own grid on first contact. */
const BBOX = { north: 36.6, south: 25.8, west: -106.7, east: -93.4 };

/** Grid rows per download. Must divide by every value in PART_CHUNK_PX. */
const BAND_ROWS = 16;

const NCSS = (v: string) =>
  `https://thredds.northwestknowledge.net/thredds/ncss/agg_met_${v}_1979_CurrentYear_CONUS.nc`;

/** zstd level 10: near-maximum ratio, still fast enough for a batch job. */
const ZSTD_LEVEL = 10;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name: string) => argv.includes(`--${name}`);

const OUT_DIR = arg("out");
const TO_R2 = flag("r2");
const ONLY_PART = arg("part") as Part | undefined;
const MAX_BANDS = arg("bands") ? Number(arg("bands")) : Infinity;
/** Resume point, 0-based. Bands are independent, so a failure loses only its own. */
const FROM_BAND = Number(arg("from-band") ?? 0);
const ONLY_VARS = arg("vars")?.split(",");
const START_YEAR = Number(arg("start") ?? 1995);
const FORCE = flag("force");
/** Publish even if the plausibility check fails. Only after checking the data by hand. */
const ALLOW_IMPLAUSIBLE = flag("allow-implausible");
/**
 * Upload to the spare folder and run both checks, but never write the manifest
 * — no promotion, no hold. The live site cannot be affected. Continues past a
 * failed check 1 so that check 2 can be exercised on the same data.
 */
const STAGE_ONLY = flag("stage-only");

if (!OUT_DIR && !TO_R2) {
  console.error("Choose an output: --out <dir> for a local trial, or --r2 to upload.");
  process.exit(1);
}

const VARS = ARCHIVE_VARS.filter((v) => !ONLY_VARS || ONLY_VARS.includes(v.key));
if (!VARS.length) {
  console.error(`No variables matched. Known: ${ARCHIVE_VARS.map((v) => v.key).join(", ")}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Output sinks
// ---------------------------------------------------------------------------

function loadEnv(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(".env.local", "utf8")
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
    );
  } catch {
    return {};
  }
}

let r2: R2Config | null = null;
if (TO_R2) {
  r2 = r2ConfigFromEnv({ ...process.env, ...loadEnv() });
  if (!r2) {
    console.error(
      "R2 credentials missing. Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,\n" +
        "R2_SECRET_ACCESS_KEY and R2_BUCKET in .env.local or the environment."
    );
    process.exit(1);
  }
}

/** A hold only fails the GitHub run (and so emails) once it has lasted this long. */
const ALERT_AFTER_HOURS = 24;
/** ...and then no more often than this. */
const ALERT_EVERY_HOURS = 24;

/**
 * Set once a rollover has switched the archive off for rebuilding.
 *
 * Declared up here, with the thresholds above, because a hold can now be
 * triggered by the very FIRST request to Idaho — before most of this script
 * has run. Anything the hold logic reads has to exist by then.
 */
let buildingRaised = false;

interface Blob {
  key: string;
  body: Buffer;
  opts?: { contentType?: string; cacheControl?: string };
}

/**
 * Chunks are immutable once written for a given rebuild, so they are cached
 * hard. The manifest changes on every rebuild and must not be.
 */
const CHUNK_CACHE = "public, max-age=31536000, immutable";
const META_CACHE = "public, max-age=300";

async function flush(blobs: Blob[], label: string): Promise<number> {
  if (!blobs.length) return 0;
  const bytes = blobs.reduce((n, b) => n + b.body.length, 0);

  if (r2) {
    await putMany(r2, blobs, {
      onProgress: (done, total) => {
        if (done === total) process.stdout.write(`      uploaded ${total} objects\n`);
      },
    });
  } else {
    for (const b of blobs) {
      const path = join(OUT_DIR as string, b.key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, b.body);
    }
  }
  console.log(
    `      ${label}: ${blobs.length} objects, ${(bytes / 1048576).toFixed(1)} MB`
  );
  return bytes;
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

async function fetchSlab(
  v: { file: string; grid: string },
  bbox: { north: number; south: number; west: number; east: number },
  start: string,
  end: string,
  /** Take every Nth cell — for a cheap statewide sample, not for the archive. */
  horizStride = 1
): Promise<Buffer> {
  const qs = new URLSearchParams({
    var: v.grid,
    north: String(bbox.north),
    south: String(bbox.south),
    west: String(bbox.west),
    east: String(bbox.east),
    time_start: `${start}T00:00:00Z`,
    time_end: `${end}T00:00:00Z`,
    // NOT netcdf4 — that returns "NetCDF: HDF error" from this server.
    accept: "netcdf",
  });
  if (horizStride > 1) qs.set("horizStride", String(horizStride));

  return fromIdaho(`downloading ${v.grid} ${start}..${end}`, async () => {
    const res = await fetch(`${NCSS(v.file)}?${qs}`);
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
  });
}

/**
 * Did this request fail because Idaho's server was not there, rather than
 * because it answered with something wrong?
 *
 * The distinction is the whole point. Between 21 and 29 September 2026 the
 * refresh failed seven times and every one was this — `ECONNREFUSED` or a
 * connect timeout against thredds.northwestknowledge.net — and every one
 * emailed "All jobs have failed". Nothing was wrong: the live copy kept
 * serving, and the next run a few hours later succeeded. A three-hourly job
 * against a university server will meet outages routinely, and an alert for
 * each one teaches the owner to ignore alerts.
 *
 * Only a gateway-style 502/503/504 counts as an outage among HTTP errors. A
 * 400 or a plain 500 means Idaho answered and refused THIS request — a
 * malformed query, say — which a retry in three hours will not fix and
 * which somebody should hear about promptly.
 */
function isUnreachable(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (/^(502|503|504)\b/.test(e.message)) return true;
  // Node's fetch reports every network-level failure as a TypeError
  // "fetch failed", with the real reason on `cause`.
  if (e instanceof TypeError && e.message === "fetch failed") return true;
  const code = (e as { code?: string }).code ?? "";
  return /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_)/.test(code);
}

/**
 * Ask Idaho for something, with retries — and if it is simply not there,
 * HOLD rather than crash.
 *
 * A hold keeps the live copy serving, records the reason in the manifest, and
 * exits green; the scheduled run three hours later tries again. It only turns
 * red, and so emails, once the outage has lasted a day — the same rule as a
 * data hold, through the same function, so there is one policy and not two.
 *
 * During a rollover the hold keeps the archive switched off and always alerts,
 * because publishing the pre-rebuild manifest over half-rewritten chunks would
 * serve a plausible, wrong series.
 */
async function fromIdaho<T>(what: string, go: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await go();
    } catch (e) {
      last = e;
      if (attempt < 2) {
        const why = e instanceof Error ? e.message : String(e);
        console.log(`      retrying (${why})`);
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      }
    }
  }
  if (isUnreachable(last)) {
    const cause = (last as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message ?? (last as Error).message;
    await holdAndExit(
      [`Idaho's gridMET server could not be reached while ${what} (${detail}), after three attempts`],
      "Idaho's server was unreachable",
      buildingRaised,
      true
    );
  }
  throw last;
}

// ---------------------------------------------------------------------------
// Zarr metadata
// ---------------------------------------------------------------------------

function zarray(shape: number[], chunks: number[], dtype: string, fill: number | null) {
  return {
    zarr_format: 2,
    shape,
    chunks,
    dtype,
    // numcodecs' zstd codec. Node emits standard zstd frames, so Python's
    // zarr/xarray reads these without anything special.
    compressor: { id: "zstd", level: ZSTD_LEVEL },
    fill_value: fill,
    order: "C",
    filters: null,
  };
}

function json(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj, null, 1));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(0).padStart(4);

// --- 0. Read what the store already holds, before asking Idaho anything ---
// Our own bucket is reliable and Idaho sometimes is not; reading this first
// means an Idaho outage can be recorded as a hold instead of a crash.
/**
 * What the store already says about itself.
 *
 * A partial run MUST NOT invent the ranges of the parts it is not touching.
 * Recomputing them looks harmless and is not: on the first run of a new year a
 * current-only refresh would write "archive covers 1995-2026" into the manifest
 * while the archive chunks still held 1995-2025 — and the reader takes its
 * slicing offsets from the manifest. Every date in the record would shift, with
 * nothing anywhere reporting an error.
 */
const existing: Manifest | null = r2
  ? ((JSON.parse(
      (await getObject(r2, MANIFEST_KEY))?.toString("utf8") ?? "null"
    ) as Manifest | null) ?? null)
  : null;

/**
 * Idaho's latest available day. Declared before the first request so that a
 * hold raised by an outage can refer to it; filled in by step 2.
 */
let latest = "";

// --- 1. Establish the grid from the server, not from assumed parameters ---
console.log("probing the grid ...");
const probe = parseNetCDF3(
  await fetchSlab(VARS[0], BBOX, "2024-07-01", "2024-07-01")
);
const lats = Array.from(readDoubles(probe, "lat"));
const lons = Array.from(readDoubles(probe, "lon"));
const nLat = lats.length;
const nLon = lons.length;
const latStep = lats[1] - lats[0];
const lonStep = lons[1] - lons[0];

console.log(
  `  ${nLat} x ${nLon} cells   lat ${lats[0].toFixed(4)} -> ${lats[nLat - 1].toFixed(4)} ` +
    `(step ${latStep.toFixed(5)})   lon ${lons[0].toFixed(4)} -> ${lons[nLon - 1].toFixed(4)}`
);

// --- 2. Work out the two time ranges ---
const dsXml = await fromIdaho("reading Idaho's latest date", async () => {
  const res = await fetch(`${NCSS(VARS[0].file)}/dataset.xml`);
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.text();
});
latest = (dsXml.match(/<end>([^<]+)<\/end>/)?.[1] ?? "").slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(latest)) {
  throw new Error(`Could not read the latest available date from THREDDS (got "${latest}")`);
}

const PARTS: Part[] = ONLY_PART ? [ONLY_PART] : ["archive", "current"];
const rebuildingArchive = PARTS.includes("archive");


/**
 * Where the archive/current boundary sits.
 *
 * When the archive is being rebuilt, it extends to the last SETTLED year end —
 * which is not simply last year, because a year only settles a month after it
 * finishes (see ARCHIVE_ROLLOVER_MONTH). Otherwise the boundary is wherever the
 * stored archive actually ends, read back rather than assumed.
 *
 * The current part then begins the day after, so the two parts are contiguous
 * by construction. Through January that makes it span ~13 months, which is the
 * intended behaviour: last year stays in the daily-refreshed part, collecting
 * Idaho's revisions, until the rollover seals it.
 */
const today = new Date().toISOString().slice(0, 10);
let archiveEnd: string;

/**
 * A previous rebuild died part-way and left the archive switched off.
 *
 * A current-only refresh must not proceed: it ends by publishing a clean
 * manifest, which would clear the flag and turn the archive back on while its
 * chunks are still half-rewritten. Only a full rebuild can honestly clear this.
 */
if (existing?.building && !rebuildingArchive) {
  console.error(
    `The manifest is flagged building:true, so a previous rebuild did not finish and the\n` +
      `archive is switched off. Refreshing the current part alone would clear that flag and\n` +
      `serve half-rewritten chunks as if they were sound.\n` +
      `Run a full rebuild instead (no --part) to finish what was started.`
  );
  process.exit(1);
}

if (rebuildingArchive) {
  archiveEnd = `${settledThroughYear(today)}-12-31`;
} else if (existing) {
  archiveEnd = existing.parts.archive.end;
  const due = `${settledThroughYear(today)}-12-31`;
  if (archiveEnd < due) {
    console.log(
      `\n  NOTE: the archive ends ${archiveEnd} but ${due} has now settled.\n` +
        `  The annual rebuild is due — run without --part to roll ${due.slice(0, 4)} in.\n` +
        `  Until then it stays in the current part, which is correct but larger.\n`
    );
  }
} else {
  console.error(
    `Cannot refresh "${ONLY_PART}" alone: there is no manifest in the bucket to say where\n` +
      `the archive ends, and guessing it would corrupt every date in the record.\n` +
      `Run a full build first (no --part).`
  );
  process.exit(1);
}

const RANGES: Record<Part, { start: string; end: string }> = {
  archive: { start: existing && !rebuildingArchive ? existing.parts.archive.start : `${START_YEAR}-01-01`, end: archiveEnd },
  current: { start: addDays(archiveEnd, 1), end: latest },
};

if (RANGES.current.start > RANGES.current.end) {
  throw new Error(
    `The archive already ends at ${archiveEnd}, past the latest available day ${latest}. ` +
      `Nothing to refresh.`
  );
}

for (const p of PARTS) {
  console.log(
    `  ${p}: ${RANGES[p].start} -> ${RANGES[p].end}  (${dayCount(RANGES[p].start, RANGES[p].end)} days)`
  );
}
if (rebuildingArchive) {
  console.log(
    `  rollover: years settle in month ${ARCHIVE_ROLLOVER_MONTH}, so the archive seals through ` +
      `${settledThroughYear(today)}`
  );
}

/**
 * --- 2b. Hold, don't publish, when anything looks wrong ---
 *
 * On 2026-09-17 Idaho's own 2026 files began serving January-July as zero rain
 * everywhere and July highs below freezing. Every shape, coordinate and date was
 * right, so every check that existed passed, and the refresh overwrote a good
 * season with that in 77 seconds. The site drew a flat rainfall line for every
 * location in Texas, in front of growers.
 *
 * Since then a refresh never touches the live copy. It is checked TWICE:
 *   1. here, on a cheap statewide sample of what Idaho is serving, before a
 *      single upload is spent; and
 *   2. after uploading to the spare folder, on the chunks as actually stored —
 *      which is what the site would read (step 4b).
 * Only a copy that passes both is promoted. Anything else HOLDS: the previous
 * good copy keeps serving, the reason is recorded in the manifest, and the
 * workflow tries again a few hours later.
 */


/** Appends to the GitHub run page's summary, when running in Actions. */
function summary(markdown: string) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) appendFileSync(path, markdown + "\n");
}

/**
 * Keep serving the last good copy, record why, and stop.
 *
 * Exits 0 for a short hold — a few hours' delay is invisible on the site, since
 * the nearest station fills the most recent days either way, and an email every
 * three hours would teach the owner to ignore them. Exits 1 once the hold has
 * lasted ALERT_AFTER_HOURS, at most once per ALERT_EVERY_HOURS.
 *
 * `keepBuilding` preserves the rebuild flag: once a rollover has started
 * overwriting the archive part, publishing the pre-rebuild manifest would turn
 * the archive back on over half-rewritten chunks.
 */
async function holdAndExit(
  problems: string[],
  stage: string,
  keepBuilding = false,
  /** The hold is ONLY because Idaho could not be reached. See `hold.unreachable`. */
  unreachable = false
): Promise<never> {
  const now = new Date().toISOString();
  const prev = existing?.hold;
  const since = prev?.since ?? now;
  const heldHours = (Date.parse(now) - Date.parse(since)) / 3.6e6;
  const sinceAlert = prev?.lastAlert ? (Date.parse(now) - Date.parse(prev.lastAlert)) / 3.6e6 : Infinity;
  const alert = keepBuilding || (heldHours >= ALERT_AFTER_HOURS && sinceAlert >= ALERT_EVERY_HOURS);

  /*
    An outage on top of a DATA hold must not overwrite it. The data problem is
    still unresolved — Idaho merely could not be asked about it this time — and
    it is the reason that matters when somebody reads the manifest.
  */
  const dataHoldStands = Boolean(unreachable && prev && !prev.unreachable);
  const reason =
    dataHoldStands && prev
      ? prev.reason
      : `${stage}: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ""}`;

  console.error(`\nHOLDING — not publishing. ${stage}:`);
  for (const p of problems) console.error(`  ${p}`);

  if (STAGE_ONLY) {
    console.error(`\n--stage-only: the manifest was not touched.`);
    process.exit(1);
  }

  if (r2 && existing) {
    const held: Manifest = {
      ...existing,
      ...(keepBuilding ? { building: true } : {}),
      hold: {
        since,
        lastTry: now,
        reason,
        // An outage can strike before Idaho's latest date has been read.
        upstreamEnd: latest || prev?.upstreamEnd || "",
        ...(unreachable && !dataHoldStands ? { unreachable: true } : {}),
        ...(alert ? { lastAlert: now } : prev?.lastAlert ? { lastAlert: prev.lastAlert } : {}),
      },
    };
    await flush(
      [
        {
          key: MANIFEST_KEY,
          body: json(held),
          opts: { contentType: "application/json", cacheControl: META_CACHE },
        },
      ],
      "hold recorded"
    );
  }

  const serving = existing
    ? existing.parts.current.withheld
      ? `The site is reading ${existing.parts.current.start.slice(0, 4)} from Earth Engine (the stored copy was withheld earlier).`
      : `The site keeps serving the last good copy, through ${existing.parts.current.end}.`
    : `Nothing is published yet.`;
  const heldFor = heldHours < 1 ? "just started" : `held for ${heldHours.toFixed(0)} hours`;

  console.error(
    `\n${serving}\nNothing new was published (${heldFor}). The next scheduled run tries again.` +
      (alert ? `\nFailing this run so GitHub sends an alert.` : "") +
      (unreachable && !dataHoldStands
        ? `\nNothing is wrong with the data; Idaho's server did not answer.`
        : `\nIf the data has been checked by hand and is genuinely right, re-run with --allow-implausible.`)
  );
  summary(
    `## gridMET update held — nothing published\n\n` +
      `**${stage}** (${heldFor}):\n\n${problems.map((p) => `- ${p}`).join("\n")}\n\n${serving}\n`
  );
  process.exit(alert ? 1 : 0);
}

/**
 * Nothing new upstream — stop before spending a single upload.
 *
 * Idaho's feed stalls for days at a time, and the workflow now runs every few
 * hours, so this is by far the commonest outcome and must stay cheap. A hold or
 * a withheld part is never "already current": Idaho may have repaired its file
 * without advancing the latest date, and only a run can find that out.
 */
if (!rebuildingArchive && existing && !FORCE) {
  const c = existing.parts.current;
  /*
    A hold that exists ONLY because Idaho was unreachable does not need a full
    re-download to clear: we have just reached Idaho, and if it has nothing new
    then the live copy is already current. Dropping the hold here costs one
    small manifest write instead of re-staging ~1,400 chunks of a copy that was
    never wrong. A DATA hold still takes the full path, because only a real
    download can show that Idaho has repaired its file.
  */
  const outageOnly = existing.hold?.unreachable === true;
  if (
    c.end === RANGES.current.end &&
    c.start === RANGES.current.start &&
    !c.withheld &&
    (!existing.hold || outageOnly)
  ) {
    if (outageOnly && r2 && !STAGE_ONLY) {
      const { hold: _cleared, ...rest } = existing;
      await flush(
        [
          {
            key: MANIFEST_KEY,
            body: json(rest),
            opts: { contentType: "application/json", cacheControl: META_CACHE },
          },
        ],
        "outage hold cleared"
      );
      console.log(`\nIdaho is reachable again and has nothing new; the outage hold is cleared.`);
    }
    console.log(
      `\nAlready current: gridMET's latest day is ${latest} and the archive already holds it.\n` +
        `Nothing uploaded. Use --force to refresh anyway.`
    );
    process.exit(0);
  }
}

/** The plausibility rules, applied to a sample, with the monthly figures logged. */
function judge(label: string, sample: PlausibilitySample): string[] {
  const stats = monthlyStats(sample);
  console.log(`  ${label} (${sample.cells} cells):`);
  for (const s of stats) {
    console.log(
      `    ${s.month}  range ${s.meanRangeK.toFixed(1)} K  high ${s.meanTmaxC.toFixed(1)} degC  ` +
        `wet ${(s.wetShare * 100).toFixed(1)}%  missing ${(s.fillShare * 100).toFixed(0)}%`
    );
  }
  const problems = implausibleMonths(stats);
  if (problems.length && ALLOW_IMPLAUSIBLE) {
    console.log(`\n  CONTINUING DESPITE ${problems.length} FAILED CHECKS (--allow-implausible):`);
    for (const p of problems) console.log(`    ${p}`);
    return [];
  }
  return problems;
}

// Idaho moving its latest day BACKWARDS means its feed is mid-rebuild. Publishing
// would silently delete days the site already shows.
if (existing && !rebuildingArchive && RANGES.current.end < existing.parts.current.end) {
  await holdAndExit(
    [`Idaho's latest day is ${latest}, but the live copy already runs to ${existing.parts.current.end}`],
    "Idaho's feed went backwards"
  );
}

/**
 * Check 1: a 1-in-8 statewide sample of what Idaho is serving — about 1 MB per
 * variable and a few seconds. When rebuilding the archive, the year being sealed
 * is included too, because once sealed nothing ever rewrites it.
 */
{
  const checkStart = rebuildingArchive ? `${archiveEnd.slice(0, 4)}-01-01` : RANGES.current.start;
  const checkEnd = RANGES.current.end;
  const STRIDE = 8;

  const sampleOf = async (key: string) => {
    const v = ARCHIVE_VARS.find((x) => x.key === key)!;
    const nc = parseNetCDF3(await fetchSlab(v, BBOX, checkStart, checkEnd, STRIDE));
    const dv = dataVariable(nc);
    const scale = Number(dv.attrs.scale_factor ?? 1);
    const offset = Number(dv.attrs.add_offset ?? 0);
    const fill = Number(dv.attrs._FillValue ?? 32767);
    const raw = readShorts(nc, dv.name);
    const values = Array.from(raw, (r) => (r === fill ? null : r * scale + offset));
    return { values, days: dv.shape[0], cells: dv.shape[1] * dv.shape[2] };
  };

  const [tx, tn, pr] = await Promise.all(["tmmx", "tmmn", "pr"].map(sampleOf));
  const nCheckDays = dayCount(checkStart, checkEnd);
  if ([tx, tn, pr].some((s) => s.days !== nCheckDays || s.cells !== tx.cells)) {
    await holdAndExit(
      [
        `expected ${nCheckDays} days, got ${tx.days}/${tn.days}/${pr.days} ` +
          `with ${tx.cells}/${tn.cells}/${pr.cells} cells`,
      ],
      "Idaho's sample came back misshapen"
    );
  }

  const problems = judge(`check 1 — Idaho's data, ${checkStart} -> ${checkEnd}`, {
    dates: Array.from({ length: nCheckDays }, (_, i) => addDays(checkStart, i)),
    tmax: tx.values,
    tmin: tn.values,
    precip: pr.values,
    cells: tx.cells,
  });
  if (problems.length && STAGE_ONLY) {
    console.log(`\n  --stage-only: check 1 failed (${problems.length} problems); continuing to exercise check 2`);
  } else if (problems.length) {
    await holdAndExit(problems, "Idaho is serving impossible weather");
  }
}

/**
 * Which folder each part is written to.
 *
 * The archive part is rewritten in place under the `building` flag, as before.
 * The current part goes to whichever of CURRENT_DIRS is NOT live, so the live
 * copy is never touched until the new one has passed check 2 and the manifest
 * is pointed at it.
 */
const liveCurrentDir = existing ? partDir(existing, "current") : CURRENT_DIRS[0];
const DIR: Record<Part, string> = {
  archive: "archive",
  current: !r2
    ? CURRENT_DIRS[0]
    : liveCurrentDir === CURRENT_DIRS[0]
      ? CURRENT_DIRS[1]
      : CURRENT_DIRS[0],
};
const writtenAt = new Date().toISOString();

// A --vars run would stage a folder whose other variables are days old — and a
// different length — and then promote it. Staging only works whole.
if (r2 && PARTS.includes("current") && VARS.length !== ARCHIVE_VARS.length) {
  console.error(
    `--vars cannot be combined with the current part: it is written to a spare folder and\n` +
      `promoted as a whole, so every variable must be written. Drop --vars.`
  );
  process.exit(1);
}
if (PARTS.includes("current")) {
  console.log(`  current part: live in "${liveCurrentDir}", writing to "${DIR.current}"`);
}

// --- 3. Per-variable packing metadata, read from the header ---
const varMeta: Manifest["vars"] = {};
for (const v of VARS) {
  const a = dataVariable(probe).attrs;
  const head =
    v.key === VARS[0].key
      ? probe
      : parseNetCDF3(await fetchSlab(v, BBOX, "2024-07-01", "2024-07-01"));
  const at = dataVariable(head).attrs;
  varMeta[v.key] = {
    grid: v.grid,
    field: v.field,
    scaleFactor: Number(at.scale_factor ?? 1),
    addOffset: Number(at.add_offset ?? 0),
    fillValue: Number(at._FillValue ?? 32767),
    units: String(at.units ?? ""),
  };
  void a;
  console.log(
    `  ${v.key.padEnd(5)} scale=${varMeta[v.key].scaleFactor} offset=${varMeta[v.key].addOffset} ` +
      `fill=${varMeta[v.key].fillValue} units=${varMeta[v.key].units}`
  );
}

/**
 * --- 3b. Switch the archive off for the duration of a rebuild ---
 *
 * Writing the manifest LAST protects a FIRST build: until it exists, a
 * half-uploaded store is simply invisible. It does nothing for a REBUILD, where
 * a valid manifest is already live and describing chunks that are being
 * overwritten underneath it — and where a rollover changes how many days each
 * part holds, so the reader's slicing offsets go wrong rather than merely stale.
 *
 * Raising `building` makes the site fall back to Earth Engine for the ~25
 * minutes this takes. Slow once a year beats a plausible, wrong series.
 *
 * A refresh of the current part alone does not need this: its shape does not
 * change, and a reader catching it mid-upload sees yesterday's values for a few
 * cells, not misaligned ones.
 */
const needsBuildingFlag = Boolean(r2 && existing && rebuildingArchive);
if (needsBuildingFlag) {
  await flush(
    [
      {
        key: MANIFEST_KEY,
        body: json({ ...(existing as Manifest), building: true }),
        opts: { contentType: "application/json", cacheControl: META_CACHE },
      },
    ],
    "archive switched off for rebuild"
  );
  buildingRaised = true;

  /**
   * If the rebuild dies half-way, the flag stays up and the site keeps serving
   * correct-but-slow Earth Engine answers indefinitely. That is the right
   * direction to fail in, but it is invisible — so say plainly what to do.
   */
  process.on("exit", (code) => {
    if (code !== 0) {
      console.error(
        `\nTHE ARCHIVE IS STILL SWITCHED OFF. This run did not finish, so the manifest\n` +
          `still has building:true and the site is falling back to Earth Engine — correct\n` +
          `answers, but 18-82 s instead of 1.7 s. Re-run this command to restore it.`
      );
    }
  });
}

// --- 4. Band loop ---
const nBands = Math.min(Math.ceil(nLat / BAND_ROWS), MAX_BANDS);
let totalBytes = 0;
let totalObjects = 0;

for (let band = FROM_BAND; band < nBands; band++) {
  const row0 = band * BAND_ROWS;
  const row1 = Math.min(row0 + BAND_ROWS, nLat); // exclusive
  const rows = row1 - row0;

  /**
   * A QUARTER of a cell of slack, not a half.
   *
   * A half-step lands exactly on the boundary between two cells, and NCSS
   * selects every cell its box touches — so rounding decided whether the
   * neighbouring row came too. Band 1 asked for 16 rows and got 18. A quarter
   * step stays strictly inside the intended cells' extents, so no neighbour can
   * be caught. The extraction below no longer depends on this being exact, but
   * getting it right keeps the downloads the size they should be.
   */
  const padLat = Math.abs(latStep) / 4;
  const bandBox = {
    north: lats[row0] + padLat,
    south: lats[row1 - 1] - padLat,
    west: BBOX.west,
    east: BBOX.east,
  };

  for (const v of VARS) {
    for (const part of PARTS) {
      const { start, end } = RANGES[part];
      const nDays = dayCount(start, end);
      const px = PART_CHUNK_PX[part];

      const t0 = Date.now();
      const raw = await fetchSlab(v, bandBox, start, end);
      const nc = parseNetCDF3(raw);
      const dv = dataVariable(nc);

      /**
       * Find the wanted rows and columns INSIDE whatever came back.
       *
       * The server decides for itself which cells its bounding box touches, so
       * a request can legitimately return a row or column more than asked for.
       * Matching on the coordinate values rather than assuming the shape means
       * an extra edge row is trimmed instead of silently shifting every value
       * in the band by one cell — which would look entirely normal downstream.
       */
      const gotLats = readDoubles(nc, "lat");
      const gotLons = readDoubles(nc, "lon");
      const gotRows = dv.shape[1];
      const gotCols = dv.shape[2];
      const tol = Math.abs(latStep) / 100;

      const nearest = (arr: Float64Array, want: number) => {
        for (let i = 0; i < arr.length; i++) if (Math.abs(arr[i] - want) < tol) return i;
        return -1;
      };

      const latOff = nearest(gotLats, lats[row0]);
      const lonOff = nearest(gotLons, lons[0]);

      if (dv.shape[0] !== nDays) {
        throw new Error(
          `Band ${band} ${v.key}/${part}: expected ${nDays} days, got ${dv.shape[0]}`
        );
      }
      if (latOff < 0 || lonOff < 0) {
        throw new Error(
          `Band ${band} ${v.key}/${part}: could not find lat ${lats[row0]} / lon ${lons[0]} ` +
            `in the response (lat ${gotLats[0]}..${gotLats[gotRows - 1]})`
        );
      }
      if (latOff + rows > gotRows || lonOff + nLon > gotCols) {
        throw new Error(
          `Band ${band} ${v.key}/${part}: response covers [${gotRows}, ${gotCols}] from ` +
            `offset [${latOff}, ${lonOff}], too small for [${rows}, ${nLon}]`
        );
      }
      // Every row must line up, not just the first — a server that returned a
      // coarser or reordered grid would pass the offset check alone.
      for (let r = 0; r < rows; r++) {
        if (Math.abs(gotLats[latOff + r] - lats[row0 + r]) > tol) {
          throw new Error(
            `Band ${band} row ${r}: latitude ${gotLats[latOff + r]}, expected ${lats[row0 + r]}`
          );
        }
      }

      const src = readShorts(nc, dv.name); // [day][lat][lon], C order

      // --- transpose into chunks ---
      const latChunk0 = row0 / px; // exact: BAND_ROWS divides by every px
      const nLatChunks = Math.ceil(rows / px);
      const nLonChunks = Math.ceil(nLon / px);
      const fill = varMeta[v.key].fillValue;

      const blobs: Blob[] = [];
      for (let ci = 0; ci < nLatChunks; ci++) {
        for (let cj = 0; cj < nLonChunks; cj++) {
          // Zarr pads edge chunks to the full shape, so every chunk is the
          // same size and readers can use a constant stride.
          const out = new Int16Array(nDays * px * px).fill(fill);

          // Source indices carry latOff/lonOff so any extra edge rows or
          // columns the server included are skipped rather than shifting
          // everything by a cell.
          for (let t = 0; t < nDays; t++) {
            const srcDay = t * gotRows * gotCols;
            const dstDay = t * px * px;
            for (let la = 0; la < px; la++) {
              const srcRow = ci * px + la;
              if (srcRow >= rows) break;
              const srcBase = srcDay + (latOff + srcRow) * gotCols + lonOff + cj * px;
              const dstBase = dstDay + la * px;
              for (let lo = 0; lo < px; lo++) {
                if (cj * px + lo >= nLon) break;
                out[dstBase + lo] = src[srcBase + lo];
              }
            }
          }

          const bytes = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
          blobs.push({
            key: chunkKey(DIR[part], v.key, latChunk0 + ci, cj),
            body: zstdCompressSync(bytes, {
              params: { [zlibConstants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
            }),
            // The current folders are reused on alternate refreshes, so their
            // chunks must not be cached as immutable. The reader also puts the
            // write time on the URL; this is the second line of defence.
            opts: { cacheControl: part === "current" ? META_CACHE : CHUNK_CACHE },
          });
        }
      }

      const written = await flush(
        blobs,
        `band ${band + 1}/${nBands} ${v.key}/${part}`
      );
      totalBytes += written;
      totalObjects += blobs.length;
      console.log(
        `[${elapsed()}s] band ${band + 1}/${nBands} rows ${row0}-${row1 - 1} ${v.key}/${part}` +
          `  ${(raw.length / 1048576).toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(0)}s` +
          `  -> ${(written / 1048576).toFixed(1)} MB  (${((written / raw.length) * 100).toFixed(0)}% of source)`
      );
    }
  }
}

/**
 * --- 4b. Check 2: read the upload back before anything points at it ---
 *
 * Check 1 judged what Idaho sent. This judges what was actually STORED, read
 * the way the site reads it: fetched from R2, decompressed, unpacked with the
 * manifest's scale and offset. It catches a fault anywhere between download and
 * disk — a transposition slip, a truncated upload, wrong packing — none of
 * which check 1 can see.
 *
 * Samples 35 of the 340 chunks, spread across the state (missing the padded
 * southern edge row, whose fill would skew the missing-data rule), and every
 * 4th cell in each: ~560 cells, ~105 small downloads, a few seconds.
 */
const wholeGrid = MAX_BANDS >= Math.ceil(nLat / BAND_ROWS);
if (r2 && PARTS.includes("current") && wholeGrid) {
  const part: Part = "current";
  const px = PART_CHUNK_PX[part];
  const nDays = dayCount(RANGES.current.start, RANGES.current.end);
  const fullLatChunks = Math.floor(nLat / px);
  const nLonChunks = Math.ceil(nLon / px);
  const picks: [number, number][] = [];
  for (let ci = 1; ci < fullLatChunks; ci += 3) {
    for (let cj = 1; cj < nLonChunks; cj += 3) picks.push([ci, cj]);
  }
  const cellsPerChunk = Math.ceil(px / 4) ** 2;
  const cells = picks.length * cellsPerChunk;
  const sample: PlausibilitySample = {
    dates: Array.from({ length: nDays }, (_, i) => addDays(RANGES.current.start, i)),
    tmax: new Array(nDays * cells).fill(null),
    tmin: new Array(nDays * cells).fill(null),
    precip: new Array(nDays * cells).fill(null),
    cells,
  };
  const target: Record<string, (number | null)[]> = {
    tmmx: sample.tmax,
    tmmn: sample.tmin,
    pr: sample.precip,
  };

  const problems: string[] = [];
  await Promise.all(
    picks.flatMap(([ci, cj], p) =>
      Object.entries(target).map(async ([key, out]) => {
        const where = `${DIR.current}/${key}/0.${ci}.${cj}`;
        const stored = await getObject(r2!, chunkKey(DIR.current, key, ci, cj));
        if (!stored) return void problems.push(`${where} is missing from the upload`);
        let chunk: Int16Array;
        try {
          const flat = zstdDecompressSync(stored);
          chunk = new Int16Array(flat.buffer, flat.byteOffset, flat.byteLength / 2);
        } catch (e) {
          return void problems.push(`${where} does not decompress (${String(e).slice(0, 60)})`);
        }
        if (chunk.length !== nDays * px * px) {
          return void problems.push(
            `${where} holds ${chunk.length / (px * px)} days, expected ${nDays}`
          );
        }
        const vm = varMeta[key];
        for (let t = 0; t < nDays; t++) {
          let c = 0;
          for (let la = 0; la < px; la += 4) {
            for (let lo = 0; lo < px; lo += 4, c++) {
              const raw = chunk[t * px * px + la * px + lo];
              out[t * cells + p * cellsPerChunk + c] =
                raw === vm.fillValue ? null : raw * vm.scaleFactor + vm.addOffset;
            }
          }
        }
      })
    )
  );

  if (problems.length) {
    await holdAndExit(problems.slice(0, 10), "The upload did not read back intact", needsBuildingFlag);
  }
  const judged = judge(`check 2 — the stored copy in "${DIR.current}"`, sample);
  if (judged.length) {
    await holdAndExit(judged, "The stored copy failed the plausibility check", needsBuildingFlag);
  }
  console.log(`  check 2 passed — promoting "${DIR.current}"`);
}

// --- 5. Zarr metadata and the manifest ---
const meta: Blob[] = [{ key: `${PREFIX}/.zgroup`, body: json({ zarr_format: 2 }) }];

for (const part of PARTS) {
  const nDays = dayCount(RANGES[part].start, RANGES[part].end);
  const px = PART_CHUNK_PX[part];
  meta.push({ key: `${PREFIX}/${DIR[part]}/.zgroup`, body: json({ zarr_format: 2 }) });

  for (const v of VARS) {
    const vm = varMeta[v.key];
    meta.push({
      key: `${PREFIX}/${DIR[part]}/${v.key}/.zarray`,
      body: json(zarray([nDays, nLat, nLon], [nDays, px, px], "<i2", vm.fillValue)),
    });
    // _ARRAY_DIMENSIONS is what lets xarray open this as a labelled dataset;
    // scale_factor/add_offset let it unpack the integers automatically.
    meta.push({
      key: `${PREFIX}/${DIR[part]}/${v.key}/.zattrs`,
      body: json({
        _ARRAY_DIMENSIONS: ["day", "lat", "lon"],
        scale_factor: vm.scaleFactor,
        add_offset: vm.addOffset,
        units: vm.units,
        long_name: vm.grid,
        missing_value: vm.fillValue,
      }),
    });
  }
}

/**
 * A withheld part is cleared only by a run that rewrote ALL of it. A
 * `--part archive` run leaves the current chunks as they were, and a `--vars pr`
 * run leaves the temperature chunks as they were — either may still be the bad
 * copy, so neither may vouch for the part.
 */
function stillWithheld(part: Part): { withheld?: string } {
  const reason = existing?.parts[part]?.withheld;
  const rewroteWhole = PARTS.includes(part) && VARS.length === ARCHIVE_VARS.length;
  return reason && !rewroteWhole ? { withheld: reason } : {};
}

const manifest: Manifest = {
  version: MANIFEST_VERSION,
  builtAt: new Date().toISOString(),
  lat0: lats[0],
  lon0: lons[0],
  latStep,
  lonStep,
  nLat,
  nLon,
  parts: {
    archive: {
      ...RANGES.archive,
      nDays: dayCount(RANGES.archive.start, RANGES.archive.end),
      ...stillWithheld("archive"),
    },
    current: {
      ...RANGES.current,
      nDays: dayCount(RANGES.current.start, RANGES.current.end),
      ...stillWithheld("current"),
      // Point the site at the folder just written and checked — or, when this
      // run did not write the current part, leave it where it was.
      ...(PARTS.includes("current")
        ? { dir: DIR.current, writtenAt }
        : {
            ...(existing?.parts.current.dir ? { dir: existing.parts.current.dir } : {}),
            ...(existing?.parts.current.writtenAt
              ? { writtenAt: existing.parts.current.writtenAt }
              : {}),
          }),
    },
  },
  // Publishing a checked current part ends any hold; a run that did not touch
  // it has nothing to say about one.
  ...(!PARTS.includes("current") && existing?.hold ? { hold: existing.hold } : {}),
  // A --vars run must not delete the variables it did not touch from the
  // manifest: the reader iterates this list, so a dropped entry silently
  // removes that variable from every lookup while its chunks sit there intact.
  vars: { ...(existing?.vars ?? {}), ...varMeta },
};

/**
 * A band-limited trial has only written part of the state, so publishing a
 * manifest for it would advertise a store full of holes as complete. Local
 * `--out` runs are exempt — nothing reads those.
 */
const partialRun = MAX_BANDS < Math.ceil(nLat / BAND_ROWS);
if (STAGE_ONLY) {
  console.log(
    `\n--stage-only: both checks passed on "${DIR.current}". The manifest was not touched, ` +
      `so the site still reads "${liveCurrentDir}".`
  );
} else if (partialRun && r2) {
  console.log(
    `\nSTOPPING SHORT OF THE MANIFEST: --bands ${MAX_BANDS} wrote only part of the grid.\n` +
      `The chunks are uploaded, but the manifest is unchanged, so nothing serves them.\n` +
      `Re-run without --bands to publish.` +
      (needsBuildingFlag ? `\nNOTE: the archive is still switched off — re-run to restore it.` : "")
  );
} else {
  meta.push({
    key: MANIFEST_KEY,
    body: json(manifest),
    opts: { contentType: "application/json", cacheControl: META_CACHE },
  });

  await flush(meta, "metadata");
}

console.log(
  `\ndone in ${elapsed()}s — ${totalObjects + meta.length} objects, ` +
    `${(totalBytes / 1073741824).toFixed(2)} GB` +
    (MAX_BANDS < Infinity ? `  (PARTIAL: only ${nBands} of ${Math.ceil(nLat / BAND_ROWS)} bands)` : "")
);
