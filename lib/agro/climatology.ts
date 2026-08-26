import type { DailyRecord } from "@/lib/types";
import { dailyGdd, type GddConfig, CORN_GDD } from "./gdd";

/**
 * Day-of-year climatology.
 *
 * Keyed on MM-DD rather than day-of-year integers. Day-of-year silently
 * misaligns leap from non-leap years — after Feb 28, DOY 100 is a different
 * calendar date depending on the year, which smears the normals by a day for
 * ~3/4 of the record. MM-DD cannot drift.
 *
 * 02-29 exists in the key list and simply carries fewer observations (n is
 * reported per day so the UI can say so).
 */

export const DOY_KEYS: string[] = (() => {
  const keys: string[] = [];
  // 2000 is a leap year — gives all 366 calendar slots.
  const d = new Date(Date.UTC(2000, 0, 1));
  while (d.getUTCFullYear() === 2000) {
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    keys.push(`${mm}-${dd}`);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return keys;
})();

export const KEY_INDEX: Map<string, number> = new Map(DOY_KEYS.map((k, i) => [k, i]));

/**
 * `et` and `balance` only exist from late 2015 onward. Everything downstream
 * treats a missing value as "no data", never as zero, so their lines simply
 * begin partway along the same 2000-2025 axis as the rest.
 */
export type Field =
  | "tmax"
  | "tmin"
  | "tmean"
  | "precip"
  | "gdd"
  | "dtr"
  | "et"
  | "balance"
  | "eto";

export interface DayStat {
  key: string;
  n: number;
  mean: number | null;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  min: number | null;
  max: number | null;
}

export interface YearSeries {
  year: number;
  /** Length 366, aligned to DOY_KEYS. */
  values: (number | null)[];
}

function valueOf(r: DailyRecord, field: Field, gddCfg: GddConfig): number | null {
  if (field === "gdd") return dailyGdd(r.tmax, r.tmin, gddCfg);
  /**
   * Day-night swing (diurnal temperature range). Derived, not stored — it is
   * simply Tmax - Tmin, and keeping it derived means it works for every source
   * automatically. It is a DIFFERENCE, so it must be rendered with the
   * `tempDelta` quantity: converting it as an absolute temperature would add
   * 32 and turn a 12 degC swing into "53 degF".
   */
  if (field === "dtr") {
    if (r.tmax === null || r.tmin === null) return null;
    if (!Number.isFinite(r.tmax) || !Number.isFinite(r.tmin)) return null;
    return r.tmax - r.tmin;
  }
  const v = r[field];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Regroup a flat daily record list into one 366-slot array per calendar year. */
export function alignByYear(
  records: DailyRecord[],
  field: Field,
  gddCfg: GddConfig = CORN_GDD
): YearSeries[] {
  const byYear = new Map<number, (number | null)[]>();

  for (const r of records) {
    if (!r.date || r.date.length < 10) continue;
    const year = Number(r.date.slice(0, 4));
    if (!Number.isFinite(year)) continue;
    const key = r.date.slice(5, 10);
    const idx = KEY_INDEX.get(key);
    if (idx === undefined) continue;

    let arr = byYear.get(year);
    if (!arr) {
      arr = new Array<number | null>(DOY_KEYS.length).fill(null);
      byYear.set(year, arr);
    }
    arr[idx] = valueOf(r, field, gddCfg);
  }

  return [...byYear.entries()]
    .map(([year, values]) => ({ year, values }))
    .sort((a, b) => a.year - b.year);
}

/** Linear-interpolated percentile over a pre-sorted ascending array. */
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarize(key: string, values: number[]): DayStat {
  if (!values.length) {
    return { key, n: 0, mean: null, p10: null, p25: null, p50: null, p75: null, p90: null, min: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    key,
    n: values.length,
    mean: sum / values.length,
    p10: percentile(sorted, 0.1),
    p25: percentile(sorted, 0.25),
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/**
 * Normals for each calendar day.
 *
 * `window` pools +/- N calendar days into each day's sample. Daily normals from
 * only 25 values are far too noisy to read as a trend line — a +/-7 day window
 * pools ~375 values and gives a curve that actually looks like a climate rather
 * than a seismograph. Precipitation especially needs this.
 */
export function dailyClimatology(
  series: YearSeries[],
  opts: { window?: number } = {}
): DayStat[] {
  const window = opts.window ?? 7;
  const n = DOY_KEYS.length;

  return DOY_KEYS.map((key, i) => {
    const pool: number[] = [];
    for (let off = -window; off <= window; off++) {
      const idx = (i + off + n) % n; // wrap across the new year
      for (const ys of series) {
        const v = ys.values[idx];
        if (v !== null && Number.isFinite(v)) pool.push(v);
      }
    }
    return summarize(key, pool);
  });
}

/**
 * Running total through the year for one year's series.
 *
 * Two different kinds of "null" have to be told apart here:
 *
 *   INTERIOR gaps (02-29 in a non-leap year, an odd missing day) carry the
 *   previous total forward. Breaking the curve there would hole every
 *   accumulation line and misalign the cross-year comparison.
 *
 *   The TRAILING gap — everything after the last real observation — must stay
 *   null. The in-progress year has no data past today, and carrying the total
 *   forward would draw a flat line to 31 Dec that reads as "no more rain all
 *   year". That is a confident claim about the future made out of missing data.
 */
export function accumulate(ys: YearSeries, startIdx = 0, maxGapDays = Infinity): YearSeries {
  const out = new Array<number | null>(DOY_KEYS.length).fill(null);

  // Where the real record actually ends.
  let lastReal = -1;
  for (let i = DOY_KEYS.length - 1; i >= startIdx; i--) {
    const v = ys.values[i];
    if (v !== null && Number.isFinite(v)) {
      lastReal = i;
      break;
    }
  }
  if (lastReal < 0) return { year: ys.year, values: out };

  let total = 0;
  let started = false;
  let gap = 0;

  for (let i = startIdx; i <= lastReal; i++) {
    const v = ys.values[i];
    if (v !== null && Number.isFinite(v)) {
      total += v;
      started = true;
      gap = 0;
    } else if (started) {
      gap++;
      /**
       * A long interior gap is not the same as a missing 29 February.
       * OpenET routinely drops whole months (April and May recur) when cloud
       * cover defeats the interpolation. Carrying the running total flat across
       * two missing months and then resuming would understate season ET by
       * ~10 inches and make an irrigation deficit look comfortable when it is
       * not — an error in the dangerous direction. So past `maxGapDays` the
       * curve simply stops and the UI says which months are missing.
       */
      if (gap > maxGapDays) return { year: ys.year, values: out };
    }
    out[i] = started ? total : null;
  }
  return { year: ys.year, values: out };
}

/**
 * Normals for an accumulation curve.
 *
 * Percentiles are taken ACROSS the per-year accumulation curves, not by
 * accumulating the daily percentiles. Accumulating a daily p90 would produce a
 * curve describing a year that was at the 90th percentile every single day —
 * which has never happened and never will. The band would be absurdly wide.
 */
export function accumClimatology(
  series: YearSeries[],
  startIdx = 0,
  maxGapDays = Infinity
): DayStat[] {
  const accums = series.map((s) => accumulate(s, startIdx, maxGapDays));
  return DOY_KEYS.map((key, i) => {
    const pool: number[] = [];
    for (const a of accums) {
      const v = a.values[i];
      if (v !== null && Number.isFinite(v)) pool.push(v);
    }
    return summarize(key, pool);
  });
}

/**
 * True when a year contains a run of missing days longer than `maxGapDays`
 * inside its own data span.
 *
 * Used to keep gappy years OUT of an accumulation band rather than letting them
 * terminate partway. A curve that stops in March silently drops out of the
 * cross-year percentile pool from that point on, so the band is computed from a
 * shrinking and non-random subset and visibly jumps where a year disappears.
 * Better to exclude such years outright and report the smaller sample honestly.
 */
export function hasLongGap(ys: YearSeries, maxGapDays: number): boolean {
  let first = -1;
  let last = -1;
  for (let i = 0; i < ys.values.length; i++) {
    const v = ys.values[i];
    if (v !== null && Number.isFinite(v)) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return false;

  let gap = 0;
  for (let i = first; i <= last; i++) {
    const v = ys.values[i];
    if (v !== null && Number.isFinite(v)) gap = 0;
    else if (++gap > maxGapDays) return true;
  }
  return false;
}

/**
 * True when a year's data begins at (or very near) the accumulation start.
 *
 * A partial FIRST year is as damaging to an accumulation band as an interior
 * gap, and is not caught by `hasLongGap` because a late start is not a gap.
 * OpenET's record opens on 1 October 2015, so 2015's cumulative curve begins at
 * zero in October; left in the pool it drags every percentile down sharply at
 * exactly that date and puts a visible step in "normal". Such years belong out
 * of the band, not partway through it.
 */
export function startsWithin(ys: YearSeries, startIdx: number, tolerance: number): boolean {
  for (let i = 0; i < ys.values.length; i++) {
    const v = ys.values[i];
    if (v !== null && Number.isFinite(v)) return i <= startIdx + tolerance;
  }
  return false;
}

/** Slice a year's series to only the days that actually have data. */
export function trimTrailingNulls(values: (number | null)[]): (number | null)[] {
  let last = values.length - 1;
  while (last >= 0 && values[last] === null) last--;
  return values.slice(0, last + 1);
}

/** Ordinary-least-squares slope of annual values, in units per year. */
export function linearTrend(points: Array<{ x: number; y: number }>): {
  slope: number;
  intercept: number;
  r2: number;
} | null {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 3) return null;

  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const p of pts) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
  }
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  return {
    slope,
    intercept: my - slope * mx,
    r2: syy === 0 ? 0 : (sxy * sxy) / (sxx * syy),
  };
}

/** Reduce each year to one number — for the 25-year trend panel. */
export function annualAggregate(
  series: YearSeries[],
  how: "sum" | "mean",
  /** Require this fraction of days present before a year counts. */
  minCoverage = 0.9
): Array<{ year: number; value: number; n: number }> {
  const out: Array<{ year: number; value: number; n: number }> = [];
  for (const ys of series) {
    const vals = ys.values.filter((v): v is number => v !== null && Number.isFinite(v));
    // Non-leap years legitimately have 365 of 366 slots.
    const expected = 365;
    if (vals.length < expected * minCoverage) continue;
    const sum = vals.reduce((a, b) => a + b, 0);
    out.push({ year: ys.year, value: how === "sum" ? sum : sum / vals.length, n: vals.length });
  }
  return out;
}
