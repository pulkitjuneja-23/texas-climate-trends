import { NextResponse } from "next/server";
import { getSource, DEFAULT_SOURCE_ID, listSources } from "@/lib/sources/registry";
import { HISTORY_START_YEAR } from "@/lib/sources/defaults";
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

/**
 * Is the fill station's RAIN GAUGE actually working?
 *
 * A dead tipping bucket does not report nothing — it reports 0.00, every day,
 * forever. Counting reported days cannot see that, which is how Paris, Texas
 * came to report 95% of days and 2.1 inches for January to August 2026 where
 * both gridMET and the NWS state map say about 30. Measured 28 Aug 2026: half
 * of 32 Texas stations checked failed some quality test.
 *
 * The check is possible because the fill window is fetched generously (45+
 * days) while only the last few are used, so there is a long OVERLAP where the
 * station and the gridded source both have data. Over that overlap they should
 * roughly agree; a gauge at a fifth of the grid is not measuring.
 *
 * Deliberately loose. Convective rain is patchy and a point gauge can honestly
 * miss a storm that crossed the rest of a 4 km cell, so this has to catch a
 * dead instrument without rejecting a dry corner of a wet cell. Hence the two
 * guards: enough rain in the window for the ratio to mean anything, and a
 * threshold far below any plausible real disagreement.
 */
/**
 * Thresholds placed from a MEASURED distribution, not picked. Gauge-to-grid
 * ratio over the overlap window at 30 Texas sites, 28 Aug 2026:
 *
 *   0.111  Paris             broken — 2.1 in for the year against gridMET's 30.6
 *   0.186  Temple            broken — 3.3 in against 22.3, and the DEFAULT PIN
 *   ------ threshold 0.20 sits in the gap ------
 *   0.243  Muleshoe          station is Clovis Muni, in New Mexico, ~60 km off
 *   0.434  Wichita Falls     only 15 overlapping days
 *   0.583  Dalhart
 *   0.699 .. 1.380           the other 25 sites, a single healthy cluster
 *
 * So the cut is not near any healthy value: the nearest thing above it is a
 * station in the wrong state, and real gauges start at 0.70. Both rejections
 * are independently confirmed by their whole-year totals, which is the point —
 * the threshold was not tuned until it produced a pleasing answer.
 *
 * Distance is a DIFFERENT fault and is deliberately not handled here. Muleshoe's
 * problem is a gauge 60 km away measuring somewhere else, not a gauge that has
 * stopped measuring, and one threshold should not quietly stand in for two
 * unrelated checks.
 */
const GAUGE_MIN_OVERLAP_DAYS = 10;
const GAUGE_MIN_GRID_MM = 25.4; // 1 inch — below this the ratio is noise
const GAUGE_MIN_RATIO = 0.2;

function gaugeLooksDead(
  grid: DailyRecord[],
  station: DailyRecord[],
  before: string
): { dead: boolean; gridMm: number; stationMm: number; days: number } {
  const byDate = new Map(station.map((r) => [r.date, r]));
  let gridMm = 0;
  let stationMm = 0;
  let days = 0;
  for (const g of grid) {
    if (g.date >= before) continue;
    const s = byDate.get(g.date);
    if (!s || g.precip === null || s.precip === null) continue;
    gridMm += g.precip;
    stationMm += s.precip;
    days++;
  }
  const dead =
    days >= GAUGE_MIN_OVERLAP_DAYS &&
    gridMm >= GAUGE_MIN_GRID_MM &&
    stationMm < GAUGE_MIN_RATIO * gridMm;
  return { dead, gridMm, stationMm, days };
}

export async function GET(req: Request) {
  const url = new URL(req.url);

  try {
    const { lat, lon } = validateLatLon(url.searchParams.get("lat"), url.searchParams.get("lon"));

    const sourceId = url.searchParams.get("source") ?? DEFAULT_SOURCE_ID;
    const source = getSource(sourceId);

    const today = todayISO();
    const currentYear = Number(today.slice(0, 4));
    const startYear = Number(url.searchParams.get("startYear") ?? HISTORY_START_YEAR);
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
     *
     * The 120-day floor is NOT for the fill — the fill only ever uses the few
     * days after the gridded source stops. It exists so the overlap with the
     * gridded record is long enough to judge whether the station's rain gauge
     * is alive (see `gaugeLooksDead`). At the previous 45 days the test was
     * useless in a dry spell: Paris in July-August 2026 had a gauge reading 3%
     * of the grid, which is unmistakably broken, but only 14.7 mm of grid rain
     * to measure it against — too little to distinguish a dead gauge from a
     * storm that missed one field. Four months is enough rain almost anywhere
     * in Texas. A station payload of 120 days is still tiny.
     */
    const fillDays = Math.max(source.meta.latencyDays + 30, 120);
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
    /**
     * The gauge health check, reported whether or not it rejected anything.
     *
     * Always emitted, not only on rejection: a guard whose numbers are only
     * visible when it fires cannot be tuned, and cannot be seen to have gone
     * wrong. This is how the threshold was placed in the gap between healthy
     * and broken stations rather than next to a real value.
     */
    let gaugeCheck: {
      rejected: boolean;
      gridMm: number;
      stationMm: number;
      ratio: number | null;
      days: number;
    } | null = null;

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

      /**
       * Drop the fill's RAINFALL if the gauge looks dead, but keep its
       * temperatures.
       *
       * Surgical on purpose: the failure is one instrument, not the station, and
       * a thermometer is usually fine while a tipping bucket is seized. Nulling
       * only precip loses the least. A null reads through the whole app as "not
       * measured" — accumulation stops there rather than adding a false zero,
       * which is exactly the intended outcome.
       */
      const gauge = gaugeLooksDead(primary, fillSettled.rows, gapStart);
      gaugeCheck = {
        rejected: gauge.dead,
        gridMm: Math.round(gauge.gridMm * 10) / 10,
        stationMm: Math.round(gauge.stationMm * 10) / 10,
        ratio: gauge.gridMm > 0 ? Math.round((gauge.stationMm / gauge.gridMm) * 1000) / 1000 : null,
        days: gauge.days,
      };
      if (gauge.dead) {
        recent = recent.map((r) => ({ ...r, precip: null }));
        console.warn(
          `[api/history] rain gauge at ${stationInfo?.name ?? "?"} looks dead: ` +
            `${gauge.stationMm.toFixed(1)} mm vs ${gauge.gridMm.toFixed(1)} mm from ${source.meta.name} ` +
            `over ${gauge.days} overlapping days — dropping its rainfall, keeping temperature.`
        );
      }
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
          /**
           * Reported rather than swallowed. A rejected gauge means the last few
           * days carry temperature but no rainfall, and a reader comparing two
           * locations deserves to know which one that happened at.
           */
          gaugeCheck,
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
