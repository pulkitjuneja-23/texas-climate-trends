import type { DailyRecord, FetchOpts, WeatherSource, SourceMeta } from "@/lib/types";
import { q } from "./precision";

/**
 * Airport weather stations (ASOS/AWOS), served from the Iowa Environmental
 * Mesonet archive at Iowa State.
 *
 * This is the only source here that is an ACTUAL INSTRUMENT rather than a
 * model. Everything else — POWER, ERA5, gridMET, Daymet — is interpolated or
 * reanalysed. When a grower says "we got an inch and a half", this is the
 * source that can agree or disagree with them on its own terms.
 *
 * Trade-off: it is a point, not a grid. A station 30 miles away in a
 * thunderstorm climate can easily miss rain that fell on the field, and vice
 * versa. Distance to the station is therefore returned and shown, not hidden.
 *
 * NOTE ON TEXMESONET: the Texas Water Development Board's TexMesonet publishes
 * a station list at /api/Stations but exposes no documented public endpoint for
 * the observations themselves (probed 2026-08-21 — every data path 404s). If
 * one is found later it slots in beside this file.
 */

const NETWORK_API = "https://mesonet.agron.iastate.edu/api/1/network";
const DAILY_API = "https://mesonet.agron.iastate.edu/cgi-bin/request/daily.py";
const UA = "TexasClimateTrends/0.1 (contact via repo issues)";

/** Networks searched for a nearby station, in preference order. */
const NETWORKS = ["TX_ASOS", "OK_ASOS", "NM_ASOS", "LA_ASOS", "AR_ASOS"];

export interface StationInfo {
  id: string;
  name: string;
  lat: number;
  lon: number;
  county: string | null;
  network: string;
  archiveBegin: string | null;
  distanceKm: number;
}

export const meta: SourceMeta = {
  id: "stations",
  name: "Airport stations",
  blurb: "Real instrument readings from the nearest airport (ASOS/AWOS).",
  resolutionKm: 0,
  startYear: 1948,
  latencyDays: 0,
  coverage: "conus",
  attribution: "Iowa Environmental Mesonet, Iowa State University; NWS/FAA ASOS network.",
  url: "https://mesonet.agron.iastate.edu/",
  available: true,
  cellDeg: null,
  /**
   * No grid — a station is a point. But the SAME station serves a wide area,
   * so rounding to ~5 km lets neighbouring requests reuse one lookup. It cannot
   * change the answer except where two stations are almost equidistant, and
   * there either is defensible.
   */
  snapDeg: 0.05,
  note: "The only real measurements here — everything else is a computer model. But it is one point: a station 30 miles off can easily miss a thunderstorm that hit your field.",
};

interface IEMStation {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  county: string | null;
  online: boolean;
  archive_begin: string | null;
}

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function loadNetwork(network: string, signal?: AbortSignal): Promise<IEMStation[]> {
  const res = await fetch(`${NETWORK_API}/${network}.json`, {
    signal,
    headers: { "User-Agent": UA },
    // Station metadata barely changes; cache for a day.
    next: { revalidate: 60 * 60 * 24 },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: IEMStation[] };
  return json.data ?? [];
}

/**
 * Nearest usable station.
 *
 * `minStartYear` filters out stations whose archive begins too late to support
 * the requested climatology — a station opened in 2019 is useless for a
 * 25-year normal, however close it is.
 */
export async function findNearestStation(
  lat: number,
  lon: number,
  minStartYear?: number,
  signal?: AbortSignal
): Promise<StationInfo | null> {
  /**
   * All five networks at once.
   *
   * This used to walk NETWORKS in order and break as soon as it found a station
   * within 60 km. For most of Texas that meant one request — but a point near
   * the Oklahoma, New Mexico, Louisiana or Arkansas line paid up to FIVE
   * sequential round trips, and every one of them sat on the critical path
   * before the station's actual observations were even requested.
   *
   * Fanning out makes the worst case cost the same as the best case. The lists
   * are small and cached for a day, so after the first load they are free.
   *
   * One deliberate behaviour change: without the early break this now returns
   * the genuinely nearest station rather than the first acceptable one. Near a
   * state line that can pick a different (closer) station than before.
   */
  const settled = await Promise.allSettled(
    NETWORKS.map(async (network) => ({ network, stations: await loadNetwork(network, signal) }))
  );

  let best: StationInfo | null = null;

  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "rejected") {
      // Never swallow this silently — a dropped network is a whole state's
      // worth of stations missing from the search, and the only symptom would
      // be a suspiciously distant "nearest" station.
      const why = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.warn(`[stations] network ${NETWORKS[i]} unavailable: ${why}`);
      continue;
    }

    const { network, stations } = r.value;
    for (const s of stations) {
      if (s.latitude === null || s.longitude === null) continue;
      if (!s.online) continue;
      if (minStartYear && s.archive_begin) {
        if (Number(s.archive_begin.slice(0, 4)) > minStartYear) continue;
      }
      const distanceKm = haversineKm(lat, lon, s.latitude, s.longitude);
      if (!best || distanceKm < best.distanceKm) {
        best = {
          id: s.id,
          name: s.name,
          lat: s.latitude,
          lon: s.longitude,
          county: s.county ?? null,
          network,
          archiveBegin: s.archive_begin ?? null,
          distanceKm,
        };
      }
    }
  }

  return best;
}

interface IEMDailyRow {
  station: string;
  day: string;
  max_temp_f: number | string | null;
  min_temp_f: number | string | null;
  precip_in: number | string | null;
  max_rh: number | string | null;
  avg_wind_speed_kts: number | string | null;
  max_dewpoint_f: number | string | null;
  srad_mj: number | string | null;
}

function n(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    if (v === "None" || v.trim() === "") return null;
    const p = Number(v);
    return Number.isFinite(p) ? p : null;
  }
  return Number.isFinite(v) ? v : null;
}

const fToC = (f: number) => ((f - 32) * 5) / 9;
const inToMm = (i: number) => i * 25.4;
const ktsToMs = (k: number) => k * 0.514444;

/** Daily observations for a specific station id. */
export async function fetchStationDaily(
  stationId: string,
  network: string,
  start: string,
  end: string,
  signal?: AbortSignal
): Promise<DailyRecord[]> {
  const [y1, m1, d1] = start.split("-");
  const [y2, m2, d2] = end.split("-");

  const params = new URLSearchParams({
    network,
    stations: stationId,
    year1: y1, month1: String(Number(m1)), day1: String(Number(d1)),
    year2: y2, month2: String(Number(m2)), day2: String(Number(d2)),
    format: "json",
  });

  const res = await fetch(`${DAILY_API}?${params}`, {
    signal,
    headers: { "User-Agent": UA },
    next: { revalidate: 60 * 60 * 3 },
  });
  if (!res.ok) throw new Error(`IEM station data returned ${res.status}`);

  const rows = (await res.json()) as IEMDailyRow[];
  if (!Array.isArray(rows)) return [];

  return rows
    .map((r) => {
      const tmaxF = n(r.max_temp_f);
      const tminF = n(r.min_temp_f);
      const tmax = tmaxF === null ? null : fToC(tmaxF);
      const tmin = tminF === null ? null : fToC(tminF);
      const precipIn = n(r.precip_in);
      const dewF = n(r.max_dewpoint_f);
      const windKt = n(r.avg_wind_speed_kts);

      // IEM reports whole degrees F and hundredths of an inch; converting to
      // metric invents digits (fToC(67) = 19.444444444444443). Rounded back to
      // the precision the instrument actually had — see lib/sources/precision.ts.
      return {
        // IEM returns an ISO timestamp; keep the calendar date only.
        date: String(r.day).slice(0, 10),
        tmax: q(tmax),
        tmin: q(tmin),
        tmean: tmax !== null && tmin !== null ? q((tmax + tmin) / 2) : null,
        precip: precipIn === null ? null : q(inToMm(precipIn)),
        srad: q(n(r.srad_mj)),
        rh: q(n(r.max_rh)),
        wind: windKt === null ? null : q(ktsToMs(windKt)),
        dew: dewF === null ? null : q(fToC(dewF)),
        origin: `${meta.id}:${stationId}`,
      } satisfies DailyRecord;
    })
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchDaily(opts: FetchOpts): Promise<DailyRecord[]> {
  const station = await findNearestStation(
    opts.lat,
    opts.lon,
    Number(opts.start.slice(0, 4)),
    opts.signal
  );
  if (!station) throw new Error("No airport station with a long enough record near this point.");
  return fetchStationDaily(station.id, station.network, opts.start, opts.end, opts.signal);
}

const source: WeatherSource = { meta, fetchDaily };
export default source;
