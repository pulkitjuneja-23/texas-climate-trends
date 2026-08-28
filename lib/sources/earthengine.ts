/**
 * Shared Earth Engine connection.
 *
 * Two sources now depend on it — OpenET water use and gridMET weather — so the
 * authentication lives in one place. EE's Node client is a process-wide
 * singleton, and serverless functions reuse warm instances, so the init promise
 * is cached rather than re-authenticating per request.
 */

export interface EeCredentials {
  client_email: string;
  private_key: string;
  project_id?: string;
}

/** Reads the service-account key without exploding when it isn't configured. */
export async function loadCredentials(): Promise<EeCredentials | null> {
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
    const resolved = nodePath.isAbsolute(path) ? path : nodePath.join(process.cwd(), path);
    return JSON.parse(await fs.readFile(resolved, "utf8")) as EeCredentials;
  } catch {
    return null;
  }
}

/** EE reports failures in several shapes; flatten to something loggable. */
export function describeEeError(err: unknown): string {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return (err as { message?: string }).message ?? JSON.stringify(err).slice(0, 400);
}

let eePromise: Promise<unknown> | null = null;

export interface EeConnection {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ee: any;
  error?: undefined;
  detail?: undefined;
}
export interface EeFailure {
  ee: null;
  error: string;
  detail?: string;
}

export async function getEe(): Promise<EeConnection | EeFailure> {
  const creds = await loadCredentials();
  if (!creds) {
    return {
      ee: null,
      error:
        "Earth Engine is not set up yet. Follow readme_for_user/SETUP-EARTHENGINE.md to add the key file.",
    };
  }

  // Modern Earth Engine requires a Cloud project.
  const project = process.env.GEE_PROJECT_ID || creds.project_id;
  if (!project) {
    return { ee: null, error: "Earth Engine needs a project id. Add GEE_PROJECT_ID to .env.local." };
  }

  try {
    const mod = await import("@google/earthengine");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ee: any = (mod as any).default ?? mod;

    if (!eePromise) {
      eePromise = new Promise((resolve, reject) => {
        ee.data.authenticateViaPrivateKey(
          creds,
          () => {
            // (baseurl, tileurl, success, error, xsrfToken, project)
            ee.initialize(
              null,
              null,
              () => resolve(true),
              (err: unknown) => reject(new Error(describeEeError(err))),
              null,
              project
            );
          },
          (err: unknown) => reject(new Error(describeEeError(err)))
        );
      });
    }

    await eePromise;
    return { ee };
  } catch (e) {
    eePromise = null; // allow a retry once the setup is corrected
    const detail = describeEeError(e);

    // Google usually names the missing role. Quote it rather than guessing.
    const roleMatch = detail.match(/roles\/[\w.]+/);
    let error = "Could not connect to Earth Engine.";
    if (/not registered|not been used|is disabled|SERVICE_DISABLED/i.test(detail)) {
      error =
        "This Google project isn't registered for Earth Engine yet — redo Step 1 of readme_for_user/SETUP-EARTHENGINE.md.";
    } else if (roleMatch) {
      error = `The service account is missing the "${roleMatch[0]}" role. Add it on the IAM page — see Step 2b of readme_for_user/SETUP-EARTHENGINE.md.`;
    } else if (/permission|PERMISSION_DENIED|forbidden|403/i.test(detail)) {
      error =
        "The service account lacks permission on this project — see Step 2 of readme_for_user/SETUP-EARTHENGINE.md.";
    } else if (/invalid_grant|invalid JWT|Invalid key|PEM/i.test(detail)) {
      error = "The key file looks invalid or corrupted — download a fresh one (Step 3).";
    }
    return { ee: null, error, detail };
  }
}

/**
 * Point time series from a daily ImageCollection.
 *
 * `getRegion` is EE's purpose-built extractor for exactly this: it returns one
 * row per image as [id, lon, lat, millis, ...bands]. One call replaces the 81
 * separate HTTP requests the same series costs from a THREDDS server, because
 * the work happens beside the data instead of the data crossing the wire.
 */
export async function getRegionSeries(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ee: any,
  collectionId: string,
  bands: string[],
  lat: number,
  lon: number,
  start: string,
  end: string,
  scaleM: number
): Promise<Array<{ date: string; values: Record<string, number | null>; millis: number }>> {
  /**
   * Retry transient failures.
   *
   * Earth Engine caps a project at 40 concurrent requests and answers 429 past
   * it; single requests also fail occasionally for no lasting reason — one was
   * observed failing once and then succeeding three times running. Without a
   * retry each of those reaches a farmer as a broken panel, so back off briefly
   * and try again rather than surfacing a blip.
   */
  const attempt = (): Promise<unknown[][]> =>
    new Promise((resolve, reject) =>
      ee
        .ImageCollection(collectionId)
        .filterDate(start, end)
        .select(bands)
        .getRegion(ee.Geometry.Point([lon, lat]), scaleM)
        .evaluate((v: unknown[][], err: unknown) =>
          err ? reject(new Error(describeEeError(err))) : resolve(v ?? [])
        )
    );

  let rows: unknown[][] = [];
  let lastError: unknown = null;
  for (let tryNo = 0; tryNo < 3; tryNo++) {
    const started = Date.now();
    try {
      rows = await attempt();
      lastError = null;
      /**
       * Log every attempt, not just failures.
       *
       * These retries were previously invisible, and that hid a real problem:
       * a route measured at 72 s wrapped an Earth Engine call measured at 30 s,
       * and the missing 42 s was a silent failed attempt plus its backoff.
       * Without this line the only symptom is "the site is slow sometimes".
       */
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (tryNo > 0) {
        console.warn(`[ee] ${collectionId} succeeded on attempt ${tryNo + 1} after ${secs}s`);
      } else if (Date.now() - started > 20_000) {
        console.warn(`[ee] ${collectionId} slow: ${secs}s for ${start}..${end}`);
      }
      break;
    } catch (e) {
      lastError = e;
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.warn(
        `[ee] ${collectionId} attempt ${tryNo + 1}/3 failed after ${secs}s: ${describeEeError(e)}`
      );
      // 1s then 3s. Long enough for a concurrency slot to free, short enough
      // that the visitor is not left waiting on a lost cause.
      if (tryNo < 2) await new Promise((r) => setTimeout(r, tryNo === 0 ? 1000 : 3000));
    }
  }
  if (lastError) throw lastError instanceof Error ? lastError : new Error(String(lastError));

  if (!rows.length) return [];

  // First row is the header: id, longitude, latitude, time, then band names.
  const header = rows[0] as string[];
  const bandIdx = bands.map((b) => header.indexOf(b));

  return rows
    .slice(1)
    .map((r) => {
      const millis = Number(r[3]);
      const values: Record<string, number | null> = {};
      bands.forEach((b, i) => {
        const v = r[bandIdx[i]];
        values[b] = typeof v === "number" && Number.isFinite(v) ? v : null;
      });
      return { date: new Date(millis).toISOString().slice(0, 10), values, millis };
    })
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date))
    .sort((a, b) => a.millis - b.millis);
}
