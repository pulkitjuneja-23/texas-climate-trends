/**
 * Which NASS series counts as "corn", and why the answer is not obvious.
 *
 * USDA NASS does not publish one yield per crop per county per year. It
 * publishes several overlapping SERIES, and merging them double-counts a single
 * harvest while picking the wrong one silently discards decades. Every choice
 * below was measured against the real Texas record (32,819 county-year records,
 * 1996-2025), not inferred from the documentation:
 *
 *   WHEAT      "ALL CLASSES" runs 1996-2007 and "WINTER" runs 1996-2025. All
 *              1,927 of the ALL CLASSES county-years are ALSO present as WINTER.
 *              So WINTER is a strict superset - taking it loses nothing.
 *
 *   CORN       Grain is BU/ACRE, silage is TONS/ACRE, and they share county-
 *              years. They are different measurements of different harvests and
 *              averaging them is meaningless. Grain only; silage has just 14
 *              county-years statewide and is not offered.
 *
 *   COTTON     UPLAND has 2,988 county-years, PIMA 61 - of which 56 duplicate
 *              an UPLAND county-year. Upland is the Texas cotton crop.
 *
 *   SUNFLOWER  Three overlapping variants (all / oil / non-oil) with heavy
 *              mutual overlap and only 250 county-years total. ALL CLASSES is
 *              preferred where present, oil type as the fallback, and the two
 *              are never summed.
 *
 * BARLEY is excluded: 4 county-years in thirty years is not a record.
 *
 * The `select` predicate is the single definition of membership, used by the
 * ingest. If it ever admits two rows for the same county-year, the ingest
 * throws rather than quietly averaging them.
 */

export type PracticeId = "all" | "irr" | "dry";

/**
 * NASS splits practice further - "NON-IRRIGATED, CONTINUOUS CROP" and
 * "NON-IRRIGATED, FOLLOWING SUMMER FALLOW". Every one of those 470 rows
 * duplicates a plain NON-IRRIGATED county-year, so they are dropped rather than
 * folded in. Exact matches only.
 */
export const PRACTICE_FROM_NASS: Record<string, PracticeId> = {
  "ALL PRODUCTION PRACTICES": "all",
  IRRIGATED: "irr",
  "NON-IRRIGATED": "dry",
};

export const PRACTICE_LABELS: Record<PracticeId, string> = {
  all: "All",
  irr: "Irrigated",
  dry: "Dryland",
};

/** What the farmer sees on the toggle, in plain words. */
export const PRACTICE_HELP: Record<PracticeId, string> = {
  all: "Every acre in the county, irrigated and dryland together",
  irr: "Irrigated acres only",
  dry: "Non-irrigated acres only - the ones the weather actually decides",
};

export interface NassRow {
  commodity_desc: string;
  class_desc: string;
  util_practice_desc: string;
  unit_desc: string;
  prodn_practice_desc: string;
  county_code: string;
  county_name: string;
  year: string;
  Value: string;
}

export interface CropDef {
  id: string;
  /** Shown in the dropdown. */
  label: string;
  /** NASS commodity to request. */
  commodity: string;
  /** Decides which rows of that commodity belong to this crop. */
  select: (r: NassRow) => boolean;
  /** NASS's own unit string, e.g. "BU / ACRE". */
  unit: string;
  /** Compact form for a table cell. */
  unitShort: string;
  decimals: number;
  /**
   * Preference order when a county-year has more than one admissible row.
   * Lower wins. Only sunflower needs it; everything else selects exactly one.
   */
  rank?: (r: NassRow) => number;
}

const grain = (r: NassRow) => r.util_practice_desc === "GRAIN";

export const CROPS: CropDef[] = [
  {
    id: "cotton",
    label: "Cotton (upland)",
    commodity: "COTTON",
    select: (r) => r.class_desc === "UPLAND",
    unit: "LB / ACRE",
    unitShort: "lb/ac",
    decimals: 0,
  },
  {
    id: "wheat",
    label: "Wheat (winter)",
    commodity: "WHEAT",
    select: (r) => r.class_desc === "WINTER",
    unit: "BU / ACRE",
    unitShort: "bu/ac",
    decimals: 1,
  },
  {
    id: "sorghum",
    label: "Sorghum (grain)",
    commodity: "SORGHUM",
    select: grain,
    unit: "BU / ACRE",
    unitShort: "bu/ac",
    decimals: 1,
  },
  {
    id: "corn",
    label: "Corn (grain)",
    commodity: "CORN",
    select: (r) => grain(r) && r.unit_desc === "BU / ACRE",
    unit: "BU / ACRE",
    unitShort: "bu/ac",
    decimals: 1,
  },
  {
    id: "oats",
    label: "Oats",
    commodity: "OATS",
    select: (r) => r.class_desc === "ALL CLASSES",
    unit: "BU / ACRE",
    unitShort: "bu/ac",
    decimals: 1,
  },
  {
    id: "soybeans",
    label: "Soybeans",
    commodity: "SOYBEANS",
    select: (r) => r.class_desc === "ALL CLASSES",
    unit: "BU / ACRE",
    unitShort: "bu/ac",
    decimals: 1,
  },
  {
    id: "peanuts",
    label: "Peanuts",
    commodity: "PEANUTS",
    select: (r) => r.class_desc === "ALL CLASSES",
    unit: "LB / ACRE",
    unitShort: "lb/ac",
    decimals: 0,
  },
  {
    id: "rice",
    label: "Rice",
    commodity: "RICE",
    select: (r) => r.class_desc === "ALL CLASSES",
    unit: "LB / ACRE",
    unitShort: "lb/ac",
    decimals: 0,
  },
  {
    id: "sunflower",
    label: "Sunflower",
    commodity: "SUNFLOWER",
    // The three variants overlap heavily, so admit all and let `rank` pick one
    // per county-year rather than summing them.
    select: (r) => ["ALL CLASSES", "OIL TYPE", "NON-OIL TYPE"].includes(r.class_desc),
    rank: (r) =>
      r.class_desc === "ALL CLASSES" ? 0 : r.class_desc === "OIL TYPE" ? 1 : 2,
    unit: "LB / ACRE",
    unitShort: "lb/ac",
    decimals: 0,
  },
  {
    id: "sugarcane",
    label: "Sugarcane",
    commodity: "SUGARCANE",
    select: (r) => r.class_desc === "ALL CLASSES",
    unit: "TONS / ACRE",
    unitShort: "t/ac",
    decimals: 1,
  },
];

export const CROP_BY_ID = new Map(CROPS.map((c) => [c.id, c]));
