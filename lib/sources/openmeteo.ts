import type { DailyRecord, FetchOpts, WeatherSource, SourceMeta } from "@/lib/types";

/**
 * Open-Meteo — three distinct jobs, three distinct endpoints.
 *
 *   1. DEEP HISTORY (`fetchDaily`, archive-api). ERA5/ERA5-Land reanalysis back
 *      to 1940. This is the endpoint to use as a standalone historical source.
 *
 *   2. GAP FILL (`fetchRecent`, historical-forecast-api). Built from archived
 *      high-resolution forecast runs, so it has data through yesterday and can
 *      close the ~5-day hole NASA POWER leaves at the present.
 *
 *   3. EXTENDED FORECAST (`fetchExtendedForecast`). NWS stops at 7 days;
 *      Open-Meteo runs to 16.
 *
 * These are NOT interchangeable. The archive API carries roughly the same
 * multi-day lag as POWER, so it cannot gap-fill; the historical-forecast API
 * 400s on dates before its archive begins, so it cannot serve deep history.
 * Using one where the other belongs is a silent failure in one direction and a
 * hard 400 in the other.
 *
 * On splicing sources: measured over 2026-08-10..14 at Waco, POWER reported
 * 0.43 / 1.98 / 0.01 / 5.02 mm of rain while Open-Meteo reported 0.00 for all
 * five days. That is a real disagreement, not a bug, and it is the reason the
 * gap-filled window is tagged `gapfill` and drawn differently rather than
 * being blended silently into the observed record.
 */

const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
const RECENT = "https://historical-forecast-api.open-meteo.com/v1/forecast";
const FORECAST = "https://api.open-meteo.com/v1/forecast";

const DAILY_VARS = [
  "temperature_2m_max",
  "temperature_2m_min",
  "temperature_2m_mean",
  "precipitation_sum",
  "shortwave_radiation_sum",
  "wind_speed_10m_max",
  "et0_fao_evapotranspiration",
].join(",");

export const meta: SourceMeta = {
  id: "openmeteo",
  name: "Open-Meteo (ERA5 / IFS)",
  blurb: "ECMWF reanalysis and archived forecast runs. Global, 1940-present, no lag.",
  resolutionKm: 11,
  startYear: 1940,
  latencyDays: 0,
  coverage: "global",
  attribution: "Open-Meteo.com, CC BY 4.0. Underlying data: ECMWF ERA5 / ERA5-Land / IFS.",
  url: "https://open-meteo.com/",
  available: true,
};

interface OMDaily {
  time?: string[];
  temperature_2m_max?: (number | null)[];
  temperature_2m_min?: (number | null)[];
  temperature_2m_mean?: (number | null)[];
  precipitation_sum?: (number | null)[];
  shortwave_radiation_sum?: (number | null)[];
  wind_speed_10m_max?: (number | null)[];
  precipitation_probability_max?: (number | null)[];
  /** WMO 4677 code, forecast only — the archive endpoints are not asked for it. */
  weather_code?: (number | null)[];
}

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function toRecords(daily: OMDaily, origin: string): DailyRecord[] {
  const times = daily.time ?? [];
  return times.map((date, i) => ({
    date,
    tmax: num(daily.temperature_2m_max?.[i]),
    tmin: num(daily.temperature_2m_min?.[i]),
    tmean: num(daily.temperature_2m_mean?.[i]),
    precip: num(daily.precipitation_sum?.[i]),
    srad: num(daily.shortwave_radiation_sum?.[i]),
    // Open-Meteo reports 10 m wind; POWER reports 2 m. Approximate the 2 m
    // equivalent with the standard log-profile factor so the two sources are
    // at least nominally comparable.
    wind: (() => {
      const w10 = num(daily.wind_speed_10m_max?.[i]);
      return w10 === null ? null : w10 * 0.748;
    })(),
    origin,
  }));
}

function buildParams(lat: number, lon: number, start: string, end: string): URLSearchParams {
  return new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    start_date: start,
    end_date: end,
    daily: DAILY_VARS,
    timezone: "America/Chicago",
  });
}

/** ERA5/ERA5-Land reanalysis back to 1940 — the deep-history endpoint. */
export async function fetchDaily(opts: FetchOpts): Promise<DailyRecord[]> {
  const res = await fetch(
    `${ARCHIVE}?${buildParams(opts.lat, opts.lon, opts.start, opts.end)}`,
    { signal: opts.signal, next: { revalidate: 60 * 60 * 6 } }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Open-Meteo archive returned ${res.status}: ${body.slice(0, 200) || res.statusText}`
    );
  }
  const json = (await res.json()) as { daily?: OMDaily };
  return toRecords(json.daily ?? {}, meta.id);
}

/**
 * Archived forecast runs — current through yesterday, used only to close the
 * lag gap left by a slower primary source. Rejects dates before its archive
 * begins, so never call it for deep history.
 */
export async function fetchRecent(opts: FetchOpts): Promise<DailyRecord[]> {
  const res = await fetch(
    `${RECENT}?${buildParams(opts.lat, opts.lon, opts.start, opts.end)}`,
    { signal: opts.signal, next: { revalidate: 60 * 60 * 3 } }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Open-Meteo gap-fill returned ${res.status}: ${body.slice(0, 200) || res.statusText}`
    );
  }
  const json = (await res.json()) as { daily?: OMDaily };
  return toRecords(json.daily ?? {}, meta.id);
}

export interface ExtendedForecastDay extends DailyRecord {
  precipProb: number | null;
  /**
   * WMO 4677 weather code for the day, or null.
   *
   * Requested purely so days 8-16 can carry the same sky symbols as days 1-7.
   * NWS supplies a phrase ("Chance Showers And Thunderstorms") for its own
   * range; Open-Meteo supplies a number, and without it the second tier would
   * be the only strip on the page showing bare figures with no picture.
   */
  weatherCode: number | null;
}

/** Days 1-16 from the GFS/ECMWF seamless blend. */
export async function fetchExtendedForecast(
  lat: number,
  lon: number,
  days = 16,
  signal?: AbortSignal
): Promise<ExtendedForecastDay[]> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: [DAILY_VARS, "precipitation_probability_max", "weather_code"].join(","),
    forecast_days: String(days),
    timezone: "America/Chicago",
  });

  const res = await fetch(`${FORECAST}?${params}`, {
    signal,
    next: { revalidate: 60 * 60 },
  });
  if (!res.ok) {
    throw new Error(`Open-Meteo forecast returned ${res.status}: ${res.statusText}`);
  }
  const json = (await res.json()) as { daily?: OMDaily };
  const daily = json.daily ?? {};
  return toRecords(daily, meta.id).map((r, i) => ({
    ...r,
    precipProb: num(daily.precipitation_probability_max?.[i]),
    weatherCode: num(daily.weather_code?.[i]),
  }));
}

const source: WeatherSource = { meta, fetchDaily };
export default source;
