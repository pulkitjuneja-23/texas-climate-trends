import { NextResponse } from "next/server";
import { getSource, DEFAULT_SOURCE_ID, listSources } from "@/lib/sources/registry";
import {
  findNearestStation,
  fetchStationDaily,
  type StationInfo,
} from "@/lib/sources/stations";
import { readSeries, writeSeries, fetchSpan, cacheEnabled } from "@/lib/cache/series";
import { validateLatLon, snapToCell, snapToStep } from "@/lib/geo";
import type { DailyRecord, TaggedRecord } from "@/lib/types";

/**
 * The station top-up resolves to this rather than rejecting, so that starting
 * it early — before the cache read — can never produce a floating rejection.
 */
interface StationFill {
  skipped: boolean;
  station: StationInfo | null;
  rows: DailyRecord[];
  error: string | null;
}

export const runtime = "nodejs";
export const revalidate = 10800;
/**
 * Headroom for a cold, uncached lookup.
 *
 * gridMET now comes from Earth Engine in one call (~11 s), but under load that
 * call can queue behind Earth Engine's 40-concurrent-request cap and retry with
 * backoff. Vercel's free tier allows 300 s, so take it: a slow first answer
 * beats a 504, and the result is then cached.
 */
export const maxDuration = 300;

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

    /**
     * Snap to the source's own grid before fetching.
     *
     * Within one cell the data is identical, so this changes no number — but it
     * means every request inside a cell resolves to the same upstream call and
     * therefore the same cached answer. With NASA POWER's ~55 km cells that can
     * be a whole county collapsing to one fetch, which saves both wait time and
     * Earth Engine quota. The snapped point is returned so the UI can say what
     * was actually read rather than implying pin-point precision.
     */
    const snapped = source.meta.cellDeg
      ? snapToCell(lat, lon, source.meta.cellDeg)
      : snapToStep(lat, lon, source.meta.snapDeg);

    /**
     * The two upstream chains run TOGETHER, not one after the other.
     *
     * Finding the nearest airport station needs nothing but the coordinates, so
     * it has no reason to wait for 25 years of gridded data to come back first.
     * Previously it did: fetchDaily (~11 s for gridMET) THEN the station lookup
     * THEN the station's observations — three waits in a row for work that is
     * almost entirely independent.
     *
     * The one real dependency is the date range: the fill should cover exactly
     * the days the gridded source is missing, and that is only known once it
     * answers. Rather than serialise on it, fetch a generous trailing window up
     * front and trim afterwards. Station payloads are small, so over-fetching is
     * far cheaper than a second round trip.
     */
    const wantsTopUp = endYear >= currentYear && sourceId !== "stations";

    /**
     * How far back the fill might need to reach, driven by the source's own
     * declared lag: gridMET runs ~3 days behind, NASA POWER ~5, Daymet ~240.
     * The +30 is slack for a source running later than it advertises.
     */
    const fillDays = Math.max(source.meta.latencyDays + 30, 45);
    const fillStart = shiftDate(today, -fillDays);

    // One station serves a wide area, so round the lookup to ~5 km and let
    // neighbouring fields share a single cached result.
    const stationPoint = snapToStep(lat, lon, 0.05);

    /**
     * Started FIRST and deliberately not awaited yet, so it overlaps the cache
     * read as well as the upstream fetch. It resolves to a result object rather
     * than rejecting, so a floating rejection can never escape.
     */
    const fillPromise: Promise<StationFill> = (async () => {
      if (!wantsTopUp) return { skipped: true, station: null, rows: [], error: null };
      try {
        const st = await findNearestStation(stationPoint.lat, stationPoint.lon, undefined);
        if (!st) return { skipped: false, station: null, rows: [], error: null };
        const rows = await fetchStationDaily(st.id, st.network, fillStart, today);
        return { skipped: false, station: st, rows, error: null };
      } catch (e) {
        return {
          skipped: false,
          station: null,
          rows: [],
          error: e instanceof Error ? e.message : String(e),
        };
      }
    })();

    /**
     * What is already cached for this cell, and what still has to be fetched.
     *
     * Years are the unit because a completed past year never changes upstream.
     * On a revisit, typically only the current year has expired — so the
     * upstream call shrinks from 27 years to one, which is the difference
     * between ~22-82 s and ~2 s.
     *
     * A cache outage returns every year as missing, i.e. exactly the behaviour
     * that existed before this layer. It can slow nothing down: reads carry a
     * 2.5 s deadline and never throw.
     */
    const cached = await readSeries(sourceId, snapped.lat, snapped.lon, startYear, endYear);
    const span = fetchSpan(cached.missing, start, end);

    const primarySettled = await Promise.allSettled([
      span
        ? source.fetchDaily({
            lat: snapped.lat,
            lon: snapped.lon,
            start: span.start,
            end: span.end,
          })
        : Promise.resolve([] as DailyRecord[]),
    ]).then((r) => r[0]);

    const fillSettled = await fillPromise;

    /**
     * A live fetch failing is fatal ONLY if the cache could not cover the
     * request. If every year was already held, an upstream outage is invisible
     * to the visitor — which is most of the point of having a cache.
     */
    if (primarySettled.status === "rejected") {
      if (cached.byYear.size === 0) {
        throw primarySettled.reason instanceof Error
          ? primarySettled.reason
          : new Error(String(primarySettled.reason));
      }
      console.warn(
        `[api/history] ${sourceId} upstream failed; serving ${cached.byYear.size} cached years: ` +
          `${primarySettled.reason instanceof Error ? primarySettled.reason.message : String(primarySettled.reason)}`
      );
    }

    const fresh = primarySettled.status === "fulfilled" ? primarySettled.value : [];

    /**
     * Cached years first, then fresh rows over the top.
     *
     * They can overlap: if the missing years are scattered (say 2005 and 2026)
     * the fetch span covers everything between them, including years already
     * held. Fresh data is the newer read, so it wins.
     */
    const merged = new Map<string, DailyRecord>();
    for (const rows of cached.byYear.values()) {
      for (const r of rows) merged.set(r.date, r);
    }
    for (const r of fresh) merged.set(r.date, r);

    const primary = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));

    // Write back only the whole years this fetch actually covered.
    if (span && fresh.length > 0) {
      const fetchedYears: number[] = [];
      for (let y = Number(span.start.slice(0, 4)); y <= Number(span.end.slice(0, 4)); y++) {
        fetchedYears.push(y);
      }
      await writeSeries(sourceId, snapped.lat, snapped.lon, fresh, {
        contributors: [sourceId],
        currentYear,
        fetchedYears,
      });
    }

    let lastGoodIdx = primary.length - 1;
    while (lastGoodIdx >= 0 && !hasData(primary[lastGoodIdx])) lastGoodIdx--;

    const tagged: TaggedRecord[] = primary
      .slice(0, lastGoodIdx + 1)
      .map((r) => ({ ...r, provenance: "observed" as const }));

    const lastObserved = lastGoodIdx >= 0 ? primary[lastGoodIdx].date : null;

    // The station fill is a bonus, never the request — it fails on its own.
    let recent: TaggedRecord[] = [];
    let recentError: string | null = fillSettled.error;
    const stationInfo: StationInfo | null = fillSettled.station;

    if (fillSettled.error) {
      console.warn(`[api/history] station top-up failed: ${fillSettled.error}`);
    } else if (!fillSettled.skipped) {
      const gapStart = lastObserved ? shiftDate(lastObserved, 1) : shiftDate(today, -30);

      /**
       * If the source lagged further than it declares, the pre-fetched window
       * starts too late to cover the whole gap. Say so rather than quietly
       * serving a short fill — a silent hole here reads on the chart as a dry
       * spell that never happened.
       */
      if (gapStart < fillStart) {
        recentError =
          `${source.meta.name} is further behind than expected (last reading ${lastObserved}); ` +
          `recent days shown only from ${fillStart}.`;
        console.warn(`[api/history] ${recentError}`);
      }

      recent = fillSettled.rows
        .filter((r) => hasData(r) && r.date >= gapStart && r.date <= today)
        .map((r) => ({ ...r, provenance: "gapfill" as const }));
    }

    const records = [...tagged, ...recent];

    return NextResponse.json(
      {
        location: { lat, lon },
        /** Where the data was actually read, after snapping to the grid. */
        readAt: snapped,
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
        /**
         * What the cache actually did. Exposed because a cache that has quietly
         * stopped working is otherwise invisible — the site simply runs at
         * uncached speed and nothing says why.
         */
        cache: {
          enabled: cacheEnabled,
          yearsFromCache: cached.byYear.size,
          yearsFetched: cached.missing.length,
          fetchedSpan: span,
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
