import { NextResponse } from "next/server";
import { fetchNWSForecast } from "@/lib/sources/nws";
import { fetchExtendedForecast } from "@/lib/sources/openmeteo";
import { fetchAllOutlooks } from "@/lib/sources/cpc";
import { validateLatLon } from "@/lib/geo";

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
  const url = new URL(req.url);

  try {
    const { lat, lon } = validateLatLon(url.searchParams.get("lat"), url.searchParams.get("lon"));

    const [nws, extended, outlooks] = await Promise.allSettled([
      fetchNWSForecast(lat, lon),
      fetchExtendedForecast(lat, lon, 16),
      fetchAllOutlooks(lat, lon),
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
        headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200" },
      }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
