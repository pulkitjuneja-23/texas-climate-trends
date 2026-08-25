import type { DailyRecord, FetchOpts, WeatherSource, SourceMeta } from "@/lib/types";

/**
 * gridMET (Abatzoglou, University of Idaho) — 4 km CONUS daily.
 *
 * Built from PRISM (temperature and precipitation climatology) blended with
 * NLDAS-2, so it is effectively PRISM-resolution data with a full agronomic
 * variable set and only a ~3 day lag.
 *
 * TWO TRAPS, both verified against the live server:
 *
 * 1. PACKED INTEGERS. The OPeNDAP/NCSS output returns the RAW stored UInt16 —
 *    scale_factor and add_offset are NOT applied. Worse, the offset DIFFERS BY
 *    VARIABLE: tmmx uses +220 K, tmmn uses +210 K. Applying one offset to both
 *    yields a minimum temperature above the maximum. Values below are read off
 *    the served .das metadata, not guessed.
 *
 * 2. REQUEST SIZE CAP. 365 days in one request returns in ~0.5 s. Anything
 *    materially larger is rejected outright (THREDDS answers 414). And the NCSS
 *    CSV endpoint, which does accept a full range, took 275 s for a single
 *    variable — unusable inside a serverless function. So the series is fetched
 *    in ONE-YEAR CHUNKS, concurrently, and stitched.
 *
 * Cost: ~3 requests per year of record. That is a lot, which is why the result
 * is cached hard upstream and why srad/ET are not fetched by default.
 */

const DODS = "https://thredds.northwestknowledge.net/thredds/dodsC";

/** Read from each dataset's .das — do not "simplify" these. */
interface GridmetVar {
  file: string;
  varName: string;
  scale: number;
  offset: number;
  field: keyof Pick<DailyRecord, "tmax" | "tmin" | "precip" | "srad">;
  /** Convert the unpacked value into our canonical unit. */
  toCanonical: (v: number) => number;
}

const KELVIN_TO_C = (k: number) => k - 273.15;

const VARS: GridmetVar[] = [
  {
    file: "agg_met_tmmx_1979_CurrentYear_CONUS.nc",
    varName: "daily_maximum_temperature",
    scale: 0.1,
    offset: 220.0,
    field: "tmax",
    toCanonical: KELVIN_TO_C,
  },
  {
    file: "agg_met_tmmn_1979_CurrentYear_CONUS.nc",
    varName: "daily_minimum_temperature",
    scale: 0.1,
    offset: 210.0, // NOT 220 — this is the bug that inverts min/max.
    field: "tmin",
    toCanonical: KELVIN_TO_C,
  },
  {
    file: "agg_met_pr_1979_CurrentYear_CONUS.nc",
    varName: "precipitation_amount",
    scale: 0.1,
    offset: 0.0,
    field: "precip",
    toCanonical: (v) => v,
  },
];

/** gridMET grid geometry, from the served coordinate arrays. */
const GRID = {
  lat0: 49.4,
  lon0: -124.76666,
  step: 1 / 24,
  nLat: 585,
  nLon: 1386,
};

/** netCDF `day` axis is days since 1900-01-01; the file starts 1979-01-01. */
const EPOCH = Date.UTC(1900, 0, 1);
const FILE_START_DAY = Math.round((Date.UTC(1979, 0, 1) - EPOCH) / 86400000);

const MISSING = 32767;
const CONCURRENCY = 8;

export const meta: SourceMeta = {
  id: "gridmet",
  name: "gridMET",
  blurb: "4 km PRISM + NLDAS-2 blend with the full agronomic variable set.",
  resolutionKm: 4,
  startYear: 1979,
  latencyDays: 3,
  coverage: "conus",
  attribution:
    "Abatzoglou, J.T. (2013). gridMET, Climatology Lab, University of Idaho.",
  url: "https://www.climatologylab.org/gridmet.html",
  available: true,
  note: "4 km and only ~3 days behind. Built on PRISM, so it is the practical way to get PRISM-grade resolution for a point. Loads in yearly chunks, so the first load for a new spot takes a few seconds.",
};

function latIndex(lat: number): number {
  return Math.min(GRID.nLat - 1, Math.max(0, Math.round((GRID.lat0 - lat) / GRID.step)));
}
function lonIndex(lon: number): number {
  return Math.min(GRID.nLon - 1, Math.max(0, Math.round((lon - GRID.lon0) / GRID.step)));
}

function dayIndex(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / 86400000) - FILE_START_DAY;
}

/**
 * Length of the time axis, read from the served .dds.
 *
 * This is NOT optional bookkeeping. Asking for an index past the end makes
 * THREDDS reject the whole request, and since a failed chunk is tolerated (so
 * one bad year cannot void 25 good ones), an unclamped end index silently drops
 * the entire current year instead of erroring. Clamping is what keeps the most
 * recent — and most interesting — days in the series.
 */
let timeLenCache: { value: number; at: number } | null = null;

async function getTimeLength(signal?: AbortSignal): Promise<number> {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  if (timeLenCache && Date.now() - timeLenCache.at < SIX_HOURS) return timeLenCache.value;

  const res = await fetch(`${DODS}/${VARS[0].file}.dds`, {
    signal,
    next: { revalidate: 60 * 60 * 6 },
  });
  if (!res.ok) throw new Error(`gridMET .dds returned ${res.status}`);
  const text = await res.text();
  const m = text.match(/day\s*=\s*(\d+)/);
  if (!m) throw new Error("gridMET .dds missing day dimension");

  const value = Number(m[1]);
  timeLenCache = { value, at: Date.now() };
  return value;
}

function dayValueToISO(dayValue: number): string {
  return new Date(EPOCH + dayValue * 86400000).toISOString().slice(0, 10);
}

/**
 * Parse the OPeNDAP ASCII payload.
 *
 * Data rows look like `[0][0], 781`; the day axis follows under a
 * `<var>.day[N]` header as comma-separated values. We key off the served day
 * axis rather than re-deriving dates from indices, so an off-by-one in the
 * index maths can never silently shift the whole series by a day.
 */
function parseDods(text: string, varName: string): Array<{ date: string; raw: number }> {
  const body = text.split(/-{10,}/)[1];
  if (!body) return [];

  const values: number[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*\[\d+\]\[\d+\]\s*,\s*(-?[\d.]+)\s*$/);
    if (m) values.push(Number(m[1]));
  }

  const dayHeader = new RegExp(`${varName}\\.day\\[\\d+\\]`);
  const lines = body.split("\n");
  const hIdx = lines.findIndex((l) => dayHeader.test(l));
  const days: number[] = [];
  if (hIdx >= 0) {
    for (let i = hIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) break;
      for (const tok of line.split(",")) {
        const n = Number(tok.trim());
        if (Number.isFinite(n)) days.push(n);
      }
    }
  }

  const n = Math.min(values.length, days.length);
  const out: Array<{ date: string; raw: number }> = [];
  for (let i = 0; i < n; i++) out.push({ date: dayValueToISO(days[i]), raw: values[i] });
  return out;
}

async function fetchChunk(
  v: GridmetVar,
  li: number,
  loi: number,
  startIdx: number,
  endIdx: number,
  signal?: AbortSignal
): Promise<Array<{ date: string; value: number | null }>> {
  const L = "%5B";
  const R = "%5D";
  const q =
    `?${v.varName}${L}${startIdx}:1:${endIdx}${R}` +
    `${L}${li}:1:${li}${R}${L}${loi}:1:${loi}${R}`;

  const res = await fetch(`${DODS}/${v.file}.ascii${q}`, {
    signal,
    next: { revalidate: 60 * 60 * 12 },
  });
  if (!res.ok) throw new Error(`gridMET ${v.varName} returned ${res.status}`);

  const text = await res.text();
  return parseDods(text, v.varName).map(({ date, raw }) => ({
    date,
    value:
      raw === MISSING || !Number.isFinite(raw)
        ? null
        : v.toCanonical(raw * v.scale + v.offset),
  }));
}

/** Run tasks with a concurrency cap so we don't hammer THREDDS. */
async function pool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

export async function fetchDaily(opts: FetchOpts): Promise<DailyRecord[]> {
  const li = latIndex(opts.lat);
  const loi = lonIndex(opts.lon);

  const startYear = Number(opts.start.slice(0, 4));
  const endYear = Number(opts.end.slice(0, 4));

  // Hard ceiling from the dataset itself — the requested end is usually "today",
  // which is several days past the last day gridMET has published.
  const maxIdx = (await getTimeLength(opts.signal)) - 1;

  // One task per (variable, year). 365-day requests are the largest the server
  // reliably accepts.
  const tasks: Array<() => Promise<{ v: GridmetVar; rows: Array<{ date: string; value: number | null }> }>> = [];

  for (const v of VARS) {
    for (let y = startYear; y <= endYear; y++) {
      const chunkStart = y === startYear ? opts.start : `${y}-01-01`;
      const chunkEnd = y === endYear ? opts.end : `${y}-12-31`;
      const si = Math.max(0, dayIndex(chunkStart));
      const ei = Math.min(maxIdx, dayIndex(chunkEnd));
      if (ei < si) continue;
      tasks.push(async () => ({
        v,
        rows: await fetchChunk(v, li, loi, si, ei, opts.signal),
      }));
    }
  }

  const settled = await pool(
    tasks.map((t) => async () => {
      try {
        return await t();
      } catch {
        // A single missing year should not void 25 years of record.
        return null;
      }
    }),
    CONCURRENCY
  );

  const byDate = new Map<string, DailyRecord>();
  for (const s of settled) {
    if (!s) continue;
    for (const row of s.rows) {
      let rec = byDate.get(row.date);
      if (!rec) {
        rec = { date: row.date, tmax: null, tmin: null, tmean: null, precip: null, origin: meta.id };
        byDate.set(row.date, rec);
      }
      (rec as unknown as Record<string, number | null>)[s.v.field] = row.value;
    }
  }

  const out = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const r of out) {
    if (r.tmax !== null && r.tmin !== null) r.tmean = (r.tmax + r.tmin) / 2;
  }
  return out;
}

/**
 * Grass reference evapotranspiration (ETo), mm/day.
 *
 * This is the DEMAND side of the water question: how much a well-watered short
 * grass reference crop would have used. Multiply by a crop coefficient (Kc) and
 * you have estimated crop water need — the standard FAO-56 approach.
 *
 * It is deliberately separate from `fetchDaily` and fetched only on demand.
 * Folding it into the main pull would add ~27 requests (one per year) to every
 * page load for a variable most visitors never open.
 *
 * Complements rather than replaces OpenET: this runs ~3 days behind and covers
 * 1979-present, where OpenET measures ACTUAL ET but starts in late 2015 and
 * lags 1-2 months. Demand now, truth later.
 */
const ETO_VAR: GridmetVar = {
  file: "agg_met_pet_1979_CurrentYear_CONUS.nc",
  varName: "daily_mean_reference_evapotranspiration_grass",
  scale: 0.1,
  offset: 0.0,
  field: "srad", // unused; ETo is returned separately, not on DailyRecord
  toCanonical: (v) => v,
};

export interface DailyEto {
  date: string;
  /** mm/day. */
  eto: number | null;
}

export async function fetchReferenceEt(opts: FetchOpts): Promise<DailyEto[]> {
  const li = latIndex(opts.lat);
  const loi = lonIndex(opts.lon);
  const maxIdx = (await getTimeLength(opts.signal)) - 1;

  const startYear = Number(opts.start.slice(0, 4));
  const endYear = Number(opts.end.slice(0, 4));

  const tasks: Array<() => Promise<Array<{ date: string; value: number | null }>>> = [];
  for (let y = startYear; y <= endYear; y++) {
    const chunkStart = y === startYear ? opts.start : `${y}-01-01`;
    const chunkEnd = y === endYear ? opts.end : `${y}-12-31`;
    const si = Math.max(0, dayIndex(chunkStart));
    const ei = Math.min(maxIdx, dayIndex(chunkEnd));
    if (ei < si) continue;
    tasks.push(async () => {
      try {
        return await fetchChunk(ETO_VAR, li, loi, si, ei, opts.signal);
      } catch {
        return [];
      }
    });
  }

  const chunks = await pool(tasks, CONCURRENCY);
  const byDate = new Map<string, number | null>();
  for (const rows of chunks) {
    for (const r of rows) byDate.set(r.date, r.value);
  }

  return [...byDate.entries()]
    .map(([date, eto]) => ({ date, eto }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

const source: WeatherSource = { meta, fetchDaily };
export default source;
