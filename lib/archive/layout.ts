/**
 * How the Texas weather archive is arranged in the bucket.
 *
 * This file is the SINGLE definition of that arrangement, imported by both the
 * ingest script that writes the store and the website code that reads it. If
 * the two ever disagreed about chunk shape or key naming, the result would be
 * plausible-looking numbers from the wrong place — so they share one source
 * rather than two matching implementations.
 *
 * No imports here, deliberately: it keeps the module trivially testable.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE, AND WHY
 * ---------------------------------------------------------------------------
 * A farmer's question is "this one spot, all thirty years". The store is
 * arranged for exactly that: each chunk covers a small 4x4 block of pixels
 * across the WHOLE time axis, so one field's entire history is a single small
 * download instead of thirty years of statewide daily maps.
 *
 * THE TIME SPLIT is what makes daily updating affordable. A chunk spanning all
 * 31 years cannot have a day appended without rewriting it, and rewriting every
 * chunk daily would be ~600,000 uploads a month against a 1,000,000 free
 * allowance — for one variable. So time is cut in two:
 *
 *   archive/   1995 -> end of last year   written once a year, never touched
 *   current/   1 Jan this year -> now     rewritten on each refresh
 *
 * A refresh then rewrites only the small current-year chunks. Measured shapes:
 *
 *   archive chunk  ~11,300 days x 4 x 4 x 2 bytes = 362 KB  (~145 KB compressed)
 *   current chunk     ~366 days x 4 x 4 x 2 bytes =  12 KB  (~5 KB compressed)
 *
 * A point lookup fetches one chunk per part per variable: 4 variables x 2 parts
 * = 8 requests, roughly 600 KB.
 *
 * ---------------------------------------------------------------------------
 * WHY 4x4 AND NOT 1x1
 * ---------------------------------------------------------------------------
 * 1x1 would transfer less per lookup (~92 KB), but it means one object per
 * pixel: 82,000 x 4 variables = 330,000 objects per part, and a refresh that
 * rewrites all of them blows the free upload allowance several times over. 4x4
 * cuts the object count 16-fold for a few hundred KB more per lookup, which is
 * a trade worth making against an 18-82 second baseline.
 */

/** Where the archive/current boundary sits. Both parts are Zarr groups. */
export type Part = "archive" | "current";

/**
 * Pixels per side in a chunk's spatial block — DIFFERENT PER PART, on purpose.
 *
 * The two parts are optimised against opposite pressures.
 *
 * `archive` is written once a year and read constantly, so it is chunked thin
 * (4x4) to keep a lookup's download small. Its 20,800 objects per rebuild are
 * irrelevant at once a year.
 *
 * `current` is rewritten on EVERY refresh, so its object count is what matters.
 * At 4x4 a daily refresh would cost ~624,000 uploads a month against a
 * 1,000,000 free allowance — survivable for gridMET alone, but with no room for
 * a second source. At 16x16 the same refresh costs ~41,000 a month. It is only
 * a few hundred KB more per lookup because the current part spans one year, not
 * thirty-one.
 */
export const PART_CHUNK_PX: Record<Part, number> = {
  archive: 4,
  current: 16,
};

/** gridMET's native grid step, degrees. */
export const GRID_STEP = 1 / 24;

/**
 * Variables held in the archive.
 *
 * `key` is our name for it; `file` and `grid` are what the University of Idaho
 * calls it. Their file naming does NOT match Earth Engine's band naming — grass
 * reference ET is `eto` in Earth Engine but `pet` on THREDDS — so both are
 * recorded rather than derived from each other.
 */
export interface ArchiveVar {
  key: string;
  file: string;
  grid: string;
  /** What it becomes in a DailyRecord. */
  field: "tmax" | "tmin" | "precip" | "eto";
}

export const ARCHIVE_VARS: ArchiveVar[] = [
  { key: "tmmx", file: "tmmx", grid: "daily_maximum_temperature", field: "tmax" },
  { key: "tmmn", file: "tmmn", grid: "daily_minimum_temperature", field: "tmin" },
  { key: "pr", file: "pr", grid: "precipitation_amount", field: "precip" },
  {
    key: "pet",
    file: "pet",
    grid: "daily_mean_reference_evapotranspiration_grass",
    field: "eto",
  },
];

/**
 * What a reader needs to locate a point without downloading any coordinates.
 *
 * The lat/lon origins are recorded as READ FROM THE SERVER, not assumed from
 * gridMET's published grid parameters. If Idaho ever shifts the grid, a rebuilt
 * archive stays self-consistent instead of silently offsetting every lookup by
 * a cell.
 */
export interface Manifest {
  /** Bumped when the on-disk arrangement changes incompatibly. */
  version: number;
  builtAt: string;
  /** Northernmost row centre, and westernmost column centre. */
  lat0: number;
  lon0: number;
  /** Degrees per row/column. Latitude descends, so latStep is negative. */
  latStep: number;
  lonStep: number;
  nLat: number;
  nLon: number;
  parts: Record<
    Part,
    {
      /** Inclusive ISO dates. */
      start: string;
      end: string;
      nDays: number;
    }
  >;
  vars: Record<
    string,
    {
      grid: string;
      field: string;
      scaleFactor: number;
      addOffset: number;
      fillValue: number;
      units: string;
    }
  >;
}

export const MANIFEST_VERSION = 1;
export const MANIFEST_KEY = "gridmet/manifest.json";

/** Root prefix inside the bucket. */
export const PREFIX = "gridmet";

export function zarrayKey(part: Part, varName: string): string {
  return `${PREFIX}/${part}/${varName}/.zarray`;
}

export function zattrsKey(part: Part, varName: string): string {
  return `${PREFIX}/${part}/${varName}/.zattrs`;
}

/**
 * Chunk key. Zarr v2 names chunks by dot-separated chunk indices in dimension
 * order; the time index is always 0 because a chunk spans its part's whole time
 * axis.
 */
export function chunkKey(part: Part, varName: string, latChunk: number, lonChunk: number): string {
  return `${PREFIX}/${part}/${varName}/0.${latChunk}.${lonChunk}`;
}

/** Where a point sits on the grid. Independent of how any part is chunked. */
export interface CellIndex {
  latIdx: number;
  lonIdx: number;
  /** The grid cell centre actually used, for the UI to report honestly. */
  lat: number;
  lon: number;
}

/** Where that cell sits within one part's chunking. */
export interface ChunkPos {
  latChunk: number;
  lonChunk: number;
  latOffset: number;
  lonOffset: number;
}

/**
 * Nearest grid cell to a point.
 *
 * Returns null outside the archive's coverage rather than clamping to the edge:
 * a silently clamped lookup would return El Paso's weather for a field in New
 * Mexico and look entirely normal doing it.
 */
export function locate(m: Manifest, lat: number, lon: number): CellIndex | null {
  const latIdx = Math.round((lat - m.lat0) / m.latStep);
  const lonIdx = Math.round((lon - m.lon0) / m.lonStep);
  if (latIdx < 0 || latIdx >= m.nLat || lonIdx < 0 || lonIdx >= m.nLon) return null;

  return {
    latIdx,
    lonIdx,
    lat: m.lat0 + latIdx * m.latStep,
    lon: m.lon0 + lonIdx * m.lonStep,
  };
}

/** Which chunk of `part` holds that cell, and where inside it. */
export function chunkOf(part: Part, cell: Pick<CellIndex, "latIdx" | "lonIdx">): ChunkPos {
  const px = PART_CHUNK_PX[part];
  return {
    latChunk: Math.floor(cell.latIdx / px),
    lonChunk: Math.floor(cell.lonIdx / px),
    latOffset: cell.latIdx % px,
    lonOffset: cell.lonIdx % px,
  };
}

/** How many chunks span the grid in each direction, for one part. */
export function chunkCounts(m: Manifest, part: Part): { lat: number; lon: number } {
  const px = PART_CHUNK_PX[part];
  return {
    lat: Math.ceil(m.nLat / px),
    lon: Math.ceil(m.nLon / px),
  };
}

/**
 * Pull one cell's whole time series out of a decompressed chunk.
 *
 * Zarr stores chunks in C order — time varies slowest, longitude fastest — so a
 * single cell's values sit px*px apart. Edge chunks are padded to the full
 * chunk shape by the Zarr spec, so the stride is constant even where the grid
 * does not divide evenly.
 */
export function extractSeries(
  part: Part,
  chunk: Int16Array,
  pos: Pick<ChunkPos, "latOffset" | "lonOffset">,
  nDays: number
): Int16Array {
  const px = PART_CHUNK_PX[part];
  const stride = px * px;
  const base = pos.latOffset * px + pos.lonOffset;
  const out = new Int16Array(nDays);
  for (let t = 0; t < nDays; t++) out[t] = chunk[t * stride + base];
  return out;
}

/** Days between two ISO dates, inclusive of both. */
export function dayCount(startISO: string, endISO: string): number {
  const a = Date.parse(`${startISO}T00:00:00Z`);
  const b = Date.parse(`${endISO}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

/** ISO date `offset` days after `startISO`. */
export function addDays(startISO: string, offset: number): string {
  const d = new Date(Date.parse(`${startISO}T00:00:00Z`) + offset * 86_400_000);
  return d.toISOString().slice(0, 10);
}
