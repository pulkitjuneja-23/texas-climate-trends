import { NextResponse } from "next/server";
import {
  fetchMonthlyEt,
  DEFAULT_BUFFER_M,
  OPENET_START,
  type OpenEtResponse,
} from "@/lib/sources/openet";
import { fetchReferenceEt, type DailyEto } from "@/lib/sources/gridmet";
import { readMany, writeMany, cacheEnabled, type PutEntry } from "@/lib/cache/store";
import { validateLatLon } from "@/lib/geo";
import { requireTexas, parseYears, tooMany, rejection, DEGRADED_CACHE } from "@/lib/api/guard";
import { shared, collapsed } from "@/lib/api/shared";

/**
 * Both water layers are Earth Engine calls, so both are cached.
 *
 * OpenET is the expensive one: a 30 m reduceRegion over 130 months, and it runs
 * on EVERY page load whether or not anyone opens a water view. That is the main
 * consumer of the Earth Engine compute budget.
 *
 * Cached on coordinates rounded to ~11 m. That is far finer than the 30 m pixel
 * and the 100 m sampling buffer, so it cannot change the answer — but it does
 * collapse repeat visits to one spot, which map clicks would otherwise miss by
 * a fraction of a metre every time.
 *
 * ET is deliberately NOT snapped to a coarse grid the way the weather sources
 * are. A pin in a field and a pin on the road beside it genuinely differ, and
 * flattening that would destroy the reason this layer exists.
 */
const ET_KEY_DP = 4;

/** OpenET publishes monthly, so a day-old answer is never meaningfully stale. */
const ET_TTL = 24 * 3600;

function etKey(kind: string, lat: number, lon: number, extra: string): string {
  return `${kind}:${lat.toFixed(ET_KEY_DP)},${lon.toFixed(ET_KEY_DP)}:${extra}`;
}

export const runtime = "nodejs";
/** Past months never change; cache hard. */
export const revalidate = 86400;
export const maxDuration = 60;

/**
 * GET /api/et?lat=&lon=&startYear=&reference=1
 *
 * Two different answers to "how much water", deliberately kept apart:
 *
 *   referenceEt  gridMET ETo, mm/day, 1979-present, ~3 days behind, 4 km.
 *                The DEMAND side — what a reference crop would have used.
 *                Free, unlimited, always available.
 *
 *   actualEt     OpenET ensemble via Earth Engine, mm/month, 2015-10 onward,
 *                1-2 months behind, 30 m averaged over a buffer.
 *                What the crop MEASURABLY used, with the six-model spread.
 *
 * They are not interchangeable and must never be summed together or plotted as
 * one line. Reference ET describes an idealised crop; actual ET describes this
 * field, including the stress and irrigation that reference ET assumes away.
 *
 * Requested lazily — only when a water variable is opened — because reference
 * ET costs ~27 upstream requests and OpenET costs Earth Engine compute.
 */

export async function GET(req: Request) {
  // Counted per caller first; then identical simultaneous requests share one answer.
  return tooMany(req, "et") ?? collapsed(req, handle);
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

  try {
    const { lat, lon } = validateLatLon(url.searchParams.get("lat"), url.searchParams.get("lon"));
    requireTexas(lat, lon);

    // Fixed, not caller-chosen. The page never sends a buffer, and accepting up
    // to 2 km let any caller ask Earth Engine for ~400x the default's work.
    const bufferM = DEFAULT_BUFFER_M;

    const today = new Date().toISOString().slice(0, 10);
    const { startYear } = parseYears(
      url.searchParams.get("startYear"),
      null,
      0,
      Number(today.slice(0, 4))
    );
    // A whole, clamped year, so the cache key below always names the year the
    // payload actually starts in. "1996.5" once mapped to 1996's key while
    // fetching a series that began in 1997.
    const refStart = `${startYear}-01-01`;

    /**
     * Reference ET is opt-in.
     *
     * It is 26 years of DAILY values — ~355 KB, roughly 22x the size of the
     * OpenET payload — and it costs ~27 upstream requests to assemble. Sending
     * it on every page load to serve one dropdown option nobody had opened was
     * the single heaviest thing on the page. Now the client asks for it only
     * when a reference-ET view is actually selected.
     */
    const wantReference = url.searchParams.get("reference") === "1";

    const actualKey = etKey("et", lat, lon, String(bufferM));
    const refKey = etKey("refet", lat, lon, refStart.slice(0, 4));

    // One round trip for both, so a cache hit costs a single query.
    const hits = await readMany<unknown>(
      wantReference ? [actualKey, refKey] : [actualKey]
    );
    const actualHit = hits.get(actualKey) as { payload: OpenEtResponse } | undefined;
    const refHit = wantReference
      ? (hits.get(refKey) as { payload: DailyEto[] } | undefined)
      : undefined;

    // Independent failure: a missing Earth Engine key must not take reference
    // ET down with it, and one layer failing must not hide the other.
    const [refSettled, actualSettled] = await Promise.allSettled([
      // Shared by key, so a crowd at one field costs Earth Engine one call per
      // instance while the cached answer is cold.
      !wantReference
        ? Promise.resolve(null)
        : refHit
        ? Promise.resolve(refHit.payload)
        : shared(refKey, () => fetchReferenceEt({ lat, lon, start: refStart, end: today })),
      actualHit
        ? Promise.resolve(actualHit.payload)
        : shared(actualKey, () =>
            fetchMonthlyEt({ lat, lon }, { bufferM, start: OPENET_START, end: today })
          ),
    ]);

    /**
     * Store only successes, and only real ones.
     *
     * An `available: false` OpenET result is usually a setup or outage problem,
     * not a fact about the location. Caching it for a day would turn a
     * five-minute Earth Engine hiccup into a day of blank water panels.
     */
    // Two different payload shapes go into the same table, so the entry list is
    // typed at the store's boundary rather than inferred from the first push.
    const toWrite: PutEntry<unknown>[] = [];
    if (
      !actualHit &&
      actualSettled.status === "fulfilled" &&
      actualSettled.value?.available
    ) {
      toWrite.push({
        key: actualKey,
        scope: "et",
        source: "openet",
        payload: actualSettled.value,
        contributors: ["openet"],
        rows: actualSettled.value.monthly.length,
        ttlSeconds: ET_TTL,
      });
    }
    if (!refHit && refSettled.status === "fulfilled" && refSettled.value?.length) {
      toWrite.push({
        key: refKey,
        scope: "refet",
        source: "gridmet",
        payload: refSettled.value,
        contributors: ["gridmet"],
        rows: refSettled.value.length,
        ttlSeconds: ET_TTL,
      });
    }
    if (toWrite.length) await writeMany(toWrite);

    const reference = !wantReference
      ? { available: false as const, reason: "Not requested.", requested: false, daily: [] }
      : refSettled.status === "fulfilled" && refSettled.value
      ? { available: true as const, unit: "mm/day", requested: true, daily: refSettled.value }
      : {
          available: false as const,
          reason: "Reference ET is temporarily unavailable.",
          requested: true,
          daily: [],
        };

    const loaded =
      actualSettled.status === "fulfilled"
        ? actualSettled.value
        : {
            available: false as const,
            reason: "Water-use data could not be loaded.",
            detail: String(actualSettled.reason ?? ""),
          };

    // Setup problems are far easier to diagnose from the terminal than from a
    // browser, and this only fires while Earth Engine is failing.
    if (!loaded.available && "detail" in loaded && loaded.detail) {
      console.warn(`[api/et] OpenET unavailable: ${loaded.reason} — ${loaded.detail}`);
    }

    // `detail` is raw Earth Engine error text (project id, IAM role names,
    // quota messages). lib/sources/openet.ts documents it as logs-only, so it
    // stays in the log line above and never reaches the response.
    const actual =
      !loaded.available && "detail" in loaded
        ? (({ detail: _detail, ...rest }) => rest)(loaded)
        : loaded;

    const degraded = !actual.available || (wantReference && !reference.available);

    return NextResponse.json(
      {
        location: { lat, lon },
        bufferM,
        referenceEt: reference,
        actualEt: actual,
        cache: {
          enabled: cacheEnabled,
          actualEtFromCache: Boolean(actualHit),
          referenceEtFromCache: Boolean(refHit),
        },
        notes: {
          openEtStart: OPENET_START,
          why: "Reference ET is what a standard crop would need. Actual ET is what this field measurably used.",
        },
      },
      {
        headers: {
          // A day at the CDN only for a complete answer. A failed layer is held
          // for a minute, as the Supabase write above already intended.
          "Cache-Control": degraded
            ? DEGRADED_CACHE
            : "public, max-age=0, must-revalidate, s-maxage=86400, stale-while-revalidate=604800",
        },
      }
    );
  } catch (e) {
    const refused = rejection(e);
    if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
