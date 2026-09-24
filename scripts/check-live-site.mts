/**
 * Do the numbers ON THE WEBSITE look like real weather?
 *
 * The refresh checks the archive before publishing it (see ingest-gridmet.mts
 * step 2b). This checks the far end of the chain: what a visitor is actually
 * served, through Earth Engine, the Supabase cache, the station top-up and the
 * CDN. On 2026-09-17 a grower was shown a flat 2026 rainfall line; this is the
 * check that would have said so first.
 *
 *   node --experimental-strip-types scripts/check-live-site.mts
 *   node --experimental-strip-types scripts/check-live-site.mts http://localhost:3000
 *
 * Asks /api/history for eight places spread across Texas and judges the
 * current year's gridded days (not the station top-up) together. Exits 1 with a
 * plain-language list of what looks wrong, so a scheduled GitHub run emails.
 *
 * It can only ALERT. It cannot fix anything: if the archive is fine and this
 * still fails, look at the Supabase cache (3 h on the current year) and at
 * Earth Engine.
 */
import { appendFileSync } from "node:fs";
import {
  monthlyStats,
  implausibleMonths,
  longestSharedDrySpell,
} from "../lib/archive/plausibility.ts";

/**
 * The address a visitor actually uses, so the check exercises the same path
 * they do. The original `texas-climate-trends.vercel.app` now redirects here,
 * and while `fetch` would follow that, checking the redirect rather than the
 * site is one indirection this job does not need.
 */
const SITE = (process.argv[2] ?? "https://www.farmwth.com").replace(/\/+$/, "");
const SOURCE = "gridmet";

/**
 * Spread east to west and north to south, all inland — a coastal point's small
 * daily temperature range would sit uncomfortably near the range rule.
 */
const PLACES: [string, number, number][] = [
  ["Blackland Prairie", 31.3, -97.4],
  ["Lubbock", 33.58, -101.85],
  ["Amarillo", 35.19, -101.85],
  ["San Angelo", 31.46, -100.44],
  ["Tyler", 32.35, -95.3],
  ["College Station", 30.63, -96.33],
  ["Uvalde", 29.21, -99.79],
  ["Abilene", 32.45, -99.73],
];

/**
 * gridMET runs ~3 days behind, and a held refresh adds up to a few more. Past
 * this, the gridded record has stopped moving and the station top-up is
 * carrying far more of the season than it should.
 */
const MAX_LAG_DAYS = 10;
/**
 * Eight places across Texas sharing this many consecutive days without a
 * single one of them recording rain is not weather. The east sees rain most
 * weeks even when the west is in drought.
 */
const MAX_SHARED_DRY_DAYS = 45;

interface Row {
  date: string;
  tmax: number | null;
  tmin: number | null;
  precip: number | null;
  provenance?: string;
}

const today = new Date().toISOString().slice(0, 10);
const year = today.slice(0, 4);
const problems: string[] = [];
const series = new Map<string, Map<string, Row>>();
let lastGridded = "";

for (const [name, lat, lon] of PLACES) {
  const url = `${SITE}/api/history?lat=${lat}&lon=${lon}&source=${SOURCE}`;
  const t0 = Date.now();
  let body: { records?: Row[] } | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(240_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (e) {
    problems.push(`${name}: the site did not answer (${e instanceof Error ? e.message : e})`);
    continue;
  }

  const rows = (body?.records ?? []).filter(
    (r) => r.date >= `${year}-01-01` && r.provenance === "observed"
  );
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!rows.length) {
    problems.push(`${name}: no ${year} data from ${SOURCE} at all`);
    continue;
  }

  const last = rows[rows.length - 1].date;
  if (last > lastGridded) lastGridded = last;
  const rain = rows.reduce((n, r) => n + (r.precip ?? 0), 0) / 25.4;
  console.log(`${name.padEnd(18)} ${rows.length} days to ${last}, ${rain.toFixed(1)} in so far  (${secs}s)`);
  series.set(name, new Map(rows.map((r) => [r.date, r])));
}

// --- freshness ---
const lagDays = lastGridded
  ? Math.round((Date.parse(today) - Date.parse(lastGridded)) / 864e5)
  : Infinity;
if (lagDays > MAX_LAG_DAYS) {
  problems.push(
    `the newest gridMET day on the site is ${lastGridded || "missing"}, ${lagDays} days ago ` +
      `(normally about 3) — the daily update may be stuck`
  );
}

// --- plausibility, all places judged together ---
if (series.size) {
  const dates: string[] = [];
  for (let d = `${year}-01-01`; d <= lastGridded; ) {
    dates.push(d);
    const n = new Date(`${d}T12:00:00Z`);
    n.setUTCDate(n.getUTCDate() + 1);
    d = n.toISOString().slice(0, 10);
  }
  const places = [...series.values()];
  const pick = (f: "tmax" | "tmin" | "precip", unit: (v: number) => number) =>
    dates.flatMap((d) =>
      places.map((p) => {
        const v = p.get(d)?.[f];
        return v === null || v === undefined ? null : unit(v);
      })
    );
  const toK = (c: number) => c + 273.15;

  const sample = {
    dates,
    tmax: pick("tmax", toK),
    tmin: pick("tmin", toK),
    precip: pick("precip", (v) => v),
    cells: places.length,
  };

  const stats = monthlyStats(sample);
  for (const s of stats) {
    console.log(
      `  ${s.month}  range ${s.meanRangeK.toFixed(1)} K  high ${s.meanTmaxC.toFixed(1)} degC  ` +
        `wet ${(s.wetShare * 100).toFixed(1)}%  missing ${(s.fillShare * 100).toFixed(0)}%`
    );
  }
  problems.push(...implausibleMonths(stats, { statewideDryRule: false }));

  const dry = longestSharedDrySpell(dates, sample.precip, sample.cells);
  console.log(`  longest spell with no rain at any of the ${places.length} places: ${dry.days} days`);
  if (dry.days >= MAX_SHARED_DRY_DAYS) {
    problems.push(
      `no rain at ANY of ${places.length} places across Texas for ${dry.days} days ` +
        `(${dry.from} to ${dry.to}) — this is the flat-line fault`
    );
  }
}

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (problems.length) {
  console.error(`\nTHE WEBSITE IS SHOWING DATA THAT LOOKS WRONG (${SITE}):`);
  for (const p of problems) console.error(`  - ${p}`);
  if (summaryPath) {
    appendFileSync(
      summaryPath,
      `## Website data looks wrong\n\n${problems.map((p) => `- ${p}`).join("\n")}\n`
    );
  }
  process.exit(1);
}

console.log(`\nWebsite data looks realistic.`);
if (summaryPath) {
  appendFileSync(
    summaryPath,
    `## Website data looks realistic\n\n${series.size} places checked, newest gridMET day ${lastGridded}.\n`
  );
}
