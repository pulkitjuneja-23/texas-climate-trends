import type { LatLon } from "./types";

/** Texas bounding box, padded slightly so border fields still resolve. */
export const TEXAS_BOUNDS = {
  minLat: 25.5,
  maxLat: 36.8,
  minLon: -107.0,
  maxLon: -93.3,
};

export const TEXAS_CENTER: LatLon = { lat: 31.3, lon: -99.5 };

export function inTexas(lat: number, lon: number): boolean {
  return (
    lat >= TEXAS_BOUNDS.minLat &&
    lat <= TEXAS_BOUNDS.maxLat &&
    lon >= TEXAS_BOUNDS.minLon &&
    lon <= TEXAS_BOUNDS.maxLon
  );
}

export function validateLatLon(latRaw: string | null, lonRaw: string | null): LatLon {
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("lat and lon are required and must be numbers");
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error("lat/lon out of range");
  }
  return { lat, lon };
}

/** A few starting points so the map is never empty on first load. */
export const TEXAS_PRESETS: Array<{ label: string; lat: number; lon: number; note: string }> = [
  { label: "Lubbock", lat: 33.578, lon: -101.855, note: "Southern High Plains — cotton" },
  { label: "Amarillo", lat: 35.222, lon: -101.831, note: "Panhandle — corn, wheat, cattle" },
  { label: "Waco", lat: 31.549, lon: -97.147, note: "Blackland Prairie — corn, sorghum" },
  { label: "Corpus Christi", lat: 27.8, lon: -97.396, note: "Coastal Bend — cotton, sorghum" },
  { label: "Weslaco", lat: 26.159, lon: -97.991, note: "Lower Rio Grande Valley — citrus, vegetables" },
  { label: "College Station", lat: 30.628, lon: -96.334, note: "Brazos Valley — mixed row crop" },
  { label: "Dalhart", lat: 36.06, lon: -102.513, note: "Far Panhandle — irrigated corn" },
  { label: "Uvalde", lat: 29.209, lon: -99.786, note: "Winter Garden — vegetables, corn" },
];
