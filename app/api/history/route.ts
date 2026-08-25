import { NextResponse } from "next/server";
import { getSource, DEFAULT_SOURCE_ID, listSources } from "@/lib/sources/registry";
import { findNearestStation, fetchStationDaily } from "@/lib/sources/stations";
import { validateLatLon } from "@/lib/geo";
import type { DailyRecord, TaggedRecord } from "@/lib/types";

export const runtime = "nodejs";
export const revalidate = 10800;
/** gridMET fetches a year per request, so allow headroom on first load. */
export const maxDuration = 60;

/**
 * GET /api/history?lat=&lon=&startYear=&endYear=&source=
 *
 * Returns the full daily series, with the most recent days topped up from the
 * nearest airport weather station.
 *
 * Every gridded source runs behind: NASA POWER ~5 days, gridMET ~3, Daymet ~8
 * MONTHS. That leaves a hole exactly where the grower is looking. Rather than
 * papering over it with another model, the tail is filled from a real
 * instrument at a known distance — and tagged, so the chart can mark where the
 * record changes hands.
 *
 * (Weather Underground was the original request for this. Its API now returns
 * 401 for everyone without a key, and keys are issued only to people who
 * operate a registered personal weather station, so it cannot be used here.)
 */

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function hasData(r: DailyRecord): boolean {
  return r.tmax !== null || r.tmin !== null || r.precip !== null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);

  try {
    const { lat, lon } = validateLatLon(url.searchParams.get("lat"), url.searchParams.get("lon"));

    const sourceId = url.searchParams.get("source") ?? DEFAULT_SOURCE_ID;
    const source = getSource(sourceId);

    const today = todayISO();
    const currentYear = Number(today.slice(0, 4));
    const startYear = Number(url.searchParams.get("startYear") ?? 2000);
    const endYear = Number(url.searchParams.get("endYear") ?? currentYear);

    if (!Number.isFinite(startYear) || !Number.isFinite(endYear) || startYear > endYear) {
      return NextResponse.json({ error: "Invalid startYear/endYear" }, { status: 400 });
    }
    if (startYear < source.meta.startYear) {
      return NextResponse.json(
        { error: `${source.meta.name} starts in ${source.meta.startYear}` },
        { status: 400 }
      );
    }

    const start = `${startYear}-01-01`;
    const end = endYear >= currentYear ? today : `${endYear}-12-31`;

    const primary = await source.fetchDaily({ lat, lon, start, end });

    let lastGoodIdx = primary.length - 1;
    while (lastGoodIdx >= 0 && !hasData(primary[lastGoodIdx])) lastGoodIdx--;

    const tagged: TaggedRecord[] = primary
      .slice(0, lastGoodIdx + 1)
      .map((r) => ({ ...r, provenance: "observed" as const }));

    const lastObserved = lastGoodIdx >= 0 ? primary[lastGoodIdx].date : null;

    // Top up the tail from the nearest real station.
    let recent: TaggedRecord[] = [];
    let recentError: string | null = null;
    let stationInfo: Awaited<ReturnType<typeof findNearestStation>> = null;

    const needsTopUp = endYear >= currentYear && (!lastObserved || lastObserved < today);
    if (needsTopUp && sourceId !== "stations") {
      const gapStart = lastObserved ? shiftDate(lastObserved, 1) : shiftDate(today, -30);
      const gapEnd = today;
      if (gapStart <= gapEnd) {
        try {
          stationInfo = await findNearestStation(lat, lon, undefined);
          if (stationInfo) {
            const fill = await fetchStationDaily(
              stationInfo.id,
              stationInfo.network,
              gapStart,
              gapEnd
            );
            recent = fill
              .filter((r) => hasData(r) && r.date >= gapStart && r.date <= gapEnd)
              .map((r) => ({ ...r, provenance: "gapfill" as const }));
          }
        } catch (e) {
          recentError = e instanceof Error ? e.message : String(e);
        }
      }
    }

    const records = [...tagged, ...recent];

    return NextResponse.json(
      {
        location: { lat, lon },
        source: source.meta,
        availableSources: listSources(),
        range: { start, end, startYear, endYear },
        lastObserved,
        recent: {
          count: recent.length,
          from: recent[0]?.date ?? null,
          to: recent[recent.length - 1]?.date ?? null,
          station: stationInfo
            ? {
                id: stationInfo.id,
                name: stationInfo.name,
                distanceKm: Math.round(stationInfo.distanceKm),
                county: stationInfo.county,
              }
            : null,
          error: recentError,
        },
        count: records.length,
        records,
      },
      {
        headers: {
          // max-age=0 makes the BROWSER revalidate every time, so flipping
          // between sources always reflects a real answer, while s-maxage keeps
          // the expensive upstream work cached at the CDN.
          "Cache-Control":
            "public, max-age=0, must-revalidate, s-maxage=10800, stale-while-revalidate=86400",
        },
      }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
