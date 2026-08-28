import type { LatLon } from "./types";

/** Texas bounding box, padded slightly so border fields still resolve. */
export const TEXAS_BOUNDS = {
  minLat: 25.5,
  maxLat: 36.8,
  minLon: -107.0,
  maxLon: -93.3,
};

export const TEXAS_CENTER: LatLon = { lat: 31.3, lon: -99.5 };

/**
 * Read a coordinate the way people actually paste one.
 *
 * Handles decimal degrees, degrees + decimal minutes (what most handheld GPS
 * units and marine apps emit), and full degrees/minutes/seconds — with or
 * without degree symbols, hemisphere letters, or a comma. Returns null rather
 * than guessing.
 *
 * Lives here, not in the picker component, because it is pure logic with real
 * edge cases and it needs to be testable without pulling React and Leaflet in.
 *
 * NOT SUPPORTED: UTM, MGRS, and State Plane. Those are projected systems that
 * need a datum and a projection library to convert; they are rejected rather
 * than mangled into a plausible-looking latitude.
 *
 * WHY IT READS TOKENS INSTEAD OF MATCHING FORMATS. The previous version tried
 * to match whole formats with one regex per format, and failed SILENTLY with a
 * confident wrong answer. Two cases, both found by testing rather than reading:
 *
 *   "31.0982° N, 97.3428° W"   ->  982, -428
 *       The DMS pattern allowed 1-3 digits before the degree sign, so it
 *       matched the "982" at the TAIL of a decimal and read it as whole
 *       degrees.
 *
 *   "31 5.883 N 97 20.568 W"   ->  31, 5.883
 *       Degrees with decimal minutes was not handled at all, so the two
 *       numbers were taken as a latitude and a longitude.
 *
 * Neither path was bounds-checked, so an impossible latitude of 982 escaped as
 * if it were a place.
 */
export function parseCoords(input: string): { lat: number; lon: number } | null {
  const s = input.trim();
  if (!s) return null;

  const tokens = [...s.matchAll(/(-?\d+(?:\.\d+)?)|([NSEWnsew])(?![a-z])/g)].map((m) =>
    m[1] !== undefined
      ? ({ kind: "num" as const, v: Number(m[1]) })
      : ({ kind: "hemi" as const, v: m[2].toUpperCase() })
  );

  /** deg / deg+decimal-minutes / deg+min+sec, all to signed decimal degrees. */
  const toDegrees = (nums: number[], hemi?: string): number | null => {
    if (!nums.length || nums.length > 3) return null;
    const sign = Math.sign(nums[0]) || 1;
    const [d, m = 0, sec = 0] = nums.map(Math.abs);
    // Minutes and seconds are sixtieths; anything at or past 60 is not one.
    if (nums.length > 1 && m >= 60) return null;
    if (nums.length > 2 && sec >= 60) return null;
    const mag = d + m / 60 + sec / 3600;
    if (hemi === "S" || hemi === "W") return -mag;
    if (hemi === "N" || hemi === "E") return mag;
    return sign * mag;
  };

  const hemiCount = tokens.filter((t) => t.kind === "hemi").length;

  // --- With hemisphere letters: each letter closes the group before it ---
  if (hemiCount === 2) {
    const groups: Array<{ nums: number[]; hemi: string }> = [];
    let nums: number[] = [];
    for (const t of tokens) {
      if (t.kind === "num") nums.push(t.v as number);
      else {
        groups.push({ nums, hemi: t.v as string });
        nums = [];
      }
    }
    if (groups.length !== 2) return null;

    const parts = groups.map((g) => ({ v: toDegrees(g.nums, g.hemi), hemi: g.hemi }));
    const lat = parts.find((p) => p.hemi === "N" || p.hemi === "S")?.v;
    const lon = parts.find((p) => p.hemi === "E" || p.hemi === "W")?.v;
    if (lat == null || lon == null) return null;
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
  }

  // --- No hemisphere letters: exactly two plain decimal numbers ---
  const nums = tokens.filter((t) => t.kind === "num").map((t) => t.v as number);
  if (nums.length !== 2) return null;

  const lat = nums[0];
  let lon = nums[1];
  // Texas longitudes are negative; a bare positive value is almost certainly a
  // dropped minus sign rather than a location in the Indian Ocean.
  if (lon > 0 && lon < 180 && lat > 0) lon = -lon;
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

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
