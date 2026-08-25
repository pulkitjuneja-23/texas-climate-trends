import type { DailyRecord, FetchOpts, WeatherSource, SourceMeta } from "@/lib/types";

/**
 * Daymet v4 (ORNL DAAC) — 1 km daily, the finest grid available here.
 *
 * The single-pixel API returns the whole requested range as CSV in ~2 s, which
 * makes it by far the cheapest of the gridded sources to query.
 *
 * TWO QUIRKS, both verified live:
 *
 * 1. NO DAY 366. Daymet forces a 365-day year by DISCARDING 31 DECEMBER in leap
 *    years — it does not drop 29 February. So `yday` maps straight onto the
 *    calendar (yday 60 in 2020 really is 29 Feb) and the only missing date is
 *    31 Dec of leap years. Naive yday->date arithmetic that "corrects" for leap
 *    years shifts every date after February by one day.
 *
 * 2. BIG LAG. Released annually. Checked 2026-08-21: the latest available day
 *    was 2025-365. Roughly 8 months behind, so Daymet can NEVER show the current
 *    season. Asking for a range past the end of the record makes the API ignore
 *    the range and return everything, so the request is clamped.
 *
 * Radiation is served as W/m^2 daylight-average; we convert to MJ/m^2/day to
 * match the other sources, which needs the daylight period (`dayl`, seconds).
 */

const ENDPOINT = "https://daymet.ornl.gov/single-pixel/api/data";

export const meta: SourceMeta = {
  id: "daymet",
  name: "Daymet",
  blurb: "1 km daily surface weather from ORNL. The finest grid here.",
  resolutionKm: 1,
  startYear: 1980,
  latencyDays: 240,
  coverage: "conus",
  attribution:
    "Thornton, M.M. et al. (2022). Daymet: Daily Surface Weather Data on a 1-km Grid for North America, Version 4 R1. ORNL DAAC.",
  url: "https://daymet.ornl.gov/",
  available: true,
  note: "Finest resolution of any source here (1 km), but it is released once a year — it runs roughly 8 months behind and cannot show the current season. Best for studying past years, not tracking this one.",
};

/** Daymet drops 31 Dec in leap years, so yday maps directly onto the calendar. */
function ydayToISO(year: number, yday: number): string {
  const d = new Date(Date.UTC(year, 0, 1));
  d.setUTCDate(d.getUTCDate() + (yday - 1));
  return d.toISOString().slice(0, 10);
}

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const v = Number(s.trim());
  return Number.isFinite(v) ? v : null;
}

export async function fetchDaily(opts: FetchOpts): Promise<DailyRecord[]> {
  // Clamp to what Daymet can actually serve. Overshooting makes it ignore the
  // range entirely and return the full 1980-present record.
  const latestYear = new Date().getUTCFullYear() - 1;
  const endYear = Math.min(Number(opts.end.slice(0, 4)), latestYear);
  const startYear = Number(opts.start.slice(0, 4));
  if (endYear < startYear) return [];

  const start = opts.start;
  const end = endYear < Number(opts.end.slice(0, 4)) ? `${endYear}-12-31` : opts.end;

  const params = new URLSearchParams({
    lat: String(opts.lat),
    lon: String(opts.lon),
    vars: "tmax,tmin,prcp,srad,dayl",
    start,
    end,
  });

  const res = await fetch(`${ENDPOINT}?${params}`, {
    signal: opts.signal,
    next: { revalidate: 60 * 60 * 24 },
  });
  if (!res.ok) {
    throw new Error(`Daymet returned ${res.status}: ${res.statusText}`);
  }

  const text = await res.text();
  const lines = text.split("\n");

  // Skip the metadata preamble; the header row starts with "year,yday".
  const headerIdx = lines.findIndex((l) => /^year,\s*yday/.test(l.trim()));
  if (headerIdx < 0) throw new Error("Daymet response missing header row");

  const header = lines[headerIdx].split(",").map((h) => h.trim());
  const col = (frag: string) => header.findIndex((h) => h.startsWith(frag));

  const iYear = col("year");
  const iYday = col("yday");
  const iTmax = col("tmax");
  const iTmin = col("tmin");
  const iPrcp = col("prcp");
  const iSrad = col("srad");
  const iDayl = col("dayl");

  const out: DailyRecord[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(",");
    const year = num(parts[iYear]);
    const yday = num(parts[iYday]);
    if (year === null || yday === null) continue;

    const tmax = num(parts[iTmax]);
    const tmin = num(parts[iTmin]);
    const sradW = iSrad >= 0 ? num(parts[iSrad]) : null;
    const dayl = iDayl >= 0 ? num(parts[iDayl]) : null;

    out.push({
      date: ydayToISO(year, yday),
      tmax,
      tmin,
      tmean: tmax !== null && tmin !== null ? (tmax + tmin) / 2 : null,
      precip: iPrcp >= 0 ? num(parts[iPrcp]) : null,
      // W/m^2 over the daylight period -> MJ/m^2/day
      srad: sradW !== null && dayl !== null ? (sradW * dayl) / 1e6 : null,
      origin: meta.id,
    });
  }

  // The API can ignore the requested window; enforce it ourselves.
  return out.filter((r) => r.date >= opts.start && r.date <= opts.end);
}

const source: WeatherSource = { meta, fetchDaily };
export default source;
