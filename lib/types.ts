/**
 * Core data contract.
 *
 * Everything downstream (climatology, GDD, analog matching, charts) speaks
 * DailyRecord and nothing else. Adding PRISM / gridMET / Daymet / a mesonet
 * means writing one more WeatherSource — no changes anywhere else.
 *
 * Canonical internal units are METRIC: degC, mm, MJ/m2/day, m/s, percent.
 * Conversion to the imperial units a Texas grower expects happens at the very
 * edge, in lib/agro/units.ts, at render time only.
 */

/** One day at one point. `null` means "not observed" — never 0, never -999. */
export interface DailyRecord {
  /** ISO calendar date, YYYY-MM-DD, local to the station/grid cell. */
  date: string;
  /** Max 2 m air temperature, degC. */
  tmax: number | null;
  /** Min 2 m air temperature, degC. */
  tmin: number | null;
  /** Mean 2 m air temperature, degC. */
  tmean: number | null;
  /** Precipitation total, mm/day. */
  precip: number | null;
  /** All-sky downward shortwave irradiance, MJ/m2/day. */
  srad?: number | null;
  /** Relative humidity at 2 m, percent. */
  rh?: number | null;
  /** Wind speed at 2 m, m/s. */
  wind?: number | null;
  /** Dew/frost point at 2 m, degC. */
  dew?: number | null;
  /**
   * Actual evapotranspiration, mm/day, spread from OpenET's monthly values.
   * Null before OpenET's record starts (late 2015) so charts begin the line
   * where the data begins rather than resting it on zero.
   */
  et?: number | null;
  /** precip - et, mm/day. Null wherever ET is null. */
  balance?: number | null;
  /**
   * Grass reference ET, mm/day, from gridMET. The DEMAND side — what a standard
   * well-watered crop would have used. Available 1979-present, so unlike `et`
   * it covers the whole record.
   */
  eto?: number | null;
  /**
   * Which source produced this row. Set when a series is spliced from more
   * than one source so the UI can mark the seam honestly instead of hiding it.
   */
  origin?: string;
}

export type Provenance = "observed" | "gapfill" | "forecast_short" | "forecast_extended";

/** A DailyRecord tagged with how much you should trust it. */
export interface TaggedRecord extends DailyRecord {
  provenance: Provenance;
}

export interface SourceMeta {
  id: string;
  name: string;
  /** Short line shown next to the source picker. */
  blurb: string;
  /** Native grid spacing in km. Drives the honesty note in the UI. */
  resolutionKm: number;
  /** First year with usable data. */
  startYear: number;
  /** Typical lag in days between today and the last observed day. */
  latencyDays: number;
  coverage: "global" | "conus" | "texas";
  attribution: string;
  url: string;
  /** false => shown in the picker but disabled, with `note` explaining why. */
  available: boolean;
  note?: string;
  /**
   * Native grid cell in degrees.
   *
   * Serves two jobs from one definition: it is drawn on the map so the grower
   * can see the real resolution, and requests are snapped to the cell centre
   * before fetching. Two fields in the same cell receive byte-identical data,
   * so snapping loses nothing and lets them share one cached answer — which
   * cuts wait time and Earth Engine quota together.
   *
   * Null for point sources, where there is no cell to snap to.
   */
  cellDeg?: { lat: number; lon: number } | null;
  /**
   * How far a request may be moved when snapping, in degrees. Used for sources
   * without a grid (a station serves a wide area, so nearby requests can safely
   * share one lookup).
   */
  snapDeg?: number;
}

export interface FetchOpts {
  lat: number;
  lon: number;
  /** YYYY-MM-DD inclusive. */
  start: string;
  /** YYYY-MM-DD inclusive. */
  end: string;
  signal?: AbortSignal;
}

export interface WeatherSource {
  meta: SourceMeta;
  fetchDaily(opts: FetchOpts): Promise<DailyRecord[]>;
}

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Place extends LatLon {
  label: string;
  county?: string;
}
