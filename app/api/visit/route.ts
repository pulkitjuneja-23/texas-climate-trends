import { NextResponse } from "next/server";
import { readCountyOnly } from "@/lib/yield/read";
import { logVisit } from "@/lib/analytics/visits";
import { validateLatLon } from "@/lib/geo";

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
  /**
   * Always 204, whatever happens.
   *
   * The caller is a fire-and-forget beacon from a page that has already
   * rendered. There is no failure here worth telling a browser about, and
   * returning an error status would only produce noise in someone's console
   * about a feature that is none of their concern.
   */
  const ok = () =>
    new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });

  try {
    const body = (await req.json()) as {
      lat?: unknown;
      lon?: unknown;
      source?: unknown;
      self?: unknown;
    };

    const { lat, lon } = validateLatLon(String(body.lat ?? ""), String(body.lon ?? ""));
    const county = await readCountyOnly(lat, lon);

    await logVisit({
      countyFips: county?.fips ?? null,
      countyName: county?.name ?? null,
      // Bounded so a malformed or hostile body cannot write a novel into the
      // table; the real values are short ids like "gridmet".
      source: typeof body.source === "string" ? body.source.slice(0, 32) : null,
      self: body.self === true,
    });
  } catch {
    // Includes a bad body, a point outside the valid range, and a database
    // that is down. None of them are the visitor's problem.
  }

  return ok();
}
