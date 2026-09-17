/**
 * Is what Idaho is serving physically possible?
 *
 * WHY THIS EXISTS. On 2026-09-17 the University of Idaho's own 2026 files
 * (`pr_2026.nc`, `tmmx_2026.nc`, and the CurrentYear aggregations built on them)
 * began serving January through July as nonsense: zero rainfall on every day in
 * every cell of Texas, July highs of -3 degC, and a daily high only ~1.5 degC
 * above the low. August onward was fine. The daily refresh copied it faithfully,
 * and within the hour every gridMET location in Texas drew 2026 cumulative
 * rainfall as a flat line along zero. Nothing errored anywhere: the shapes, the
 * coordinates and the time axis were all correct. Only the values were wrong.
 *
 * So the refresh now samples the state before uploading anything and refuses to
 * publish a month that fails any rule below.
 *
 * THE RULES ARE DELIBERATELY COARSE. They catch a broken FILE, not an unusual
 * season — a false alarm would withhold real data during precisely the kind of
 * extreme year a grower most wants to see. Measured on a 1-in-8 sample of the
 * Texas grid (~1,000 land cells), monthly:
 *
 *   statistic                         healthy 2025     broken 2026 Jan-Jul
 *   mean daily range (tmax - tmin)    12.4 - 17.0 K    1.1 - 2.2 K
 *   cell-days with >= 1 mm rain       4.9 - 30.5 %     0.0 - 0.7 %
 *   mean tmax, June-August            32 - 34 degC     0.0 - 1.3 degC
 *   fill share (Gulf, Mexico)         28 %             28 %
 *
 * Every threshold sits far inside the gap. What they will NOT catch is a single
 * bad day or a subtle bias — that is what `scripts/verify-current.mts` is for.
 */

export interface PlausibilitySample {
  /** ISO dates, one per day. */
  dates: string[];
  /**
   * Unpacked values per day, per sampled cell: Kelvin for temperature, mm for
   * rainfall. null where the source holds its fill value (ocean, Mexico).
   * Every array is dates.length x cells, day-major.
   */
  tmax: (number | null)[];
  tmin: (number | null)[];
  precip: (number | null)[];
  cells: number;
}

export interface MonthStats {
  month: string;
  days: number;
  fillShare: number;
  meanRangeK: number;
  meanTmaxC: number;
  wetShare: number;
}

/** A month with fewer days than this is too short to judge; skip it. */
const MIN_DAYS = 10;
/** Healthy months run 12-17 K; a broken file ran 1-2 K. */
const MIN_MEAN_RANGE_K = 6;
/** Healthy summers run 32-34 degC statewide; a broken file ran ~0 degC. */
const MIN_SUMMER_TMAX_C = 20;
const SUMMER_MONTHS = new Set([6, 7, 8]);
/** Healthy 28% — the box includes the Gulf and northern Mexico. */
const MAX_FILL_SHARE = 0.5;
/**
 * Not one land cell-day with a millimetre of rain across a whole month of
 * Texas. The driest measured month here was still 4.9%. Only applied to months
 * of 20+ days so a short tail cannot trip it.
 */
const MIN_DAYS_FOR_DRY_RULE = 20;

export function monthlyStats(s: PlausibilitySample): MonthStats[] {
  const acc = new Map<
    string,
    { days: number; n: number; fill: number; range: number; tmax: number; wet: number }
  >();

  for (let d = 0; d < s.dates.length; d++) {
    const key = s.dates[d].slice(0, 7);
    let m = acc.get(key);
    if (!m) acc.set(key, (m = { days: 0, n: 0, fill: 0, range: 0, tmax: 0, wet: 0 }));
    m.days++;
    for (let c = 0; c < s.cells; c++) {
      const i = d * s.cells + c;
      const tx = s.tmax[i];
      const tn = s.tmin[i];
      const p = s.precip[i];
      if (tx === null || tn === null || p === null) {
        m.fill++;
        continue;
      }
      m.n++;
      m.range += tx - tn;
      m.tmax += tx;
      if (p >= 1) m.wet++;
    }
  }

  return [...acc.entries()].map(([month, m]) => ({
    month,
    days: m.days,
    fillShare: m.fill / Math.max(1, m.n + m.fill),
    meanRangeK: m.n ? m.range / m.n : NaN,
    meanTmaxC: m.n ? m.tmax / m.n - 273.15 : NaN,
    wetShare: m.n ? m.wet / m.n : NaN,
  }));
}

/**
 * Problems found, in words. Empty means the sample looks like real weather.
 *
 * `statewideDryRule` is only valid on a statewide sample of ~1,000 cells. A
 * handful of points can genuinely go a month without rain; for those use
 * `longestSharedDrySpell` instead.
 */
export function implausibleMonths(
  stats: MonthStats[],
  { statewideDryRule = true }: { statewideDryRule?: boolean } = {}
): string[] {
  const problems: string[] = [];
  for (const m of stats) {
    if (m.days < MIN_DAYS) continue;
    const month = Number(m.month.slice(5, 7));

    if (!(m.fillShare <= MAX_FILL_SHARE)) {
      problems.push(`${m.month}: ${(m.fillShare * 100).toFixed(0)}% of cells are missing`);
      continue; // the remaining statistics are meaningless on mostly-empty data
    }
    if (!(m.meanRangeK >= MIN_MEAN_RANGE_K)) {
      problems.push(
        `${m.month}: daily high only ${m.meanRangeK.toFixed(1)} K above the low on average ` +
          `(real months run 12-17)`
      );
    }
    if (SUMMER_MONTHS.has(month) && !(m.meanTmaxC >= MIN_SUMMER_TMAX_C)) {
      problems.push(`${m.month}: statewide mean high ${m.meanTmaxC.toFixed(1)} degC in summer`);
    }
    if (statewideDryRule && m.days >= MIN_DAYS_FOR_DRY_RULE && m.wetShare === 0) {
      problems.push(`${m.month}: not one cell-day with 1 mm of rain anywhere in Texas`);
    }
  }
  return problems;
}

/**
 * The longest run of consecutive days on which NONE of the given places had any
 * measurable rain — the flat line, stated as a number.
 *
 * Places spread across the state do not all go dry together for long: the east
 * sees rain most weeks even when the west is in drought. So a long shared spell
 * across a spread of sites means the data went flat, not the weather. `precip`
 * is day-major, `cells` values per day; a null counts as dry, because a missing
 * value draws the same flat line on screen.
 */
export function longestSharedDrySpell(
  dates: string[],
  precip: (number | null)[],
  cells: number
): { days: number; from: string | null; to: string | null } {
  let best = { days: 0, from: null as string | null, to: null as string | null };
  let runStart = -1;
  for (let d = 0; d <= dates.length; d++) {
    let anyRain = d === dates.length;
    for (let c = 0; !anyRain && c < cells; c++) {
      const p = precip[d * cells + c];
      if (p !== null && p >= 0.1) anyRain = true;
    }
    if (!anyRain) {
      if (runStart < 0) runStart = d;
    } else if (runStart >= 0) {
      const len = d - runStart;
      if (len > best.days) best = { days: len, from: dates[runStart], to: dates[d - 1] };
      runStart = -1;
    }
  }
  return best;
}
