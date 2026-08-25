import type { LatLon } from "@/lib/types";

/**
 * OpenET actual evapotranspiration, read through Google Earth Engine.
 *
 * WHY EARTH ENGINE AND NOT THE OpenET REST API
 * OpenET publishes its ensemble as a native EE ImageCollection under CC-BY-4.0.
 * Going through EE removes the REST API's hard cap (400 queries/month on the
 * Earth-Engine-linked tier) — EE meters compute, not request counts. The REST
 * key stays as a fallback path if this ever has to move to a commercial
 * licence; see SETUP-EARTHENGINE.md.
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

interface EeCredentials {
  client_email: string;
  private_key: string;
  project_id?: string;
}

/** Reads the service-account key without exploding if it isn't there yet. */
async function loadCredentials(): Promise<EeCredentials | null> {
  const inline = process.env.GEE_KEY_JSON;
  if (inline) {
    try {
      return JSON.parse(inline) as EeCredentials;
    } catch {
      return null;
    }
  }

  const path = process.env.GEE_KEY_FILE;
  if (!path) return null;

  try {
    const fs = await import("node:fs/promises");
    const nodePath = await import("node:path");
    const resolved = nodePath.isAbsolute(path)
      ? path
      : nodePath.join(process.cwd(), path);
    const raw = await fs.readFile(resolved, "utf8");
    return JSON.parse(raw) as EeCredentials;
  } catch {
    return null;
  }
}

/**
 * Earth Engine's Node client is a singleton that must be initialised once per
 * process. Serverless functions reuse warm instances, so cache the promise
 * rather than re-authenticating on every request.
 */
let eePromise: Promise<unknown> | null = null;

/** Turns EE's varied error shapes into something readable in a log. */
function describe(err: unknown): string {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  const anyErr = err as { message?: string };
  return anyErr.message ?? JSON.stringify(err).slice(0, 400);
}

async function getEe(): Promise<
  { ee: any; error?: undefined; detail?: undefined } | { ee: null; error: string; detail?: string }
> {
  const creds = await loadCredentials();
  if (!creds) {
    return {
      ee: null,
      error:
        "Earth Engine is not set up yet. Follow SETUP-EARTHENGINE.md to add the key file.",
    };
  }

  // Modern Earth Engine requires a Cloud project. Prefer the explicit env var,
  // fall back to the one baked into the service-account key.
  const project = process.env.GEE_PROJECT_ID || creds.project_id;
  if (!project) {
    return {
      ee: null,
      error: "Earth Engine needs a project id. Add GEE_PROJECT_ID to .env.local.",
    };
  }

  try {
    // Imported lazily so the app runs fine before the package/key exist.
    const mod = await import("@google/earthengine");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ee: any = (mod as any).default ?? mod;

    if (!eePromise) {
      eePromise = new Promise((resolve, reject) => {
        ee.data.authenticateViaPrivateKey(
          creds,
          () => {
            // Signature: (baseurl, tileurl, success, error, xsrfToken, project)
            ee.initialize(
              null,
              null,
              () => resolve(true),
              (err: unknown) => reject(new Error(describe(err))),
              null,
              project
            );
          },
          (err: unknown) => reject(new Error(describe(err)))
        );
      });
    }

    await eePromise;
    return { ee };
  } catch (e) {
    // Reset so a later request can retry once the setup is corrected.
    eePromise = null;
    const detail = describe(e);

    // Map the failures a first-time setup actually hits onto plain guidance.
    let error = "Could not connect to Earth Engine.";

    // Google usually names the exact missing role. Quote it rather than
    // guessing — the first setup attempt failed because the docs said
    // "Earth Engine Resource Viewer" when the missing piece was
    // "Service Usage Consumer".
    const roleMatch = detail.match(/roles\/[\w.]+/);

    if (/not registered|not been used|is disabled|SERVICE_DISABLED/i.test(detail)) {
      error =
        "This Google project isn't registered for Earth Engine yet — redo Step 1 of SETUP-EARTHENGINE.md.";
    } else if (roleMatch) {
      error = `The service account is missing the "${roleMatch[0]}" role. Add it on the IAM page — see Step 2b of SETUP-EARTHENGINE.md.`;
    } else if (/permission|PERMISSION_DENIED|forbidden|403/i.test(detail)) {
      error =
        "The service account lacks permission on this project — see Step 2 of SETUP-EARTHENGINE.md.";
    } else if (/invalid_grant|invalid JWT|Invalid key|PEM/i.test(detail)) {
      error = "The key file looks invalid or corrupted — download a fresh one (Step 3).";
    }

    return { ee: null, error, detail };
  }
}

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
