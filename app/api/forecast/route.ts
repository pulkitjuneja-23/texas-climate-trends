import { NextResponse } from "next/server";
import { fetchNWSForecast } from "@/lib/sources/nws";
import { fetchExtendedForecast } from "@/lib/sources/openmeteo";
import { fetchAllOutlooks } from "@/lib/sources/cpc";
import { validateLatLon, snapToStep } from "@/lib/geo";
import { requireTexas, tooMany, rejection, DEGRADED_CACHE } from "@/lib/api/guard";
import { shared, collapsed } from "@/lib/api/shared";

export const runtime = "nodejs";
export const revalidate = 3600;

/**
 * GET /api/forecast?lat=&lon=
 *
 * Three tiers, deliberately kept separate rather than merged into one line:
 *
 *   1-7 days    NWS/NOAA gridpoint forecast. The authoritative one.
 *   8-16 days   Open-Meteo GFS/ECMWF blend. Useful for direction, not detail.
 *   3-4 weeks   CPC probabilistic tercile outlooks, resolved to THIS point by
 *               point-in-polygon on the published contours.
 *
 * A grower needs to know which tier a number came from. Splicing them into one
 * smooth 30-day curve would imply a confidence that does not exist past day 7.
 * Each tier fails independently — one being down never blanks the panel.
 */

export async function GET(req: Request) {
  // Counted per caller first; then identical simultaneous requests share one answer.
  return tooMany(req, "forecast") ?? collapsed(req, handle);
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

  try {
    const raw = validateLatLon(url.searchParams.get("lat"), url.searchParams.get("lon"));
    requireTexas(raw.lat, raw.lon);

    /**
     * Rounded to 0.01° (~1 km) before anything goes upstream. NWS forecasts on a
     * 2.5 km grid and Open-Meteo coarser still, so this changes no number. But
     * every distinct coordinate used to be a separate call to both, so a caller
     * nudging the point by a millionth of a degree could spend the site's free
     * NWS and Open-Meteo allowance one request at a time.
     */
    const { lat, lon } = snapToStep(raw.lat, raw.lon, 0.01);

    // Shared by rounded point, so simultaneous visitors near one spot cost the
    // weather services one call per instance, not one each.
    const at = `${lat},${lon}`;
    const [nws, extended, outlooks] = await Promise.allSettled([
      shared(`nws:${at}`, () => fetchNWSForecast(lat, lon)),
      shared(`om:${at}`, () => fetchExtendedForecast(lat, lon, 16)),
      shared(`cpc:${at}`, () => fetchAllOutlooks(lat, lon)),
    ]);

    return NextResponse.json(
      {
        location: { lat, lon },
        tiers: {
          short: {
            label: "Days 1-7 · NOAA/NWS",
            confidence: "high",
            provider: "National Weather Service (api.weather.gov)",
            data: nws.status === "fulfilled" ? nws.value : null,
            error: nws.status === "rejected" ? String(nws.reason?.message ?? nws.reason) : null,
          },
          extended: {
            label: "Days 8-16 · GFS/ECMWF blend",
            confidence: "moderate",
            provider: "Open-Meteo seamless blend",
            data: extended.status === "fulfilled" ? extended.value : null,
            error:
              extended.status === "rejected"
                ? String(extended.reason?.message ?? extended.reason)
                : null,
          },
          outlook: {
            label: "Weeks 2-4 · NOAA CPC",
            confidence: "probabilistic",
            provider: "NOAA Climate Prediction Center",
            note: "Tercile probabilities — the odds are tilted this way. Not a predicted value.",
            data: outlooks.status === "fulfilled" ? outlooks.value : null,
            error:
              outlooks.status === "rejected"
                ? String(outlooks.reason?.message ?? outlooks.reason)
                : null,
          },
        },
      },
      {
        headers: {
          // A tier that failed is retried within a minute instead of being
          // replayed from the CDN for an hour.
          "Cache-Control": [nws, extended, outlooks].some((t) => t.status === "rejected")
            ? DEGRADED_CACHE
            : "public, s-maxage=3600, stale-while-revalidate=7200",
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
