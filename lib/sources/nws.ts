/**
 * NOAA / National Weather Service — api.weather.gov.
 *
 * The authoritative near-term forecast for a US point, and the tier a grower
 * should weight most heavily. Free, no key, but it does require a real
 * User-Agent with contact info or it will start refusing requests.
 *
 * Two hops: /points/{lat},{lon} resolves the forecast office + grid cell, then
 * /gridpoints/{office}/{x},{y}/forecast returns 14 day/night periods = 7 days.
 */

const UA = "TexasClimateTrends/0.1 (github.com/texas-climate-trends; contact via repo issues)";

export interface NWSPeriod {
  number: number;
  name: string;
  startTime: string;
  endTime: string;
  isDaytime: boolean;
  /** Value in `temperatureUnit`, as issued (NWS gives F for US offices). */
  temperature: number;
  temperatureUnit: string;
  precipProb: number | null;
  windSpeed: string;
  windDirection: string;
  shortForecast: string;
  detailedForecast: string;
  icon: string;
}

export interface NWSForecast {
  office: string;
  gridX: number;
  gridY: number;
  timeZone: string;
  updated: string | null;
  periods: NWSPeriod[];
}

interface PointsResponse {
  properties?: {
    gridId?: string;
    gridX?: number;
    gridY?: number;
    forecast?: string;
    timeZone?: string;
    relativeLocation?: { properties?: { city?: string; state?: string } };
  };
}

interface ForecastResponse {
  properties?: {
    updated?: string;
    periods?: Array<{
      number: number;
      name: string;
      startTime: string;
      endTime: string;
      isDaytime: boolean;
      temperature: number;
      temperatureUnit: string;
      probabilityOfPrecipitation?: { value: number | null };
      windSpeed: string;
      windDirection: string;
      shortForecast: string;
      detailedForecast: string;
      icon: string;
    }>;
  };
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    signal,
    headers: { "User-Agent": UA, Accept: "application/geo+json" },
    next: { revalidate: 60 * 30 },
  });
  if (!res.ok) {
    throw new Error(`NWS ${url} returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function fetchNWSForecast(
  lat: number,
  lon: number,
  signal?: AbortSignal
): Promise<NWSForecast> {
  // NWS rejects excessive precision on the points endpoint.
  const la = Number(lat.toFixed(4));
  const lo = Number(lon.toFixed(4));

  const pts = await getJson<PointsResponse>(
    `https://api.weather.gov/points/${la},${lo}`,
    signal
  );
  const p = pts.properties;
  if (!p?.forecast) {
    throw new Error("NWS did not return a forecast URL for this point (outside US coverage?)");
  }

  const fc = await getJson<ForecastResponse>(p.forecast, signal);
  const periods = fc.properties?.periods ?? [];

  return {
    office: p.gridId ?? "",
    gridX: p.gridX ?? 0,
    gridY: p.gridY ?? 0,
    timeZone: p.timeZone ?? "America/Chicago",
    updated: fc.properties?.updated ?? null,
    periods: periods.map((x) => ({
      number: x.number,
      name: x.name,
      startTime: x.startTime,
      endTime: x.endTime,
      isDaytime: x.isDaytime,
      temperature: x.temperature,
      temperatureUnit: x.temperatureUnit,
      precipProb: x.probabilityOfPrecipitation?.value ?? null,
      windSpeed: x.windSpeed,
      windDirection: x.windDirection,
      shortForecast: x.shortForecast,
      detailedForecast: x.detailedForecast,
      icon: x.icon,
    })),
  };
}
