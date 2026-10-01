import { NextResponse } from "next/server";
import { readCountyOnly } from "@/lib/yield/read";
import { logVisit } from "@/lib/analytics/visits";
import { validateLatLon } from "@/lib/geo";
import { envelopeFrom, beaconOk, beaconAdmitted } from "../_beacon";
import { LIMITS } from "@/lib/api/guard";

/**
 * POST /api/visit — record that someone looked at a location.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN ROUTE AND NOT A LINE INSIDE /api/history
 * ---------------------------------------------------------------------------
 * `/api/history` is CDN-cached for three hours (`s-maxage=10800`), which is
 * most of why the site is fast. A second visitor looking at the same field
 * within that window is served straight from the edge and the route function
 * NEVER RUNS — so a counter placed there would silently miss exactly the
 * repeat interest it was installed to detect, and would undercount the popular
 * locations most of all.
 *
 * This route is therefore explicitly uncacheable. It is also tiny: no upstream
 * weather call, just a point-in-polygon test against a boundary index that is
 * already in memory.
 *
 * The coordinates arrive, are resolved to a county, and are then dropped. They
 * are not written anywhere. See lib/analytics/visits.ts for why.
 */

export const runtime = "nodejs";
/** Never cached, never prerendered — the whole point is that it runs every time. */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!beaconAdmitted(req, "visit", LIMITS.visit)) return beaconOk();
  try {
    const body = (await req.json()) as Record<string, unknown>;

    const { lat, lon } = validateLatLon(String(body.lat ?? ""), String(body.lon ?? ""));
    const county = await readCountyOnly(lat, lon);

    await logVisit({
      ...envelopeFrom(body),
      countyFips: county?.fips ?? null,
      countyName: county?.name ?? null,
      source: typeof body.source === "string" ? body.source : null,
      via: typeof body.via === "string" ? body.via : null,
      referrer: typeof body.referrer === "string" ? body.referrer : null,
    });
  } catch {
    // Includes a bad body, a point outside the valid range, and a database
    // that is down. None of them are the visitor's problem.
  }

  return beaconOk();
}
