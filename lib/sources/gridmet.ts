import type { DailyRecord, FetchOpts, WeatherSource, SourceMeta } from "@/lib/types";
import { getEe, getRegionSeries } from "./earthengine";

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
  note: "The best detail here — 4 km, only ~3 days behind, built on PRISM. Needs the Earth Engine connection.",
};

/** Bands we read. `eto` is grass reference ET, and costs nothing extra here. */
const BANDS = ["tmmx", "tmmn", "pr", "eto"];

/**
 * Split a range into ~5-year spans.
 *
 * One call for 25 years works, but Earth Engine parallelises across separate
 * calls better than it does within one: measured 13.7 s as a single request
 * versus 10.6 s as five concurrent ones. Unlike the Idaho server, there is no
 * cap forcing this — it is purely a speed choice, so the spans are large.
 */
function fiveYearSpans(start: string, end: string): Array<[string, string]> {
  const spans: Array<[string, string]> = [];
  const endYear = Number(end.slice(0, 4));
  let y = Number(start.slice(0, 4));
  let from = start;
  while (y <= endYear) {
    const nextY = Math.min(y + 5, endYear + 1);
    const to = nextY > endYear ? shiftDay(end, 1) : `${nextY}-01-01`;
    spans.push([from, to]);
    from = to;
    y = nextY;
  }
  return spans;
}

export async function fetchDaily(opts: FetchOpts): Promise<DailyRecord[]> {
  const conn = await getEe();
  if (!conn.ee) throw new Error(conn.error);

  const spans = fiveYearSpans(opts.start, opts.end);
  const chunks = await Promise.all(
    spans.map(([s, e]) =>
      getRegionSeries(conn.ee, COLLECTION, BANDS, opts.lat, opts.lon, s, e, SCALE_M)
    )
  );

  const rows = chunks.flat().sort((a, b) => a.millis - b.millis);

  return rows
    .filter((r) => r.date >= opts.start && r.date <= opts.end)
    .map((r) => {
      const tmax = r.values.tmmx === null ? null : r.values.tmmx - KELVIN;
      const tmin = r.values.tmmn === null ? null : r.values.tmmn - KELVIN;
      return {
        date: r.date,
        tmax,
        tmin,
        tmean: tmax !== null && tmin !== null ? (tmax + tmin) / 2 : null,
        precip: r.values.pr,
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
  const conn = await getEe();
  if (!conn.ee) throw new Error(conn.error);

  const chunks = await Promise.all(
    fiveYearSpans(opts.start, opts.end).map(([s, e]) =>
      getRegionSeries(conn.ee, COLLECTION, ["eto"], opts.lat, opts.lon, s, e, SCALE_M)
    )
  );

  return chunks
    .flat()
    .sort((a, b) => a.millis - b.millis)
    .filter((r) => r.date >= opts.start && r.date <= opts.end)
    .map((r) => ({ date: r.date, eto: r.values.eto }));
}

const source: WeatherSource = { meta, fetchDaily };
export default source;
