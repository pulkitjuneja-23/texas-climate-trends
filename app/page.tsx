"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DailyRecord, Place, SourceMeta, TaggedRecord } from "@/lib/types";
// From `defaults`, never `registry`: registry pulls in every source module,
// and the Earth Engine ones use Node APIs that cannot be bundled for a browser.
import { DEFAULT_SOURCE_ID } from "@/lib/sources/defaults";
import { DEFAULT_PLACE } from "@/lib/geo";
import { GDD_PRESETS } from "@/lib/agro/gdd";
import {
  alignByYear,
  accumulate,
  accumClimatology,
  KEY_INDEX,
  DOY_KEYS,
  hasLongGap,
  startsWithin,
  type Field,
} from "@/lib/agro/climatology";
import { convert, unitLabel, type UnitSystem } from "@/lib/agro/units";
import { monthlyEtToDaily, attachWaterFields, balanceWording } from "@/lib/agro/water";
import type { MonthlyEt } from "@/lib/sources/openet";
import LocationPicker from "@/components/LocationPicker";
import SourceSelect from "@/components/SourceSelect";
import ClimateChart, { type ViewMode } from "@/components/ClimateChart";
import AnnualTrendChart from "@/components/AnnualTrendChart";
import AnalogPanel from "@/components/AnalogPanel";
import ForecastStrip, { type ForecastPayload } from "@/components/ForecastStrip";

const START_YEAR = 2000;

interface StationRef {
  id: string;
  name: string;
  distanceKm: number;
  county: string | null;
}

interface HistoryPayload {
  location: { lat: number; lon: number };
  source: SourceMeta;
  availableSources: SourceMeta[];
  lastObserved: string | null;
  recent: {
    count: number;
    from: string | null;
    to: string | null;
    station: StationRef | null;
    error: string | null;
  };
  records: TaggedRecord[];
}

type Theme = "system" | "light" | "dark";

interface EtPayload {
  bufferM: number;
  referenceEt: { available: boolean; daily: Array<{ date: string; eto: number | null }> };
  actualEt:
    | { available: true; monthly: MonthlyEt[]; bufferM: number; areaAcres: number }
    | { available: false; reason: string };
}

// The grid cell comes from the source's own metadata now — one definition,
// used both to draw the map rectangle and to snap requests server-side.

/**
 * Optional URL overrides — ?lat=&lon=&source=&place= — so a location can be
 * linked or shared rather than re-found by hand.
 *
 * Applied in an effect AFTER mount, never in a useState initialiser. Reading
 * window.location during render makes the server render one set of values and
 * the client another, which is a hydration mismatch: React discards the server
 * markup and logs an error.
 */
function readUrlDefaults(): {
  place: Place | null;
  source: string | null;
  variable: Field | null;
  trend: Field | null;
} {
  if (typeof window === "undefined")
    return { place: null, source: null, variable: null, trend: null };
  const q = new URLSearchParams(window.location.search);
  const latRaw = q.get("lat");
  const lonRaw = q.get("lon");
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  const source = q.get("source");
  const allowed: Field[] = [
    "tmax", "tmin", "tmean", "precip", "gdd", "dtr", "et", "balance", "eto",
  ];
  const pick = (raw: string | null): Field | null =>
    raw && (allowed as string[]).includes(raw) ? (raw as Field) : null;
  const variable = pick(q.get("variable"));
  const trend = pick(q.get("trend"));
  const place =
    latRaw && lonRaw && Number.isFinite(lat) && Number.isFinite(lon)
      ? { lat, lon, label: q.get("place") ?? `${lat.toFixed(3)}°, ${lon.toFixed(3)}°` }
      : null;
  return { place, source, variable, trend };
}

export default function Page() {
  const [place, setPlace] = useState<Place>({ ...DEFAULT_PLACE });
  const [sourceId, setSourceId] = useState(DEFAULT_SOURCE_ID);
  /** Blocks the data fetch until any URL overrides have been applied, so a
   *  shared link does not fire a throwaway request for the default location. */
  const [urlReady, setUrlReady] = useState(false);
  const [units, setUnits] = useState<UnitSystem>("imperial");
  const [theme, setTheme] = useState<Theme>("system");
  const [gddPreset, setGddPreset] = useState<keyof typeof GDD_PRESETS>("corn");

  const [field, setField] = useState<Field>("precip");
  const [mode, setMode] = useState<ViewMode>("accumulated");
  /** Lifted out of AnnualTrendChart so reference ET can be lazily loaded for it. */
  const [trendField, setTrendField] = useState<Field>("precip");
  const [compareYears, setCompareYears] = useState<number[]>([]);

  const currentYear = new Date().getFullYear();
  // "Since" dates for the season-to-date tiles. Default 1 Jan, but a grower
  // usually cares about accumulation since planting, not since New Year.
  const [rainSince, setRainSince] = useState(`${currentYear}-01-01`);
  const [gddSince, setGddSince] = useState(`${currentYear}-01-01`);
  /** ET and deficit share one date — they are two halves of the same sum. */
  const [etSince, setEtSince] = useState(`${currentYear}-01-01`);

  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [sourceList, setSourceList] = useState<SourceMeta[]>([]);
  const [histLoading, setHistLoading] = useState(true);
  const [histError, setHistError] = useState<string | null>(null);

  const [forecast, setForecast] = useState<ForecastPayload | null>(null);
  const [fcLoading, setFcLoading] = useState(true);

  const [water, setWater] = useState<EtPayload | null>(null);
  const [waterLoading, setWaterLoading] = useState(true);

  const gddConfig = GDD_PRESETS[gddPreset].config;

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }, [theme]);

  // Apply ?lat/?lon/?source once, after hydration.
  useEffect(() => {
    const { place: p, source: s, variable: v, trend: t } = readUrlDefaults();
    if (p) setPlace(p);
    if (s) setSourceId(s);
    if (t) setTrendField(t);
    if (v) {
      setField(v);
      // Temperatures read as day-by-day; totals read as season-to-date.
      setMode(v === "tmax" || v === "tmin" || v === "tmean" ? "daily" : "accumulated");
    }
    setUrlReady(true);
  }, []);

  /**
   * Guards against showing the wrong source's numbers.
   *
   * Two separate failure modes, both of which were happening:
   *
   *  1. STALE DISPLAY. Switching source left the previous source's chart on
   *     screen for the whole load. gridMET takes ~5 s cold but under a second
   *     warm, so it looked like the page "sometimes" ignored the switch. The
   *     old payload is now dropped the instant the source changes, so the page
   *     shows a skeleton rather than numbers from a dataset you just left.
   *
   *  2. OUT-OF-ORDER RESPONSES. Switching A -> B -> A could let a slow earlier
   *     response land after a faster later one and win. Every request carries a
   *     sequence number and only the newest is allowed to write state.
   */
  const reqSeq = useRef(0);
  const prevSource = useRef(sourceId);

  useEffect(() => {
    if (!urlReady) return;

    if (prevSource.current !== sourceId) {
      setHistory(null);
      prevSource.current = sourceId;
    }

    const seq = ++reqSeq.current;
    const ctrl = new AbortController();
    setHistLoading(true);
    setHistError(null);

    fetch(
      `/api/history?lat=${place.lat}&lon=${place.lon}&startYear=${START_YEAR}&source=${sourceId}`,
      { signal: ctrl.signal }
    )
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? `Request failed (${r.status})`);
        return json as HistoryPayload;
      })
      .then((json) => {
        if (reqSeq.current !== seq) return;
        setHistory(json);
        // Kept outside `history` so the topbar picker still has its options
        // while a switch is in flight and `history` is intentionally null.
        if (json.availableSources?.length) setSourceList(json.availableSources);
      })
      .catch((e) => {
        if (e.name !== "AbortError" && reqSeq.current === seq) {
          setHistError(e.message ?? String(e));
        }
      })
      .finally(() => {
        if (reqSeq.current === seq) setHistLoading(false);
      });

    return () => ctrl.abort();
  }, [place.lat, place.lon, sourceId, urlReady]);

  useEffect(() => {
    if (!urlReady) return;
    const ctrl = new AbortController();
    setFcLoading(true);

    fetch(`/api/forecast?lat=${place.lat}&lon=${place.lon}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((json) => setForecast(json as ForecastPayload))
      .catch(() => setForecast(null))
      .finally(() => setFcLoading(false));

    return () => ctrl.abort();
  }, [place.lat, place.lon, urlReady]);

  /**
   * Reference ET is ~355 KB of daily values and ~27 upstream requests, so it is
   * fetched only once a view that actually shows it is selected — either chart.
   * Once loaded for a location it stays loaded; switching away does not discard
   * it, so toggling back is instant.
   */
  const needsReference = field === "eto" || trendField === "eto";
  const [refLoaded, setRefLoaded] = useState(false);

  // A new location invalidates whatever reference data we were holding.
  useEffect(() => {
    setRefLoaded(false);
  }, [place.lat, place.lon]);

  // ---- water (OpenET actual ET, plus reference ET on demand) ----
  useEffect(() => {
    if (!urlReady) return;
    if (needsReference && refLoaded) return; // already have everything

    const ctrl = new AbortController();
    setWaterLoading(true);

    const url =
      `/api/et?lat=${place.lat}&lon=${place.lon}&startYear=${START_YEAR}` +
      (needsReference ? "&reference=1" : "");

    fetch(url, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((json) => {
        const payload = json as EtPayload;
        setWater((prev) =>
          // Keep reference data already in hand if this response didn't ask for it.
          !payload.referenceEt?.available && prev?.referenceEt?.available
            ? { ...payload, referenceEt: prev.referenceEt }
            : payload
        );
        if (payload.referenceEt?.available) setRefLoaded(true);
      })
      .catch(() => setWater(null))
      .finally(() => setWaterLoading(false));

    return () => ctrl.abort();
  }, [place.lat, place.lon, urlReady, needsReference, refLoaded]);

  /** Monthly OpenET spread across days so it lines up with the daily series. */
  const dailyEt = useMemo(() => {
    if (!water?.actualEt?.available) return new Map<string, number>();
    return monthlyEtToDaily(water.actualEt.monthly);
  }, [water]);

  /**
   * Months in the current year OpenET could not produce. These are the reason a
   * cumulative water curve stops early, so the chart names them rather than
   * leaving a silent blank.
   */
  const missingEtMonths = useMemo(() => {
    if (!water?.actualEt?.available) return [];
    const yr = String(currentYear);
    return water.actualEt.monthly
      .filter((m) => m.month.startsWith(yr) && (m.et === null || !Number.isFinite(m.et)))
      .map((m) => m.month);
  }, [water, currentYear]);

  /** gridMET reference ET, already daily. */
  const dailyEto = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of water?.referenceEt?.daily ?? []) {
      if (d.eto !== null && Number.isFinite(d.eto)) m.set(d.date, d.eto);
    }
    return m;
  }, [water]);

  const rawRecords: DailyRecord[] = history?.records ?? [];

  /**
   * ET and balance are merged onto the daily records so the existing
   * climatology, accumulation and charting code can treat them as ordinary
   * variables. Days before OpenET's record stay null, never zero.
   */
  const records: DailyRecord[] = useMemo(
    () =>
      dailyEt.size || dailyEto.size
        ? attachWaterFields(rawRecords, dailyEt, dailyEto)
        : rawRecords,
    [rawRecords, dailyEt, dailyEto]
  );

  const availableYears = useMemo(() => {
    const ys = new Set<number>();
    for (const r of records) ys.add(Number(r.date.slice(0, 4)));
    return [...ys].filter(Number.isFinite).sort((a, b) => a - b);
  }, [records]);

  /**
   * Accumulated total from a chosen start date to the last observed day, with
   * the same window averaged across all prior years for comparison.
   */
  const makeStat = useCallback(
    (f: Field, sinceISO: string) => {
      if (!records.length || !history?.lastObserved) return null;
      const endIdx = KEY_INDEX.get(history.lastObserved.slice(5, 10));
      const startIdx = KEY_INDEX.get(sinceISO.slice(5, 10));
      if (endIdx === undefined || startIdx === undefined) return null;
      if (startIdx > endIdx) return null;

      const series = alignByYear(records, f, gddConfig);
      const baseline = series.filter((s) => s.year < currentYear);
      const cur = series.find((s) => s.year === currentYear);
      if (!cur || !baseline.length) return null;

      /**
       * Same gap rule as the chart. OpenET drops whole months, and running the
       * total straight through a two-month hole would report, say, 14.8 in of
       * ET "through Jul 31" when April and May are simply absent — roughly 9 in
       * short, making the deficit look far more comfortable than it is. Stop at
       * the gap and let the tile say how far it actually got.
       */
      const isMonthlySource = f === "et" || f === "balance";
      const maxGap = isMonthlySource ? 5 : Infinity;

      const accum = accumulate(cur, startIdx, maxGap).values;

      /**
       * `lastObserved` is the last day with ANY reading, but an individual
       * variable can be missing on that day — an airport station reports
       * today's temperature long before the day's rainfall total is closed out.
       * Indexing straight at `lastObserved` then lands on a null and the tile
       * silently shows a dash. Walk back to the last day this variable actually
       * has, and read the normal at that same calendar day so the two stay
       * comparable.
       */
      let idx = endIdx;
      while (idx > startIdx && (accum[idx] === null || !Number.isFinite(accum[idx] as number))) {
        idx--;
      }
      const value = accum[idx];
      if (value === null || !Number.isFinite(value)) return null;

      /**
       * COVERAGE GUARD — the reason a season total can be badly wrong.
       *
       * An accumulation sums only the days that reported. Airport stations drop
       * days routinely: measured 2026 at Muleshoe 173/237 days, Pecos 23/237.
       * Summing those gives 1.81 in and 4.5 in, which then get compared against
       * a COMPLETE 25-year normal and render as "-13.2 vs normal" — a fake
       * catastrophic drought, stated with total confidence.
       *
       * The total itself is honest (it is what the station measured); the
       * COMPARISON is what lies. So count the days actually present and let the
       * tile drop the vs-normal line and say what is missing instead.
       */
      let present = 0;
      let span = 0;
      for (let i = startIdx; i <= idx; i++) {
        span++;
        const v = cur.values[i];
        if (v !== null && Number.isFinite(v)) present++;
      }
      // 02-29 is legitimately absent in non-leap years, so allow a little slack.
      const coverage = span > 0 ? present / span : 0;

      // Compare against years that actually have a complete record, or the
      // "normal" is an average of half-finished seasons.
      const normBase = isMonthlySource
        ? baseline.filter(
            (s) =>
              s.values.some((v) => v !== null) &&
              !hasLongGap(s, maxGap) &&
              startsWithin(s, startIdx, maxGap)
          )
        : baseline;
      if (!normBase.length) return null;

      const norm = accumClimatology(normBase, startIdx, maxGap)[idx];
      if (!norm || norm.mean === null) return null;

      return {
        value,
        normal: norm.mean,
        throughIdx: idx,
        stale: idx < endIdx,
        coverage,
        daysPresent: present,
        daysExpected: span,
        /**
         * Threshold set at 90%, not higher, on purpose.
         *
         * Too strict and ordinary small gaps (a handful of days out of a
         * hundred) get reported like a fault, which trains the reader to ignore
         * the warning — and then it fails when it matters. Too loose and the
         * genuinely broken cases slip through. 90% catches the real ones
         * measured in Texas: Pecos at 10% coverage, Muleshoe at 89%.
         *
         * Note this is harsher on rainfall than on temperature by nature:
         * rain arrives on a few days, so missing days can hide most of the
         * total, while a missing temperature day barely moves an average.
         */
        sparse: coverage < 0.9,
      };
    },
    [records, history?.lastObserved, gddConfig, currentYear]
  );

  const rainStat = useMemo(() => makeStat("precip", rainSince), [makeStat, rainSince]);
  const gddStat = useMemo(() => makeStat("gdd", gddSince), [makeStat, gddSince]);
  /**
   * "Estimated" is the honest word: OpenET publishes one figure per month, and
   * these tiles divide it across the month's days to line up with an arbitrary
   * start date. Accurate to the month, interpolated within it.
   */
  const etStat = useMemo(() => makeStat("et", etSince), [makeStat, etSince]);
  const balanceStat = useMemo(() => makeStat("balance", etSince), [makeStat, etSince]);

  /**
   * Last seven days at a glance. Costs nothing — it reads the tail of the
   * series already in memory — and fills the column beside the map with
   * something a grower actually checks, rather than white space.
   */
  const lastWeek = useMemo(() => {
    const withData = records.filter((r) => r.tmax !== null || r.precip !== null);
    if (withData.length < 2) return null;
    const tail = withData.slice(-7);

    let rain = 0;
    let hottest = -Infinity;
    let hotDays = 0;
    let wetDays = 0;
    for (const r of tail) {
      if (r.precip !== null) {
        rain += r.precip;
        if (r.precip >= 0.254) wetDays++; // 0.01 in
      }
      if (r.tmax !== null) {
        hottest = Math.max(hottest, r.tmax);
        if (r.tmax >= 35) hotDays++;
      }
    }
    return {
      days: tail.length,
      rain,
      hottest: Number.isFinite(hottest) ? hottest : null,
      hotDays,
      wetDays,
      from: tail[0].date,
      to: tail[tail.length - 1].date,
    };
  }, [records]);

  const handlePlace = useCallback((p: Place) => setPlace(p), []);

  /**
   * ET can end earlier than rainfall — it stops at a satellite data gap while
   * rain runs to yesterday. Showing "21.9 in rain" beside "14.8 in ET" and a
   * "-4.4 in deficit" is nonsense unless the reader knows the last two cover a
   * SHORTER period. So any tile whose data ends early says so.
   */
  const monthDay = useCallback((key: string | undefined) => {
    if (!key) return null;
    const [mm, dd] = key.split("-");
    const name = new Date(Date.UTC(2000, Number(mm) - 1, 1)).toLocaleDateString("en-US", {
      month: "short",
      timeZone: "UTC",
    });
    return `${name} ${Number(dd)}`;
  }, []);

  const throughLabel = useCallback(
    (idx: number | undefined) => monthDay(idx === undefined ? undefined : DOY_KEYS[idx]),
    [monthDay]
  );

  /** The range a truncated water tile actually covers, honouring the chosen start date. */
  const etRangeLabel = useCallback(
    (idx: number | undefined) => `${monthDay(etSince.slice(5))} – ${throughLabel(idx)} only`,
    [monthDay, throughLabel, etSince]
  );

  const precipDp = units === "imperial" ? 1 : 0;

  return (
    <>
      <div className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <h1>Texas Climate Trends</h1>
            <small>25 years of weather history for your field</small>
          </div>

          {/* Source lives in the sticky bar so it can be changed from anywhere
              on the page without scrolling back to the top. */}
          {sourceList.length > 0 && (
            <SourceSelect
              sources={sourceList}
              activeId={sourceId}
              onChange={setSourceId}
              loading={histLoading}
              station={history?.recent.station ?? null}
            />
          )}

          <div className="seg">
            <button aria-pressed={units === "imperial"} onClick={() => setUnits("imperial")}>
              °F / in
            </button>
            <button aria-pressed={units === "metric"} onClick={() => setUnits("metric")}>
              °C / mm
            </button>
          </div>

          {/* Hidden on phones — a set-once preference does not deserve a
              permanent row of a small screen. It reappears below, in the page
              itself, where it scrolls away like ordinary content. */}
          <div className="seg topbar-theme">
            {(["system", "light", "dark"] as Theme[]).map((t) => (
              <button key={t} aria-pressed={theme === t} onClick={() => setTheme(t)}>
                {t === "system" ? "Auto" : t === "light" ? "Light" : "Dark"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="shell">
        {/* Phone-only twin of the theme control. Same state, so the two can
            never disagree. */}
        <div className="mobile-theme">
          <span className="mt-label">Appearance</span>
          <div className="seg">
            {(["system", "light", "dark"] as Theme[]).map((t) => (
              <button key={t} aria-pressed={theme === t} onClick={() => setTheme(t)}>
                {t === "system" ? "Auto" : t === "light" ? "Light" : "Dark"}
              </button>
            ))}
          </div>
        </div>

        <div className="grid-2">
          <div className="card">
            <div className="card-head">
              <h2>Your location</h2>
            </div>
            <LocationPicker
              place={place}
              onChange={handlePlace}
              cellSize={sourceList.find((s) => s.id === sourceId)?.cellDeg ?? null}
            />
            <div className="small" style={{ marginTop: 10, color: "var(--text-secondary)" }}>
              <strong>{place.label}</strong> · {place.lat.toFixed(4)}°, {place.lon.toFixed(4)}°
            </div>
          </div>

          <div>
            <div className="card">
              <div className="card-head">
                <h2>Season so far</h2>
                {history?.lastObserved && (
                  <span className="badge">through {history.lastObserved}</span>
                )}
                {history?.source && <span className="badge">{history.source.name}</span>}
              </div>
              {histLoading ? (
                <div className="skeleton" style={{ height: 150 }} />
              ) : (
                <div className="tiles compact">
                  <div className="tile">
                    <div className="k">Rain since</div>
                    <div className="v">
                      {rainStat
                        ? convert(rainStat.value, "precip", units).toFixed(precipDp)
                        : "—"}
                      <span className="muted" style={{ fontSize: "0.72rem", fontWeight: 500 }}>
                        {" "}
                        {unitLabel("precip", units)}
                      </span>
                    </div>
                    {/* A vs-normal comparison is only shown when the record is
                        complete enough to support it. See the coverage guard. */}
                    {rainStat &&
                      (rainStat.sparse ? (
                        <div className="d" style={{ color: "var(--div-warm)", fontWeight: 600 }}>
                          incomplete — only {rainStat.daysPresent} of{" "}
                          {rainStat.daysExpected} days reported
                        </div>
                      ) : (
                        <div
                          className="d"
                          style={{
                            color:
                              rainStat.value < rainStat.normal
                                ? "var(--div-warm)"
                                : "var(--div-cool)",
                            fontWeight: 600,
                          }}
                        >
                          {rainStat.value >= rainStat.normal ? "+" : ""}
                          {convert(rainStat.value - rainStat.normal, "precip", units).toFixed(
                            precipDp
                          )}{" "}
                          vs normal
                        </div>
                      ))}
                    <div className="since-row">
                      <input
                        type="date"
                        aria-label="Rain accumulated since"
                        value={rainSince}
                        min={`${currentYear}-01-01`}
                        max={history?.lastObserved ?? `${currentYear}-12-31`}
                        onChange={(e) => setRainSince(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="tile">
                    <div className="k">GDD since</div>
                    <div className="v">
                      {gddStat
                        ? Math.round(convert(gddStat.value, "gdd", units)).toLocaleString()
                        : "—"}
                    </div>
                    {gddStat &&
                      (gddStat.sparse ? (
                        <div className="d" style={{ color: "var(--div-warm)", fontWeight: 600 }}>
                          incomplete — only {gddStat.daysPresent} of {gddStat.daysExpected} days
                          reported
                        </div>
                      ) : (
                        <div
                          className="d"
                          style={{
                            color:
                              gddStat.value >= gddStat.normal
                                ? "var(--div-warm)"
                                : "var(--div-cool)",
                            fontWeight: 600,
                          }}
                        >
                          {gddStat.value >= gddStat.normal ? "+" : ""}
                          {Math.round(
                            convert(gddStat.value - gddStat.normal, "gdd", units)
                          ).toLocaleString()}{" "}
                          vs normal
                        </div>
                      ))}
                    <div className="since-row">
                      <input
                        type="date"
                        aria-label="GDD accumulated since"
                        value={gddSince}
                        min={`${currentYear}-01-01`}
                        max={history?.lastObserved ?? `${currentYear}-12-31`}
                        onChange={(e) => setGddSince(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="tile">
                    <div className="k">Estimated ET since</div>
                    <div className="v">
                      {etStat
                        ? convert(etStat.value, "precip", units).toFixed(precipDp)
                        : waterLoading
                        ? "…"
                        : "n/a"}
                      {etStat && (
                        <span className="muted" style={{ fontSize: "0.72rem", fontWeight: 500 }}>
                          {" "}
                          {unitLabel("precip", units)}
                        </span>
                      )}
                    </div>
                    {/*
                      When ET ends earlier than rain, the period is the single
                      most important thing on the tile — without it a reader
                      compares two different spans and sees a surplus that is
                      not there. Stated as a plain date range; the reason lives
                      in the tooltip so the tile stays short.
                    */}
                    <div
                      className="d"
                      style={{ color: etStat?.stale ? "var(--div-warm)" : undefined }}
                      title={
                        etStat?.stale
                          ? "The satellite could not measure some months (too cloudy), so the total stops there."
                          : undefined
                      }
                    >
                      {etStat
                        ? etStat.stale
                          ? etRangeLabel(etStat.throughIdx)
                          : "water used by the crop"
                        : "needs satellite data"}
                    </div>
                    <div className="since-row">
                      <input
                        type="date"
                        aria-label="Estimated ET accumulated since"
                        value={etSince}
                        min={`${currentYear}-01-01`}
                        max={history?.lastObserved ?? `${currentYear}-12-31`}
                        onChange={(e) => setEtSince(e.target.value)}
                      />
                    </div>
                  </div>

                  {/*
                    Named "Water balance", not "Deficit". A heading of "Deficit"
                    above a signed value reads both ways at once. The magnitude
                    is shown unsigned with the word doing the work instead.
                  */}
                  <div className="tile">
                    <div className="k">Water balance since</div>
                    <div
                      className="v"
                      style={{
                        color: balanceStat
                          ? balanceWording(balanceStat.value).colorVar
                          : undefined,
                      }}
                    >
                      {balanceStat
                        ? Math.abs(convert(balanceStat.value, "precip", units)).toFixed(precipDp)
                        : waterLoading
                        ? "…"
                        : "n/a"}
                      {balanceStat && (
                        <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                          {" "}
                          {unitLabel("precip", units)}{" "}
                          {balanceWording(balanceStat.value).short.toLowerCase()}
                        </span>
                      )}
                    </div>
                    <div className="d muted">
                      {balanceStat
                        ? balanceStat.sparse
                          ? `incomplete — only ${balanceStat.daysPresent} of ${balanceStat.daysExpected} days reported`
                          : balanceWording(balanceStat.value).long
                        : "rain minus ET"}
                    </div>
                    {/*
                      "vs <source> rain" was dropped: the card header already
                      carries the source badge, so it was clutter competing with
                      the one thing that actually changes how you read the number.
                    */}
                    {balanceStat?.stale && (
                      <div
                        className="small"
                        style={{ marginTop: 3, fontSize: "0.68rem", color: "var(--div-warm)" }}
                        title="The satellite could not measure some months (too cloudy), so the comparison stops there."
                      >
                        {etRangeLabel(balanceStat.throughIdx)}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Crop base and station provenance as compact rows rather than
                  tiles of their own — they are settings/context, not figures. */}
              {!histLoading && (
                <div className="foot-rows">
                  <div className="foot-row">
                    <span className="fr-k">GDD base</span>
                    <select
                      value={gddPreset}
                      onChange={(e) => setGddPreset(e.target.value as keyof typeof GDD_PRESETS)}
                      className="fr-select"
                    >
                      {Object.entries(GDD_PRESETS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {history?.recent.station && (
                    <div className="foot-row">
                      <span className="fr-k">Latest days from</span>
                      <span className="fr-v">
                        {history.recent.station.id} · {history.recent.station.name} ·{" "}
                        {history.recent.station.distanceKm} km away
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {!histLoading && lastWeek && (
              <div className="card">
                <div className="card-head">
                  <h2>Last {lastWeek.days} days</h2>
                  <span className="badge">
                    {lastWeek.from} to {lastWeek.to}
                  </span>
                </div>
                <div className="tiles compact" style={{ marginTop: 10 }}>
                  <div className="tile">
                    <div className="k">Rain</div>
                    <div className="v">
                      {convert(lastWeek.rain, "precip", units).toFixed(precipDp)}
                      <span className="muted" style={{ fontSize: "0.7rem", fontWeight: 500 }}>
                        {" "}
                        {unitLabel("precip", units)}
                      </span>
                    </div>
                    <div className="d">
                      {lastWeek.wetDays} day{lastWeek.wetDays === 1 ? "" : "s"} with rain
                    </div>
                  </div>
                  <div className="tile">
                    <div className="k">Hottest</div>
                    <div className="v">
                      {lastWeek.hottest !== null
                        ? Math.round(convert(lastWeek.hottest, "temp", units))
                        : "—"}
                      {"°"}
                    </div>
                    <div className="d">
                      {lastWeek.hotDays} day{lastWeek.hotDays === 1 ? "" : "s"} over{" "}
                      {units === "imperial" ? "95°F" : "35°C"}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {histError && (
          <div className="note error">
            <span>⚠</span>
            <span>
              Could not load history: {histError}
              <br />
              <button style={{ marginTop: 8 }} onClick={() => setPlace({ ...place })}>
                Retry
              </button>
            </span>
          </div>
        )}

        {histLoading && !history ? (
          <div className="card">
            <div className="skeleton" style={{ height: 420 }} />
          </div>
        ) : records.length > 0 ? (
          <>
            <ClimateChart
              records={records}
              field={field}
              onFieldChange={setField}
              mode={mode}
              onModeChange={setMode}
              compareYears={compareYears}
              onCompareChange={setCompareYears}
              currentYear={currentYear}
              availableYears={availableYears}
              units={units}
              gddConfig={gddConfig}
              smoothing={7}
              lastObserved={history?.lastObserved ?? null}
              waterStatus={{
                loading: waterLoading,
                available: dailyEt.size > 0,
                reason:
                  water?.actualEt && !water.actualEt.available
                    ? water.actualEt.reason
                    : "Earth Engine is not connected yet — see readme_for_user/SETUP-EARTHENGINE.md.",
                missingMonths: missingEtMonths,
              }}
            />

            <AnalogPanel
              records={records}
              units={units}
              gddConfig={gddConfig}
              lastObserved={history?.lastObserved ?? null}
              dailyEt={dailyEt}
              waterLoading={waterLoading}
              onCompareYears={(ys) => {
                setCompareYears(ys.slice(0, 4));
                document.querySelector(".card")?.scrollIntoView({ behavior: "smooth" });
              }}
            />

            <ForecastStrip forecast={forecast} loading={fcLoading} units={units} />

            <AnnualTrendChart
              records={records}
              units={units}
              gddConfig={gddConfig}
              currentYear={currentYear}
              field={trendField}
              onFieldChange={setTrendField}
              waterLoading={waterLoading}
            />
          </>
        ) : null}

        <footer className="site">
          <p>
            <strong>Data sources.</strong>{" "}
            {history?.source.attribution ?? "NASA POWER"} · Most recent days from the nearest
            airport station via the{" "}
            <a href="https://mesonet.agron.iastate.edu/">Iowa Environmental Mesonet</a>. Forecast
            days 1–7 from the{" "}
            <a href="https://www.weather.gov/documentation/services-web-api">NOAA/NWS API</a>; days
            8–16 from <a href="https://open-meteo.com/">Open-Meteo</a>; weeks 2–4 outlooks from the{" "}
            <a href="https://www.cpc.ncep.noaa.gov/">NOAA Climate Prediction Center</a>. Geocoding by{" "}
            <a href="https://nominatim.openstreetmap.org/">Nominatim</a>, map tiles ©{" "}
            <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors.
          </p>
          <p>
            <strong>What this is not.</strong> Normals are computed from {START_YEAR}–
            {currentYear - 1} at a single grid point, not the official NOAA 1991–2020 station
            normals, so they will not match a NWS climate report exactly. Similar years rank past
            seasons against this one; they are not a forecast, and a similar start has often been
            followed by a very different finish. Nothing here is validated against your own rain
            gauge and it should not be the only input to an irrigation or planting decision.
          </p>
        </footer>
      </div>
    </>
  );
}
