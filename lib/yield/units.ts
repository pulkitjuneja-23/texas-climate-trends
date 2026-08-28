/**
 * Converting NASS yields to metric.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT ONE MULTIPLIER
 * ---------------------------------------------------------------------------
 * NASS reports three different US units across these ten crops, and one of them
 * is not a unit of mass at all:
 *
 *   LB / ACRE     cotton, peanuts, rice, sunflower   - a real mass
 *   TONS / ACRE   sugarcane                          - US SHORT tons, 2000 lb
 *   BU / ACRE     corn, sorghum, wheat, soybeans,    - a unit of VOLUME
 *                 oats
 *
 * A bushel is a volume, so converting it to mass needs the crop's own legal
 * test weight, and those genuinely differ: corn and sorghum are 56 lb, wheat
 * and soybeans 60 lb, oats only 32 lb. Using one factor for all of them would
 * overstate an oat crop by 88%.
 *
 * ---------------------------------------------------------------------------
 * WHY t/ha RATHER THAN Mg/ha
 * ---------------------------------------------------------------------------
 * They are the same number - a tonne IS a megagram - so this is purely about
 * which one a grower reads without stopping. "t/ha" is what extension services,
 * FAO and seed companies print; "Mg/ha" appears mainly in journals. Same value,
 * less friction.
 *
 * The one awkward case is cotton, which lands near 0.6 t/ha because the figure
 * is lint rather than seed cotton. Two decimal places keep it readable rather
 * than switching cotton alone to kg/ha, which would put two different metric
 * units in one column and defeat the point of converting.
 */

/**
 * 1 lb/acre in t/ha.
 *
 *   0.45359237 kg per lb / 0.40468564 ha per acre = 1.120851 kg/ha
 *
 * ...then kg -> t. Written out because a bare 0.00112 is unverifiable.
 */
const LB_PER_AC_TO_T_PER_HA = 0.45359237 / 0.40468564 / 1000;

/** US short ton, 2000 lb - NOT the 1000 kg tonne this converts TO. */
const LB_PER_SHORT_TON = 2000;

/**
 * Legal bushel test weights, pounds. These are the US statutory values, not
 * approximations, and they are why the conversion is per crop.
 */
const BUSHEL_LB: Record<string, number> = {
  corn: 56,
  sorghum: 56,
  wheat: 60,
  soybeans: 60,
  oats: 32,
};

export const METRIC_YIELD_UNIT = "t/ha";

/**
 * Multiplier from a crop's NASS unit to t/ha, or null if we cannot convert it
 * safely.
 *
 * Null rather than a guess: a bushel crop missing from BUSHEL_LB has no
 * defensible mass conversion, and inventing one would produce a confident
 * number that is simply wrong. The caller keeps US units for that crop instead,
 * which is visibly odd and therefore self-reporting.
 */
export function metricFactor(cropId: string, nassUnit: string): number | null {
  switch (nassUnit) {
    case "LB / ACRE":
      return LB_PER_AC_TO_T_PER_HA;
    case "TONS / ACRE":
      return LB_PER_SHORT_TON * LB_PER_AC_TO_T_PER_HA;
    case "BU / ACRE": {
      const lb = BUSHEL_LB[cropId];
      return lb ? lb * LB_PER_AC_TO_T_PER_HA : null;
    }
    default:
      return null;
  }
}

export interface YieldUnitView {
  /** Multiply a stored value by this. 1 when staying in US units. */
  factor: number;
  /** Column heading, e.g. "t/ha" or "lb/ac". */
  label: string;
  decimals: number;
}

/**
 * How to display this crop's yields under the chosen unit system.
 *
 * Falls back to US units when a metric conversion is not available, so the
 * column is never blank and never wrong.
 */
export function yieldUnitView(
  crop: { id: string; unit: string; unitShort: string; decimals: number },
  units: "imperial" | "metric"
): YieldUnitView {
  if (units !== "metric") {
    return { factor: 1, label: crop.unitShort, decimals: crop.decimals };
  }

  const factor = metricFactor(crop.id, crop.unit);
  if (factor === null) {
    return { factor: 1, label: crop.unitShort, decimals: crop.decimals };
  }

  return {
    factor,
    label: METRIC_YIELD_UNIT,
    // Two places for everything except the tons/acre crops, which land in the
    // tens of t/ha where a second decimal is noise.
    decimals: crop.unit === "TONS / ACRE" ? 1 : 2,
  };
}
