"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DailyRecord, Place, SourceMeta, TaggedRecord } from "@/lib/types";
// From `defaults`, never `registry`: registry pulls in every source module,
// and the Earth Engine ones use Node APIs that cannot be bundled for a browser.
import { DEFAULT_SOURCE_ID, HISTORY_START_YEAR } from "@/lib/sources/defaults";
import { DEFAULT_PLACE, inTexas } from "@/lib/geo";
import { GDD_PRESETS, plantingStart, CUSTOM_GDD_DEFAULT } from "@/lib/agro/gdd";
import {
  alignByYear,
  accumulate,
  accumClimatology,
  hasLongGap,
  startsWithin,
  fieldValue,
  type Field,
} from "@/lib/agro/climatology";
import { convert, unitLabel, fToC, type UnitSystem } from "@/lib/agro/units";
import { monthlyEtToDaily, attachWaterFields } from "@/lib/agro/water";
import { formatRange } from "@/lib/format/date";
import { sendVisit, trackOnce } from "@/lib/analytics/client";
import type { PickMethod } from "@/lib/analytics/visitor";
import type { MonthlyEt } from "@/lib/sources/openet";
// The TYPE only — `lib/yield/read` touches process.env and must stay server-side.
import type { CountyYields } from "@/lib/yield/types";
import LocationPicker from "@/components/LocationPicker";
import GddBaseInput from "@/components/GddBaseInput";
import SourceSelect from "@/components/SourceSelect";
import ClimateChart, { type ViewMode } from "@/components/ClimateChart";
import AnnualTrendChart from "@/components/AnnualTrendChart";
import AnalogPanel from "@/components/AnalogPanel";
import ForecastStrip, { type ForecastPayload } from "@/components/ForecastStrip";
import PanelRail, { PANELS, type PanelId } from "@/components/PanelRail";

const START_YEAR = HISTORY_START_YEAR;

interface StationRef {
  id: string;
  name: string;
  distanceKm: number;
  county: string | null;
}

interface HistoryPayload {
  location: { lat: number; lon: number };
  /**
   * The grid cell centre actually read, after snapping to the source's own
   * grid. The route has always sent this; it is declared here because the
   * exports need it — a file labelled with the clicked point would imply a
   * precision that a 55 km NASA POWER cell does not have.
   */
  readAt?: { lat: number; lon: number };
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
  panel: PanelId | null;
} {
  if (typeof window === "undefined")
    return { place: null, source: null, variable: null, trend: null, panel: null };
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
  // Which view was open, so a shared link lands on what the sender was looking
  // at rather than the default.
  const rawPanel = q.get("panel");
  const panel = PANELS.some((p) => p.id === rawPanel) ? (rawPanel as PanelId) : null;
  const place =
    latRaw && lonRaw && Number.isFinite(lat) && Number.isFinite(lon)
      ? { lat, lon, label: q.get("place") ?? `${lat.toFixed(3)}°, ${lon.toFixed(3)}°` }
      : null;
  return { place, source, variable, trend, panel };
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
  /**
   * Which slice of the calendar the season chart draws, as MM-DD.
   *
   * Lifted here rather than kept inside the chart for the same reason `field`
   * and `mode` are: the chart element is built once and mounted under whichever
   * panel is open, so state living inside it would reset every time the reader
   * moved between the season and similar-years panels.
   */
  const [chartFrom, setChartFrom] = useState("01-01");
  const [chartTo, setChartTo] = useState("12-31");
  /**
   * Which deep view is open. Season tracker first: it answers the question the
   * tool exists for, and it is the one a returning grower opens most.
   */
  const [panel, setPanel] = useState<PanelId>("season");

  /**
   * The stage, so opening a cover can take the reader to what it opened.
   *
   * On a phone the rail is two rows and the stage starts below the fold, so a
   * tap changed the page somewhere the reader could not see and the covers
   * looked inert. On a desktop the rail is one row but the season chart still
   * starts near the bottom of the window.
   */
  const stageRef = useRef<HTMLDivElement | null>(null);
  /** Set only by a tap on the rail, so first load and ?panel= never jump. */
  const wantScroll = useRef(false);

  /**
   * How the current pin was chosen, for the visit log.
   *
   * A ref rather than state: it is context attached to the next beacon, and
   * making it state would re-render the whole dashboard to record a fact
   * nothing on screen depends on. It is set before `setPlace` every time, so it
   * is always current when the beacon effect reads it.
   */
  const pickedVia = useRef<PickMethod>("default");

  /**
   * This tool is Texas-only, so a pin dropped outside the state says so rather
   * than quietly serving numbers.
   *
   * gridMET and NASA POWER both cover far more than Texas, so a click in New
   * Mexico used to return a complete, plausible, fully-drawn analysis — while
   * the county yields, the archive and the station network all silently had
   * nothing for it. Half a tool that looks like a whole one is the worse
   * failure, so the state line is now the edge of what this claims to know.
   */
  const outsideTexas = !inTexas(place.lat, place.lon);

  const currentYear = new Date().getFullYear();

  /**
   * ONE DATE RANGE FOR THE WHOLE "SEASON SO FAR" CARD.
   *
   * Rain, growing degree days, estimated ET and the water balance used to
   * carry three separate date pickers, so answering "how has this crop done
   * since I planted" meant setting the same date three times — and the
   * balance tile could end up summing a rainfall window that did not match its
   * own ET window, which makes the subtraction quietly meaningless.
   *
   * They are four views of one season, so they take one window. The start
   * still follows the crop's planting date until the grower sets their own,
   * for the reason below; the end now exists at all, so a finished season can
   * be read back rather than only the year to date.
   *
   * WHY THE START FOLLOWS THE CROP. Heat units counted from New Year are
   * meaningless — at Beeville that read 5,706 degF-days for corn by late
   * August, roughly two crops' worth. Once the grower picks a date it stays
   * put: their planting date is a fact about their field, not something a crop
   * change should overwrite. Rain and ET since planting are the right
   * comparison too, which is why sharing the date improves them rather than
   * compromising them.
   */
  const [seasonFrom, setSeasonFrom] = useState(() => plantingStart("corn", currentYear, null));
  const [seasonFromTouched, setSeasonFromTouched] = useState(false);
  /**
   * Null means "up to the newest day there is", which is what almost everyone
   * wants and what this card did before an end date existed. It is resolved
   * against `lastObserved` at read time rather than stored, so it keeps up as
   * new days arrive instead of freezing on whatever was current at first load.
   */
  const [seasonTo, setSeasonTo] = useState<string | null>(null);

  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [sourceList, setSourceList] = useState<SourceMeta[]>([]);
  const [histLoading, setHistLoading] = useState(true);
  const [histError, setHistError] = useState<string | null>(null);

  const [forecast, setForecast] = useState<ForecastPayload | null>(null);
  const [fcLoading, setFcLoading] = useState(true);

  const [water, setWater] = useState<EtPayload | null>(null);
  const [waterLoading, setWaterLoading] = useState(true);

  /**
   * The grower's own base temperature, held in degC like everything internal.
   *
   * Stored in Celsius and converted only at the input, the same rule the rest
   * of the app follows — a base kept in whatever unit happened to be on screen
   * would silently change meaning the moment somebody flipped the toggle.
   */
  const [customBase, setCustomBase] = useState(CUSTOM_GDD_DEFAULT.base);
  const [customCap, setCustomCap] = useState<number | null>(null);

  /**
   * The line a day's high must reach to count as a hot day, in degC.
   *
   * WHY 95 degF AND NOT THE RESEARCH THRESHOLDS. Schlenker & Roberts (2009,
   * PNAS 106:15594) put yield damage beginning at 29 degC for corn (84 degF),
   * 30 for soybeans (86) and 32 for cotton (90). Those are right biologically
   * and nearly useless as a Texas count: measured over May-September 1996-2025
   * from this site's own gridMET data, 84 degF is crossed on 80-97% of days
   * every year — in the Valley on 144-151 of 153 days whether the summer was
   * mild or brutal — so a "vs normal" tile would read the same every season.
   * At 95 degF the years genuinely differ: 27 to 88 days at the default
   * location, a threefold spread between a 1-in-10 cool and hot summer.
   *
   * So 95 degF is where Texas summers are DISTINGUISHABLE, which is what a
   * comparison tile needs — not where damage starts. The user chose it as the
   * default on 30 September 2026, adjustable, so a cotton grower can set 90.
   */
  const [hotThresholdC, setHotThresholdC] = useState(35);

  const gddConfig = useMemo(() => {
    if (gddPreset !== "custom") return GDD_PRESETS[gddPreset].config;
    // A cap is what separates the two methods, so offering the cap and a
    // method toggle separately would let the reader pick a contradiction.
    return customCap === null
      ? { base: customBase, cutoff: 100, method: "simple" as const }
      : { base: customBase, cutoff: customCap, method: "modified" as const };
  }, [gddPreset, customBase, customCap]);

  /** A base temperature as the reader has chosen to see temperatures. */
  const showTemp = useCallback(
    (degC: number) =>
      `${Math.round(convert(degC, "temp", units))}${unitLabel("temp", units)}`,
    [units]
  );

  /** What to call the current setting wherever GDD is shown. */
  const gddShort =
    gddPreset === "custom" ? `base ${showTemp(customBase)}` : GDD_PRESETS[gddPreset].short;

  /**
   * Built once here and handed to both places the crop selector appears.
   *
   * The alternative was five more props on each of two components for a
   * control that only one setting ever uses.
   */
  const gddCustomControls =
    gddPreset === "custom" ? (
      <GddBaseInput
        units={units}
        baseC={customBase}
        capC={customCap}
        onBaseChange={setCustomBase}
        onCapChange={setCustomCap}
      />
    ) : null;

  /**
   * Follow the crop's planting date until the grower overrides it.
   *
   * Also re-runs once `lastObserved` arrives, because a planting date in the
   * future accumulates nothing — wheat's October date is ahead of most of the
   * year and falls back to 1 January.
   */
  useEffect(() => {
    if (seasonFromTouched) return;
    const next = plantingStart(gddPreset, currentYear, history?.lastObserved ?? null);
    setSeasonFrom((prev) => (prev === next ? prev : next));
  }, [gddPreset, currentYear, history?.lastObserved, seasonFromTouched]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }, [theme]);

  // Apply ?lat/?lon/?source once, after hydration.
  useEffect(() => {
    const { place: p, source: s, variable: v, trend: t, panel: pn } = readUrlDefaults();
    // Records how this first location arrived: a shared link that carried
    // coordinates, or nobody having chosen yet. Both are worth telling apart
    // from a deliberate map click.
    pickedVia.current = p ? "link" : "default";
    if (p) setPlace(p);
    if (s) setSourceId(s);
    if (t) setTrendField(t);
    if (pn) setPanel(pn);
    if (v) {
      setField(v);
      // Temperatures read as day-by-day; totals read as season-to-date.
      setMode(v === "tmax" || v === "tmin" || v === "tmean" ? "daily" : "accumulated");
    }
    setUrlReady(true);
  }, []);

  /**
   * Keep ?panel in the address bar so a shared link opens on the view the
   * sender was looking at. `replaceState`, not push: flipping between views is
   * not navigation, and stacking history entries would make Back feel broken.
   */
  useEffect(() => {
    if (!urlReady) return;
    const url = new URL(window.location.href);
    if (panel === "season") url.searchParams.delete("panel");
    else url.searchParams.set("panel", panel);
    window.history.replaceState(null, "", url);
  }, [panel, urlReady]);

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
    if (!urlReady || outsideTexas) return;

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
  }, [place.lat, place.lon, sourceId, urlReady, outsideTexas]);

  useEffect(() => {
    if (!urlReady || outsideTexas) return;
    const ctrl = new AbortController();
    setFcLoading(true);

    fetch(`/api/forecast?lat=${place.lat}&lon=${place.lon}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((json) => setForecast(json as ForecastPayload))
      .catch(() => setForecast(null))
      .finally(() => setFcLoading(false));

    return () => ctrl.abort();
  }, [place.lat, place.lon, urlReady, outsideTexas]);

  /**
   * Reference ET is ~355 KB of daily values and ~27 upstream requests, so it is
   * fetched only once a view that actually shows it is selected — either chart.
   * Once loaded for a location it stays loaded; switching away does not discard
   * it, so toggling back is instant.
   */
  const needsReference = field === "eto" || trendField === "eto";
  const [refLoaded, setRefLoaded] = useState(false);

  const [yields, setYields] = useState<CountyYields | null>(null);
  const [yieldsLoading, setYieldsLoading] = useState(false);

  // A new location invalidates whatever reference data we were holding.
  useEffect(() => {
    setRefLoaded(false);
  }, [place.lat, place.lon]);

  // ---- water (OpenET actual ET, plus reference ET on demand) ----
  useEffect(() => {
    if (!urlReady || outsideTexas) return;
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
  }, [place.lat, place.lon, urlReady, needsReference, refLoaded, outsideTexas]);

  /**
   * ---- visit log ----
   *
   * One beacon per LOCATION, not per page view: it hangs off the coordinates
   * alone, so changing source, variable or panel at the same spot does not fire
   * it again. What we want to know is which fields people look at, and a reader
   * who flips through four datasets at one farm looked at one farm.
   *
   * Deliberately NOT awaited and deliberately not tied to the data load — it
   * must never delay or affect anything on screen. `keepalive` lets it survive
   * the reader immediately navigating away, which is otherwise the most common
   * way a first visit goes unrecorded.
   *
   * The server turns the coordinates into a county and throws them away; see
   * lib/analytics/visits.ts.
   */
  useEffect(() => {
    if (!urlReady) return;
    sendVisit({
      lat: place.lat,
      lon: place.lon,
      source: sourceId,
      via: pickedVia.current,
    });
    // sourceId and pickedVia are read but intentionally NOT dependencies: they
    // are recorded as context for the visit, not as a reason to record another.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place.lat, place.lon, urlReady]);

  /**
   * ---- feature log ----
   *
   * What people actually came for, which the visit log cannot say. Each of
   * these is recorded at most once per sitting (see lib/analytics/client.ts),
   * so the figure means "in what fraction of visits did anyone open this"
   * rather than rewarding whoever clicked most.
   *
   * Gated on `urlReady` for the same reason every fetch is: a shared link
   * applies its state after mount, and firing before that would record the
   * defaults rather than what the reader was actually sent to.
   */
  useEffect(() => {
    if (!urlReady) return;
    trackOnce("panel", panel);
  }, [panel, urlReady]);

  useEffect(() => {
    if (!urlReady) return;
    trackOnce("variable", field);
  }, [field, urlReady]);

  useEffect(() => {
    if (!urlReady) return;
    trackOnce("trend", trendField);
  }, [trendField, urlReady]);

  useEffect(() => {
    if (!urlReady) return;
    trackOnce("source", sourceId);
  }, [sourceId, urlReady]);

  useEffect(() => {
    if (!urlReady) return;
    trackOnce("units", units);
  }, [units, urlReady]);

  useEffect(() => {
    if (!urlReady || field !== "gdd") return;
    // Only meaningful while growing degree days are on screen; recorded
    // otherwise it would count the default crop for everyone who never looked.
    trackOnce("crop", gddPreset);
  }, [gddPreset, field, urlReady]);

  /**
   * ---- county crop yields (NASS) ----
   *
   * Served entirely from our own quarterly copy, so this never waits on USDA.
   * It is one extra column on a panel that works without it, so every failure
   * just clears it rather than surfacing an error.
   */
  useEffect(() => {
    if (!urlReady || outsideTexas) return;

    const ctrl = new AbortController();
    setYieldsLoading(true);

    fetch(`/api/yield?lat=${place.lat}&lon=${place.lon}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((json) => setYields(json?.available ? (json as CountyYields) : null))
      .catch(() => setYields(null))
      .finally(() => setYieldsLoading(false));

    return () => ctrl.abort();
  }, [place.lat, place.lon, urlReady, outsideTexas]);

  /**
   * What a downloaded CSV or figure says about where its numbers came from.
   *
   * `readAt` is the grid cell actually read after snapping, not the clicked
   * point — a gridMET export is a 4 km cell and a NASA POWER one is 55 km, and
   * a file carrying only the pin would imply a precision that was never there.
   */
  const exportContext = useMemo(
    () => ({
      placeName: place.label ?? null,
      lat: place.lat,
      lon: place.lon,
      readAt: history?.readAt ?? null,
      sourceName: history?.source.name ?? null,
      sourceId: history?.source.id ?? sourceId,
    }),
    [place, history, sourceId]
  );

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
   * Accumulated total over an ARBITRARY date window, with the same window in
   * each earlier year for comparison.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS WORKS ON REAL DATES AND NOT ON DAY-OF-YEAR
   * ---------------------------------------------------------------------------
   * It used to index a 366-slot array keyed on MM-DD, one array per calendar
   * year, which is why the date boxes were locked to the current year. That
   * made two ordinary things impossible.
   *
   * A grower could not look at a season that has finished. And no window could
   * cross 31 December — which is not an edge case, it is WINTER WHEAT: planted
   * in October, harvested the following summer. Wheat silently fell back to
   * 1 January and quietly reported something nobody asked for.
   *
   * So the window is now two absolute dates and the sum walks the calendar
   * between them. The comparison window for an earlier year is the same window
   * shifted back whole years, which keeps it aligned on MM-DD — the project's
   * standing rule — and keeps working across a year boundary, because both ends
   * move together.
   */
  const makeStat = useCallback(
    (
      f: Field,
      fromISO: string,
      untilISO: string | null,
      /**
       * Optional per-day mapping applied before summing. With
       * `v => v >= threshold ? 1 : 0` the "total" becomes a COUNT of days over a
       * line — which lets the hot-days tile reuse the window, the year-by-year
       * comparison and the coverage guard below instead of duplicating them. A
       * day with no reading stays missing, so coverage still means "days that
       * reported", not "days that were cool".
       */
      perDay?: (v: number) => number
    ) => {
      if (!records.length || !history?.lastObserved) return null;

      const byDate = new Map<string, number | null>();
      for (const r of records) {
        const v = fieldValue(r, f, gddConfig);
        byDate.set(r.date.slice(0, 10), v === null || !perDay ? v : perDay(v));
      }

      const observed = history.lastObserved.slice(0, 10);
      /**
       * Never past the last day there is data for.
       *
       * A chosen end in the future is not an error to refuse — someone setting
       * up a whole season will naturally pick a harvest date that has not
       * arrived. It means "as far as you can get", so it is clamped and the
       * `stale` flag tells the reader where the numbers actually stop.
       */
      const to = untilISO && untilISO < observed ? untilISO : observed;
      if (fromISO > to) return null;

      /**
       * OpenET drops whole months when cloud defeats its interpolation, so a
       * water total must STOP at a real hole rather than coast through it —
       * otherwise a season reads ~9 in short and the irrigation deficit looks
       * comfortable when it is not. Weather fields are daily-complete, so they
       * carry straight through.
       */
      const maxGap = f === "et" || f === "balance" ? 5 : Infinity;

      const nextDay = (iso: string) => {
        const d = new Date(`${iso}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString().slice(0, 10);
      };

      /** Sum one window, stopping at a gap longer than `maxGap`. */
      const sumWindow = (from: string, end: string) => {
        let total = 0;
        let present = 0;
        let span = 0;
        let gap = 0;
        let lastGood: string | null = null;
        let truncated = false;

        for (let d = from; d <= end; d = nextDay(d)) {
          span++;
          const v = byDate.get(d);
          if (v === null || v === undefined || !Number.isFinite(v)) {
            gap++;
            if (gap > maxGap) {
              truncated = true;
              break;
            }
          } else {
            gap = 0;
            total += v;
            present++;
            lastGood = d;
          }
        }

        if (lastGood === null) return null;

        // On truncation the span must stop where the numbers do, or coverage
        // would be measured against days the total never reached.
        if (truncated) {
          span = 0;
          for (let d = from; d <= lastGood; d = nextDay(d)) span++;
        }
        return { total, present, span, lastGood, truncated };
      };

      const cur = sumWindow(fromISO, to);
      if (!cur) return null;

      /** The same window, whole years earlier. Both ends move together. */
      const shift = (iso: string, years: number) =>
        `${Number(iso.slice(0, 4)) - years}${iso.slice(4)}`;

      const firstYear = Number(records[0].date.slice(0, 4));
      const normals: number[] = [];
      for (let k = 1; k <= 40; k++) {
        const bFrom = shift(fromISO, k);
        if (Number(bFrom.slice(0, 4)) < firstYear) break;
        const b = sumWindow(bFrom, shift(to, k));
        // A comparison year is only usable if it is reasonably complete —
        // otherwise a half-covered year drags the normal down and every
        // comparison against it flatters the current season.
        if (!b || b.truncated) continue;
        if (b.span === 0 || b.present / b.span < 0.9) continue;
        normals.push(b.total);
      }
      if (!normals.length) return null;

      /**
       * COVERAGE GUARD — the reason a season total can be badly wrong.
       *
       * An accumulation sums only the days that reported. Airport stations drop
       * days routinely: measured 2026 at Muleshoe 173/237 days, Pecos 23/237.
       * Summing those gives 1.81 in and 4.5 in, which then get compared against
       * a COMPLETE 30-year normal and render as "-13.2 vs normal" — a fake
       * catastrophic drought, stated with total confidence.
       *
       * The total itself is honest (it is what the station measured); the
       * COMPARISON is what lies. So count the days actually present and let the
       * tile drop the vs-normal line and say what is missing instead.
       */
      const coverage = cur.span > 0 ? cur.present / cur.span : 0;

      return {
        value: cur.total,
        normal: normals.reduce((a, b) => a + b, 0) / normals.length,
        /** Years the comparison is actually built from, not the years asked for. */
        normalYears: normals.length,
        /** The last day the total really reached. */
        throughDate: cur.lastGood,
        stale: cur.lastGood < to,
        coverage,
        daysPresent: cur.present,
        daysExpected: cur.span,
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
    [records, history?.lastObserved, gddConfig]
  );

  const rainStat = useMemo(
    () => makeStat("precip", seasonFrom, seasonTo),
    [makeStat, seasonFrom, seasonTo]
  );
  const gddStat = useMemo(
    () => makeStat("gdd", seasonFrom, seasonTo),
    [makeStat, seasonFrom, seasonTo]
  );
  const hotStat = useMemo(
    () => makeStat("tmax", seasonFrom, seasonTo, (v) => (v >= hotThresholdC ? 1 : 0)),
    [makeStat, seasonFrom, seasonTo, hotThresholdC]
  );

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

  const handlePlace = useCallback((p: Place, via: PickMethod = "map") => {
    pickedVia.current = via;
    setPlace(p);
  }, []);

  /**
   * Put the top of the stage just under the masthead.
   *
   * The bar is `position: sticky` and self-sizing — it takes an extra row at
   * the mobile breakpoint where the source picker wraps — so its height is
   * measured rather than hard-coded. A constant here would tuck the first line
   * of every chart under the bar on exactly the screens that need this most.
   */
  const scrollToStage = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const bar = document.querySelector<HTMLElement>(".hero-bar");
    const top =
      stage.getBoundingClientRect().top + window.scrollY - (bar?.offsetHeight ?? 0) - 12;
    window.scrollTo({
      top: Math.max(0, top),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }, []);

  /**
   * Re-tapping the open cover scrolls immediately: `setPanel` with the value it
   * already holds is a no-op, so the effect below would never run, and the one
   * cover a reader is most likely to tap twice would be the one that did
   * nothing.
   */
  const handlePanel = useCallback(
    (id: PanelId) => {
      if (id === panel) {
        scrollToStage();
        return;
      }
      wantScroll.current = true;
      setPanel(id);
    },
    [panel, scrollToStage]
  );

  // After the new panel has rendered — its content is mounted only once it is
  // the open one, so the stage has no measurable position until then.
  useEffect(() => {
    if (!wantScroll.current) return;
    wantScroll.current = false;
    scrollToStage();
  }, [panel, scrollToStage]);


  /**
   * The window every tile in the card is describing, written out once.
   *
   * It moved into the card heading because the four tiles now share it —
   * repeating "since Mar 1" on each was what made three separate pickers look
   * reasonable in the first place.
   */
  const seasonRangeLabel = useMemo(() => {
    const observed = history?.lastObserved ?? null;
    // Null means "to the newest day", and so does an end date that has not
    // arrived — in both cases the honest label is the last day with data.
    const effectiveTo = seasonTo && observed && seasonTo < observed ? seasonTo : observed;
    if (!effectiveTo) return null;
    // Full dates, not month-and-day: a window may now start in one year and
    // finish in the next, and "Oct 1 – Jun 30" would not say which.
    return formatRange(seasonFrom, effectiveTo);
  }, [seasonFrom, seasonTo, history?.lastObserved]);

  const precipDp = units === "imperial" ? 1 : 0;

  /**
   * The season chart, built once and handed to whichever panel needs it.
   *
   * The season panel IS this chart. The analog panel opens the SAME chart
   * beneath its table when the reader asks to plot the matched years, rather
   * than throwing them over to another view — the point of plotting is to read
   * the lines against the rows, and a jump would take the rows away.
   *
   * One element rather than two copies, so the two placements cannot drift
   * apart, and only ever mounted in one place at a time.
   */
  const seasonChart = (
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
      exportContext={exportContext}
      gddPresetKey={gddPreset}
      gddPresets={GDD_PRESETS}
      onGddPresetChange={(k) => setGddPreset(k as keyof typeof GDD_PRESETS)}
      gddExtra={gddCustomControls}
      rangeFrom={chartFrom}
      rangeTo={chartTo}
      onRangeChange={(f, t) => {
        setChartFrom(f);
        setChartTo(t);
      }}
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
  );

  return (
    <>
      {/*
        The masthead is FIXED to the top of the window, on its own ground.

        It used to sit on the photograph, which looked better but scrolled away
        — and the source picker is the one control a reader needs from anywhere
        on the page, because it changes every number below it. A source you
        cannot see or change while looking at a chart is exactly the hidden
        default this project exists to argue against.

        It carries only what has to be reachable: the name, the source, the
        units, the theme. Everything else belongs in the page.
      */}
      <div className="hero-bar">
        <div className="hero-bar-inner">
          {/*
            The name stands on its own — it says what the tool is, so there is
            no expansion to hide on phones and no gloss to keep in step with it.
          */}
          <div className="brand">
            <h1>Texas Weather Explorer</h1>
          </div>

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

      {/*
        A cotton harvester cutting rows at Batesville, Texas. USDA, public
        domain — no attribution is legally required and none is printed, which
        is why the credit line that used to sit in the corner is gone. The
        provenance lives in public/img/CREDITS.md, where it belongs: a caption
        on a decorative photograph is furniture, not information.
      */}
      <header className="hero">
        <div className="hero-photo" aria-hidden="true" />
      </header>

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
              gddPresetKey={gddPreset}
              gddPresets={GDD_PRESETS}
              onGddPresetChange={(k) => setGddPreset(k as keyof typeof GDD_PRESETS)}
              gddExtra={gddCustomControls}
            />
            {/*
              Provenance for this point, under the map: where the pin is on the
              left, which real instrument is filling the recent days on the
              right. Both answer "where did this come from", so they belong
              together rather than in the figures card.
            */}
            <div className="map-foot">
              <span>
                <strong>{place.label}</strong> · {place.lat.toFixed(4)}°, {place.lon.toFixed(4)}°
              </span>
              {history?.recent.station && (
                <span className="map-foot-right">
                  Nearest weather station · {history.recent.station.name} ·{" "}
                  {history.recent.station.distanceKm} km away
                </span>
              )}
            </div>
          </div>

          {/*
            Outside Texas the map keeps the pin exactly where it was dropped.
            A notice with no pin leaves the reader unsure whether the click
            even registered; showing both makes the boundary the explanation.
          */}
          {outsideTexas ? (
            <div className="card outside-texas">
              <div className="card-head">
                <h2>Data not available</h2>
              </div>
              <p>
                This tool covers <strong>Texas only</strong>. The pin is at{" "}
                {place.lat.toFixed(4)}°, {place.lon.toFixed(4)}° — outside the state.
              </p>
              <p className="muted">
                The county yields, the rainfall archive and the station network behind
                these figures are all built for Texas. A point past the state line would
                come back partly empty while still looking like a complete answer.
              </p>
              <button
                style={{ marginTop: 4 }}
                onClick={() => handlePlace({ ...DEFAULT_PLACE }, "default")}
              >
                Back to Texas
              </button>
            </div>
          ) : (
          <div>
            <div className="card">
              <div className="card-head">
                <h2>Season so far</h2>
                {/* The source badge is gone from here: the picker is now fixed
                    to the top of the window, so the active source is on screen
                    at all times and repeating it was clutter. The badge now
                    carries the window all four tiles share, which is the thing
                    that changed and the thing they all depend on. */}
                {seasonRangeLabel && <span className="badge">{seasonRangeLabel}</span>}
              </div>

              {/*
                ONE RANGE FOR THE CARD, set here rather than four times below.

                "To" is allowed to be empty, and empty is the default: it means
                "up to the newest day there is", which is what this card always
                did and what almost everyone wants. Making the reader pick an
                end date to get the ordinary behaviour would be a worse default
                than having no end date at all.
              */}
              <div className="season-range">
                <label>
                  <span>From</span>
                  <input
                    type="date"
                    aria-label="Season window start"
                    value={seasonFrom}
                    max={seasonTo ?? undefined}
                    onChange={(e) => {
                      setSeasonFrom(e.target.value);
                      setSeasonFromTouched(true);
                    }}
                  />
                </label>
                <label>
                  <span>To</span>
                  <input
                    type="date"
                    aria-label="Season window end, blank for the latest day available"
                    value={seasonTo ?? ""}
                    min={seasonFrom}
                    onChange={(e) => setSeasonTo(e.target.value || null)}
                  />
                </label>
                {seasonTo ? (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => setSeasonTo(null)}
                    title="Go back to counting up to the newest day available"
                  >
                    to latest
                  </button>
                ) : (
                  <span className="muted" style={{ fontSize: "0.72rem" }}>
                    to the latest day available
                  </span>
                )}
              </div>
              {histLoading ? (
                <div className="skeleton" style={{ height: 150 }} />
              ) : (
                <div className="tiles compact">
                  <div className="tile">
                    <div className="k">Rain</div>
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
                  </div>

                  <div className="tile">
                    {/* Names the crop, because "GDD since" alone is
                        unanswerable — a user asked what crop it meant. */}
                    <div className="k">
                      GDD · {gddShort}
                    </div>
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
                  </div>

                  {/*
                    HOT DAYS — days whose high reached the threshold, over the
                    same window as the other tiles, against the same window in
                    past years. The threshold is part of the LABEL and editable
                    in place: a count of "hot days" is meaningless without the
                    line it was counted against, the same way growing degree days
                    are meaningless without a base. See `hotThresholdC` for why
                    95 degF is the default and not the research thresholds.
                  */}
                  <div className="tile">
                    <div
                      className="k"
                      title={
                        "Days when the high reached this temperature. 95°F is the default because " +
                        "it is where Texas summers differ most from one another. Heat damage to " +
                        "crops starts lower (about 84°F for corn, 90°F for cotton), but in Texas " +
                        "those are passed on most summer days, so the count barely changes year to year."
                      }
                    >
                      Days ≥{" "}
                      <input
                        type="number"
                        className="tile-threshold"
                        aria-label={`Hot day threshold in ${unitLabel("temp", units)}`}
                        value={Math.round(convert(hotThresholdC, "temp", units))}
                        min={units === "imperial" ? 70 : 20}
                        max={units === "imperial" ? 120 : 49}
                        step={1}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (!Number.isFinite(n) || e.target.value === "") return;
                          setHotThresholdC(units === "imperial" ? fToC(n) : n);
                        }}
                      />
                      {unitLabel("temp", units)}
                    </div>
                    <div className="v">
                      {hotStat ? Math.round(hotStat.value) : "—"}
                      <span className="muted" style={{ fontSize: "0.72rem", fontWeight: 500 }}>
                        {" "}
                        days
                      </span>
                    </div>
                    {hotStat &&
                      (hotStat.sparse ? (
                        <div className="d" style={{ color: "var(--div-warm)", fontWeight: 600 }}>
                          incomplete — only {hotStat.daysPresent} of {hotStat.daysExpected} days
                          reported
                        </div>
                      ) : (
                        <div
                          className="d"
                          style={{
                            color:
                              hotStat.value >= hotStat.normal
                                ? "var(--div-warm)"
                                : "var(--div-cool)",
                            fontWeight: 600,
                          }}
                        >
                          {hotStat.value >= hotStat.normal ? "+" : "−"}
                          {Math.abs(Math.round(hotStat.value - hotStat.normal))} vs normal
                        </div>
                      ))}
                  </div>

                  {/*
                    ESTIMATED ET AND WATER BALANCE WERE REMOVED FROM THIS CARD
                    on 30 September 2026 at the user's request, leaving rain and
                    growing degree days. Both variables are still in the season
                    chart, the year-by-year trend and the similar-years table —
                    only the headline tiles went. Their arithmetic (the gap rule,
                    the coverage guard) lives on in `makeStat`, which serves any
                    field, so restoring a tile is markup only.
                  */}
                </div>
              )}

              {/*
                The crop selector and the station line used to sit here as
                settings rows. Both moved to the location card: the crop because
                it belongs beside the controls that define what you are looking
                at, the station because it is provenance for the point and
                belongs under the map with the coordinates. This card is now
                only figures.
              */}
            </div>

            {!histLoading && lastWeek && (
              <div className="card">
                <div className="card-head">
                  <h2>Last {lastWeek.days} days</h2>
                  <span className="badge">{formatRange(lastWeek.from, lastWeek.to)}</span>
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
                    {/* The bare degree sign said nothing: 95° and 35° are the
                        same temperature and the tile gave no way to tell which
                        it meant. Every other figure on the page names its
                        unit. */}
                    <div className="v">
                      {lastWeek.hottest !== null
                        ? Math.round(convert(lastWeek.hottest, "temp", units))
                        : "—"}
                      <span className="muted" style={{ fontSize: "0.72rem", fontWeight: 500 }}>
                        {" "}
                        {unitLabel("temp", units)}
                      </span>
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
          )}
        </div>

        {!outsideTexas && histError && (
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

        {outsideTexas ? null : histLoading && !history ? (
          <div className="card">
            <div className="skeleton" style={{ height: 420 }} />
          </div>
        ) : records.length > 0 ? (
          <>
            <PanelRail active={panel} onChange={handlePanel} />

            {/*
              The stage. Its treatment changes with the open panel — a light
              slab for the season chart, a warm split for the analogs, an
              inverted dark band for the thirty-year trend. Four identical white
              rectangles would say these answer the same kind of question, and
              they do not.

              Only the open panel is mounted, so three charts are not being
              computed for a reader looking at the fourth.
            */}
            <div ref={stageRef} id="panel-stage" className={`panel-stage stage-${panel}`}>
            {panel === "season" && seasonChart}

            {panel === "analog" && (
            <AnalogPanel
              records={records}
              units={units}
              gddConfig={gddConfig}
              lastObserved={history?.lastObserved ?? null}
              dailyEt={dailyEt}
              waterLoading={waterLoading}
              yields={yields}
              yieldsLoading={yieldsLoading}
              chartSlot={seasonChart}
              /* Just sets the years. The panel decides where the chart goes
                 and when, so this no longer jumps the reader to another view. */
              onCompareYears={setCompareYears}
            />
            )}

            {panel === "forecast" && (
              <ForecastStrip forecast={forecast} loading={fcLoading} units={units} />
            )}

            {panel === "trend" && (
            <AnnualTrendChart
              records={records}
              units={units}
              gddConfig={gddConfig}
              currentYear={currentYear}
              field={trendField}
              onFieldChange={setTrendField}
              waterLoading={waterLoading}
              gddCropShort={gddShort}
              exportContext={exportContext}
            />
            )}
            </div>
          </>
        ) : null}

        <footer className="site">
          {/*
            DISCLAIMER FIRST, SOURCES SECOND — the order is the point. A reader
            who stops after one paragraph should leave knowing these are
            estimates to be used with care, not where the estimates came from.
            It absorbed the old "What this is not" paragraph, whose content
            (unofficial normals, similar years are not a forecast, not your
            gauge) is part of the same warning.
          */}
          <p className="disclaimer">
            <strong>Please use with care.</strong> The historical weather on this site comes
            from gridded, interpolated datasets — estimates built from weather stations, radar
            and satellites spread across a grid — not from a measurement taken in your field.
            They can differ from what actually fell or was felt at your location, especially
            rainfall from individual storms. Normals are calculated from {START_YEAR}–
            {currentYear - 1} at a single grid point and are not the official NOAA 1991–2020
            station normals. Similar years compare past seasons with this one; they are not a
            forecast. Use these figures alongside your own observations, and not as the only
            basis for irrigation, planting or other management decisions.
          </p>

          {/*
            THE TEAM, behind one button — no names line above it. A visible
            names line was tried and removed on 30 September 2026: with the
            team one click away it only repeated what the button holds.

            The button is "Team & contact" rather than "Meet the team" because
            the feedback address lives inside it, and somebody looking for a way
            to ask a question will not think to open a button that only
            promises people.

            Positions are a plain title and location, as the authors asked — no
            specialisms, no street addresses. Checked against each person's
            Texas A&M profile page on 30 September 2026; re-check there if
            anyone is promoted or changes post. Names run in author order.

            THERE IS DELIBERATELY NO "HOW TO CITE" LINE YET. The authors intend
            to license the code (MIT) and deposit a release with Zenodo for a
            DOI first; a citation without the DOI would then need changing in
            every copy already taken.
          */}
          <div className="folds">
          <details className="fold">
            <summary>Team &amp; contact</summary>
            {/*
              Photos: Pulkit's from his own site, the others from their Texas
              A&M profile pages — each cropped to the face and reduced to a
              192 px square (~7 KB) so the footer stays light. Sources are in
              public/img/CREDITS.md.
            */}
            <ul className="people">
              <li>
                <img className="avatar" src="/img/people/juneja.jpg" alt="Pulkit Juneja" width={48} height={48} />
                <div>
                  <strong>Pulkit Juneja</strong>
                  <span className="role">PhD Student · Blackland Research and Extension Center</span>
                </div>
              </li>
              <li>
                <img className="avatar" src="/img/people/baath.jpg" alt="Dr. Gurjinder S. Baath" width={48} height={48} />
                <div>
                  <strong>Dr. Gurjinder S. Baath</strong>
                  <span className="role">
                    Assistant Professor · Blackland Research and Extension Center
                  </span>
                </div>
              </li>
              <li>
                <img className="avatar" src="/img/people/burke.jpg" alt="Dr. Joseph A. Burke" width={48} height={48} />
                <div>
                  <strong>Dr. Joseph A. Burke</strong>
                  <span className="role">Assistant Professor · Texas A&amp;M AgriLife Lubbock</span>
                </div>
              </li>
            </ul>
            <p className="contact">
              <strong>Feedback or questions?</strong> Email{" "}
              <a href="mailto:pulkit.juneja@tamu.edu?subject=Texas%20Weather%20Explorer%20feedback">
                pulkit.juneja@tamu.edu
              </a>
            </p>
          </details>

          {/*
            FORMAL CITATIONS, verified against the registries on 30 September
            2026 — Crossref for the three journal articles, DataCite for the
            Open-Meteo software record. Two things worth knowing if this is
            edited:
            - OpenET's article appeared online in 2021 but is volume 58 issue 6
              of 2022; the issue year is the one to cite.
            - Open-Meteo's registered year is 2024, not the 2023 that circulates.
            NASA POWER asks for its acknowledgement sentence verbatim rather
            than a paper, and OpenStreetMap's licence requires the
            "© OpenStreetMap contributors" wording.
          */}
          {/*
            COLLAPSED BY DEFAULT, behind a button. Nine citations took most of
            the footer's height for something a grower reads rarely and a
            researcher looks up once. The disclaimer above deliberately stays
            OPEN — it is the one thing every reader should see.

            A native <details> rather than React state: it works before the
            page's JavaScript has loaded, it is keyboard- and screen-reader-
            accessible for free, and the citations stay in the page source, so
            search engines and "find in page" still reach them.
          */}
          <details className="fold">
            <summary>Data sources and citations</summary>
            <ul>
              <li>
                <strong>Historical weather (gridMET).</strong> Abatzoglou, J. T. (2013).
                Development of gridded surface meteorological data for ecological applications
                and modelling. <em>International Journal of Climatology</em>, 33(1), 121–131.{" "}
                <a href="https://doi.org/10.1002/joc.3413">https://doi.org/10.1002/joc.3413</a>
              </li>
              <li>
                <strong>Historical weather (NASA POWER).</strong> These data were obtained from
                the NASA Langley Research Center (LaRC) POWER Project funded through the NASA
                Earth Science/Applied Science Program.{" "}
                <a href="https://power.larc.nasa.gov/">https://power.larc.nasa.gov/</a>
              </li>
              <li>
                <strong>Most recent days.</strong> Nearest airport (ASOS) weather station, via
                the Iowa Environmental Mesonet, Iowa State University.{" "}
                <a href="https://mesonet.agron.iastate.edu/">
                  https://mesonet.agron.iastate.edu/
                </a>
              </li>
              <li>
                <strong>Crop water use (OpenET).</strong> Melton, F. S., et al. (2022). OpenET:
                Filling a critical data gap in water management for the western United States.{" "}
                <em>Journal of the American Water Resources Association</em>, 58(6), 971–994.{" "}
                <a href="https://doi.org/10.1111/1752-1688.12956">
                  https://doi.org/10.1111/1752-1688.12956
                </a>{" "}
                Accessed through Google Earth Engine: Gorelick, N., Hancher, M., Dixon, M.,
                Ilyushchenko, S., Thau, D., &amp; Moore, R. (2017). Google Earth Engine:
                Planetary-scale geospatial analysis for everyone.{" "}
                <em>Remote Sensing of Environment</em>, 202, 18–27.{" "}
                <a href="https://doi.org/10.1016/j.rse.2017.06.031">
                  https://doi.org/10.1016/j.rse.2017.06.031
                </a>
              </li>
              <li>
                <strong>Forecast, days 1–7.</strong> NOAA National Weather Service API.{" "}
                <a href="https://www.weather.gov/documentation/services-web-api">
                  https://www.weather.gov/documentation/services-web-api
                </a>
              </li>
              <li>
                <strong>Forecast, days 8–16.</strong> Zippenfenig, P. (2024). Open-Meteo.com
                Weather API [Computer software]. Zenodo.{" "}
                <a href="https://doi.org/10.5281/zenodo.7970649">
                  https://doi.org/10.5281/zenodo.7970649
                </a>
              </li>
              <li>
                <strong>Outlook, weeks 2–4.</strong> NOAA Climate Prediction Center.{" "}
                <a href="https://www.cpc.ncep.noaa.gov/">https://www.cpc.ncep.noaa.gov/</a>
              </li>
              <li>
                <strong>County crop yields.</strong> USDA National Agricultural Statistics
                Service, Quick Stats.{" "}
                <a href="https://quickstats.nass.usda.gov/">https://quickstats.nass.usda.gov/</a>
              </li>
              <li>
                <strong>Maps and places.</strong> Map tiles and place search ©{" "}
                <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors,
                via Nominatim. County boundaries from the U.S. Census Bureau (TIGERweb).
              </li>
            </ul>
          </details>
          </div>
          {/*
            THE "WHAT WE RECORD" PARAGRAPH WAS REMOVED ON 21 SEPTEMBER 2026 AT
            THE USER'S REQUEST. Recording that here rather than deleting the
            note silently, because the code it described is still running.

            `lib/analytics/visitor.ts` keeps a random code in each visitor's
            browser so repeat visits can be counted as one person. That is
            persistent identification of a browser — harmless in itself, joined
            to nothing, but the kind of thing a visitor is normally told. The
            site now does it without saying so anywhere on the page.

            If that disclosure is ever wanted back, it belongs here, and the
            wording is in the git history of this file.
          */}
        </footer>
      </div>
    </>
  );
}
