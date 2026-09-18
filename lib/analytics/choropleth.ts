/**
 * Turning Texas county polygons into an SVG map of where people looked.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GEOMETRY IS FLATTENED ON THE SERVER
 * ---------------------------------------------------------------------------
 * The county boundary index is close to a megabyte and lib/yield/county.ts is
 * explicit that it never goes to a browser. Projecting and simplifying it here,
 * in a server component, means the page ships a few hundred path strings
 * instead — no map library, no tile requests, and no client JavaScript at all.
 *
 * That last part is worth more than it sounds. The build trap this project hit
 * on 26 August — a client component importing the source registry and dragging
 * `node:fs` into the browser bundle, invisible to `tsc` — is impossible on a
 * page that has no client component to begin with.
 *
 * ---------------------------------------------------------------------------
 * A SECOND SIMPLIFICATION PASS IS NOT REDUNDANT
 * ---------------------------------------------------------------------------
 * The stored index is already simplified to 0.003 degrees, which was chosen so
 * a point lands in the right county to within a few hundred metres. A map nine
 * hundred pixels wide spans about thirteen degrees of longitude, so one stored
 * vertex step is a fifth of a pixel — far finer than anything that can be seen,
 * and paid for in bytes on every load. Re-simplifying for DISPLAY at 0.01
 * degrees is about three quarters of a pixel and cuts the path data hard.
 *
 * The two tolerances answer different questions and must not be merged: one
 * governs whether a field is in the right county, the other governs whether the
 * outline looks like Texas.
 */

import { simplifyRing, type CountyShape } from "../yield/county";

/** Display simplification, in degrees. Sub-pixel at the sizes this renders at. */
const DISPLAY_TOLERANCE_DEG = 0.01;

/** Coordinate decimals kept in the path. One is a tenth of a pixel. */
const PATH_DECIMALS = 1;

export interface CountyPath {
  fips: string;
  name: string;
  /** SVG path data in the returned viewBox's coordinates. */
  d: string;
}

export interface ProjectedMap {
  paths: CountyPath[];
  width: number;
  height: number;
}

/**
 * Equirectangular, with longitude squeezed by the cosine of the middle
 * latitude.
 *
 * Not a real equal-area projection, and it does not need to be: nothing here is
 * measured off the map, the shapes are only read for recognition, and across
 * the eleven degrees of latitude Texas occupies the distortion is invisible.
 * Dropping the cosine term, on the other hand, is immediately visible — Texas
 * comes out noticeably too wide.
 */
export function projectCounties(counties: CountyShape[], width = 900): ProjectedMap {
  if (!counties.length) return { paths: [], width, height: 1 };

  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const c of counties) {
    if (c.bbox[0] < west) west = c.bbox[0];
    if (c.bbox[1] < south) south = c.bbox[1];
    if (c.bbox[2] > east) east = c.bbox[2];
    if (c.bbox[3] > north) north = c.bbox[3];
  }

  const kx = Math.cos((((north + south) / 2) * Math.PI) / 180);
  const spanX = (east - west) * kx;
  const spanY = north - south;
  const scale = width / spanX;
  const height = Math.round(spanY * scale);

  const px = (lon: number) => ((lon - west) * kx * scale).toFixed(PATH_DECIMALS);
  // y is flipped: SVG counts downward, latitude counts upward.
  const py = (lat: number) => ((north - lat) * scale).toFixed(PATH_DECIMALS);

  const paths: CountyPath[] = [];
  for (const c of counties) {
    let d = "";
    for (const raw of c.rings) {
      const ring = simplifyRing(raw, DISPLAY_TOLERANCE_DEG);
      const n = ring.length / 2;
      // Two points cannot enclose anything; a degenerate ring would render as
      // an invisible hairline and is not worth the bytes.
      if (n < 3) continue;
      d += `M${px(ring[0])} ${py(ring[1])}L`;
      for (let i = 1; i < n; i++) {
        d += `${px(ring[i * 2])} ${py(ring[i * 2 + 1])} `;
      }
      d = d.trimEnd() + "Z";
    }
    if (d) paths.push({ fips: c.fips, name: c.name, d });
  }

  return { paths, width, height };
}

/**
 * Colour bins, doubling.
 *
 * Visit counts are heavily skewed — a handful of counties carry most of the
 * lookups and most carry none — so equal-width bins would put almost every
 * county in the first one and say nothing. Doubling thresholds spread a skewed
 * distribution across the ramp without having to be tuned to the data, which
 * matters because this map has to stay readable from the first week, when the
 * maximum is three, to a year in, when it might be three thousand.
 *
 * Zero is NOT a bin. A county nobody has looked at is a different statement
 * from a county someone looked at once, and shading them on the same ramp would
 * blur the only thing the map is for.
 *
 * THE RAMP IS FIXED HEX, NOT THEME TOKENS — the same decision, for the same
 * reason, as the analog panel's year swatches: these are solid blocks read
 * against each other, and a ramp mixed toward the surface colour would run
 * light-to-dark in one theme and dark-to-dark in the other. The page paints its
 * own light ground so this ramp always sits on what it was chosen for.
 */
export const BINS: Array<{ min: number; label: string; fill: string }> = [
  { min: 1, label: "1", fill: "#d3e5f6" },
  { min: 2, label: "2-3", fill: "#a8cbe8" },
  { min: 4, label: "4-7", fill: "#77aed8" },
  { min: 8, label: "8-15", fill: "#4a8cc4" },
  { min: 16, label: "16-31", fill: "#2a68a6" },
  { min: 32, label: "32+", fill: "#16457a" },
];

/** Neutral, and deliberately not the palest blue — see BINS. */
export const NO_DATA_FILL = "#eceae4";

export function fillFor(count: number): string {
  if (count < 1) return NO_DATA_FILL;
  let fill = BINS[0].fill;
  for (const b of BINS) if (count >= b.min) fill = b.fill;
  return fill;
}
