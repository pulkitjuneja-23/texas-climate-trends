import type { LatLon } from "@/lib/types";
import { getEe } from "./earthengine";

/**
 * OpenET actual evapotranspiration, read through Google Earth Engine.
 *
 * WHY EARTH ENGINE AND NOT THE OpenET REST API
 * OpenET publishes its ensemble as a native EE ImageCollection under CC-BY-4.0.
 * Going through EE removes the REST API's hard cap (400 queries/month on the
 * Earth-Engine-linked tier) — EE meters compute, not request counts. The REST
 * key stays as a fallback path if this ever has to move to a commercial
 * licence; see readme_for_user/SETUP-EARTHENGINE.md.
 *
 * WHAT THE DATA IS
 *   collection : projects/openet/assets/ensemble/conus/gridmet/monthly/v2_1
 *   pixel      : 30 m (0.22 acres)
 *   cadence    : monthly, mm of water
 *   record     : 2015-10 onward — about a decade, NOT the 25 years the weather
 *                sources cover, so any chart must let it start late rather than
 *                pretend the early years are zero.
 *   latency    : roughly 1-2 months. It can never describe the current week.
 *
 * BANDS WORTH HAVING
 *   et_ensemble_mad        the ensemble mean — the headline number
 *   et_ensemble_mad_min/max the spread across six models. This is a real
 *                          uncertainty band shipped with the data, which no
 *                          other layer in this app provides.
 *   et_ensemble_mad_count  how many models survived outlier filtering. A low
 *                          count is a quality warning, not a curiosity.
 *
 * SAMPLING
 * A single 30 m pixel can land on a turnrow, a road or a farmstead and report
 * something real that has nothing to do with the crop. So we average every
 * pixel inside a buffer around the point.
 */

export const OPENET_COLLECTION =
  "projects/openet/assets/ensemble/conus/gridmet/monthly/v2_1";

/** First month present in the collection. */
export const OPENET_START = "2015-10-01";

export const DEFAULT_BUFFER_M = 100;

export interface MonthlyEt {
  /** YYYY-MM */
  month: string;
  /** Ensemble mean ET, mm for the month. */
  et: number | null;
  /** Ensemble spread, mm. */
  etMin: number | null;
  etMax: number | null;
  /** Models surviving outlier filtering (0-6). Low = treat with suspicion. */
  modelCount: number | null;
}

export interface OpenEtResult {
  available: true;
  collection: string;
  bufferM: number;
  /** Approximate sampled area in acres, for the UI to state plainly. */
  areaAcres: number;
  monthly: MonthlyEt[];
}

export interface OpenEtUnavailable {
  available: false;
  /** Plain-language reason, safe to show a farmer. */
  reason: string;
  /** Technical detail for the logs, never rendered. */
  detail?: string;
}

export type OpenEtResponse = OpenEtResult | OpenEtUnavailable;

/**
 * Monthly actual ET for a buffered point.
 *
 * One `evaluate()` returns the whole series — do not loop years. The reducer
 * runs at the collection's native 30 m so the mean reflects real pixels rather
 * than a resampled approximation.
 */
export async function fetchMonthlyEt(
  { lat, lon }: LatLon,
  opts: { bufferM?: number; start?: string; end?: string } = {}
): Promise<OpenEtResponse> {
  const bufferM = opts.bufferM ?? DEFAULT_BUFFER_M;
  const start = opts.start ?? OPENET_START;
  const end = opts.end ?? new Date().toISOString().slice(0, 10);

  const conn = await getEe();
  if (!conn.ee) {
    return {
      available: false,
      reason: conn.error ?? "Earth Engine unavailable.",
      detail: conn.detail,
    };
  }
  const ee = conn.ee;

  try {
    const region = ee.Geometry.Point([lon, lat]).buffer(bufferM);

    const col = ee
      .ImageCollection(OPENET_COLLECTION)
      .filterDate(start, end)
      .filterBounds(region);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const features = col.map((img: any) => {
      const stats = img
        .select([
          "et_ensemble_mad",
          "et_ensemble_mad_min",
          "et_ensemble_mad_max",
          "et_ensemble_mad_count",
        ])
        .reduceRegion({
          reducer: ee.Reducer.mean(),
          geometry: region,
          scale: 30,
          maxPixels: 1e9,
          bestEffort: true,
        });

      return ee.Feature(null, {
        month: ee.Date(img.get("start_date")).format("YYYY-MM"),
        et: stats.get("et_ensemble_mad"),
        etMin: stats.get("et_ensemble_mad_min"),
        etMax: stats.get("et_ensemble_mad_max"),
        modelCount: stats.get("et_ensemble_mad_count"),
      });
    });

    const raw = await new Promise<any>((resolve, reject) => {
      features.evaluate((value: unknown, err: unknown) => {
        if (err) reject(new Error(String(err)));
        else resolve(value);
      });
    });

    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;

    const monthly: MonthlyEt[] = (raw?.features ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((f: any) => ({
        month: String(f?.properties?.month ?? ""),
        et: num(f?.properties?.et),
        etMin: num(f?.properties?.etMin),
        etMax: num(f?.properties?.etMax),
        modelCount: num(f?.properties?.modelCount),
      }))
      .filter((m: MonthlyEt) => /^\d{4}-\d{2}$/.test(m.month))
      .sort((a: MonthlyEt, b: MonthlyEt) => a.month.localeCompare(b.month));

    return {
      available: true,
      collection: OPENET_COLLECTION,
      bufferM,
      areaAcres: (Math.PI * bufferM * bufferM) / 4046.86,
      monthly,
    };
  } catch (e) {
    return {
      available: false,
      reason: "Earth Engine could not return water-use data for this spot.",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
