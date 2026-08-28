/**
 * Which Texas county is this field in?
 *
 * NASS publishes yield per county, so every lookup starts here. The boundaries
 * come from the Census TIGERweb service (no key), simplified once during the
 * ingest and hosted alongside the yield data.
 *
 * WHY POLYGONS AND NOT A RASTER. The obvious alternative is to precompute the
 * county for every gridMET cell and store one byte each - 83 KB, an array index
 * at request time, very fast. It was rejected because a 4 km cell straddling a
 * county line puts a real field in the wrong county, and the error is invisible:
 * the farmer gets a confident yield figure from the county next door. Simplified
 * polygons are a comparable size, decouple this from the weather grid entirely,
 * and are accurate to a few hundred metres.
 *
 * This runs SERVER-SIDE only. The polygon file is a megabyte or so and is never
 * sent to a browser.
 */

/** A ring is a flat [lon, lat, lon, lat, ...] run, which halves the JSON size. */
export type Ring = number[];

export interface CountyShape {
  /** Three-digit Texas county FIPS, e.g. "027" for Bell. */
  fips: string;
  name: string;
  /** [west, south, east, north] - checked before any ring test. */
  bbox: [number, number, number, number];
  /** Outer rings. Holes do not occur between counties, so none are stored. */
  rings: Ring[];
}

export interface CountyIndex {
  version: number;
  builtAt: string;
  /** Douglas-Peucker tolerance in degrees, recorded so the error is knowable. */
  toleranceDeg: number;
  counties: CountyShape[];
}

export const COUNTY_INDEX_VERSION = 1;

/**
 * Ray casting. A point exactly on an edge may land either way, which is
 * acceptable here: the two answers are neighbouring counties and the caller is
 * asking for a county-wide average, not a boundary determination.
 */
export function pointInRing(ring: Ring, lon: number, lat: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const yi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const yj = ring[j * 2 + 1];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * The county containing this point, or null outside Texas.
 *
 * Null rather than nearest-county on purpose. A point in New Mexico is not
 * "nearly Hudspeth County" for the purpose of a yield figure, and silently
 * snapping to the closest one would put another state's weather beside Texas
 * yields with nothing to show it had happened.
 */
export function locateCounty(index: CountyIndex, lat: number, lon: number): CountyShape | null {
  for (const c of index.counties) {
    if (lon < c.bbox[0] || lon > c.bbox[2] || lat < c.bbox[1] || lat > c.bbox[3]) continue;
    for (const ring of c.rings) {
      if (pointInRing(ring, lon, lat)) return c;
    }
  }
  return null;
}

/**
 * Douglas-Peucker on a flat coordinate run.
 *
 * Iterative rather than recursive: a full-resolution TIGER ring can carry tens
 * of thousands of vertices, and recursing per vertex overflows the stack on the
 * long river boundaries in east Texas.
 */
export function simplifyRing(ring: Ring, tolerance: number): Ring {
  const n = ring.length / 2;
  if (n < 3) return ring;

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;

    const x1 = ring[first * 2];
    const y1 = ring[first * 2 + 1];
    const x2 = ring[last * 2];
    const y2 = ring[last * 2 + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const denom = dx * dx + dy * dy;

    let maxDist = -1;
    let maxIdx = -1;
    for (let i = first + 1; i < last; i++) {
      const px = ring[i * 2];
      const py = ring[i * 2 + 1];
      // Perpendicular distance, or plain distance if the segment is a point.
      let d: number;
      if (denom === 0) {
        d = (px - x1) ** 2 + (py - y1) ** 2;
      } else {
        let t = ((px - x1) * dx + (py - y1) * dy) / denom;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d = (px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2;
      }
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }

    if (maxDist > tolerance * tolerance && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push([first, maxIdx], [maxIdx, last]);
    }
  }

  const out: Ring = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(ring[i * 2], ring[i * 2 + 1]);
  }
  return out;
}
