"use client";

import type { UnitSystem } from "@/lib/agro/units";
import { convert, unitLabel } from "@/lib/agro/units";
import type { NWSForecast } from "@/lib/sources/nws";
import type { ExtendedForecastDay } from "@/lib/sources/openmeteo";
import type { OutlookResult } from "@/lib/sources/cpc";
import { formatForecastDay } from "@/lib/format/date";
import {
  SkyIcon,
  WetIcon,
  skyFromPhrase,
  skyFromCode,
  phraseFromCode,
  type Sky,
  type Wet,
} from "./WeatherIcon";

/**
 * Three forecast tiers, kept visibly separate.
 *
 * Merging them into one 30-day curve would imply the day-25 number deserves the
 * same weight as the day-2 number. It does not. The confidence label on each
 * tier is the point of the component, not decoration.
 *
 * LAYOUT: one strip per tier, each tier on a single row.
 *
 * The tiles used to be a wrapping grid, which put seven days across two ragged
 * lines with a half-empty second row, and made the three tiers hard to tell
 * apart because they all ran together as one field of boxes. A tier is a
 * SEQUENCE — day 1 through day 7 — and a sequence belongs on one line. Each
 * strip scrolls sideways inside itself on a narrow screen rather than wrapping,
 * so the reading order never breaks.
 */

/**
 * How far to trust this tier, drawn rather than only named.
 *
 * The three tiers are already labelled "High / Medium / Low confidence", but a
 * word is easy to skim past and gives no sense of the GAP between them. A bar
 * shows at a glance that days 8-16 are not a slightly-worse version of days 1-7
 * — they are a different kind of claim, and the weeks 2-4 outlook is different
 * again.
 *
 * The widths are a deliberate visual ranking, not a computed skill score. No
 * such score is published per location by these three providers, and inventing
 * a precise-looking percentage would be exactly the false confidence this
 * component exists to prevent.
 */
function ConfidenceBar({ level }: { level: "high" | "medium" | "low" }) {
  const width = level === "high" ? "88%" : level === "medium" ? "52%" : "26%";
  const color =
    level === "high" ? "var(--good)" : level === "medium" ? "var(--warning)" : "var(--text-muted)";
  return (
    <div className="conf-bar" aria-hidden="true">
      <i style={{ width, background: color }} />
    </div>
  );
}

export interface ForecastPayload {
  tiers: {
    short: { label: string; confidence: string; provider: string; data: NWSForecast | null; error: string | null };
    extended: { label: string; confidence: string; provider: string; data: ExtendedForecastDay[] | null; error: string | null };
    outlook: { label: string; confidence: string; provider: string; note?: string; data: OutlookResult[] | null; error: string | null };
  };
}

interface Props {
  forecast: ForecastPayload | null;
  loading: boolean;
  units: UnitSystem;
}

/** NWS issues Fahrenheit for US offices; normalise before display. */
function nwsTemp(value: number, fromUnit: string, units: UnitSystem): number {
  const celsius = fromUnit.toUpperCase() === "F" ? ((value - 32) * 5) / 9 : value;
  return Math.round(convert(celsius, "temp", units));
}

function tercileColor(t: OutlookResult["tercile"], isTemp: boolean): string {
  if (t === "near") return "var(--text-muted)";
  if (isTemp) return t === "above" ? "var(--div-warm)" : "var(--div-cool)";
  return t === "above" ? "var(--div-cool)" : "var(--div-warm)";
}

/**
 * One day, laid out the way a phone weather app lays it out.
 *
 * Sky and temperature on the left, water on the right. Two questions, two
 * halves — a grower asks "how hot" and "will it rain" separately, and a single
 * combined glyph makes one of them win. A sunny day carrying a 40% afternoon
 * storm is the commonest Texas summer day there is, and it needs both.
 */
function DayTile({
  day,
  sky,
  wet,
  phrase,
  temp,
  tempLow,
  unit,
  chance,
  amount,
  title,
}: {
  day: string;
  sky: Sky;
  wet: Wet;
  phrase: string;
  temp: string;
  tempLow?: string;
  unit: string;
  /** Percent chance of precipitation, or null when the provider gives none. */
  chance: number | null;
  /** Forecast amount with its unit, days 8-16 only. */
  amount?: string | null;
  title?: string;
}) {
  return (
    <div className="fc-day" title={title}>
      <div className="fc-when">{day}</div>
      <div className="fc-body">
        <div className="fc-half">
          <SkyIcon
            sky={sky}
            size={20}
            warm="var(--warning)"
            cool="var(--div-cool)"
            neutral="var(--text-secondary)"
          />
          {/*
            High, then low, then the unit ONCE at the end. Written as
            "99 °F / 78" the unit landed in the middle of a pair and the low
            ran straight into the rain figure beside it; "99/78 °F" is both
            shorter and reads as one temperature range.
          */}
          <span className="fc-temp">
            {temp}
            {tempLow !== undefined && <span className="fc-low">/{tempLow}</span>}
            <span className="fc-unit">{unit}</span>
          </span>
        </div>
        <div className="fc-half fc-wet">
          {/* Nothing is drawn when nothing is expected. A 0% droplet on every
              dry day is noise that trains the eye to skip the column, and the
              column is where the useful number lives. */}
          {chance !== null && chance > 0 ? (
            <>
              <WetIcon
                wet={wet === "none" ? "rain" : wet}
                size={13}
                cool="var(--div-cool)"
                warm="var(--warning)"
              />
              <span className="fc-chance">{chance}%</span>
            </>
          ) : amount ? (
            <>
              <WetIcon
                wet={wet === "none" ? "rain" : wet}
                size={13}
                cool="var(--div-cool)"
                warm="var(--warning)"
              />
              <span className="fc-chance">{amount}</span>
            </>
          ) : (
            <span className="fc-dry">—</span>
          )}
        </div>
      </div>
      <div className="fc-phrase">{phrase}</div>
    </div>
  );
}

export default function ForecastStrip({ forecast, loading, units }: Props) {
  if (loading) {
    return (
      <div className="card">
        <h2>Forecast for next month</h2>
        <div className="skeleton" style={{ height: 100, marginTop: 12 }} />
      </div>
    );
  }
  if (!forecast) return null;

  const { short, extended, outlook } = forecast.tiers;
  const dayPeriods = short.data?.periods.filter((p) => p.isDaytime) ?? [];
  // Open-Meteo days 1-7 duplicate NWS; show only the part NWS cannot cover.
  const extDays = (extended.data ?? []).slice(7);
  const tUnit = unitLabel("temp", units);
  const pUnit = unitLabel("precip", units);

  return (
    <div className="card">
      <div className="card-head">
        <h2>Forecast for next month</h2>
      </div>

      {/* Tier 1 - NWS */}
      <div className="fc-tier">
        <div className="fc-head">
          <h3>{short.label}</h3>
          <span
            className="badge"
            style={{
              background: "color-mix(in srgb, var(--good) 18%, transparent)",
              color: "var(--text-secondary)",
            }}
          >
            High confidence
          </span>
        </div>
        <ConfidenceBar level="high" />
        {short.error ? (
          <div className="note error">
            <span>!</span>
            <span>NWS unavailable: {short.error}</span>
          </div>
        ) : (
          <div className="fc-strip" style={{ ["--fc-n" as string]: dayPeriods.length }}>
            {dayPeriods.map((p) => {
              const { sky, wet } = skyFromPhrase(p.shortForecast);
              return (
                <DayTile
                  key={p.number}
                  day={p.name}
                  sky={sky}
                  wet={wet}
                  phrase={p.shortForecast}
                  temp={String(nwsTemp(p.temperature, p.temperatureUnit, units))}
                  unit={tUnit}
                  chance={p.precipProb}
                  title={p.detailedForecast}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Tier 2 - extended */}
      <div className="fc-tier">
        <div className="fc-head">
          <h3>{extended.label}</h3>
          <span
            className="badge"
            style={{
              background: "color-mix(in srgb, var(--warning) 22%, transparent)",
              color: "var(--text-secondary)",
            }}
          >
            Moderate confidence
          </span>
        </div>
        <ConfidenceBar level="medium" />
        {extended.error ? (
          <div className="note error">
            <span>!</span>
            <span>Extended forecast unavailable: {extended.error}</span>
          </div>
        ) : (
          <div className="fc-strip" style={{ ["--fc-n" as string]: extDays.length }}>
            {extDays.map((d) => {
              const { sky, wet } = skyFromCode(d.weatherCode);
              return (
                <DayTile
                  key={d.date}
                  day={formatForecastDay(d.date)}
                  sky={sky}
                  wet={wet}
                  phrase={phraseFromCode(d.weatherCode)}
                  temp={d.tmax !== null ? String(Math.round(convert(d.tmax, "temp", units))) : "—"}
                  tempLow={
                    d.tmin !== null ? String(Math.round(convert(d.tmin, "temp", units))) : "—"
                  }
                  unit={tUnit}
                  chance={d.precipProb}
                  amount={
                    d.precip !== null && d.precip > 0
                      ? `${convert(d.precip, "precip", units).toFixed(
                          units === "imperial" ? 2 : 1
                        )} ${pUnit}`
                      : null
                  }
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Tier 3 - CPC outlooks */}
      <div className="fc-tier">
        <div className="fc-head">
          <h3>{outlook.label}</h3>
          <span className="badge">Probabilistic</span>
        </div>
        <ConfidenceBar level="low" />
        {outlook.error ? (
          <div className="note error">
            <span>!</span>
            <span>CPC outlook unavailable: {outlook.error}</span>
          </div>
        ) : !outlook.data?.length ? (
          <div className="small muted">No CPC outlook covers this point right now.</div>
        ) : (
          <>
            <div className="fc-strip" style={{ ["--fc-n" as string]: outlook.data.length }}>
              {outlook.data.map((o) => {
                const isTemp = o.product.includes("temp");
                const equal = o.raw.startsWith("Equal");
                return (
                  <div className="fc-day fc-outlook" key={o.product}>
                    <div className="fc-when">{o.label}</div>
                    <div
                      className="fc-tercile"
                      style={{ color: tercileColor(o.tercile, isTemp) }}
                    >
                      {o.tercile === "near"
                        ? "Near normal"
                        : o.tercile === "above"
                        ? "Above normal"
                        : "Below normal"}
                    </div>
                    <div className="fc-phrase">
                      {equal ? "Odds not tilted" : `${o.probability.toFixed(0)}% odds`}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="small muted" style={{ marginTop: 8 }}>
              These are odds, not amounts. &ldquo;60% chance of above normal&rdquo; means the odds
              are tilted that way &mdash; it is not a prediction of how much.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
