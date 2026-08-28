"use client";

import { useMemo, useRef, useState } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Cell,
} from "recharts";
import type { DailyRecord } from "@/lib/types";
import { alignByYear, annualAggregate, linearTrend, type Field } from "@/lib/agro/climatology";
import type { GddConfig } from "@/lib/agro/gdd";
import { convert, unitLabel, decimals, type Quantity, type UnitSystem } from "@/lib/agro/units";
import { BALANCE_LEGEND } from "@/lib/agro/water";
import ChartExport from "./ChartExport";
import { buildCsv, slug } from "@/lib/export/csv";
import { csvHeader, figureFooter, today, type ExportContext } from "@/lib/export/context";

/**
 * Year-by-year totals with a fitted trend — the "is it actually changing here"
 * question the farmer feedback started from.
 *
 * Bars are colored DIVERGING around the period mean (warm/dry vs cool/wet),
 * because the meaningful signal is the sign and size of the anomaly, not the
 * absolute total. The pole assignment follows the conventions growers already
 * read: warm = red for temperature, dry = red for rainfall.
 *
 * The trend line is ordinary least squares. Where the fit is weak the subtitle
 * says so in plain words rather than printing r²: a 30-year record is still
 * short for climate, and a slope with an r² of 0.04 must not be read as a
 * trend. Reporting the slope alone would invite exactly that mistake.
 */

/**
 * 30 is the full record (1996 onward) and the default, because the whole point
 * of moving the start year back was to fit trends over a conventional
 * thirty-year span. The shorter windows stay: a grower asking "what have the
 * last ten years done" is asking a different and equally fair question.
 */
const TREND_WINDOWS = [10, 15, 20, 25, 30];
const DEFAULT_TREND_WINDOW = 30;

const AGGREGATES: Array<{
  field: Field;
  label: string;
  how: "sum" | "mean";
  quantity: Quantity;
  /** true => higher values read as "warm/dry" and take the warm pole. */
  warmIsHigh: boolean;
  /** Legend wording, since "wetter/drier" is wrong for most of these. */
  high: string;
  low: string;
}> = [
  { field: "precip", label: "Annual rainfall", how: "sum", quantity: "precip", warmIsHigh: false, high: "Wetter than average", low: "Drier than average" },
  { field: "tmax", label: "Average daily high", how: "mean", quantity: "temp", warmIsHigh: true, high: "Warmer than average", low: "Cooler than average" },
  { field: "tmin", label: "Average daily low", how: "mean", quantity: "temp", warmIsHigh: true, high: "Warmer than average", low: "Cooler than average" },
  { field: "tmean", label: "Average temperature", how: "mean", quantity: "temp", warmIsHigh: true, high: "Warmer than average", low: "Cooler than average" },
  { field: "gdd", label: "Annual growing degree days", how: "sum", quantity: "gdd", warmIsHigh: true, high: "More heat units", low: "Fewer heat units" },
  { field: "dtr", label: "Average temperature swing (high − low)", how: "mean", quantity: "tempDelta", warmIsHigh: true, high: "Bigger swing", low: "Smaller swing" },
  /**
   * Water variables only have data from 2016, so most years simply have no bar.
   * ET is coloured "more/less used" rather than good/bad: a high ET year can
   * mean a thriving crop or a thirsty one, and the chart should not imply which.
   * The balance is not ambiguous — negative is a deficit, and takes the warm pole.
   */
  { field: "et", label: "Annual water used (ET)", how: "sum", quantity: "precip", warmIsHigh: true, high: "More water used", low: "Less water used" },
  { field: "balance", label: "Annual water balance (rain − ET)", how: "sum", quantity: "precip", warmIsHigh: false, high: BALANCE_LEGEND.high, low: BALANCE_LEGEND.low },
  { field: "eto", label: "Annual water demand (reference ET)", how: "sum", quantity: "precip", warmIsHigh: true, high: "Higher demand", low: "Lower demand" },
];

/** Variables whose satellite record only begins part-way through the axis. */
const WATER_TREND_FIELDS: Field[] = ["et", "balance"];
/** First calendar year OpenET covers end to end (its record opens 2015-10-01). */
const OPENET_FIRST_FULL_YEAR = 2016;

interface Props {
  records: DailyRecord[];
  units: UnitSystem;
  gddConfig: GddConfig;
  currentYear: number;
  /** Lifted so the page can lazily load reference ET when it is selected here. */
  field: Field;
  onFieldChange: (f: Field) => void;
  waterLoading?: boolean;
  /** Provenance for the CSV and figure exports. */
  exportContext?: ExportContext;
}

export default function AnnualTrendChart({
  records,
  units,
  gddConfig,
  currentYear,
  field,
  onFieldChange,
  waterLoading = false,
  exportContext,
}: Props) {
  const [window, setWindow] = useState(DEFAULT_TREND_WINDOW);
  const [showTable, setShowTable] = useState(false);
  const chartRef = useRef<HTMLDivElement>(null);

  const def = AGGREGATES.find((a) => a.field === field) ?? AGGREGATES[0];
  const isWaterField = WATER_TREND_FIELDS.includes(field) || field === "eto";
  const quantity = def.quantity;
  const unit = unitLabel(quantity, units);
  const dp = decimals(quantity, units);

  const { data, trend, mean, excludedCurrent, droppedYears } = useMemo(() => {
    const series = alignByYear(records, field, gddConfig);
    // The in-progress year is not a complete annual total — including it would
    // draw a false collapse at the right edge of every chart.
    const complete = annualAggregate(series, def.how, 0.9).filter((d) => d.year < currentYear);

    /**
     * Years that failed the coverage test are dropped, because summing a year
     * with 119 reported days would draw a bar that looks like a drought when it
     * is really a gap in the record. But dropping them SILENTLY is what makes a
     * chart look inexplicably sparse — common with airport stations at remote
     * locations, where a station can miss months at a time. So name them.
     */
    const kept = new Set(complete.map((d) => d.year));
    const droppedYears = series
      .filter((s) => s.year < currentYear && !kept.has(s.year))
      .filter((s) => s.values.some((v) => v !== null))
      .map((s) => s.year);

    const windowed = complete.slice(-window);

    const converted = windowed.map((d) => ({
      year: d.year,
      value: convert(d.value, quantity, units),
    }));

    const mean = converted.length
      ? converted.reduce((a, b) => a + b.value, 0) / converted.length
      : 0;

    const t = linearTrend(converted.map((d) => ({ x: d.year, y: d.value })));

    const data = converted.map((d) => ({
      ...d,
      anomaly: d.value - mean,
      fit: t ? t.intercept + t.slope * d.year : null,
    }));

    return {
      data,
      trend: t,
      mean,
      droppedYears,
      excludedCurrent: complete.length !== series.filter((s) => s.year <= currentYear).length,
    };
  }, [records, field, window, units, gddConfig, def.how, quantity, currentYear]);

  const decadeChange = trend ? trend.slope * 10 : null;

  /**
   * The bars, the fitted line, and each year's distance from the mean — the
   * three things actually drawn. `fit` is included because a reader
   * reconstructing the trend from the bars alone would get a different line:
   * it is fitted over the visible window only, not the whole record.
   */
  function csvForChart() {
    const csv = buildCsv(
      data,
      [
        { header: "year", value: (d) => d.year },
        { header: `${def.field}_${unit}`, value: (d) => d.value.toFixed(dp) },
        { header: "anomaly_vs_period_mean", value: (d) => d.anomaly.toFixed(dp) },
        { header: "trend_fit", value: (d) => (d.fit === null ? "" : d.fit.toFixed(dp)) },
      ],
      csvHeader(exportContext, [
        `Chart: Year-by-year trend — ${def.label}`,
        `Units: ${unit}`,
        `Aggregate: annual ${def.how}`,
        `Window: last ${window} years requested, ${data.length} complete years available`,
        `Period mean: ${mean.toFixed(dp)} ${unit}`,
        trend
          ? `Trend: ${trend.slope >= 0 ? "+" : ""}${(trend.slope * 10).toFixed(dp)} ${unit} per decade, r2 ${trend.r2.toFixed(3)}`
          : "Trend: not fitted",
        trend && trend.r2 < 0.15
          ? "NOTE: r2 below 0.15 — year-to-year variation far exceeds the long-term drift. Read the bars, not the line."
          : "",
        droppedYears.length
          ? `Years excluded for incomplete coverage: ${droppedYears.join(", ")}`
          : "",
        `${currentYear} excluded — season still in progress.`,
      ].filter(Boolean))
    );
    return {
      csv,
      filename: `${slug(
        exportContext?.placeName ?? "texas",
        `annual ${def.label}`,
        exportContext?.sourceId,
        today()
      )}.csv`,
    };
  }

  function figureForChart() {
    return {
      meta: {
        title: `Year-by-year trend — ${def.label}`,
        subtitle:
          `${exportContext?.placeName ? `${exportContext.placeName} · ` : ""}` +
          `${data.length} complete years · ${unit}` +
          (decadeChange !== null
            ? ` · ${decadeChange >= 0 ? "+" : ""}${decadeChange.toFixed(dp)} ${unit}/decade`
            : ""),
        footer: figureFooter(
          exportContext,
          trend && trend.r2 < 0.15 ? "weak fit — read the bars, not the line" : undefined
        ),
        // The bar colours are diverging around the period mean, which is
        // meaningless without the poles named — and "wetter/drier" is wrong for
        // most variables, so the words come from the same definition the
        // on-screen legend uses.
        legend: [
          { label: def.low, varName: def.warmIsHigh ? "--div-cool" : "--div-warm", kind: "band" as const },
          { label: def.high, varName: def.warmIsHigh ? "--div-warm" : "--div-cool", kind: "band" as const },
          { label: "Trend", varName: "--text-primary", kind: "dash" as const },
        ],
      },
      filename: `${slug(
        exportContext?.placeName ?? "texas",
        `annual ${def.label}`,
        exportContext?.sourceId,
        today()
      )}.png`,
    };
  }
  const warmPole = "var(--div-warm)";
  const coolPole = "var(--div-cool)";

  function barColor(anomaly: number): string {
    const high = anomaly >= 0;
    if (def.warmIsHigh) return high ? warmPole : coolPole;
    return high ? coolPole : warmPole;
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Year-by-year trend</h2>
        <span className="badge">
          {def.label} · {unit}
        </span>
        {/* Headline figures sit beside the title instead of in their own tile
            row — same information, one less band of vertical space. */}
        {trend && (
          <div className="head-stats">
            <div className="head-stat">
              <span className="hk">Change per decade</span>
              <span className="hv" style={{ color: barColor(decadeChange ?? 0) }}>
                {decadeChange !== null && decadeChange >= 0 ? "+" : ""}
                {decadeChange?.toFixed(dp)} {unit}
              </span>
            </div>
            <div className="head-stat">
              {/* The actual number of bars, not the window setting. With a
                  30-year window but only 9 years of satellite water data,
                  "30-year average" would be plainly untrue. */}
              <span className="hk">{data.length}-year average</span>
              <span className="hv">
                {mean.toFixed(dp)} {unit}
              </span>
            </div>
          </div>
        )}
      </div>
      <p className="card-sub">
        One bar per completed year, colored by how far it sat from the {data.length}-year average.
        {trend && trend.r2 < 0.15 ? (
          <>
            {" "}
            The dashed trend line is <strong>weak here</strong> — the swing between years is far
            bigger than the long-term drift, so read the bars, not the line.
          </>
        ) : (
          <> The dashed line is the long-term trend.</>
        )}
      </p>

      <div className="controls">
        <div className="field">
          <label htmlFor="agg-select">Measure</label>
          <select
            id="agg-select"
            value={field}
            onChange={(e) => onFieldChange(e.target.value as Field)}
          >
            {AGGREGATES.map((a) => (
              <option key={a.field} value={a.field}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Trend window</label>
          <div className="seg">
            {TREND_WINDOWS.map((w) => (
              <button key={w} aria-pressed={window === w} onClick={() => setWindow(w)}>
                {w} yr
              </button>
            ))}
          </div>
        </div>
        <div className="field" style={{ marginLeft: "auto" }}>
          <label>&nbsp;</label>
          <button onClick={() => setShowTable((s) => !s)} aria-pressed={showTable}>
            {showTable ? "Hide table" : "Show table"}
          </button>
        </div>

        <ChartExport chartRef={chartRef} buildCsv={csvForChart} buildFigure={figureForChart} />
      </div>

      {isWaterField && waterLoading && (
        <div className="small" style={{ marginBottom: 8, color: "var(--text-secondary)" }}>
          <span className="mini-spinner" style={{ marginRight: 6, verticalAlign: "-1px" }} />
          Loading water data…
        </div>
      )}

      {isWaterField && !waterLoading && data.length === 0 && (
        <div className="small" style={{ marginBottom: 8, color: "var(--text-secondary)" }}>
          No complete years of water data at this spot yet.
        </div>
      )}

      <div className="chart-trend" ref={chartRef}>
        <ResponsiveContainer>
          <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="var(--gridline)" vertical={false} />
            <XAxis
              dataKey="year"
              tick={{ fill: "var(--text-muted)", fontSize: 11 }}
              axisLine={{ stroke: "var(--baseline)" }}
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={18}
            />
            <YAxis
              tick={{ fill: "var(--text-muted)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={52}
              domain={quantity === "temp" ? ["auto", "auto"] : [0, "auto"]}
              tickFormatter={(v: number) => v.toFixed(0)}
            />
            <ReferenceLine y={mean} stroke="var(--baseline)" strokeWidth={1} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {data.map((d) => (
                <Cell key={d.year} fill={barColor(d.anomaly)} />
              ))}
            </Bar>
            <Line
              dataKey="fit"
              stroke="var(--text-primary)"
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
              activeDot={false}
            />
            <Tooltip
              cursor={{ fill: "color-mix(in srgb, var(--text-muted) 12%, transparent)" }}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              content={({ active, payload }: any) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload;
                return (
                  <div className="tt">
                    <div className="tt-h">{d.year}</div>
                    <div className="tt-row">
                      <span className="lbl">
                        <span className="swatch" style={{ background: barColor(d.anomaly) }} />
                        {def.label}
                      </span>
                      <span className="val">
                        {d.value.toFixed(dp)} {unit}
                      </span>
                    </div>
                    <div className="tt-row">
                      <span className="lbl">vs {data.length}-yr avg</span>
                      <span className="val">
                        {d.anomaly >= 0 ? "+" : ""}
                        {d.anomaly.toFixed(dp)} {unit}
                      </span>
                    </div>
                  </div>
                );
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="chip-row" style={{ marginTop: 10 }}>
        <span className="small muted">
          <span
            className="swatch"
            style={{
              background: def.warmIsHigh ? coolPole : warmPole,
              display: "inline-block",
              marginRight: 5,
            }}
          />
          {def.low}
        </span>
        <span className="small muted">
          <span
            className="swatch"
            style={{
              background: def.warmIsHigh ? warmPole : coolPole,
              display: "inline-block",
              marginRight: 5,
            }}
          />
          {def.high}
        </span>
        {excludedCurrent && (
          <span className="small muted">· {currentYear} excluded — season still in progress</span>
        )}
      </div>

      {droppedYears.length > 0 && (
        <div className="small" style={{ marginTop: 8, color: "var(--text-secondary)" }}>
          <strong>
            {droppedYears.length} year{droppedYears.length === 1 ? "" : "s"} not shown
          </strong>{" "}
          ({droppedYears.join(", ")}) —{" "}
          {isWaterField ? (
            <>
              satellite water data doesn&apos;t cover the whole of{" "}
              {droppedYears.length === 1 ? "that year" : "those years"}, so there is no real annual
              total. Years before {OPENET_FIRST_FULL_YEAR} have no satellite data at all and are
              simply absent.
            </>
          ) : (
            <>
              the weather station missed too many days that year to give a real annual total.
              Switching to a gridded source will fill those gaps.
            </>
          )}
        </div>
      )}

      {showTable && (
        <div className="table-wrap" style={{ maxHeight: 300, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Year</th>
                <th>{def.label} ({unit})</th>
                <th>vs average</th>
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((d) => (
                <tr key={d.year}>
                  <td>{d.year}</td>
                  <td>{d.value.toFixed(dp)}</td>
                  <td style={{ color: barColor(d.anomaly) }}>
                    {d.anomaly >= 0 ? "+" : ""}
                    {d.anomaly.toFixed(dp)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
