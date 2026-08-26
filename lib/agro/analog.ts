import type { DailyRecord } from "@/lib/types";
import { dailyGdd, type GddConfig, CORN_GDD } from "./gdd";

/**
 * Analog year matching — "which past year is this one tracking like?"
 *
 * Two things are compared, because either alone is misleading:
 *
 *   LEVEL  Where the season ended up: total rain, mean temps, accumulated GDD,
 *          dry days, longest dry spell, days over 35 degC.
 *
 *   SHAPE  How it got there. Two years can both finish the window at 180 mm —
 *          one from steady weekly rain, one from a single 150 mm event after a
 *          two-month drought. To a grower those are completely different years.
 *          Shape distance compares the standardised trajectory day by day.
 *
 * Both are standardised against the spread of the candidate years, so a
 * "distance" is in units of how unusual the difference is at that location,
 * not in millimetres. Comparing raw mm and raw degC in one Euclidean sum would
 * let precipitation dominate purely because it has bigger numbers.
 *
 * The payoff is `whatHappenedNext`: for each matching year, what the REST of
 * that season actually did. A similar year is only interesting because of what
 * followed it.
 */

export interface AnalogFeatures {
  precipTotal: number;
  tmaxMean: number;
  tminMean: number;
  gddTotal: number;
  dryDays: number;
  maxDrySpell: number;
  hotDays: number;
}

export const FEATURE_LABELS: Record<keyof AnalogFeatures, string> = {
  precipTotal: "Rainfall total",
  tmaxMean: "Avg high temp",
  tminMean: "Avg low temp",
  gddTotal: "Accumulated GDD",
  dryDays: "Dry days (<1 mm)",
  maxDrySpell: "Longest dry spell",
  hotDays: "Days ≥ 35 °C / 95 °F",
};

/**
 * Columns shown in the comparison table. `hotDays` still drives the matching
 * maths — it is a real signal — it is just not displayed, because it overlapped
 * heavily with avg high temp and made the table too wide to scan.
 */
/**
 * Columns shown in the comparison table.
 *
 * `tminMean` and `dryDays` were briefly dropped to hold the table's width and
 * have been restored — the table scrolls horizontally instead. `maxDrySpell`
 * stays out because it was reported as confusing, not because of width, and
 * `hotDays` stays out because it duplicates avg-high. Both still drive the
 * matching maths; only the display differs.
 */
export const DISPLAYED_FEATURES: Array<keyof AnalogFeatures> = [
  "precipTotal",
  "tmaxMean",
  "tminMean",
  "gddTotal",
  "dryDays",
];

/**
 * Short column headings. The long labels pushed the "what came next" columns —
 * the whole point of the table — off the right edge on a normal screen.
 */
export const FEATURE_SHORT_LABELS: Record<keyof AnalogFeatures, string> = {
  precipTotal: "Rain",
  tmaxMean: "Avg high",
  tminMean: "Avg low",
  gddTotal: "GDD",
  dryDays: "Dry days",
  maxDrySpell: "Dry spell",
  hotDays: "Hot days",
};

/** Relative importance in the level term. Rain and heat drive most decisions. */
const FEATURE_WEIGHTS: Record<keyof AnalogFeatures, number> = {
  precipTotal: 1.6,
  tmaxMean: 1.2,
  tminMean: 0.7,
  gddTotal: 1.2,
  dryDays: 1.0,
  maxDrySpell: 1.0,
  hotDays: 0.9,
};

const FEATURE_KEYS = Object.keys(FEATURE_WEIGHTS) as Array<keyof AnalogFeatures>;

/** Level vs shape mix. Shape is weighted heavily — it is the "trend" question. */
const LEVEL_WEIGHT = 0.55;
const SHAPE_WEIGHT = 0.45;

const DRY_DAY_MM = 1.0;
const HOT_DAY_C = 35;

export interface WhatHappenedNext {
  days: number;
  precipTotal: number | null;
  tmaxMean: number | null;
  gddTotal: number | null;
  /** Candidate's next-N-days rain as a % of the median across all years. */
  precipVsMedianPct: number | null;
  coverage: number;
}

export interface AnalogMatch {
  year: number;
  /** Combined distance; lower is more similar. */
  distance: number;
  /** 0-100, rescaled across the candidate set for readability. */
  similarity: number;
  levelDistance: number;
  shapeDistance: number;
  features: AnalogFeatures;
  /** candidate minus current, in raw metric units. */
  deltas: Record<keyof AnalogFeatures, number>;
  whatHappenedNext: WhatHappenedNext | null;
  coverage: number;
}

/**
 * The long-run average across EVERY eligible year, not just the close matches.
 *
 * This is the baseline a grower needs in order to read the matches at all. "The
 * five similar years gave 0.5 to 8.6 in afterwards" means little until you know
 * a typical year gives 4 in. Averaged over all candidates rather than the top
 * five, because the point is what is normal, not what is similar.
 */
export interface AnalogAverages {
  /** How many years went into these means. */
  years: number;
  features: AnalogFeatures;
  next: {
    days: number;
    precipTotal: number | null;
    tmaxMean: number | null;
    gddTotal: number | null;
    years: number;
  } | null;
}

export interface AnalogResult {
  asOf: string;
  windowStart: string;
  windowDays: number;
  currentYear: number;
  currentFeatures: AnalogFeatures;
  currentCoverage: number;
  matches: AnalogMatch[];
  /** Every year eligible for matching — the panel averages water over these. */
  candidateYears: number[];
  /** Long-run means across all candidate years. */
  averages: AnalogAverages | null;
  /** Years dropped for having too few observations in the window. */
  skippedYears: number[];
  lookAheadDays: number;
}

function shiftDate(iso: string, deltaDays: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** MM-DD offsets covering the trailing window ending at asOf. */
function windowKeys(asOf: string, windowDays: number): string[] {
  const keys: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    keys.push(shiftDate(asOf, -i).slice(5, 10));
  }
  return keys;
}

function indexByDate(records: DailyRecord[]): Map<string, DailyRecord> {
  const m = new Map<string, DailyRecord>();
  for (const r of records) if (r.date) m.set(r.date, r);
  return m;
}

/** Pull one year's records for a MM-DD window, handling the year rollover. */
function windowRecords(
  byDate: Map<string, DailyRecord>,
  year: number,
  keys: string[],
  /** true when the window crosses 1 Jan, so early keys belong to year-1. */
  spansNewYear: boolean,
  rolloverIdx: number
): Array<DailyRecord | null> {
  return keys.map((key, i) => {
    const y = spansNewYear && i < rolloverIdx ? year - 1 : year;
    if (key === "02-29" && !isLeap(y)) return null;
    return byDate.get(`${y}-${key}`) ?? null;
  });
}

function computeFeatures(recs: Array<DailyRecord | null>, gddCfg: GddConfig): {
  features: AnalogFeatures;
  coverage: number;
  cumPrecip: number[];
  rollTmax: number[];
} {
  let precipTotal = 0;
  let tmaxSum = 0;
  let tmaxN = 0;
  let tminSum = 0;
  let tminN = 0;
  let gddTotal = 0;
  let dryDays = 0;
  let hotDays = 0;
  let maxDrySpell = 0;
  let curDrySpell = 0;
  let present = 0;

  const cumPrecip: number[] = [];
  const tmaxSeries: Array<number | null> = [];

  for (const r of recs) {
    const p = r?.precip ?? null;
    const tx = r?.tmax ?? null;
    const tn = r?.tmin ?? null;

    if (r && (p !== null || tx !== null)) present++;

    if (p !== null) {
      precipTotal += p;
      if (p < DRY_DAY_MM) {
        dryDays++;
        curDrySpell++;
        maxDrySpell = Math.max(maxDrySpell, curDrySpell);
      } else {
        curDrySpell = 0;
      }
    }
    cumPrecip.push(precipTotal);

    if (tx !== null) {
      tmaxSum += tx;
      tmaxN++;
      if (tx >= HOT_DAY_C) hotDays++;
    }
    if (tn !== null) {
      tminSum += tn;
      tminN++;
    }
    tmaxSeries.push(tx);

    const g = dailyGdd(tx, tn, gddCfg);
    if (g !== null) gddTotal += g;
  }

  // 7-day trailing mean of tmax, carrying the last good value across gaps.
  const rollTmax: number[] = [];
  let lastGood = tmaxN ? tmaxSum / tmaxN : 0;
  for (let i = 0; i < tmaxSeries.length; i++) {
    const slice: number[] = [];
    for (let j = Math.max(0, i - 6); j <= i; j++) {
      const v = tmaxSeries[j];
      if (v !== null) slice.push(v);
    }
    if (slice.length) {
      lastGood = slice.reduce((a, b) => a + b, 0) / slice.length;
    }
    rollTmax.push(lastGood);
  }

  return {
    features: {
      precipTotal,
      tmaxMean: tmaxN ? tmaxSum / tmaxN : 0,
      tminMean: tminN ? tminSum / tminN : 0,
      gddTotal,
      dryDays,
      maxDrySpell,
      hotDays,
    },
    coverage: recs.length ? present / recs.length : 0,
    cumPrecip,
    rollTmax,
  };
}

function meanSd(values: number[]): { mean: number; sd: number } {
  if (!values.length) return { mean: 0, sd: 1 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const varc = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  // Floor the sd so a near-constant feature cannot blow up the z-scores.
  return { mean, sd: Math.max(Math.sqrt(varc), 1e-6) };
}

export interface AnalogOptions {
  windowDays?: number;
  lookAheadDays?: number;
  gddConfig?: GddConfig;
  topN?: number;
  /** Minimum fraction of the window a year must have to be eligible. */
  minCoverage?: number;
  /** Override "today"; defaults to the last record carrying real data. */
  asOf?: string;
}

export function findAnalogYears(
  records: DailyRecord[],
  opts: AnalogOptions = {}
): AnalogResult {
  const windowDays = opts.windowDays ?? 150;
  const lookAheadDays = opts.lookAheadDays ?? 60;
  const gddCfg = opts.gddConfig ?? CORN_GDD;
  const topN = opts.topN ?? 5;
  const minCoverage = opts.minCoverage ?? 0.8;

  const byDate = indexByDate(records);

  const withData = records.filter(
    (r) => r.tmax !== null || r.precip !== null
  );
  if (!withData.length) {
    throw new Error("No usable records for analog matching.");
  }

  const asOf = opts.asOf ?? withData[withData.length - 1].date;
  const currentYear = Number(asOf.slice(0, 4));
  const windowStart = shiftDate(asOf, -(windowDays - 1));

  const keys = windowKeys(asOf, windowDays);
  const spansNewYear = windowStart.slice(0, 4) !== asOf.slice(0, 4);
  // Index at which the window crosses into the asOf year.
  const rolloverIdx = spansNewYear
    ? keys.findIndex((_, i) => shiftDate(windowStart, i).slice(0, 4) === asOf.slice(0, 4))
    : 0;

  const current = computeFeatures(
    windowRecords(byDate, currentYear, keys, spansNewYear, rolloverIdx),
    gddCfg
  );

  const years = [...new Set(records.map((r) => Number(r.date.slice(0, 4))))]
    .filter((y) => Number.isFinite(y) && y < currentYear)
    .sort((a, b) => a - b);

  const skippedYears: number[] = [];
  const candidates: Array<{
    year: number;
    f: ReturnType<typeof computeFeatures>;
  }> = [];

  for (const y of years) {
    // A window spanning the new year needs year-1 to exist too.
    if (spansNewYear && !years.includes(y - 1) && y - 1 < years[0]) {
      skippedYears.push(y);
      continue;
    }
    const f = computeFeatures(
      windowRecords(byDate, y, keys, spansNewYear, rolloverIdx),
      gddCfg
    );
    if (f.coverage < minCoverage) {
      skippedYears.push(y);
      continue;
    }
    candidates.push({ year: y, f });
  }

  if (!candidates.length) {
    return {
      asOf,
      windowStart,
      windowDays,
      currentYear,
      currentFeatures: current.features,
      currentCoverage: current.coverage,
      matches: [],
      candidateYears: [],
      averages: null,
      skippedYears,
      lookAheadDays,
    };
  }

  // --- Level term: z-score each feature across the candidate spread. ---
  const stats: Record<string, { mean: number; sd: number }> = {};
  for (const k of FEATURE_KEYS) {
    stats[k] = meanSd(candidates.map((c) => c.f.features[k]));
  }

  const totalWeight = FEATURE_KEYS.reduce((a, k) => a + FEATURE_WEIGHTS[k], 0);

  function levelDistance(f: AnalogFeatures): number {
    let acc = 0;
    for (const k of FEATURE_KEYS) {
      const { mean, sd } = stats[k];
      const zc = (current.features[k] - mean) / sd;
      const zy = (f[k] - mean) / sd;
      acc += FEATURE_WEIGHTS[k] * (zc - zy) ** 2;
    }
    return Math.sqrt(acc / totalWeight);
  }

  // --- Shape term: standardise each day of the trajectory across years. ---
  const steps = keys.length;
  const cumStats: Array<{ mean: number; sd: number }> = [];
  const tmaxStats: Array<{ mean: number; sd: number }> = [];
  for (let i = 0; i < steps; i++) {
    cumStats.push(meanSd(candidates.map((c) => c.f.cumPrecip[i] ?? 0)));
    tmaxStats.push(meanSd(candidates.map((c) => c.f.rollTmax[i] ?? 0)));
  }

  function shapeDistance(f: ReturnType<typeof computeFeatures>): number {
    let acc = 0;
    for (let i = 0; i < steps; i++) {
      const cz = (current.cumPrecip[i] - cumStats[i].mean) / cumStats[i].sd;
      const yz = (f.cumPrecip[i] - cumStats[i].mean) / cumStats[i].sd;
      const ct = (current.rollTmax[i] - tmaxStats[i].mean) / tmaxStats[i].sd;
      const yt = (f.rollTmax[i] - tmaxStats[i].mean) / tmaxStats[i].sd;
      // Rain trajectory weighted above temperature trajectory.
      acc += 0.6 * (cz - yz) ** 2 + 0.4 * (ct - yt) ** 2;
    }
    return Math.sqrt(acc / steps);
  }

  // --- What the rest of that season did. ---
  function lookAhead(year: number): WhatHappenedNext | null {
    const startISO = shiftDate(asOf, 1);
    const startKey = startISO.slice(5, 10);
    const startYearOffset = startISO.slice(0, 4) !== asOf.slice(0, 4) ? 1 : 0;

    let precipTotal = 0;
    let tmaxSum = 0;
    let tmaxN = 0;
    let gddTotal = 0;
    let present = 0;

    for (let i = 0; i < lookAheadDays; i++) {
      const iso = shiftDate(`${year + startYearOffset}-${startKey}`, i);
      const rec = byDate.get(iso);
      if (!rec) continue;
      if (rec.precip !== null || rec.tmax !== null) present++;
      if (rec.precip !== null) precipTotal += rec.precip;
      if (rec.tmax !== null) {
        tmaxSum += rec.tmax;
        tmaxN++;
      }
      const g = dailyGdd(rec.tmax, rec.tmin, gddCfg);
      if (g !== null) gddTotal += g;
    }

    const coverage = present / lookAheadDays;
    if (coverage < 0.5) return null;

    return {
      days: lookAheadDays,
      precipTotal,
      tmaxMean: tmaxN ? tmaxSum / tmaxN : null,
      gddTotal,
      precipVsMedianPct: null, // filled in below once all candidates are known
      coverage,
    };
  }

  const scored = candidates.map((c) => {
    const ld = levelDistance(c.f.features);
    const sd = shapeDistance(c.f);
    const deltas = {} as Record<keyof AnalogFeatures, number>;
    for (const k of FEATURE_KEYS) {
      deltas[k] = c.f.features[k] - current.features[k];
    }
    return {
      year: c.year,
      distance: LEVEL_WEIGHT * ld + SHAPE_WEIGHT * sd,
      similarity: 0,
      levelDistance: ld,
      shapeDistance: sd,
      features: c.f.features,
      deltas,
      whatHappenedNext: lookAhead(c.year),
      coverage: c.f.coverage,
    } satisfies AnalogMatch;
  });

  // Median of next-N-days rain across all candidates, for context.
  const nextRains = scored
    .map((s) => s.whatHappenedNext?.precipTotal)
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => a - b);
  const medianNextRain = nextRains.length
    ? nextRains[Math.floor(nextRains.length / 2)]
    : null;

  for (const s of scored) {
    if (s.whatHappenedNext && medianNextRain && medianNextRain > 0) {
      s.whatHappenedNext.precipVsMedianPct =
        (s.whatHappenedNext.precipTotal! / medianNextRain) * 100;
    }
  }

  scored.sort((a, b) => a.distance - b.distance);

  // Rescale distance to a 0-100 readability score across this candidate set.
  const dMin = scored[0].distance;
  const dMax = scored[scored.length - 1].distance;
  const span = Math.max(dMax - dMin, 1e-9);
  for (const s of scored) {
    s.similarity = Math.round((1 - (s.distance - dMin) / span) * 100);
  }

  // Long-run means over EVERY candidate, computed before the top-N cut.
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  const avgFeatures = {} as AnalogFeatures;
  for (const k of FEATURE_KEYS) {
    avgFeatures[k] = mean(candidates.map((c) => c.f.features[k]));
  }

  const nexts = scored.map((s) => s.whatHappenedNext).filter((n): n is WhatHappenedNext => !!n);
  const averages: AnalogAverages = {
    years: candidates.length,
    features: avgFeatures,
    next: nexts.length
      ? {
          days: lookAheadDays,
          precipTotal: mean(
            nexts.map((n) => n.precipTotal).filter((v): v is number => typeof v === "number")
          ),
          tmaxMean: mean(
            nexts.map((n) => n.tmaxMean).filter((v): v is number => typeof v === "number")
          ),
          gddTotal: mean(
            nexts.map((n) => n.gddTotal).filter((v): v is number => typeof v === "number")
          ),
          years: nexts.length,
        }
      : null,
  };

  return {
    asOf,
    windowStart,
    windowDays,
    currentYear,
    currentFeatures: current.features,
    currentCoverage: current.coverage,
    matches: scored.slice(0, topN),
    candidateYears: candidates.map((c) => c.year),
    averages,
    skippedYears,
    lookAheadDays,
  };
}
