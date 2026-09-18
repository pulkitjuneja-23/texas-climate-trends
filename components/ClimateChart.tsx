"use client";

import { useMemo, useRef, useState } from "react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import type { DailyRecord } from "@/lib/types";
import {
  DOY_KEYS,
  alignByYear,
  dailyClimatology,
  accumClimatology,
  accumulate,
  hasLongGap,
  startsWithin,
  type Field,
  type DayStat,
  type YearSeries,
} from "@/lib/agro/climatology";
import { type GddConfig } from "@/lib/agro/gdd";
import { convert, unitLabel, decimals, type Quantity, type UnitSystem } from "@/lib/agro/units";
import ChartExport from "./ChartExport";
import { buildCsv, slug } from "@/lib/export/csv";
import { csvHeader, figureFooter, today, type ExportContext } from "@/lib/export/context";
import { formatDate } from "@/lib/format/date";

/**
 * The main view: one calendar year on the x-axis, the 30-year normal drawn as a
 * distribution band behind it, and any years you pick drawn on top.
 *
 * Design decisions that matter agronomically:
 *
 *  - The band is NEUTRAL GRAY, not a color. It is context, not a series. Giving
 *    it a hue would make "normal" compete with the years you actually chose.
 *
 *  - Precipitation and GDD default to SEASON-TO-DATE ACCUMULATION, not daily
 *    values. A daily-rainfall normal is a nearly meaningless number (the mean of
 *    mostly zeros); the accumulated curve is what a grower actually reasons
 *    about — am I ahead or behind on moisture.
 *
 *  - Every series gets a direct end-label. Three of the five categorical hues
 *    sit under 3:1 on the light surface, and the validator's contrast WARN
 *    obligates relief — labels plus the table view are that relief.
 */

/**
 * Five comparison colours, not four.
 *
 * The fifth (`--series-6`, violet) exists because the analog panel finds five
 * matches and the plot button silently dropped one of them — a palette limit
 * showing through as a missing finding. The five matches ARE the spread, and
 * the spread is what that panel is for.
 *
 * NOTE FOR ANY FUTURE PALETTE WORK: slots 1-5 are the validated data-viz
 * instance; slot 6 was added here and contrast-checked by hand (4.6:1 on the
 * light surface, 5.4:1 on the dark one) but has not been through the validator.
 * Violet is also the slot most easily confused with the blue current-year line
 * for a colour-blind reader — the existing relief covers it, which is precisely
 * why the direct end-labels and the table view are not optional.
 */
const SERIES_VARS = [
  "--series-2",
  "--series-3",
  "--series-4",
  "--series-5",
  "--series-6",
];
const CURRENT_VAR = "--series-1";
const MAX_COMPARE = 5;

export type ViewMode = "daily" | "accumulated";

const VARIABLES: Array<{
  field: Field;
  label: string;
  quantity: Quantity;
  defaultMode: ViewMode;
  accumulable: boolean;
  /** One line under the chart when the sign needs explaining. */
  hint?: string;
}> = [
  { field: "tmax", label: "Daily high temp", quantity: "temp", defaultMode: "daily", accumulable: false },
  { field: "tmin", label: "Daily low temp", quantity: "temp", defaultMode: "daily", accumulable: false },
  { field: "tmean", label: "Daily mean temp", quantity: "temp", defaultMode: "daily", accumulable: false },
  { field: "precip", label: "Rainfall", quantity: "precip", defaultMode: "accumulated", accumulable: true },
  { field: "gdd", label: "Growing degree days", quantity: "gdd", defaultMode: "accumulated", accumulable: true },
  /**
   * Day-night swing. `tempDelta`, never `temp` — it is a difference, so it
   * converts by ratio alone with no +32 offset.
   */
  { field: "dtr", label: "Temperature swing (high − low)", quantity: "tempDelta", defaultMode: "daily", accumulable: false, hint: "The day's high minus its low — how far the temperature falls overnight. Warm nights make a crop burn through the sugars it made during the day, so a bigger swing generally favours grain fill and fibre quality. A shrinking swing usually means cloud or humidity — and longer leaf wetness." },
  // Water variables share the same axis but only exist from late 2015, so
  // earlier years simply draw nothing rather than sitting at zero.
  { field: "et", label: "Water used (ET)", quantity: "precip", defaultMode: "accumulated", accumulable: true },
  { field: "balance", label: "Water balance (rain − ET)", quantity: "precip", defaultMode: "accumulated", accumulable: true, hint: "Above zero: more rain than the crop used. Below zero: the crop used more than it rained." },
  // Reference ET covers the full record, so it has no late start.
  { field: "eto", label: "Water demand (reference ET)", quantity: "precip", defaultMode: "accumulated", accumulable: true },
];

/**
 * Variables that need OpenET, which only exists from late 2015. Reference ET is
 * NOT in this list — it comes from gridMET and covers the whole record.
 *
 * These are also the variables whose SOURCE data is monthly. OpenET publishes a
 * single figure per month; the daily values used elsewhere are that figure
 * divided across the month's days. So a "day by day" view of them would show a
 * flat line that implies a precision the data does not have — hence the second
 * view is labelled and rendered as MONTHLY for these fields.
 */
export const WATER_FIELDS: Field[] = ["et", "balance"];

/** Grouped month-by-month so a monthly source is never shown as if it were daily. */
const MONTH_INDICES: number[][] = (() => {
  const groups: number[][] = Array.from({ length: 12 }, () => []);
  DOY_KEYS.forEach((k, i) => groups[Number(k.slice(0, 2)) - 1].push(i));
  return groups;
})();

/**
 * Collapse a year to monthly totals, written back across every day of each
 * month so the existing 366-row chart machinery can draw it as a step.
 * Summing the prorated daily values recovers OpenET's original monthly figure
 * exactly.
 */
function toMonthlyTotals(ys: YearSeries): YearSeries {
  const out = new Array<number | null>(DOY_KEYS.length).fill(null);
  for (const idxs of MONTH_INDICES) {
    let sum = 0;
    let any = false;
    for (const i of idxs) {
      const v = ys.values[i];
      if (v !== null && Number.isFinite(v)) {
        sum += v;
        any = true;
      }
    }
    if (any) for (const i of idxs) out[i] = sum;
  }
  return { year: ys.year, values: out };
}

const MONTH_TICKS = [
  "01-01", "02-01", "03-01", "04-01", "05-01", "06-01",
  "07-01", "08-01", "09-01", "10-01", "11-01", "12-01",
];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Props {
  records: DailyRecord[];
  field: Field;
  onFieldChange: (f: Field) => void;
  mode: ViewMode;
  onModeChange: (m: ViewMode) => void;
  compareYears: number[];
  onCompareChange: (years: number[]) => void;
  currentYear: number;
  availableYears: number[];
  units: UnitSystem;
  gddConfig: GddConfig;
  smoothing: number;
  lastObserved: string | null;
  /**
   * Which crop the GDD base belongs to, and how to change it.
   *
   * Passed in so the crop can be named in the variable label and offered right
   * beside the chart when GDD is selected — a user could not tell what crop the
   * degree days were for, which is the one thing that makes them mean anything.
   */
  gddPresetKey?: string;
  gddPresets?: Record<string, { label: string; short: string }>;
  onGddPresetChange?: (key: string) => void;
  /** Provenance for the CSV and figure exports — a chart that leaves the app
   *  without naming its source undercuts the whole argument for the picker. */
  exportContext?: ExportContext;
  /** Status of the separately-loaded water data, for the ET/balance variables. */
  waterStatus?: {
    loading: boolean;
    available: boolean;
    reason?: string;
    /** Months in the current year OpenET could not produce, e.g. ["2026-04"]. */
    missingMonths?: string[];
  };
}

interface Row {
  key: string;
  label: string;
  /** 25th-75th percentile — the only band drawn. */
  band50?: [number, number];
  normal?: number | null;
  [series: string]: unknown;
}

function keyToLabel(key: string): string {
  const [mm, dd] = key.split("-");
  return `${MONTH_NAMES[Number(mm) - 1]} ${Number(dd)}`;
}

export default function ClimateChart(props: Props) {
  const {
    records, field, onFieldChange, mode, onModeChange,
    compareYears, onCompareChange, currentYear, availableYears,
    units, gddConfig, smoothing, lastObserved, waterStatus, exportContext,
    gddPresetKey, gddPresets, onGddPresetChange,
  } = props;

  const chartRef = useRef<HTMLDivElement>(null);

  const isWaterField = WATER_FIELDS.includes(field);
  /** True when the underlying data is published monthly, not daily. */
  const isMonthlySource = isWaterField;

  const [showTable, setShowTable] = useState(false);

  const varDef = VARIABLES.find((v) => v.field === field) ?? VARIABLES[0];

  /**
   * Growing degree days are named with their crop everywhere they appear.
   *
   * "Growing degree days" alone is an unanswerable number — 5,700 of them means
   * nothing until you know the base temperature, which is really a crop. A user
   * hit exactly this and had to hunt for the setting.
   */
  const gddCrop = gddPresetKey && gddPresets ? gddPresets[gddPresetKey]?.short : null;
  const varLabel =
    varDef.field === "gdd" && gddCrop ? `${varDef.label} — ${gddCrop}` : varDef.label;
  const quantity = varDef.quantity;
  const effectiveMode: ViewMode = varDef.accumulable ? mode : "daily";

  const {
    rows,
    stats,
    seriesYears,
    excludedFromBand,
    bandYearCount,
    bandFirstYear,
    bandLastYear,
  } = useMemo(() => {
    const series = alignByYear(records, field, gddConfig);
    // Normals exclude the in-progress year — a partial year would drag the
    // late-season normals toward whatever the current season has done so far.
    const baseline = series.filter((s) => s.year < currentYear);

    /**
     * OpenET drops whole months when cloud defeats its interpolation, so an
     * accumulated water curve must stop at a real gap rather than coast through
     * it. Weather variables are daily-complete apart from 29 February, which
     * must still carry forward — hence the two different tolerances.
     */
    const maxGap = WATER_FIELDS.includes(field) ? 5 : Infinity;

    /**
     * Years predating OpenET are not "excluded" — they simply have no data and
     * saying so would alarm rather than inform. Only years that HAVE data but
     * were rejected as incomplete are worth reporting.
     */
    const yearsWithData = baseline.filter((s) => s.values.some((v) => v !== null));

    // Years with a month-long hole, or a partial first year, are kept out of
    // the band entirely rather than allowed to terminate partway — which would
    // make "normal" step down wherever a year drops out of the pool.
    const bandYears =
      Number.isFinite(maxGap) && effectiveMode === "accumulated"
        ? yearsWithData.filter((s) => !hasLongGap(s, maxGap) && startsWithin(s, 0, maxGap))
        : baseline;

    // A monthly source shown "day by day" becomes monthly totals, unsmoothed —
    // a ±7-day window would bleed one month's figure into the next.
    const monthlyView = isMonthlySource && effectiveMode === "daily";

    const stats: DayStat[] =
      effectiveMode === "accumulated"
        ? accumClimatology(bandYears, 0, maxGap)
        : monthlyView
        ? dailyClimatology(
            baseline.filter((s) => s.values.some((v) => v !== null)).map(toMonthlyTotals),
            { window: 0 }
          )
        : dailyClimatology(baseline, { window: smoothing });

    const excludedFromBand = yearsWithData.length - bandYears.length;
    const bandYearCount = bandYears.length;
    const bandFirstYear = bandYears.length ? bandYears[0].year : null;
    const bandLastYear = bandYears.length ? bandYears[bandYears.length - 1].year : null;

    const byYear = new Map(series.map((s) => [s.year, s]));
    const shown = [currentYear, ...compareYears].filter((y) => byYear.has(y));

    const curves = new Map<number, (number | null)[]>();
    for (const y of shown) {
      const ys = byYear.get(y)!;
      curves.set(
        y,
        effectiveMode === "accumulated"
          ? accumulate(ys, 0, maxGap).values
          : monthlyView
          ? toMonthlyTotals(ys).values
          : ys.values
      );
    }

    const rows: Row[] = DOY_KEYS.map((key, i) => {
      const s = stats[i];
      const row: Row = {
        key,
        label: keyToLabel(key),
        normal: s.mean === null ? null : convert(s.mean, quantity, units),
        // p10/p90 are still computed by the climatology and remain available;
        // they are simply no longer drawn. Only the middle half is shown.
        band50:
          s.p25 !== null && s.p75 !== null
            ? [convert(s.p25, quantity, units), convert(s.p75, quantity, units)]
            : undefined,
      };
      for (const y of shown) {
        const v = curves.get(y)![i];
        row[`y${y}`] = v === null ? null : convert(v, quantity, units);
      }
      return row;
    });

    return {
      rows,
      stats,
      seriesYears: shown,
      excludedFromBand,
      bandYearCount,
      bandFirstYear,
      bandLastYear,
    };
  }, [records, field, effectiveMode, compareYears, currentYear, units, gddConfig, smoothing, quantity]);

  const unit = unitLabel(quantity, units);
  const dp = decimals(quantity, units);

  /**
   * Rounded to the same precision the chart shows.
   *
   * Deliberately not full float precision: the export is defined as "what is on
   * screen", and 19.049999999999997 in a spreadsheet implies a precision these
   * sources do not have. Empty for a gap, never 0 — a missing day and a dry day
   * are different facts.
   */
  const fmt = (v: number | null | undefined) =>
    typeof v === "number" && Number.isFinite(v) ? v.toFixed(dp) : "";

  const lastObservedKey = lastObserved ? lastObserved.slice(5, 10) : null;

  function colorFor(year: number, idx: number): string {
    if (year === currentYear) return `var(${CURRENT_VAR})`;
    return `var(${SERIES_VARS[(idx - 1) % SERIES_VARS.length]})`;
  }

  /**
   * The chart's data exactly as drawn: the same variable, units, view mode and
   * chosen years. Built at click time, never cached, so it cannot go stale.
   *
   * The normal and both percentile bands are included because they are what
   * makes a single year interpretable — a column of rainfall totals with no
   * sense of what is normal is the thing this whole app exists to replace.
   */
  const viewLabel =
    effectiveMode === "accumulated"
      ? "season-to-date accumulation"
      : isMonthlySource
      ? "monthly totals"
      : "day by day";

  function csvForChart() {
    const csv = buildCsv(
      rows,
      [
        { header: "month_day", value: (r) => r.key },
        { header: "date_label", value: (r) => r.label },
        // The long-term average and the years actually plotted, nothing else.
        // The percentile columns were dropped at the user's request: they made
        // the file wide and are trivially recomputed from the raw record by
        // anyone who wants them.
        { header: `long_term_average_${unit}`, value: (r) => fmt(r.normal) },
        ...seriesYears.map((y) => ({
          header: String(y),
          value: (r: Row) => fmt(r[`y${y}`] as number | null | undefined),
        })),
      ],
      csvHeader(exportContext, [
        `Chart: Season tracker — ${varLabel}`,
        `View: ${viewLabel}`,
        `Units: ${unit}`,
        `Normal band: ${bandYearCount} years` +
          (bandFirstYear && bandLastYear ? ` (${bandFirstYear}–${bandLastYear})` : "") +
          (excludedFromBand > 0 ? `, ${excludedFromBand} left out as incomplete` : ""),
        effectiveMode === "daily" && !isMonthlySource
          ? `Smoothing: ±${smoothing}-day window on the long-term average`
          : "Smoothing: none",
      ])
    );
    return {
      csv,
      filename: `${slug(
        exportContext?.placeName ?? "texas",
        varLabel,
        exportContext?.sourceId,
        today()
      )}.csv`,
    };
  }

  function figureForChart() {
    return {
      meta: {
        title: `Season tracker — ${varLabel}`,
        subtitle:
          `${exportContext?.placeName ? `${exportContext.placeName} · ` : ""}` +
          `${viewLabel} · ${unit} · normal from ${bandYearCount} years`,
        footer: figureFooter(exportContext, `as of ${formatDate(lastObserved)}`),
        // Redrawn because the on-screen legend is HTML outside the SVG. The
        // bands are the context that makes a single year readable, so a figure
        // without them explained is not self-contained.
        legend: [
          { label: "Middle half of years", varName: "--band-inner", kind: "band" as const },
          { label: "Average", varName: "--text-muted", kind: "dash" as const },
          // Same colour assignment as `colorFor`, so the legend cannot drift
          // from the lines it describes.
          ...seriesYears.map((y, i) => ({
            label: String(y),
            varName: y === currentYear ? CURRENT_VAR : SERIES_VARS[(i - 1) % SERIES_VARS.length],
            kind: "line" as const,
          })),
        ],
      },
      filename: `${slug(
        exportContext?.placeName ?? "texas",
        varLabel,
        exportContext?.sourceId,
        today()
      )}.png`,
    };
  }

  function toggleYear(y: number) {
    if (compareYears.includes(y)) {
      onCompareChange(compareYears.filter((x) => x !== y));
    } else if (compareYears.length < MAX_COMPARE) {
      onCompareChange([...compareYears, y]);
    }
  }

  /** Draws a series name at its last real point — the contrast relief. */
  function endLabel(seriesKey: string, year: number, idx: number) {
    let lastIdx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      const v = rows[i][seriesKey];
      if (typeof v === "number" && Number.isFinite(v)) {
        lastIdx = i;
        break;
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (p: any) => {
      if (p.index !== lastIdx) return <g key={`${seriesKey}-${p.index}`} />;
      // Always right of the endpoint — the chart reserves a right margin wide
      // enough for a 4-digit year, so this cannot overflow at any width.
      return (
        <g key={`${seriesKey}-lbl`}>
          <text
            x={p.x + 8}
            y={p.y}
            dy={4}
            textAnchor="start"
            fontSize={11}
            fontWeight={700}
            fill={colorFor(year, idx)}
            style={{ paintOrder: "stroke", stroke: "var(--surface)", strokeWidth: 3 }}
          >
            {year}
          </text>
        </g>
      );
    };
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Season tracker</h2>
        {/* Unit lives here rather than as a rotated axis label — at this axis
            width a rotated label collides with the tick values. */}
        <span className="badge">
          {varLabel}
          {effectiveMode === "accumulated"
            ? " · season to date"
            : isMonthlySource
            ? " · monthly total"
            : ""}{" "}
          · {unit}
        </span>
        <span className="badge">{records.length.toLocaleString()} days loaded</span>
      </div>
      <p className="card-sub">
        The dashed line is the {availableYears[0]}–{currentYear - 1} average for each calendar day
        at this point. The grey band is the middle half of those years — half of them ran inside it,
        a quarter above and a quarter below. Pick any year to draw on top.
      </p>

      <div className="controls">
        <div className="field">
          <label htmlFor="var-select">Variable</label>
          <select
            id="var-select"
            value={field}
            onChange={(e) => {
              const f = e.target.value as Field;
              onFieldChange(f);
              const def = VARIABLES.find((v) => v.field === f);
              if (def) onModeChange(def.defaultMode);
            }}
          >
            {VARIABLES.map((v) => (
              <option key={v.field} value={v.field}>
                {v.label}
              </option>
            ))}
          </select>
        </div>

        {varDef.accumulable && (
          <div className="field">
            <label>View</label>
            <div className="seg">
              <button
                aria-pressed={effectiveMode === "accumulated"}
                onClick={() => onModeChange("accumulated")}
              >
                Season to date
              </button>
              <button
                aria-pressed={effectiveMode === "daily"}
                onClick={() => onModeChange("daily")}
                title={
                  isMonthlySource
                    ? "This data is published once a month, so it is shown by month."
                    : undefined
                }
              >
                {isMonthlySource ? "Monthly" : "Day by day"}
              </button>
            </div>
          </div>
        )}

        {/*
          The crop appears NEXT TO the chart, only when growing degree days are
          being shown. It used to live in a settings row further down the page,
          and a user could not work out what crop the degree days were for —
          reasonably, since without a base temperature the number means nothing.
          Shown here it is unmissable, and hidden for every other variable so it
          does not clutter the row.
        */}
        {field === "gdd" && gddPresets && onGddPresetChange && (
          <div className="field">
            <label htmlFor="gdd-crop">Crop</label>
            <select
              id="gdd-crop"
              value={gddPresetKey}
              onChange={(e) => onGddPresetChange(e.target.value)}
            >
              {Object.entries(gddPresets).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="field" style={{ marginLeft: "auto" }}>
          <label>&nbsp;</label>
          <button onClick={() => setShowTable((s) => !s)} aria-pressed={showTable}>
            {showTable ? "Hide table" : "Show table"}
          </button>
        </div>

        <ChartExport
          chartRef={chartRef}
          buildCsv={csvForChart}
          buildFigure={figureForChart}
          chartId="season"
        />
      </div>

      <div className="field" style={{ marginBottom: 14 }}>
        <label>
          Compare years — pick up to {MAX_COMPARE}
          {compareYears.length >= MAX_COMPARE && (
            <span className="muted"> · limit reached, deselect one to add another</span>
          )}
        </label>
        <div className="chip-row">
          {availableYears
            .filter((y) => y !== currentYear)
            .slice()
            .reverse()
            .map((y) => {
              const on = compareYears.includes(y);
              const idx = compareYears.indexOf(y) + 1;
              return (
                <button
                  key={y}
                  className="chip"
                  aria-pressed={on}
                  onClick={() => toggleYear(y)}
                  disabled={!on && compareYears.length >= MAX_COMPARE}
                  style={on ? { color: colorFor(y, idx) } : undefined}
                >
                  {on && <span className="swatch" style={{ background: colorFor(y, idx) }} />}
                  {y}
                </button>
              );
            })}
        </div>
      </div>

      {isWaterField && waterStatus && (waterStatus.loading || !waterStatus.available) && (
        <div className="small" style={{ marginBottom: 10, color: "var(--text-secondary)" }}>
          {waterStatus.loading ? (
            <>
              <span className="mini-spinner" style={{ marginRight: 6, verticalAlign: "-1px" }} />
              Loading water-use data…
            </>
          ) : (
            <>
              <strong>Water-use data not available.</strong> {waterStatus.reason}
            </>
          )}
        </div>
      )}

      {isWaterField &&
        waterStatus?.available &&
        (waterStatus.missingMonths?.length ?? 0) > 0 && (
          <div className="small" style={{ marginBottom: 10, color: "var(--text-secondary)" }}>
            <strong>The {currentYear} line stops early.</strong> Satellite water-use data is
            missing for{" "}
            {waterStatus.missingMonths!
              .map((m) => MONTH_NAMES[Number(m.slice(5, 7)) - 1])
              .join(" and ")}
            {" "}— too much cloud that month for the models to produce a value. The season total
            can&apos;t be completed past that point, and carrying it through would understate
            water use.
          </div>
        )}

      <div className="chart-main" ref={chartRef}>
        <ResponsiveContainer>
          <ComposedChart data={rows} margin={{ top: 8, right: 52, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="var(--gridline)" vertical={false} />
            <XAxis
              dataKey="key"
              ticks={MONTH_TICKS}
              tickFormatter={(k: string) => MONTH_NAMES[Number(k.split("-")[0]) - 1]}
              tick={{ fill: "var(--text-muted)", fontSize: 11 }}
              axisLine={{ stroke: "var(--baseline)" }}
              tickLine={false}
              interval={0}
            />
            <YAxis
              tick={{ fill: "var(--text-muted)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={52}
              tickFormatter={(v: number) => v.toFixed(dp === 2 ? 1 : 0)}
            />

            {/*
              ONE band, the middle half (25th-75th percentile).

              Two nested bands asked the reader to hold two different
              probabilities at once and told them neither clearly — a user said
              plainly that the 50%/80% pair was confusing. There is no single
              industry convention here: Cornell's Climate Smart Farming tool
              shades the full record, NOAA defines "near normal" as the middle
              third, and box plots use the middle half. The middle half was
              chosen: it is the box-plot standard, it is the tightest honest
              summary of a typical year, and "half of all years sat in here" is
              a sentence that needs no further explanation.
            */}
            <Area
              dataKey="band50"
              stroke="none"
              fill="var(--band-inner)"
              fillOpacity={1}
              isAnimationActive={false}
              activeDot={false}
              legendType="none"
            />
            <Line
              dataKey="normal"
              stroke="var(--normal-line)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              isAnimationActive={false}
              activeDot={false}
            />

            {lastObservedKey && (
              <ReferenceLine
                x={lastObservedKey}
                stroke="var(--text-muted)"
                strokeDasharray="2 3"
                strokeWidth={1}
              />
            )}

            {seriesYears.map((y, i) => (
              <Line
                key={y}
                dataKey={`y${y}`}
                stroke={colorFor(y, i)}
                strokeWidth={y === currentYear ? 2.5 : 2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
                label={endLabel(`y${y}`, y, i)}
              />
            ))}

            <Tooltip
              cursor={{ stroke: "var(--text-muted)", strokeWidth: 1, strokeDasharray: "3 3" }}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              content={({ active, payload, label }: any) => {
                if (!active || !payload?.length) return null;
                const row = payload[0]?.payload as Row | undefined;
                if (!row) return null;
                return (
                  <div className="tt">
                    <div className="tt-h">{row.label}</div>
                    {seriesYears.map((y, i) => {
                      const v = row[`y${y}`];
                      if (typeof v !== "number") return null;
                      return (
                        <div className="tt-row" key={y}>
                          <span className="lbl">
                            <span className="swatch" style={{ background: colorFor(y, i) }} />
                            {y}
                          </span>
                          <span className="val">
                            {v.toFixed(dp)} {unit}
                          </span>
                        </div>
                      );
                    })}
                    <div
                      className="tt-row"
                      style={{ borderTop: "1px solid var(--gridline)", marginTop: 5, paddingTop: 5 }}
                    >
                      <span className="lbl">Normal</span>
                      <span className="val">
                        {typeof row.normal === "number" ? row.normal.toFixed(dp) : "—"} {unit}
                      </span>
                    </div>
                    {row.band50 && (
                      <div className="tt-row">
                        <span className="lbl">Middle half of years</span>
                        <span className="val">
                          {row.band50[0].toFixed(dp)}–{row.band50[1].toFixed(dp)}
                        </span>
                      </div>
                    )}
                  </div>
                );
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {varDef.hint && (
        <div className="small muted" style={{ marginTop: 8 }}>
          {varDef.hint}
        </div>
      )}

      <div className="chip-row" style={{ marginTop: 10, alignItems: "center" }}>
        <span className="small muted">
          <span
            className="swatch"
            style={{ background: "var(--band-inner)", display: "inline-block", marginRight: 5 }}
          />
          Middle half of years
        </span>
        <span className="small muted">— — Normal (mean)</span>
        {lastObservedKey && <span className="small muted">┆ Last observed day</span>}
        {isWaterField && bandYearCount > 0 && (
          <span className="small muted">
            · Normal from {bandYearCount} year{bandYearCount === 1 ? "" : "s"} ({bandFirstYear}–
            {bandLastYear})
            {excludedFromBand > 0 &&
              `, ${excludedFromBand} more left out as incomplete`}
          </span>
        )}
      </div>

      {showTable && (
        <div className="table-wrap" style={{ maxHeight: 340, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Average ({unit})</th>
                <th>25th</th>
                <th>75th</th>
                {seriesYears.map((y) => (
                  <th key={y}>{y}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows
                .filter((_, i) => i % 7 === 0)
                .map((r, i) => {
                  const s = stats[i * 7];
                  return (
                    <tr key={r.key}>
                      <td>{r.label}</td>
                      <td>{typeof r.normal === "number" ? r.normal.toFixed(dp) : "—"}</td>
                      <td>{r.band50 ? r.band50[0].toFixed(dp) : "—"}</td>
                      <td>{r.band50 ? r.band50[1].toFixed(dp) : "—"}</td>
                      {seriesYears.map((y) => {
                        const v = r[`y${y}`];
                        return (
                          <td key={y}>{typeof v === "number" ? v.toFixed(dp) : "—"}</td>
                        );
                      })}
                    </tr>
                  );
                })}
            </tbody>
          </table>
          <div className="small muted" style={{ padding: "8px 11px" }}>
            Every 7th day shown. {stats[0]?.n ?? 0} year-values pooled per normal
            {effectiveMode === "daily" ? ` (±${smoothing}-day window)` : ""}.
          </div>
        </div>
      )}
    </div>
  );
}
