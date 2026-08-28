/**
 * The shape of the hosted county-yield store, and the trend maths that makes
 * a thirty-year yield comparison mean anything.
 *
 * ---------------------------------------------------------------------------
 * WHY A TREND IS NOT OPTIONAL HERE
 * ---------------------------------------------------------------------------
 * Raw yield across thirty years is dominated by genetics and agronomy, not
 * weather. Texas corn averaged roughly 100 bu/ac in the late 1990s and roughly
 * 150 now. Drop those numbers into a table of analog years and 1998 reads as a
 * disaster next to 2023 - when 1998 may have been a perfectly good season for
 * its time.
 *
 * That would be an actively misleading answer to the question the panel asks,
 * which is "in years whose weather looked like this one, how did the crop do?"
 * The answer has to be relative to what was normal THEN. So every cell carries
 * both: the actual yield, and that yield as a percentage of the fitted trend
 * for its year.
 *
 * ---------------------------------------------------------------------------
 * THE STORE IS ONE SMALL FILE
 * ---------------------------------------------------------------------------
 * All of Texas is ~33,000 numbers - under a megabyte. This is deliberately NOT
 * an archive like gridMET (1.39 GB, 20,820 objects): it is a single JSON blob,
 * rewritten whole every quarter. The site therefore never calls NASS, so NASS
 * being down cannot affect a page load. If a quarterly refresh fails, the
 * previously published file keeps serving.
 */

/** A contiguous run of years, with gaps as null. Compact by design. */
export interface YieldSeries {
  /** Calendar year of index 0. */
  y0: number;
  /** One slot per year from y0; null where the county has no published figure. */
  v: (number | null)[];
}

/** Ordinary-least-squares fit of yield against year. */
export interface YieldTrend {
  slope: number;
  intercept: number;
  /** Years actually used. Below MIN_TREND_YEARS no trend is published. */
  n: number;
  r2: number;
  /**
   * True when the SLOPE was borrowed from the statewide series for this crop
   * and practice, then anchored to this county's own average level.
   *
   * Why this exists: only 54% of all-practice series and 31% of dryland series
   * have enough years to fit their own slope, so a strict rule left the
   * irrigated/dryland toggle showing mostly blanks — gutting the comparison the
   * panel is for. A county with eight years cannot estimate a technology trend,
   * but it does not need to: the trend is a statewide phenomenon (better
   * genetics, better agronomy), while the county's own LEVEL is local. So the
   * statewide rate of improvement is applied at this county's own average.
   *
   * It is marked because it is an assumption, not a measurement, and the UI
   * says so on hover.
   */
  borrowed?: boolean;
}

export interface CountyCropData {
  /** Keyed by PracticeId: "all" | "irr" | "dry". */
  series: Record<string, YieldSeries>;
  trend: Record<string, YieldTrend>;
}

export interface YieldStore {
  version: number;
  builtAt: string;
  /** Where the numbers came from, shown in the UI. */
  attribution: string;
  /** Crop ids present, in display order. */
  crops: Array<{
    id: string;
    label: string;
    unit: string;
    unitShort: string;
    decimals: number;
  }>;
  /** FIPS county code (3 digits, Texas) -> proper name. */
  countyNames: Record<string, string>;
  /** countyFips -> cropId -> data. */
  data: Record<string, Record<string, CountyCropData>>;
}

export const YIELD_STORE_VERSION = 1;
export const YIELD_STORE_KEY = "nass/texas-yield.json";
export const COUNTY_INDEX_KEY = "nass/county-index.json";

/**
 * Below this many observed years, no trend is published for that series.
 *
 * A slope fitted through eight noisy county yields can come out negative or
 * absurd, and dividing by an absurd fitted value produces a confident-looking
 * percentage that is nonsense. Twelve is enough that a technology trend
 * dominates the weather noise; most Texas county-crop series have 20-30.
 */
export const MIN_TREND_YEARS = 12;

/**
 * Below this, not even a borrowed slope is offered.
 *
 * Anchoring a statewide slope needs a believable county AVERAGE to anchor it
 * to, and four scattered years is not one — especially since the years a county
 * happens to report are not random (a crop gets reported when enough people
 * grow it, which correlates with it having gone well).
 */
export const MIN_ANCHOR_YEARS = 6;

/**
 * Statewide rate of improvement for one crop and practice, as a FRACTION of the
 * mean per year — so it can be re-anchored to any county's own level.
 */
export interface StateTrendRate {
  relSlope: number;
  n: number;
  r2: number;
}

/**
 * Build a county trend by borrowing the statewide slope and anchoring it to
 * this county's own average.
 *
 * The line passes through (mean year, mean yield) of the county's own
 * observations, so the county's LEVEL is entirely local; only the tilt is
 * borrowed.
 */
export function anchorTrend(
  rate: StateTrendRate,
  years: number[],
  values: number[]
): YieldTrend | null {
  const n = years.length;
  if (n < MIN_ANCHOR_YEARS) return null;

  const meanX = years.reduce((a, b) => a + b, 0) / n;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  if (!(meanY > 0)) return null;

  const slope = rate.relSlope * meanY;
  return {
    slope,
    intercept: meanY - slope * meanX,
    n,
    r2: rate.r2,
    borrowed: true,
  };
}

/** Fit yield against year. Returns null when there is not enough to fit. */
export function fitTrend(years: number[], values: number[]): YieldTrend | null {
  const n = years.length;
  if (n < MIN_TREND_YEARS) return null;

  const meanX = years.reduce((a, b) => a + b, 0) / n;
  const meanY = values.reduce((a, b) => a + b, 0) / n;

  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (years[i] - meanX) * (values[i] - meanY);
    sxx += (years[i] - meanX) ** 2;
  }
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const fit = intercept + slope * years[i];
    ssRes += (values[i] - fit) ** 2;
    ssTot += (values[i] - meanY) ** 2;
  }

  return { slope, intercept, n, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot };
}

/**
 * That year's yield as a percentage of what the trend expected for that year.
 *
 * Returns null rather than a number whenever the comparison would be
 * meaningless: no trend, or a fitted value at or below zero. A trend line
 * extrapolated below zero can otherwise produce percentages like -400%, which
 * look precise and mean nothing.
 */
export function percentOfTrend(
  trend: YieldTrend | undefined,
  year: number,
  value: number
): number | null {
  if (!trend) return null;
  const fitted = trend.intercept + trend.slope * year;
  if (!(fitted > 0)) return null;
  return (value / fitted) * 100;
}

/**
 * The same comparison as a SIGNED deviation: -7% rather than 93%.
 *
 * The baseline is unchanged — still the fitted trend for that year, so the
 * thirty years of genetic improvement are still removed. Only the presentation
 * differs, and it differs for a reason: "93%" makes the reader subtract from a
 * hundred before it means anything, while "-7%" is already the answer. Above
 * zero beat what was normal for that year; below fell short.
 */
export function deviationFromTrend(
  trend: YieldTrend | undefined,
  year: number,
  value: number
): number | null {
  const pct = percentOfTrend(trend, year, value);
  return pct === null ? null : pct - 100;
}

/**
 * One county's slice, as the API sends it to the browser.
 *
 * Declared here rather than in `read.ts` so a client component can import the
 * type without dragging the reader — which touches `process.env` and would be
 * traced into the browser bundle. Same wall as `lib/sources/defaults.ts`.
 */
export interface CountyYields {
  county: { fips: string; name: string };
  attribution: string;
  builtAt: string;
  /** Only the crops this county actually has figures for, in display order. */
  crops: Array<{
    id: string;
    label: string;
    unit: string;
    unitShort: string;
    decimals: number;
    /** Which of all/irr/dry this county publishes for this crop. */
    practices: string[];
  }>;
  data: Record<string, CountyCropData>;
}

/** Read one year out of a series, or null if absent. */
export function yieldAt(series: YieldSeries | undefined, year: number): number | null {
  if (!series) return null;
  const i = year - series.y0;
  if (i < 0 || i >= series.v.length) return null;
  return series.v[i];
}
