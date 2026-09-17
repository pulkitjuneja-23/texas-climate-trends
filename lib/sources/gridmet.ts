import type { DailyRecord, FetchOpts, WeatherSource, SourceMeta } from "@/lib/types";
import { getEe, getRegionSeries } from "./earthengine";
import { q } from "./precision";
import { readArchivePoint, withheldFrom, type ArchivePoint } from "@/lib/archive/read";

/**
 * gridMET (Abatzoglou, University of Idaho) — 4 km CONUS daily, via Earth Engine.
 *
 * WHY EARTH ENGINE AND NOT THE IDAHO SERVER
 * The original implementation read Idaho's THREDDS server directly. That server
 * refuses any request spanning more than 365 days (731 returns a 414), so a
 * 25-year point series cost 3 variables x 27 years = 81 separate HTTP requests.
 * From a laptop that was ~5 s. From Vercel, where the hop is far longer, it was
 * 73-131 s and for a while timed out entirely at 60 s — on the DEFAULT source.
 *
 * Earth Engine hosts the same dataset as `IDAHO_EPSCOR/GRIDMET`. One
 * `getRegion` call returns the whole series because the extraction happens
 * beside the data. Measured: **9,732 days in ~11 s**, and reference ET arrives
 * in the same response, which also deleted a separate 27-request fetch.
 *
 * Two further wins: EE serves REAL UNITS (Kelvin, mm), so the packed-integer
 * trap is gone — the THREDDS feed returned raw UInt16 whose scale_factor and
 * add_offset differed per variable (tmmx +220 K, tmmn +210 K), and applying one
 * offset to both produced a minimum above the maximum.
 *
 * KNOWN DISCREPANCY, verified against the Idaho server day by day:
 * 9,731 of 9,732 days agree to within 0.04 degC and 0.03 mm. The exception is
 * **2026-01-01**, where EE reads ~11.8 degC low across northern and central
 * Texas — a cold dip between two warm days. The nearby airport gauge recorded
 * 25.6 degC that day, so EE is the wrong one; it looks like an ingestion
 * artifact at the year boundary. One winter day in 9,732 (0.01%), outside the
 * growing season, was judged an acceptable price for removing a timeout on the
 * default source. Revisit if more such days appear.
 */

const COLLECTION = "IDAHO_EPSCOR/GRIDMET";
/** Native gridMET pixel, ~1/24 degree. */
const SCALE_M = 4638;

const KELVIN = 273.15;

export const meta: SourceMeta = {
  id: "gridmet",
  name: "gridMET",
  blurb: "4 km PRISM + NLDAS-2 blend with the full agronomic variable set.",
  resolutionKm: 4,
  startYear: 1979,
  latencyDays: 3,
  coverage: "conus",
  attribution:
    "Abatzoglou, J.T. (2013). gridMET, Climatology Lab, University of Idaho. Served via Google Earth Engine.",
  url: "https://www.climatologylab.org/gridmet.html",
  available: true,
  /** 1/24 degree — the native gridMET cell, ~4 km. */
  cellDeg: { lat: 1 / 24, lon: 1 / 24 },
  note: "The best detail here — 4 km, only ~3 days behind, built on PRISM. Needs the Earth Engine connection.",
};

/** Bands we read. `eto` is grass reference ET, and costs nothing extra here. */
const BANDS = ["tmmx", "tmmn", "pr", "eto"];

/**
 * ONE request for the whole series. Do not split it into parallel chunks.
 *
 * Chunking into six 5-year spans was measurably faster — 10.6 s against 13.7 s
 * — but Earth Engine allows only **40 concurrent requests per project**, and
 * six requests per visitor caps the site at about six simultaneous first-time
 * lookups before Google starts refusing with HTTP 429.
 *
 * One request per visitor raises that ceiling to ~40 for the cost of about
 * three seconds. Throughput under load matters far more here than the fastest
 * possible single answer.
 */
export async function fetchDaily(opts: FetchOpts): Promise<DailyRecord[]> {
  /**
   * Our own archive first.
   *
   * Same gridMET numbers, verified day-by-day against Earth Engine to the
   * packing precision — but pre-transposed, so one field's thirty years is a
   * few small downloads instead of a computation over 11,500 daily grids.
   *
   * It returns null for anything it cannot answer completely: outside Texas,
   * earlier than the archive starts, a chunk that failed to arrive, or a part
   * the refresh has withheld as implausible. Every one of those falls through
   * to Earth Engine below, so the archive can only make the site faster, never
   * break it.
   */
  return withArchive(opts, fromArchive, async (start, end) => {
    const rows = await eeSeries(BANDS, opts.lat, opts.lon, start, end);
    return rows.map((r) => {
      // Rounded because subtracting 273.15 invents digits: gridMET is stored at
      // 0.1 degC precision, but the raw subtraction yields 19.749993896484398.
      // See lib/sources/precision.ts.
      const tmax = q(r.values.tmmx === null ? null : r.values.tmmx - KELVIN);
      const tmin = q(r.values.tmmn === null ? null : r.values.tmmn - KELVIN);
      return {
        date: r.date,
        tmax,
        tmin,
        tmean: tmax !== null && tmin !== null ? q((tmax + tmin) / 2) : null,
        precip: q(r.values.pr),
        origin: meta.id,
      } satisfies DailyRecord;
    });
  });
}

/** One Earth Engine point series, trimmed to the inclusive date range. */
async function eeSeries(bands: string[], lat: number, lon: number, start: string, end: string) {
  const conn = await getEe();
  if (!conn.ee) throw new Error(conn.error);

  const rows = await getRegionSeries(
    conn.ee,
    COLLECTION,
    bands,
    lat,
    lon,
    start,
    // getRegion's end is exclusive; nudge so the final day is included.
    shiftDay(end, 1),
    SCALE_M
  );
  return rows.filter((r) => r.date >= start && r.date <= end);
}

/**
 * Serve from the archive, splitting at a withheld part rather than abandoning it.
 *
 * When the refresh has withheld this year's part (Idaho served impossible
 * values), a request spanning 1996-today would otherwise decline as a whole and
 * send all thirty-one years to Earth Engine. Splitting keeps the sealed years on
 * the fast path and sends only the withheld stretch to Earth Engine.
 */
async function withArchive<T>(
  opts: FetchOpts,
  /** Null when the archive lacks what this caller needs — Earth Engine then serves it all. */
  archive: (a: ArchivePoint) => T[] | null,
  ee: (start: string, end: string) => Promise<T[]>
): Promise<T[]> {
  const whole = await readArchivePoint(opts.lat, opts.lon, opts.start, opts.end);
  const served = whole && archive(whole);
  if (served) return served;

  const cut = await withheldFrom();
  if (cut && cut > opts.start && cut <= opts.end) {
    const older = await readArchivePoint(opts.lat, opts.lon, opts.start, shiftDay(cut, -1));
    const olderRows = older && archive(older);
    if (olderRows) return [...olderRows, ...(await ee(cut, opts.end))];
  }
  return ee(opts.start, opts.end);
}

function fromArchive(archived: ArchivePoint): DailyRecord[] {
  return archived.dates.map((date, i) => {
    // The archive stores Kelvin, as gridMET does. Rounded on the way out for
    // the same reason as the Earth Engine path — see lib/sources/precision.ts.
    const k2c = (v: number | null | undefined) => (v === null || v === undefined ? null : q(v - KELVIN));
    const tmax = k2c(archived.values.tmmx?.[i]);
    const tmin = k2c(archived.values.tmmn?.[i]);
    return {
      date,
      tmax,
      tmin,
      tmean: tmax !== null && tmin !== null ? q((tmax + tmin) / 2) : null,
      precip: q(archived.values.pr?.[i]),
      origin: meta.id,
    } satisfies DailyRecord;
  });
}

function shiftDay(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface DailyEto {
  date: string;
  /** mm/day. */
  eto: number | null;
}

/**
 * Grass reference evapotranspiration (ETo), mm/day — the DEMAND side of the
 * water question: what a well-watered short grass reference crop would use.
 * Multiply by a crop coefficient for estimated crop need (FAO-56).
 *
 * Now the same single Earth Engine call as the weather itself. It previously
 * meant ~27 more requests to Idaho, which is why it was made opt-in.
 */
export async function fetchReferenceEt(opts: FetchOpts): Promise<DailyEto[]> {
  // The archive carries reference ET in the same chunks as the weather, so this
  // costs no extra request when the point is covered.
  return withArchive(
    opts,
    (a) => (a.values.pet ? a.dates.map((date, i) => ({ date, eto: q(a.values.pet[i]) })) : null),
    async (start, end) =>
      (await eeSeries(["eto"], opts.lat, opts.lon, start, end)).map((r) => ({
        date: r.date,
        eto: q(r.values.eto),
      }))
  );
}

const source: WeatherSource = { meta, fetchDaily };
export default source;
