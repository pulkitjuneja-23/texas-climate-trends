import type { DailyRecord, FetchOpts, WeatherSource, SourceMeta } from "@/lib/types";

/**
 * NASA POWER — daily point API, agroclimatology community.
 *
 * Verified against the live API: no key, no auth, and the full 2000-present
 * daily series for one point comes back in a single request in ~1.5 s.
 *
 * Two behaviours that bite if you don't handle them:
 *   1. Missing values are the literal number -999.0, not null. Left unmapped
 *      they silently destroy every mean you compute.
 *   2. There is a ~5 day processing lag, so the last few days of any request
 *      ending "today" are all -999. lib/sources/openmeteo.ts backfills that
 *      window and the UI marks the backfilled days.
 */

const POWER_FILL = -999.0;
const ENDPOINT = "https://power.larc.nasa.gov/api/temporal/daily/point";

/** POWER parameter -> our field name. Max 20 params per request; we use 8. */
const PARAM_MAP = {
  T2M_MAX: "tmax",
  T2M_MIN: "tmin",
  T2M: "tmean",
  PRECTOTCORR: "precip",
  ALLSKY_SFC_SW_DWN: "srad",
  RH2M: "rh",
  WS2M: "wind",
  T2MDEW: "dew",
} as const;

type PowerParam = keyof typeof PARAM_MAP;

interface PowerResponse {
  properties?: { parameter?: Record<string, Record<string, number>> };
  header?: { fill_value?: number };
  messages?: string[];
}

export const meta: SourceMeta = {
  id: "nasapower",
  name: "NASA POWER",
  blurb: "Satellite + MERRA-2 reanalysis, agroclimatology community. Global, 1981-present.",
  resolutionKm: 55,
  startYear: 1981,
  latencyDays: 5,
  coverage: "global",
  attribution:
    "NASA Prediction Of Worldwide Energy Resources (POWER), Langley Research Center. Funded through the NASA Earth Science/Applied Science Program.",
  url: "https://power.larc.nasa.gov/",
  available: true,
  // MERRA-2 grid. A whole county often falls in one cell, so snapping here
  // collapses a great many separate lookups into one.
  cellDeg: { lat: 0.5, lon: 0.625 },
  note: "~55 km grid cell — one cell spans several Texas counties. Good for climate trends, too coarse to separate one field from the next.",
};

/** "2000-01-01" -> "20000101" */
function compact(iso: string): string {
  return iso.replace(/-/g, "");
}

/** "20000101" -> "2000-01-01" */
function expand(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function clean(v: number | undefined, fill: number): number | null {
  if (v === undefined || v === null) return null;
  if (!Number.isFinite(v)) return null;
  // POWER uses -999; compare with tolerance rather than equality.
  if (Math.abs(v - fill) < 0.01) return null;
  if (v <= -998) return null;
  return v;
}

export async function fetchDaily(opts: FetchOpts): Promise<DailyRecord[]> {
  const params = new URLSearchParams({
    latitude: String(opts.lat),
    longitude: String(opts.lon),
    start: compact(opts.start),
    end: compact(opts.end),
    community: "AG",
    parameters: Object.keys(PARAM_MAP).join(","),
    format: "JSON",
  });

  const res = await fetch(`${ENDPOINT}?${params}`, {
    signal: opts.signal,
    headers: { Accept: "application/json" },
    // Historical data is immutable once past the lag window; cache hard.
    next: { revalidate: 60 * 60 * 6 },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `NASA POWER returned ${res.status}: ${body.slice(0, 300) || res.statusText}`
    );
  }

  const json = (await res.json()) as PowerResponse;
  const bucket = json.properties?.parameter;
  if (!bucket) {
    throw new Error(
      `NASA POWER response missing properties.parameter${
        json.messages?.length ? ` — ${json.messages.join("; ")}` : ""
      }`
    );
  }

  const fill = json.header?.fill_value ?? POWER_FILL;

  // Every parameter is keyed by the same YYYYMMDD set; drive off tmax and fall
  // back to whichever series actually came back, so a partial response still
  // yields rows instead of an empty array.
  const dateKeys = Object.keys(
    bucket.T2M_MAX ?? bucket.PRECTOTCORR ?? Object.values(bucket)[0] ?? {}
  ).sort();

  return dateKeys.map((k) => {
    const rec: DailyRecord = {
      date: expand(k),
      tmax: null,
      tmin: null,
      tmean: null,
      precip: null,
      origin: meta.id,
    };
    for (const [powerName, field] of Object.entries(PARAM_MAP) as [
      PowerParam,
      (typeof PARAM_MAP)[PowerParam]
    ][]) {
      (rec as unknown as Record<string, number | null>)[field] = clean(
        bucket[powerName]?.[k],
        fill
      );
    }
    return rec;
  });
}

const source: WeatherSource = { meta, fetchDaily };
export default source;
