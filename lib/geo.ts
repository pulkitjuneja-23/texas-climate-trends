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

/**
 * Move a request to the centre of the grid cell that contains it.
 *
 * Within one cell every point returns identical data, so this changes no
 * number — but it means two farmers a mile apart share a single cached answer
 * instead of triggering two separate fetches. gridMET cells are 4 km; NASA
 * POWER cells are ~55 km, where a whole county often collapses to one request.
 *
 * Deliberately NOT applied to OpenET: at 30 m its entire value is telling one
 * field from the next, and shifting the sample by even 100 m would change what
 * is measured rather than merely how it is addressed.
 */
export function snapToCell(
  lat: number,
  lon: number,
  cell: { lat: number; lon: number } | null | undefined
): LatLon {
  if (!cell || !(cell.lat > 0) || !(cell.lon > 0)) return { lat, lon };
  const centre = (v: number, size: number) => Math.floor(v / size) * size + size / 2;
  return {
    lat: Number(centre(lat, cell.lat).toFixed(6)),
    lon: Number(centre(lon, cell.lon).toFixed(6)),
  };
}

/** Round to a fixed step — for sources with no grid of their own. */
export function snapToStep(lat: number, lon: number, step: number | undefined): LatLon {
  if (!step || !(step > 0)) return { lat, lon };
  return {
    lat: Number((Math.round(lat / step) * step).toFixed(6)),
    lon: Number((Math.round(lon / step) * step).toFixed(6)),
  };
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

/**
 * Where a first-time visitor lands.
 *
 * Deliberately a FIELD, not a town. Water use is measured at 30 m, and a pin in
 * a city reads roughly a third of cropland twenty miles away — 2024 at Waco
 * city centre gave 355 mm of ET against 926 mm on this cropland point. Landing
 * someone on pavement means their first impression of the water figures is
 * wrong, and they have no way to know it.
 *
 * This is Blackland Prairie row-crop ground in McLennan/Falls County, verified
 * against OpenET as genuine cropland with a complete nearby station record.
 */
export const DEFAULT_PLACE = {
  lat: 31.3,
  lon: -97.4,
  label: "Blackland Prairie cropland, TX",
};

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
