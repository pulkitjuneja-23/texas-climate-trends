"use client";

import { useMemo, useState } from "react";
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

/**
 * "Which past year is this one tracking like?"
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
const SERIES_VARS = ["--series-2", "--series-3", "--series-4", "--series-5"];

interface Props {
  records: DailyRecord[];
  units: UnitSystem;
  gddConfig: GddConfig;
  lastObserved: string | null;
  onCompareYears: (years: number[]) => void;
  /** Daily ET (mm) keyed YYYY-MM-DD, spread from OpenET's monthly values. */
  dailyEt?: Map<string, number>;
  waterLoading?: boolean;
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

function fmtFeature(v: number, k: keyof AnalogFeatures, units: UnitSystem): string {
  const q = QTY[k];
  if (q === "rh") return `${Math.round(v)} days`;
  const conv = convert(v, q, units);
  const dp = q === "precip" ? (units === "imperial" ? 2 : 0) : q === "gdd" ? 0 : 1;
  return `${conv.toFixed(dp)} ${unitLabel(q, units)}`;
}

function fmtDelta(v: number, k: keyof AnalogFeatures, units: UnitSystem): string {
  const q = QTY[k];
  if (q === "rh") return `${v >= 0 ? "+" : ""}${Math.round(v)}`;
  // A temperature DIFFERENCE converts with the ratio only — applying the +32
  // offset here would turn "2 degC warmer" into "35.6 degF warmer".
  const adj = convert(v, q === "temp" ? "tempDelta" : q, units);
  const dp = q === "precip" ? (units === "imperial" ? 2 : 0) : q === "gdd" ? 0 : 1;
  return `${adj >= 0 ? "+" : ""}${adj.toFixed(dp)}`;
}

export default function AnalogPanel({
  records,
  units,
  gddConfig,
  lastObserved,
  onCompareYears,
  dailyEt,
  waterLoading = false,
}: Props) {
  const [windowDays, setWindowDays] = useState(150);
  const [lookAhead, setLookAhead] = useState(60);

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

  if (!result || !result.matches.length) {
    return (
      <div className="card">
        <h2>Analog years</h2>
        <p className="card-sub">
          Not enough overlapping history at this point to match against yet.
        </p>
      </div>
    );
  }

  const featureKeys = DISPLAYED_FEATURES;

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
   * Signed value plus the word, so a cell can never be misread. "-1.6" alone
   * under a heading is ambiguous; "1.6 short" is not.
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
    const dp = units === "imperial" ? 1 : 0;
    const wording = balanceWording(w.balance);
    return {
      text: `${Math.abs(v).toFixed(dp)}`,
      word: wording.short.toLowerCase(),
      color: wording.colorVar,
    };
  }
  const nextRains = result.matches
    .map((m) => m.whatHappenedNext?.precipTotal)
    .filter((v): v is number => typeof v === "number");
  const spreadLow = nextRains.length ? Math.min(...nextRains) : null;
  const spreadHigh = nextRains.length ? Math.max(...nextRains) : null;

  return (
    <div className="card">
      <div className="card-head">
        <h2>Which year is this one tracking like?</h2>
        <span className="badge">as of {result.asOf}</span>
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
          <button onClick={() => onCompareYears(result.matches.slice(0, 4).map((m) => m.year))}>
            Plot top 4 on the chart
          </button>
        </div>
      </div>

      {spreadLow !== null && spreadHigh !== null && (
        <div className={`note ${spreadHigh - spreadLow > spreadLow * 2 ? "" : "info"}`} style={{ marginBottom: 14 }}>
          <span>{spreadHigh - spreadLow > spreadLow * 2 ? "⚠" : "ℹ"}</span>
          <span>
            In the {lookAhead} days after this point, those five years delivered between{" "}
            <strong>{fmtFeature(spreadLow, "precipTotal", units)}</strong> and{" "}
            <strong>{fmtFeature(spreadHigh, "precipTotal", units)}</strong> of rain.
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
              <th colSpan={2} className="grp-blank" />
              <th colSpan={featureKeys.length + 2} className="grp-past">
                Already happened &mdash; last {result.windowDays} days
              </th>
              <th colSpan={4} className="grp-future">
                What came next &mdash; the following {lookAhead} days
              </th>
            </tr>
            <tr>
              <th>Year</th>
              <th>Match</th>
              {featureKeys.map((k) => (
                <th key={k} title={FEATURE_LABELS[k]}>
                  {FEATURE_SHORT_LABELS[k]}
                </th>
              ))}
              <th title="Estimated water used by the crop, from OpenET monthly values">
                Est. ET
              </th>
              <th title="Rain minus estimated water used. Plus is a surplus; minus means the crop used more than it rained.">
                Balance
              </th>
              <th className="future-start">Rain</th>
              <th className="future">Avg high</th>
              <th className="future">Est. ET</th>
              <th
                className="future"
                title="Rain minus estimated water used. Plus is a surplus; minus means the crop used more than it rained."
              >
                Balance
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="now-row">
              <td style={{ fontWeight: 700, color: "var(--series-1)" }}>
                {result.currentYear} (now)
              </td>
              <td className="muted">&mdash;</td>
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
              <td className="future-start muted" colSpan={4} style={{ textAlign: "center" }}>
                still to come
              </td>
            </tr>
            {result.matches.map((m, i) => (
              <tr key={m.year}>
                <td style={{ fontWeight: 650 }}>
                  <span
                    className="swatch"
                    style={{
                      background: `var(${SERIES_VARS[i % SERIES_VARS.length]})`,
                      display: "inline-block",
                      marginRight: 6,
                    }}
                  />
                  {m.year}
                </td>
                <td style={{ fontWeight: 600 }}>{m.similarity}</td>
                {featureKeys.map((k) => (
                  <td key={k}>
                    {fmtFeature(m.features[k], k, units)}
                    <span className="muted" style={{ fontSize: "0.72rem", marginLeft: 5 }}>
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
                <td style={{ fontWeight: 650 }}>Typical year</td>
                <td className="muted">avg</td>
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
                      {Math.abs(convert(waterAverages.pastBalance, "precip", units)).toFixed(
                        units === "imperial" ? 1 : 0
                      )}
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
                      {Math.abs(convert(waterAverages.nextBalance, "precip", units)).toFixed(
                        units === "imperial" ? 1 : 0
                      )}
                      <span style={{ fontSize: "0.72rem", marginLeft: 4, fontWeight: 500 }}>
                        {balanceWording(waterAverages.nextBalance).short.toLowerCase()}
                      </span>
                    </>
                  ) : (
                    "n/a"
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="small muted" style={{ marginTop: 10, lineHeight: 1.6 }}>
        <strong>Match</strong> is 0–100 rescaled across the candidate years — it ranks them against
        each other, it is not a probability. Small grey numbers are that year minus this year.
        {result.skippedYears.length > 0 && (
          <> Years skipped for sparse data: {result.skippedYears.join(", ")}.</>
        )}
      </div>
    </div>
  );
}
