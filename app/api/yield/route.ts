import { NextResponse } from "next/server";
import { validateLatLon, inTexas } from "@/lib/geo";
import { readCountyYields, yieldEnabled } from "@/lib/yield/read";
import { overLimit, clientKey, DEGRADED_CACHE, LIMITS } from "@/lib/api/guard";

/**
 * GET /api/yield?lat=&lon=
 *
 * County crop yields for the analog panel's last column, from USDA NASS.
 *
 * Served entirely from our own copy in R2 — this route never calls NASS. Quick
 * Stats is not always up, and a farmer loading a page should not be exposed to
 * that. The data changes once a quarter at most, so the trade costs nothing.
 *
 * NEVER FATAL. Outside Texas, a county NASS has no figures for, or the store
 * being unreachable all return `available: false` with 200, not an error. This
 * is one extra column on a panel that works without it.
 */

export const runtime = "nodejs";
// The store is a static file and the reader caches it in-process; an hour at
// the CDN keeps a cold lambda from re-fetching 600 KB per visitor.
export const revalidate = 3600;

export async function GET(req: Request) {
  const url = new URL(req.url);

  try {
    const { lat, lon } = validateLatLon(url.searchParams.get("lat"), url.searchParams.get("lon"));

    if (overLimit("yield", clientKey(req), LIMITS.data)) {
      return NextResponse.json(
        { available: false, reason: "Too many requests. Please wait a minute." },
        { status: 429 }
      );
    }

    if (!yieldEnabled) {
      return NextResponse.json(
        { available: false, reason: "No yield store configured." },
        { status: 200 }
      );
    }

    const result = await readCountyYields(lat, lon);

    if (!result) {
      return NextResponse.json(
        {
          available: false,
          reason:
            "No county crop yields for this point. NASS publishes by county for Texas only, " +
            "and not every county reports every crop.",
        },
        {
          status: 200,
          headers: {
            // Outside Texas "no yields" is a fact; inside Texas it may be a
            // failed read of the store, so it is held at the CDN for a minute.
            "Cache-Control": inTexas(lat, lon)
              ? DEGRADED_CACHE
              : "public, s-maxage=3600, stale-while-revalidate=86400",
          },
        }
      );
    }

    return NextResponse.json(
      { available: true, ...result },
      {
        status: 200,
        headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
      }
    );
  } catch (e) {
    // Even a bad coordinate degrades rather than erroring: the panel simply
    // shows no yields.
    return NextResponse.json(
      { available: false, reason: e instanceof Error ? e.message : String(e) },
      { status: 200 }
    );
  }
}
