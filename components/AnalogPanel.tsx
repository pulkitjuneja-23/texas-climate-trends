"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { DailyRecord } from "@/lib/types";
import {
  findAnalogYears,
  FEATURE_LABELS,
  FEATURE_SHORT_LABELS,
  DISPLAYED_FEATURES,
  type AnalogFeatures,
} from "@/lib/agro/analog";
import type { GddConfig } from "@/lib/agro/gdd";
import { convert, type Quantity, type UnitSystem, unitLabel } from "@/lib/agro/units";
import { waterBalanceForWindow, balanceWording, type WaterWindow } from "@/lib/agro/water";
import { formatDate } from "@/lib/format/date";
// Both of these modules are pure data and maths with no imports of their own,
// so a client component may use them; the reader that touches process.env
// stays on the server.
import { deviationFromTrend, yieldAt, type CountyYields } from "@/lib/yield/types";
import { PRACTICE_LABELS, PRACTICE_HELP, type PracticeId } from "@/lib/yield/crops";
import { yieldUnitView } from "@/lib/yield/units";

/**
 * "Were there any similar years in past?"
 *
 * The ranking is only half the value. The other half is `whatHappenedNext` —
 * what the rest of that analog season actually did. A grower does not care that
 * 2011 looked like this year; they care that the 60 days after this point in
 * 2011 delivered 18 mm of rain.
 *
 * The panel deliberately shows the spread of outcomes across the top matches
 * rather than a single "most similar year" verdict. Five analogs that went five
 * different directions afterwards is a real and useful answer — it means the
 * current state does not constrain what comes next, and presenting only the
 * top match would hide that.
 */

const QTY: Record<keyof AnalogFeatures, Quantity> = {
  precipTotal: "precip",
  tmaxMean: "temp",
  tminMean: "temp",
  gddTotal: "gdd",
  dryDays: "rh",
  maxDrySpell: "rh",
  hotDays: "rh",
};

const WINDOWS = [90, 120, 150, 180];

/** Chart line colours, used only once the years are actually being plotted. */
const SERIES_VARS = [
  "--series-2",
  "--series-3",
  "--series-4",
  "--series-5",
  "--series-6",
];

/**
 * Match strength as ONE ramp, closest darkest.
 *
 * Five unrelated hues in the year column said "these are five different
 * series" — which is true only while they are being plotted, and false the
 * rest of the time. Worse, they carried no ranking: the best match looked
 * exactly as important as the fifth, so the numeric Match column had to spell
 * out something the colours were actively contradicting.
 *
 * One green ramp encodes the ranking directly, which is what let the Match
 * column go. The exact figure survives on the swatch's tooltip for anyone who
 * wants it.
 *
 * Fixed hex rather than theme tokens on purpose: these are small solid blocks
 * read against each other, not against the page, so they should look the same
 * in both themes. A ramp built with `color-mix` toward `--surface` would run
 * dark-to-light in one theme and dark-to-dark in the other.
 */
const MATCH_GREENS = ["#1b5e20", "#2e7d32", "#43a047", "#66bb6a", "#a5d6a7"];

interface Props {
  records: DailyRecord[];
  units: UnitSystem;
  gddConfig: GddConfig;
  lastObserved: string | null;
  onCompareYears: (years: number[]) => void;
  /**
   * The season chart, ready to mount underneath the table. Passed in rather
   * than imported so this panel does not have to know how the chart is
   * configured — the page owns that.
   */
  chartSlot?: ReactNode;
  /** Daily ET (mm) keyed YYYY-MM-DD, spread from OpenET's monthly values. */
  dailyEt?: Map<string, number>;
  waterLoading?: boolean;
  /** County crop yields from NASS, or null outside Texas / with no figures. */
  yields?: CountyYields | null;
  yieldsLoading?: boolean;
}

/** Shift an ISO date by whole days. */
function shift(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The same calendar window as the current year, but in year `y`.
 *
 * Handles a window that crosses New Year: if the window began in the previous
 * calendar year, its start belongs to y-1, not y.
 */
function windowForYear(
  y: number,
  windowStart: string,
  asOf: string
): { start: string; end: string } {
  const spans = windowStart.slice(0, 4) !== asOf.slice(0, 4);
  return {
    start: `${spans ? y - 1 : y}-${windowStart.slice(5)}`,
    end: `${y}-${asOf.slice(5)}`,
  };
}

/**
 * A BARE NUMBER. The unit lives in the column heading, once.
 *
 * Repeating "in" or "°F" in all seventy cells of a table this dense trebled the
 * width of every column for information that never changes down it — and it
 * made the numbers themselves harder to compare by eye, which is the only thing
 * the table is for.
 *
 * One decimal place at most. Two decimals of rainfall (`12.44 in`) implies a
 * hundredth-of-an-inch agreement between sources that measurably disagree by
 * six inches a year; counts and degree days take none at all.
 */
function fmtFeature(v: number, k: keyof AnalogFeatures, units: UnitSystem): string {
  const q = QTY[k];
  if (q === "rh") return String(Math.round(v));
  if (q === "gdd") return Math.round(convert(v, q, units)).toLocaleString();
  return convert(v, q, units).toFixed(1);
}

/**
 * The difference from this year, in brackets: `(+2.4)` / `(−1.1)`.
 *
 * Bracketed so it cannot be misread as a second measurement sitting beside the
 * first — it is an annotation on the number to its left, and brackets are what
 * says so without a word.
 */
function fmtDelta(v: number, k: keyof AnalogFeatures, units: UnitSystem): string {
  const q = QTY[k];
  const sign = v >= 0 ? "+" : "";
  if (q === "rh") return `(${sign}${Math.round(v)})`;
  // A temperature DIFFERENCE converts with the ratio only — applying the +32
  // offset here would turn "2 degC warmer" into "35.6 degF warmer".
  if (q === "gdd") {
    return `(${sign}${Math.round(convert(v, "gdd", units)).toLocaleString()})`;
  }
  const adj = convert(v, q === "temp" ? "tempDelta" : q, units);
  return `(${adj >= 0 ? "+" : ""}${adj.toFixed(1)})`;
}

/**
 * Green when that year ran HIGHER than this one, red when lower.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE CHANGING IT. Green and red mean HIGHER and LOWER here, not
 * GOOD and BAD, and those are not the same thing in every column.
 * ---------------------------------------------------------------------------
 * More rain than this year is usually welcome and reads correctly as green. A
 * higher average high in August is not welcome and reads as green anyway. The
 * pair was chosen deliberately as a *direction* indicator so the whole table
 * can be scanned in one pass — every column answers the same question the same
 * way — and it is stated in the note under the table for exactly this reason.
 *
 * The alternative was per-column semantics: green for wetter, green for cooler.
 * That is more truthful cell by cell and much worse to read, because the reader
 * would have to know which convention each column was on before a colour meant
 * anything.
 *
 * Deliberately NOT `--div-warm`/`--div-cool`. Those encode hot/cold across the
 * rest of the app, and reusing them for up/down would make red mean "hotter" in
 * one place and "less" in another.
 */
function deltaColor(v: number): string | undefined {
  if (v === 0) return undefined;
  return v > 0 ? "var(--up)" : "var(--down)";
}

/**
 * The unit for a column heading, or null where the label already carries it.
 *
 * "Dry days" is a count of days and says so; degree days are their own unit and
 * "GDD (GDD °F)" would be nonsense.
 */
function headUnit(k: keyof AnalogFeatures, units: UnitSystem): string | null {
  const q = QTY[k];
  if (q === "rh" || q === "gdd") return null;
  return unitLabel(q, units);
}

/**
 * Which of a crop's practice series to actually use here.
 *
 * The one with the most reported years. MEASURED, not assumed: across all 223
 * Texas counties in the store, 1,032 of 1,035 crop series have an all-practices
 * record at least as complete as either split, which is what makes "all" the
 * near-universal answer — a county that publishes a split publishes the
 * combined figure too, and the split is a subset of it.
 *
 * The three exceptions are real and are why this is a function rather than a
 * constant: Somervell County wheat has ONLY a dryland series (one year, no
 * all-acres figure at all), and Washington County wheat has four all-acres
 * years against five dryland. Hardcoding "all" would blank one and understate
 * the other.
 */
function bestPractice(
  crop: { practices: string[] } | null | undefined,
  data: { series: Record<string, { v: Array<number | null> }> } | undefined
): PracticeId {
  if (!crop || !data) return "all";
  let best: PracticeId = (crop.practices[0] as PracticeId) ?? "all";
  let bestN = -1;
  for (const p of crop.practices as PracticeId[]) {
    const n = data.series[p]?.v.filter((v) => v !== null).length ?? 0;
    if (n > bestN) {
      bestN = n;
      best = p;
    }
  }
  return best;
}

/** Renders a heading as label + a quieter unit, so the unit reads as a unit. */
function Head({ label, unit }: { label: string; unit?: string | null }) {
  return (
    <>
      {label}
      {unit ? <span className="th-unit">{unit}</span> : null}
    </>
  );
}

export default function AnalogPanel({
  records,
  units,
  gddConfig,
  lastObserved,
  onCompareYears,
  chartSlot,
  dailyEt,
  waterLoading = false,
  yields = null,
  yieldsLoading = false,
}: Props) {
  const [windowDays, setWindowDays] = useState(150);
  const [lookAhead, setLookAhead] = useState(60);
  const [cropId, setCropId] = useState<string | null>(null);

  /**
   * Whether the season chart is showing beneath the table.
   *
   * Starts closed EVERY time this panel is opened, which is deliberate and is
   * why the state lives here rather than on the page: the panel's job is the
   * comparison table, and the chart is an answer to a question the reader has
   * to ask. Only the open panel is mounted, so leaving a view and coming back
   * resets this for free.
   */
  const [plotted, setPlotted] = useState(false);

  /**
   * Which crop to open on: the BEST REPORTED one in this county, not the first.
   *
   * The store orders crops by statewide importance, and opening on that order
   * was wrong in exactly the places it matters. In Bandera County NASS has one
   * year of wheat and eight of oats; the panel opened on wheat, showed a column
   * of dashes, and gave no hint that oats was sitting in the dropdown with
   * eight times the record. A user reported precisely this, southwest of
   * Austin, and reasonably assumed it was a bug.
   *
   * Statewide importance is the right ORDER for the dropdown — it stays
   * predictable — but the wrong default for a specific field.
   */
  const bestCrop = useMemo(() => {
    if (!yields?.crops.length) return null;
    let best = yields.crops[0];
    let bestN = -1;
    for (const c of yields.crops) {
      const s = yields.data[c.id]?.series;
      const n = s
        ? Math.max(...Object.values(s).map((x) => x.v.filter((v) => v !== null).length))
        : 0;
      if (n > bestN) {
        bestN = n;
        best = c;
      }
    }
    return best;
  }, [yields]);

  /**
   * Re-resolved every render, so moving to a county that does not grow the
   * selected crop recovers instead of showing blanks.
   */
  const crop = yields?.crops.find((c) => c.id === cropId) ?? bestCrop;

  /**
   * THE IRRIGATED / DRYLAND TOGGLE IS GONE, AND THE REASON MATTERS.
   *
   * A user tried it: "All" had figures, "Irrigated" was blank, "Dryland" was
   * blank — and reasonably asked what the setting was even for, since a field
   * is one or the other. The toggle was not broken; it was offering options
   * this county does not publish. NASS reports the practice split for only some
   * crops in some counties, so in most places "All" is the ONLY series that
   * exists and the other two buttons were an invitation to empty columns.
   *
   * So the panel now picks the best-populated series itself, and says which one
   * it picked in the dropdown when that is not the plain county-wide figure. A
   * control whose options are usually empty is worse than no control: it makes
   * a complete answer look like a broken feature.
   *
   * Note this cannot be resolved by asking the grower whether their field is
   * irrigated. The constraint is what USDA published for their county, not what
   * they do on their own acres.
   */
  const cropData = crop ? yields?.data[crop.id] : undefined;
  const activePractice = bestPractice(crop, cropData);

  const series = cropData?.series[activePractice];
  const trend = cropData?.trend[activePractice];

  /**
   * Yield is the one column the unit toggle used to miss, because NASS reports
   * it in three different US units and a bushel is a volume — so the factor is
   * per crop, not global. See lib/yield/units.ts.
   */
  const uv = crop ? yieldUnitView(crop, units) : null;

  /**
   * Which row is showing its comparison, on touch.
   *
   * The percentage is hidden by default so the column reads as plain yields.
   * Hover reveals it on a desktop, but a phone has no hover — so the cell is a
   * button and a tap toggles the same thing. One row at a time: tapping another
   * moves it rather than accumulating.
   */
  const [revealed, setRevealed] = useState<number | null>(null);

  const result = useMemo(() => {
    try {
      return findAnalogYears(records, {
        windowDays,
        lookAheadDays: lookAhead,
        gddConfig,
        topN: 5,
        asOf: lastObserved ?? undefined,
      });
    } catch {
      return null;
    }
  }, [records, windowDays, lookAhead, gddConfig, lastObserved]);

  /**
   * Keep the plotted lines in step with the table while it is open.
   *
   * Changing the look-back window re-ranks the years, so without this the chart
   * would keep drawing the PREVIOUS set while the table showed a new one — two
   * different answers to the same question on one screen. Serialised to a
   * string so an identical set does not re-fire.
   */
  const plottedKey = result?.matches.map((m) => m.year).join(",") ?? "";
  useEffect(() => {
    if (!plotted || !plottedKey) return;
    onCompareYears(plottedKey.split(",").map(Number));
  }, [plotted, plottedKey, onCompareYears]);

  if (!result || !result.matches.length) {
    return (
      <div className="card">
        <h2>Were there any similar years in past?</h2>
        <p className="card-sub">
          Not enough overlapping history at this point to match against yet.
        </p>
      </div>
    );
  }

  const featureKeys = DISPLAYED_FEATURES;
  const precipUnit = unitLabel("precip", units);

  /**
   * Water use and deficit for every row, past window and look-ahead window.
   *
   * Computed here rather than inside the matching maths on purpose: ET only
   * exists from late 2015, so letting it into the distance calculation would
   * make pre-2016 years incomparable and quietly bias the ranking. It is shown,
   * not scored.
   */
  const water = useMemo(() => {
    const out = new Map<
      number,
      { past: WaterWindow | null; next: WaterWindow | null }
    >();
    if (!dailyEt || dailyEt.size === 0) return out;

    // Every candidate, not just the shown matches — the long-run average row
    // needs water figures across all of them.
    const years = [
      result.currentYear,
      ...new Set([...result.matches.map((m) => m.year), ...result.candidateYears]),
    ];
    for (const y of years) {
      const w = windowForYear(y, result.windowStart, result.asOf);
      const past = waterBalanceForWindow(records, dailyEt, w.start, w.end);

      const nextStart = shift(w.end, 1);
      const nextEnd = shift(w.end, lookAhead);
      const next =
        y === result.currentYear
          ? null
          : waterBalanceForWindow(records, dailyEt, nextStart, nextEnd);

      out.set(y, { past, next });
    }
    return out;
  }, [dailyEt, records, result, lookAhead]);

  /** Mean water figures across every candidate year that has ET at all. */
  const waterAverages = useMemo(() => {
    const past: number[] = [];
    const pastBal: number[] = [];
    const next: number[] = [];
    const nextBal: number[] = [];
    for (const y of result.candidateYears) {
      const w = water.get(y);
      if (w?.past?.et != null) past.push(w.past.et);
      if (w?.past?.balance != null) pastBal.push(w.past.balance);
      if (w?.next?.et != null) next.push(w.next.et);
      if (w?.next?.balance != null) nextBal.push(w.next.balance);
    }
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    return {
      pastEt: avg(past),
      pastBalance: avg(pastBal),
      nextEt: avg(next),
      nextBalance: avg(nextBal),
      n: past.length,
    };
  }, [water, result.candidateYears]);

  /** "—" when ET simply does not reach that year. */
  function etCell(w: WaterWindow | null | undefined): string {
    if (waterLoading) return "…";
    if (!dailyEt || dailyEt.size === 0) return "n/a";
    if (!w || w.et === null) return "n/a";
    return fmtFeature(w.et, "precipTotal", units);
  }

  /**
   * Magnitude plus the word, so a cell can never be misread. "-1.6" alone under
   * a heading is ambiguous; "1.6 short" is not.
   *
   * The word is NOT a unit and does not move to the heading with the others —
   * it is the sign, in English, and it is the single thing that stops a signed
   * water balance from reading backwards. See lib/agro/water.ts.
   */
  function balanceCell(w: WaterWindow | null | undefined): {
    text: string;
    word?: string;
    color?: string;
  } {
    if (waterLoading) return { text: "…" };
    if (!dailyEt || dailyEt.size === 0) return { text: "n/a" };
    if (!w || w.balance === null) return { text: "n/a" };
    const v = convert(w.balance, "precip", units);
    const wording = balanceWording(w.balance);
    return {
      text: `${Math.abs(v).toFixed(1)}`,
      word: wording.short.toLowerCase(),
      color: wording.colorVar,
    };
  }
  /**
   * The yield cell for one analog year.
   *
   * BOTH numbers, deliberately. Raw yield across thirty years is dominated by
   * genetics and agronomy rather than weather — Texas corn has gone from ~100
   * to ~150 bu/ac — so a 1998 analog would read as a catastrophe beside 2023
   * even if it was a good season for its time. The percentage answers the
   * question the panel actually asks: in years whose weather looked like this
   * one, did the crop do well or badly *for that era*.
   */
  // Hoisted because control-flow narrowing of `result` does not reach inside a
  // closure declared after the early return.
  const currentYear = result.currentYear;

  /**
   * How much of this crop's record actually exists here.
   *
   * A column of dashes reads as a broken feature when it is really an honest
   * report that NASS never published a figure — many Hill Country counties are
   * ranch land with almost no row crop, and 16 Texas counties have exactly one
   * crop. The project has hit this class of bug three times already (the trend
   * chart's dropped years, the sparse-station tiles): coverage-based emptiness
   * must always be DISCLOSED, never silent.
   */
  const yieldCoverage = (() => {
    if (!crop || !series) return null;
    const reported = series.v.filter((v) => v !== null).length;
    const matched = result.matches.filter(
      (m) => yieldAt(series, m.year) !== null
    ).length;
    return { reported, matched, shown: result.matches.length };
  })();

  function yieldCell(year: number) {
    if (yieldsLoading) return <span className="muted">…</span>;
    if (!crop || !series || !uv) return <span className="muted">n/a</span>;

    const raw = yieldAt(series, year);
    // NASS publishes a county yield the spring after harvest, so the year in
    // progress legitimately has none. Say "not yet", not "no data" — they mean
    // different things and only one of them is a gap in the record.
    if (raw === null) {
      return <span className="muted">{year >= currentYear ? "not yet" : "—"}</span>;
    }

    /**
     * NASS publishes a literal 0 for a crop that failed or was never taken to
     * harvest — 133 times in 23,544 Texas values, clustered in drought years.
     * Real data, but "0.0" beside "-100%" reads as a broken cell rather than
     * the outcome it is, so say it in words. The percentage is dropped: "none"
     * already carries the whole meaning, and -100% is the same number every
     * time regardless of what normal was.
     */
    if (raw === 0) {
      return (
        <span
          className="muted"
          title={
            `NASS published a zero yield for ${year} — no harvest was recorded in this ` +
            `county. Zero years are shown here but left out of the long-term trend, since a ` +
            `failed crop is the absence of a yield rather than a low one.`
          }
          style={{ borderBottom: "1px dotted currentColor" }}
        >
          none
        </span>
      );
    }

    const shown = (raw * uv.factor).toFixed(uv.decimals);

    // A RATIO, so it needs no unit conversion — the same in bu/ac or t/ha.
    const dev = deviationFromTrend(trend, year, raw);
    if (dev === null) return <span style={{ fontWeight: 650 }}>{shown}</span>;

    const on = revealed === year;
    return (
      <button
        type="button"
        className="yield-cell"
        aria-expanded={on}
        aria-label={`${shown} ${uv.label}, ${Math.abs(dev).toFixed(0)}% ${
          dev >= 0 ? "above" : "below"
        } the long-term trend`}
        title={
          `${Math.abs(dev).toFixed(0)}% ${dev >= 0 ? "above" : "below"} the long-term trend for ` +
          `${year}. ` +
          (trend?.borrowed
            ? "Measured against the statewide rate of improvement for this crop, anchored to " +
              "this county's own average — this county reports too few years to fit its own."
            : `Measured against this county's own fitted trend (${trend?.n} years).`)
        }
        onClick={() => setRevealed(on ? null : year)}
      >
        <span className="yv">{shown}</span>
        <span
          className="yp"
          data-on={on || undefined}
          style={{
            color: dev >= 0 ? "var(--div-cool)" : "var(--div-warm)",
            borderBottom: trend?.borrowed ? "1px dotted currentColor" : undefined,
          }}
        >
          {dev >= 0 ? "+" : "−"}
          {Math.abs(dev).toFixed(0)}%
        </span>
      </button>
    );
  }

  const nextRains = result.matches
    .map((m) => m.whatHappenedNext?.precipTotal)
    .filter((v): v is number => typeof v === "number");
  const spreadLow = nextRains.length ? Math.min(...nextRains) : null;
  const spreadHigh = nextRains.length ? Math.max(...nextRains) : null;

  /**
   * Plot draws EVERY row, not the top four.
   *
   * The four-year cap was a palette limit dressed up as a feature: the chart
   * had four compare colours, so the button silently dropped the fifth match.
   * That is exactly backwards for this panel — the fifth match is part of the
   * spread, and the spread is the finding. A sixth series slot was added rather
   * than continuing to hide a row the table had already shown.
   */
  function togglePlot() {
    // The effect above pushes the years once `plotted` flips, so this only has
    // to own the open/closed state.
    setPlotted((v) => !v);
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Were there any similar years in past?</h2>
        <span className="badge">as of {formatDate(result.asOf)}</span>
      </div>
      <div className="controls">
        <div className="field">
          <label>Look back</label>
          <div className="seg">
            {WINDOWS.map((w) => (
              <button key={w} aria-pressed={windowDays === w} onClick={() => setWindowDays(w)}>
                {w}d
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Then look ahead</label>
          <div className="seg">
            {[30, 60, 90].map((w) => (
              <button key={w} aria-pressed={lookAhead === w} onClick={() => setLookAhead(w)}>
                {w}d
              </button>
            ))}
          </div>
        </div>
        <div className="field" style={{ marginLeft: "auto" }}>
          <label>&nbsp;</label>
          <button aria-pressed={plotted} onClick={togglePlot}>
            {plotted ? "Remove plot" : "Plot on the chart"}
          </button>
        </div>
      </div>

      {spreadLow !== null && spreadHigh !== null && (
        <div className={`note ${spreadHigh - spreadLow > spreadLow * 2 ? "" : "info"}`} style={{ marginBottom: 14 }}>
          <span>{spreadHigh - spreadLow > spreadLow * 2 ? "⚠" : "ℹ"}</span>
          <span>
            In the {lookAhead} days after this point, those five years delivered between{" "}
            <strong>
              {fmtFeature(spreadLow, "precipTotal", units)} {precipUnit}
            </strong>{" "}
            and{" "}
            <strong>
              {fmtFeature(spreadHigh, "precipTotal", units)} {precipUnit}
            </strong>{" "}
            of rain.
            {spreadHigh - spreadLow > spreadLow * 2
              ? " That is a wide spread — a similar start did not determine what followed. Treat these as a range of possibilities, not a forecast."
              : " The outcomes were reasonably consistent across matches."}
          </span>
        </div>
      )}

      {/*
        Two banded column groups with a hard divider. Without them the table
        reads as one flat run of numbers and there is no way to tell where the
        record of what ALREADY happened stops and what came AFTERWARDS begins —
        which is the entire point of the comparison.
      */}
      <div className="table-wrap">
        <table className="analog-table">
          <thead>
            <tr className="group-row">
              <th className="grp-blank" />
              <th colSpan={featureKeys.length + 2} className="grp-past">
                Already happened &mdash; last {result.windowDays} days
              </th>
              <th colSpan={crop ? 5 : 4} className="grp-future">
                What came next &mdash; the following {lookAhead} days
                {crop && (
                  <span style={{ fontWeight: 500, opacity: 0.8 }}>
                    , and that year&rsquo;s harvest
                  </span>
                )}
              </th>
            </tr>
            <tr>
              <th>Year</th>
              {featureKeys.map((k) => (
                <th key={k} title={FEATURE_LABELS[k]}>
                  <Head label={FEATURE_SHORT_LABELS[k]} unit={headUnit(k, units)} />
                </th>
              ))}
              <th title="Estimated water used by the crop, from OpenET monthly values">
                <Head label="Est. ET" unit={precipUnit} />
              </th>
              <th title="Rain minus estimated water used. A surplus means more rain fell than the crop used; short means it used more than it rained.">
                <Head label="Balance" unit={precipUnit} />
              </th>
              <th className="future-start">
                <Head label="Rain" unit={precipUnit} />
              </th>
              <th className="future">
                <Head label="Avg high" unit={unitLabel("temp", units)} />
              </th>
              <th className="future">
                <Head label="Est. ET" unit={precipUnit} />
              </th>
              <th
                className="future"
                title="Rain minus estimated water used. A surplus means more rain fell than the crop used; short means it used more than it rained."
              >
                <Head label="Balance" unit={precipUnit} />
              </th>
              {crop && (
                <th className="future yield-head">
                  {/* The dropdown IS the heading, so the column names itself
                      after whatever is being shown. Only crops this county
                      actually reports are listed. */}
                  {/*
                    The unit rides INSIDE the option text rather than sitting on
                    a line of its own. That removes a second row from the header
                    — the column was noticeably taller than its neighbours — and
                    it earns its place in the list too: these crops genuinely do
                    not share a unit, so "Cotton (upland) · lb/ac" beside "Corn
                    (grain) · bu/ac" is information, not decoration.
                  */}
                  <select
                    aria-label="Crop"
                    value={crop.id}
                    onChange={(e) => setCropId(e.target.value)}
                  >
                    {yields!.crops.map((c) => {
                      // Named only when it is NOT the plain county-wide figure.
                      // Writing "· all" on nine options out of ten would be
                      // noise; naming the exception is the whole point.
                      const p = bestPractice(c, yields!.data[c.id]);
                      return (
                        <option key={c.id} value={c.id}>
                          {c.label}
                          {p !== "all" ? ` · ${PRACTICE_LABELS[p].toLowerCase()}` : ""} ·{" "}
                          {yieldUnitView(c, units).label}
                        </option>
                      );
                    })}
                  </select>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            <tr className="now-row">
              <td style={{ fontWeight: 700 }}>
                <span
                  className="swatch"
                  style={{
                    background: plotted ? "var(--series-1)" : "var(--text-secondary)",
                    display: "inline-block",
                    marginRight: 6,
                  }}
                />
                {result.currentYear} (now)
              </td>
              {featureKeys.map((k) => (
                <td key={k} style={{ fontWeight: 600 }}>
                  {fmtFeature(result.currentFeatures[k], k, units)}
                </td>
              ))}
              <td style={{ fontWeight: 600 }}>{etCell(water.get(result.currentYear)?.past)}</td>
              <td
                style={{
                  fontWeight: 600,
                  color: balanceCell(water.get(result.currentYear)?.past).color,
                }}
              >
                {balanceCell(water.get(result.currentYear)?.past).text}
                {balanceCell(water.get(result.currentYear)?.past).word && (
                  <span style={{ fontSize: "0.72rem", marginLeft: 4, fontWeight: 500 }}>
                    {balanceCell(water.get(result.currentYear)?.past).word}
                  </span>
                )}
              </td>
              <td className="future-start muted" colSpan={crop ? 5 : 4} style={{ textAlign: "center" }}>
                still to come
              </td>
            </tr>
            {result.matches.map((m, i) => (
              <tr key={m.year}>
                <td style={{ fontWeight: 650 }}>
                  {/*
                    Green ramp normally, chart colours while plotting. The
                    swatch answers two different questions in those two states —
                    "how close is this one" versus "which line is this one" —
                    and the same five hues cannot do both.
                  */}
                  <span
                    className="swatch"
                    title={`Match ${m.similarity} of 100 — ${
                      i === 0 ? "the closest" : `rank ${i + 1}`
                    } of ${result.candidateYears.length} years compared`}
                    style={{
                      background: plotted
                        ? `var(${SERIES_VARS[i % SERIES_VARS.length]})`
                        : MATCH_GREENS[Math.min(i, MATCH_GREENS.length - 1)],
                      display: "inline-block",
                      marginRight: 6,
                    }}
                  />
                  {m.year}
                </td>
                {featureKeys.map((k) => (
                  <td key={k}>
                    {fmtFeature(m.features[k], k, units)}
                    <span
                      className="delta"
                      style={{ color: deltaColor(m.deltas[k]) }}
                    >
                      {fmtDelta(m.deltas[k], k, units)}
                    </span>
                  </td>
                ))}
                <td>{etCell(water.get(m.year)?.past)}</td>
                <td style={{ color: balanceCell(water.get(m.year)?.past).color }}>
                  {balanceCell(water.get(m.year)?.past).text}
                  {balanceCell(water.get(m.year)?.past).word && (
                    <span style={{ fontSize: "0.72rem", marginLeft: 4 }}>
                      {balanceCell(water.get(m.year)?.past).word}
                    </span>
                  )}
                </td>
                <td className="future-start" style={{ fontWeight: 700 }}>
                  {m.whatHappenedNext?.precipTotal !== undefined &&
                  m.whatHappenedNext?.precipTotal !== null
                    ? fmtFeature(m.whatHappenedNext.precipTotal, "precipTotal", units)
                    : "—"}
                </td>
                <td className="future">
                  {m.whatHappenedNext?.tmaxMean !== undefined &&
                  m.whatHappenedNext?.tmaxMean !== null
                    ? fmtFeature(m.whatHappenedNext.tmaxMean, "tmaxMean", units)
                    : "—"}
                </td>
                <td className="future">{etCell(water.get(m.year)?.next)}</td>
                <td
                  className="future"
                  style={{ fontWeight: 700, color: balanceCell(water.get(m.year)?.next).color }}
                >
                  {balanceCell(water.get(m.year)?.next).text}
                  {balanceCell(water.get(m.year)?.next).word && (
                    <span style={{ fontSize: "0.72rem", marginLeft: 4, fontWeight: 500 }}>
                      {balanceCell(water.get(m.year)?.next).word}
                    </span>
                  )}
                </td>
                {crop && <td className="future">{yieldCell(m.year)}</td>}
              </tr>
            ))}

            {/*
              The baseline. Without it the matched years float free: "0.5 to 8.6
              in afterwards" only becomes meaningful once you know a typical year
              delivers 4 in. Averaged over every candidate year, not the top
              five, because this row answers "what is normal", not "what is
              similar".
            */}
            {result.averages && (
              <tr className="avg-row">
                {/*
                  Counts the years actually averaged rather than printing a
                  flat "30". With a full record it reads exactly "30-year
                  Normal" as intended, but a sparse airport station or a
                  location with skipped years would otherwise be labelled with a
                  sample size it does not have — the same rule the trend chart
                  follows.
                */}
                <td style={{ fontWeight: 650 }}>{result.candidateYears.length}-year Normal</td>
                {featureKeys.map((k) => (
                  <td key={k}>{fmtFeature(result.averages!.features[k], k, units)}</td>
                ))}
                <td>
                  {waterAverages.pastEt !== null
                    ? fmtFeature(waterAverages.pastEt, "precipTotal", units)
                    : "n/a"}
                </td>
                <td
                  style={{
                    color:
                      waterAverages.pastBalance !== null
                        ? balanceWording(waterAverages.pastBalance).colorVar
                        : undefined,
                  }}
                >
                  {waterAverages.pastBalance !== null ? (
                    <>
                      {Math.abs(convert(waterAverages.pastBalance, "precip", units)).toFixed(1)}
                      <span style={{ fontSize: "0.72rem", marginLeft: 4 }}>
                        {balanceWording(waterAverages.pastBalance).short.toLowerCase()}
                      </span>
                    </>
                  ) : (
                    "n/a"
                  )}
                </td>
                <td className="future-start" style={{ fontWeight: 700 }}>
                  {result.averages.next?.precipTotal != null
                    ? fmtFeature(result.averages.next.precipTotal, "precipTotal", units)
                    : "—"}
                </td>
                <td className="future">
                  {result.averages.next?.tmaxMean != null
                    ? fmtFeature(result.averages.next.tmaxMean, "tmaxMean", units)
                    : "—"}
                </td>
                <td className="future">
                  {waterAverages.nextEt !== null
                    ? fmtFeature(waterAverages.nextEt, "precipTotal", units)
                    : "n/a"}
                </td>
                <td
                  className="future"
                  style={{
                    fontWeight: 700,
                    color:
                      waterAverages.nextBalance !== null
                        ? balanceWording(waterAverages.nextBalance).colorVar
                        : undefined,
                  }}
                >
                  {waterAverages.nextBalance !== null ? (
                    <>
                      {Math.abs(convert(waterAverages.nextBalance, "precip", units)).toFixed(1)}
                      <span style={{ fontSize: "0.72rem", marginLeft: 4, fontWeight: 500 }}>
                        {balanceWording(waterAverages.nextBalance).short.toLowerCase()}
                      </span>
                    </>
                  ) : (
                    "n/a"
                  )}
                </td>
                {crop && (
                  <td className="future">
                    {/*
                      NOT the mean of the analog years' yields. That average
                      would span 1996-2025 and be dragged down by thirty years
                      of older genetics — reintroducing exactly the bias the
                      percentage column exists to remove. The honest baseline
                      is what the trend expects TODAY: what a normal year yields
                      now, which is the number a farmer can actually compare
                      their own field against.
                    */}
                    {trend && uv ? (
                      <span
                        title={
                          `What a normal year yields now, from the fitted trend. ` +
                          `Not an average of the years above — those span three decades ` +
                          `of changing genetics.`
                        }
                      >
                        {(
                          (trend.intercept + trend.slope * result.currentYear) *
                          uv.factor
                        ).toFixed(uv.decimals)}
                        <span className="muted" style={{ fontSize: "0.72rem", marginLeft: 5 }}>
                          now
                        </span>
                      </span>
                    ) : (
                      <span className="muted">n/a</span>
                    )}
                  </td>
                )}
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="small muted" style={{ marginTop: 10, lineHeight: 1.6 }}>
        Years are ranked against each other, closest first — the green blocks run dark to light in
        that order, and hovering one gives its score out of 100. That is a ranking within this
        location&rsquo;s own record, not a probability.{" "}
        {/*
          The colour convention, said plainly. It has to be said, because green
          and red normally read as good and bad and here they do not: a higher
          average high is green, and nobody wants a hotter August.
        */}
        Bracketed figures are that year minus this one —{" "}
        <span style={{ color: "var(--up)", fontWeight: 600 }}>green where it ran higher</span>,{" "}
        <span style={{ color: "var(--down)", fontWeight: 600 }}>red where it ran lower</span>. That
        is direction only, not good or bad; a hotter year is green in the temperature columns.
        {result.skippedYears.length > 0 && (
          <> Years skipped for sparse data: {result.skippedYears.join(", ")}.</>
        )}
        {crop && (
          <>
            {" "}
            <strong>{crop.label}</strong> yield is the average across all of{" "}
            <strong>{yields!.county.name} County</strong> — a much coarser thing than the weather
            columns beside it, which come from the grid cell containing your pin.{" "}
            {/*
              Only stated when the figure is NOT county-wide. Most counties
              publish nothing else, so saying "all production practices" every
              time would be noise; naming the exception is what carries meaning.
            */}
            {activePractice !== "all" && (
              <>
                USDA publishes no county-wide figure for this crop here, so these are{" "}
                <strong>{PRACTICE_LABELS[activePractice].toLowerCase()} acres only</strong> —{" "}
                {PRACTICE_HELP[activePractice].toLowerCase()}.{" "}
              </>
            )}
            Hover or tap a yield to see how far it sat above or below the long-term trend; that
            comparison is against the trend rather than a flat average because thirty years of
            better genetics would otherwise make every old year look like a failure.{" "}
            {yields!.attribution}.
          </>
        )}
        {/*
          Say why the column is empty. Dashes alone read as a broken feature
          when they are really an accurate report that nothing was published.
        */}
        {crop && yieldCoverage && yieldCoverage.matched < yieldCoverage.shown && (
          <>
            {" "}
            <strong>
              Only {yieldCoverage.matched} of the {yieldCoverage.shown} matched years
            </strong>{" "}
            {yieldCoverage.matched === 1 ? "has" : "have"} a reported {crop.label.toLowerCase()}{" "}
            yield here — NASS published one for {yieldCoverage.reported} of the last{" "}
            {result.candidateYears.length} years in {yields!.county.name} County. That is the
            record being thin, not a fault: much of the Hill Country is ranch land and some
            counties report only one crop.
            {yields!.crops.length > 1 && (
              <> Another crop in the dropdown may have a fuller record here.</>
            )}
          </>
        )}
      </div>

      {/*
        The chart opens BELOW the table rather than replacing it.

        Replacing it would answer the question and remove the evidence in one
        gesture: the reader wants to see 2011's line against this year's WHILE
        reading 2011's row. This is also why it starts closed on every visit —
        the table is the panel, and the chart is a thing you ask for.
      */}
      {plotted && chartSlot && <div className="analog-plot">{chartSlot}</div>}
    </div>
  );
}
