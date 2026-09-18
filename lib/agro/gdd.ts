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
/**
 * Bermuda grass — a warm-season perennial, so this one is not a crop calendar.
 *
 * Base 10 degC (50 degF) is the figure Texas forage and turf extension work
 * uses for bermudagrass growth. The simple method is right here: the modified
 * method's cap exists because a corn KERNEL stops filling in extreme heat, and
 * bermuda grass has no equivalent — it keeps growing through a Texas summer,
 * which is most of why it is planted.
 */
export const BERMUDA_GDD: GddConfig = { base: 10, cutoff: 30, method: "simple" };

/** Starting point when the grower switches to a custom base of their own. */
export const CUSTOM_GDD_DEFAULT: GddConfig = { base: 10, cutoff: 30, method: "simple" };

/**
 * `short` exists so the crop can be named wherever GDD is shown.
 *
 * A user asked "what crop are the growing degree days for?" and only found the
 * base-temperature selector after starting to write the question. Growing
 * degree days are meaningless without a base temperature, and a base
 * temperature is really a crop — so the crop belongs in the LABEL, not only in
 * a setting somewhere below.
 */
export const GDD_PRESETS: Record<
  string,
  { label: string; short: string; config: GddConfig; planting: string }
> = {
  corn: {
    label: "Corn / sorghum (50-86°F)",
    short: "corn / sorghum",
    config: CORN_GDD,
    planting: "03-01",
  },
  cotton: { label: "Cotton (60-90°F)", short: "cotton", config: COTTON_GDD, planting: "04-01" },
  wheat: { label: "Wheat (40°F)", short: "wheat", config: WHEAT_GDD, planting: "10-01" },
  /*
    Bermuda grass is PERENNIAL, so "planting" here means spring green-up, not a
    date anything goes in the ground. 1 March is the broad statewide point at
    which soil temperature brings it out of dormancy; it is earlier in the
    Valley and later on the High Plains, same caveat as every other date here.
  */
  bermuda: {
    label: "Bermuda grass (50°F)",
    short: "bermuda grass",
    config: BERMUDA_GDD,
    planting: "03-01",
  },
  /*
    The grower's own base temperature.

    `config` here is only the starting point — the live value is held in the
    page's state and replaces this, because a setting the reader can change has
    to live where React can see it change. The label is deliberately generic;
    the UI prints the actual base beside it, so the number on screen is always
    the number being used.

    It exists because these four presets cannot cover the question. Base
    temperatures in real use run from about 0 degC for cool-season grasses to
    18 degC for some tropical species, and a grower or agronomist working on
    anything outside this list was previously stuck with the nearest wrong
    answer.
  */
  custom: {
    label: "Custom base temperature",
    short: "custom base",
    config: CUSTOM_GDD_DEFAULT,
    planting: "01-01",
  },
};

/**
 * Where a season's heat accumulation should START, as MM-DD.
 *
 * WHY THIS EXISTS. Accumulating GDD from 1 January is arithmetically fine and
 * agronomically meaningless — nobody plants corn in January. Measured at
 * Beeville, corn GDD from 1 Jan reached 5,706 degF-days by late August, when a
 * corn crop needs roughly 2,400-2,800 from planting to black layer. The tile
 * was showing about two crops' worth of heat, and a user correctly said it
 * "seems high". Heat units only mean something counted from planting.
 *
 * These are broad statewide defaults and WILL be wrong for a specific field —
 * south Texas corn goes in around mid-February, the High Plains not until
 * April. They are a better starting point than 1 January, not a substitute for
 * the grower setting their own date, and the UI says so.
 *
 * WINTER WHEAT IS THE AWKWARD ONE. It is planted in the autumn and harvested
 * the following summer, so its real window crosses the year boundary — which
 * the season-to-date machinery cannot represent, since it accumulates within
 * one calendar year. October is its true planting month; for most of the year
 * that date lies in the future, and `plantingStart` falls back to 1 January
 * rather than showing an empty tile. That fallback is a limitation, not a
 * recommendation.
 */
export function plantingStart(presetKey: string, year: number, lastObserved?: string | null): string {
  const md = GDD_PRESETS[presetKey]?.planting ?? "01-01";
  const candidate = `${year}-${md}`;
  // A planting date that has not arrived yet would accumulate nothing at all.
  if (lastObserved && candidate > lastObserved) return `${year}-01-01`;
  return candidate;
}

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
