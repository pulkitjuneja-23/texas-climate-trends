/**
 * Daily-series caching, chunked by calendar year.
 *
 * WHY YEARS AND NOT WHOLE RANGES
 * The obvious key is (source, cell, start..end), but it caches badly: a visitor
 * asking 1996-2026 and one asking 2010-2026 share nothing, and tomorrow's
 * request for 1996-2026 misses because `end` moved by a day. Almost every entry
 * would be written once and read never.
 *
 * Years fix that, because of one fact about this data: **a completed past year
 * never changes.** 2019 at a given gridMET cell is the same 365 rows forever.
 * So 30 of the 31 years in a 30-year request are permanently cacheable, and
 * only the current one needs refreshing.
 *
 * That turns the expensive case into a cheap one. A revisit to a known cell
 * whose current year has gone stale re-fetches ONE year — measured at ~2 s
 * against ~22-82 s for the full record — and reads the other 30 from Postgres.
 */

import type { DailyRecord } from "@/lib/types";
import { readMany, writeMany, cacheEnabled } from "./store";
import { encodeYear, decodeYear, type EncodedYear } from "./encode";

export { cacheEnabled };
export { fetchSpan } from "./span";

/** What one year looks like in the table — see ./encode for why. */
type StoredYear = EncodedYear;

/** Past years are refetched only if they came back suspiciously short. */
const COMPLETE_YEAR_DAYS = 300;

/** The in-progress year is still being written upstream. */
const CURRENT_YEAR_TTL = 3 * 3600;

/** A past year that arrived incomplete — a sparse station, or a lagging source. */
const PARTIAL_YEAR_TTL = 7 * 24 * 3600;

function cellKey(lat: number, lon: number): string {
  // The caller passes coordinates already snapped to the source's grid; fixing
  // the precision here guards against float formatting drift producing two keys
  // for one cell (31.291666666 vs 31.29167).
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

function yearKey(source: string, lat: number, lon: number, year: number): string {
  return `hist:${source}:${cellKey(lat, lon)}:${year}`;
}

export interface CachedSeries {
  /** Years that were present and unexpired, with their records. */
  byYear: Map<number, DailyRecord[]>;
  /** Years that must be fetched upstream. */
  missing: number[];
}

/**
 * What is already known for this cell across a span of years.
 *
 * Never throws and never blocks for long: a cache outage returns every year as
 * missing, which is exactly the behaviour before this layer existed.
 */
export async function readSeries(
  source: string,
  lat: number,
  lon: number,
  startYear: number,
  endYear: number
): Promise<CachedSeries> {
  const years: number[] = [];
  for (let y = startYear; y <= endYear; y++) years.push(y);

  const byYear = new Map<number, DailyRecord[]>();
  if (!cacheEnabled) return { byYear, missing: years };

  const found = await readMany<StoredYear>(years.map((y) => yearKey(source, lat, lon, y)));

  const missing: number[] = [];
  for (const y of years) {
    const hit = found.get(yearKey(source, lat, lon, y));
    const rows = hit?.payload?.records;
    // A hit holding a non-array payload is a corrupt row; treat it as a miss
    // rather than handing garbage to the climatology.
    if (rows && Array.isArray(rows) && rows.length > 0) {
      byYear.set(y, decodeYear(rows, hit.payload.origin ?? null));
    } else {
      missing.push(y);
    }
  }

  return { byYear, missing };
}

/**
 * Store a freshly fetched series, split into years.
 *
 * `contributors` records which upstream services produced these rows. Only
 * whole years are stored — a partial span at either end of the fetch would
 * otherwise be written as if it were the complete year and then served as one.
 */
export async function writeSeries(
  source: string,
  lat: number,
  lon: number,
  records: DailyRecord[],
  opts: { contributors: string[]; currentYear: number; fetchedYears: number[] }
): Promise<void> {
  if (!cacheEnabled || records.length === 0) return;

  const grouped = new Map<number, DailyRecord[]>();
  for (const r of records) {
    const y = Number(r.date.slice(0, 4));
    if (!Number.isFinite(y)) continue;
    if (!opts.fetchedYears.includes(y)) continue;
    const bucket = grouped.get(y);
    if (bucket) bucket.push(r);
    else grouped.set(y, [r]);
  }

  const entries = [...grouped.entries()].map(([year, rows]) => {
    // Lift out the fields that can be rebuilt exactly — ~35% smaller on disk.
    const encoded = encodeYear(rows);

    /**
     * Immutable only when the year is genuinely finished AND arrived full.
     * A past year that came back short — a sparse airport station, or a source
     * that has not published it yet — gets a TTL instead, so it is retried
     * rather than frozen incomplete forever.
     */
    const past = year < opts.currentYear;
    const complete = rows.length >= COMPLETE_YEAR_DAYS;
    const immutable = past && complete;

    return {
      key: yearKey(source, lat, lon, year),
      scope: "history",
      source,
      payload: encoded,
      /**
       * The real `origin` values, not just the source id — for airport stations
       * that names the individual station, so a series whose composition
       * changed between two reads stays traceable.
       */
      contributors: encoded.origin ? [encoded.origin] : opts.contributors,
      rows: rows.length,
      immutable,
      ttlSeconds: immutable ? undefined : past ? PARTIAL_YEAR_TTL : CURRENT_YEAR_TTL,
    };
  });

  await writeMany(entries);
}
