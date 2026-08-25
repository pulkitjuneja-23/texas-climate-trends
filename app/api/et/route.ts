import { NextResponse } from "next/server";
import { fetchMonthlyEt, DEFAULT_BUFFER_M, OPENET_START } from "@/lib/sources/openet";
import { fetchReferenceEt } from "@/lib/sources/gridmet";
import { validateLatLon } from "@/lib/geo";

export const runtime = "nodejs";
/** Past months never change; cache hard. */
export const revalidate = 86400;
export const maxDuration = 60;

/**
 * GET /api/et?lat=&lon=&startYear=&buffer=
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
  const url = new URL(req.url);

  try {
    const { lat, lon } = validateLatLon(url.searchParams.get("lat"), url.searchParams.get("lon"));

    const bufferRaw = Number(url.searchParams.get("buffer"));
    const bufferM =
      Number.isFinite(bufferRaw) && bufferRaw >= 30 && bufferRaw <= 2000
        ? bufferRaw
        : DEFAULT_BUFFER_M;

    const today = new Date().toISOString().slice(0, 10);
    const startYear = Number(url.searchParams.get("startYear") ?? 2000);
    const refStart = `${Number.isFinite(startYear) ? startYear : 2000}-01-01`;

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

    // Independent failure: a missing Earth Engine key must not take reference
    // ET down with it, and a THREDDS outage must not hide OpenET.
    const [refSettled, actualSettled] = await Promise.allSettled([
      wantReference
        ? fetchReferenceEt({ lat, lon, start: refStart, end: today })
        : Promise.resolve(null),
      fetchMonthlyEt({ lat, lon }, { bufferM, start: OPENET_START, end: today }),
    ]);

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

    const actual =
      actualSettled.status === "fulfilled"
        ? actualSettled.value
        : {
            available: false as const,
            reason: "Water-use data could not be loaded.",
            detail: String(actualSettled.reason ?? ""),
          };

    // Setup problems are far easier to diagnose from the terminal than from a
    // browser, and this only fires while Earth Engine is failing.
    if (!actual.available && "detail" in actual && actual.detail) {
      console.warn(`[api/et] OpenET unavailable: ${actual.reason} — ${actual.detail}`);
    }

    return NextResponse.json(
      {
        location: { lat, lon },
        bufferM,
        referenceEt: reference,
        actualEt: actual,
        notes: {
          openEtStart: OPENET_START,
          why: "Reference ET is what a standard crop would need. Actual ET is what this field measurably used.",
        },
      },
      {
        headers: {
          "Cache-Control":
            "public, max-age=0, must-revalidate, s-maxage=86400, stale-while-revalidate=604800",
        },
      }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
