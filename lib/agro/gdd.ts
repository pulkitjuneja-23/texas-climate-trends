import type { DailyRecord } from "@/lib/types";

/**
 * Growing degree days, metric (degC-days). Convert for display only.
 *
 * Two methods, because they disagree and the difference matters for corn:
 *
 *   simple    GDD = max(0, (Tmax + Tmin)/2 - base)
 *   modified  Tmax is capped at `cutoff` and Tmin is floored at `base` BEFORE
 *             averaging. This is the standard corn/maize method — it encodes
 *             that the crop stops accumulating heat above ~30 degC and does not
 *             lose progress on a cold night.
 *
 * In a Texas summer the two diverge substantially: a 38/24 degC day gives
 * 21.0 GDD simple but only 17.0 modified, because 38 is capped to 30.
 */

export type GddMethod = "simple" | "modified";

export interface GddConfig {
  /** Base temperature in degC. 10 degC (50 degF) for corn/sorghum. */
  base: number;
  /** Upper cutoff in degC, `modified` only. 30 degC (86 degF) for corn. */
  cutoff: number;
  method: GddMethod;
}

export const CORN_GDD: GddConfig = { base: 10, cutoff: 30, method: "modified" };
export const COTTON_GDD: GddConfig = { base: 15.6, cutoff: 32.2, method: "simple" };
export const WHEAT_GDD: GddConfig = { base: 4.4, cutoff: 30, method: "simple" };

export const GDD_PRESETS: Record<string, { label: string; config: GddConfig }> = {
  corn: { label: "Corn / sorghum (50-86°F)", config: CORN_GDD },
  cotton: { label: "Cotton (60-90°F)", config: COTTON_GDD },
  wheat: { label: "Wheat (40°F)", config: WHEAT_GDD },
};

export function dailyGdd(
  tmax: number | null,
  tmin: number | null,
  cfg: GddConfig = CORN_GDD
): number | null {
  if (tmax === null || tmin === null) return null;
  if (!Number.isFinite(tmax) || !Number.isFinite(tmin)) return null;

  let hi = tmax;
  let lo = tmin;

  if (cfg.method === "modified") {
    hi = Math.min(hi, cfg.cutoff);
    lo = Math.max(lo, cfg.base);
    // A day whose capped max fell below base contributes nothing.
    hi = Math.max(hi, cfg.base);
  }

  const mean = (hi + lo) / 2;
  return Math.max(0, mean - cfg.base);
}

export function gddSeries(records: DailyRecord[], cfg: GddConfig = CORN_GDD): (number | null)[] {
  return records.map((r) => dailyGdd(r.tmax, r.tmin, cfg));
}
