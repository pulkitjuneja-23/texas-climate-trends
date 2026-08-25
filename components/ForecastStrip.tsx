"use client";

import type { UnitSystem } from "@/lib/agro/units";
import { convert, unitLabel } from "@/lib/agro/units";
import type { NWSForecast } from "@/lib/sources/nws";
import type { ExtendedForecastDay } from "@/lib/sources/openmeteo";
import type { OutlookResult } from "@/lib/sources/cpc";

/**
 * Three forecast tiers, kept visibly separate.
 *
 * Merging them into one 30-day curve would imply the day-25 number deserves the
 * same weight as the day-2 number. It does not. The confidence label on each
 * tier is the point of the component, not decoration.
 */

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
function nwsTemp(value: number, fromUnit: string, units: UnitSystem): string {
  const celsius = fromUnit.toUpperCase() === "F" ? ((value - 32) * 5) / 9 : value;
  return `${Math.round(convert(celsius, "temp", units))}°`;
}

function dayName(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });
}

function tercileColor(t: OutlookResult["tercile"], isTemp: boolean): string {
  if (t === "near") return "var(--text-muted)";
  if (isTemp) return t === "above" ? "var(--div-warm)" : "var(--div-cool)";
  return t === "above" ? "var(--div-cool)" : "var(--div-warm)";
}

export default function ForecastStrip({ forecast, loading, units }: Props) {
  if (loading) {
    return (
      <div className="card">
        <h2>Next month prediction</h2>
        <div className="skeleton" style={{ height: 100, marginTop: 12 }} />
      </div>
    );
  }
  if (!forecast) return null;

  const { short, extended, outlook } = forecast.tiers;
  const dayPeriods = short.data?.periods.filter((p) => p.isDaytime) ?? [];
  // Open-Meteo days 1-7 duplicate NWS; show only the part NWS cannot cover.
  const extDays = (extended.data ?? []).slice(7);

  return (
    <div className="card">
      <div className="card-head">
        <h2>Next month prediction</h2>
      </div>
      {/* Tier 1 - NWS */}
      <div style={{ marginBottom: 12, marginTop: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
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
        {short.error ? (
          <div className="note error">
            <span>!</span>
            <span>NWS unavailable: {short.error}</span>
          </div>
        ) : (
          <div className="tiles compact">
            {dayPeriods.map((p) => (
              <div className="tile" key={p.number} title={p.detailedForecast}>
                <div className="k">{p.name}</div>
                <div className="v">{nwsTemp(p.temperature, p.temperatureUnit, units)}</div>
                <div className="d">
                  {p.shortForecast}
                  {p.precipProb !== null && p.precipProb > 0 && (
                    <>
                      {" · "}
                      <strong>{p.precipProb}%</strong> rain
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tier 2 - extended */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
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
        {extended.error ? (
          <div className="note error">
            <span>!</span>
            <span>Extended forecast unavailable: {extended.error}</span>
          </div>
        ) : (
          <div className="tiles compact">
            {extDays.map((d) => (
              <div className="tile" key={d.date}>
                <div className="k">{dayName(d.date)}</div>
                <div className="v">
                  {d.tmax !== null ? Math.round(convert(d.tmax, "temp", units)) : "—"}
                  {"°"}
                  <span className="muted" style={{ fontSize: "0.85rem", fontWeight: 500 }}>
                    {" / "}
                    {d.tmin !== null ? Math.round(convert(d.tmin, "temp", units)) : "—"}
                    {"°"}
                  </span>
                </div>
                <div className="d">
                  {d.precip !== null
                    ? `${convert(d.precip, "precip", units).toFixed(
                        units === "imperial" ? 2 : 1
                      )} ${unitLabel("precip", units)}`
                    : "—"}
                  {d.precipProb !== null && d.precipProb > 0 && ` · ${d.precipProb}%`}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tier 3 - CPC outlooks */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
          <h3>{outlook.label}</h3>
          <span className="badge">Probabilistic</span>
        </div>
        {outlook.error ? (
          <div className="note error">
            <span>!</span>
            <span>CPC outlook unavailable: {outlook.error}</span>
          </div>
        ) : !outlook.data?.length ? (
          <div className="small muted">No CPC outlook covers this point right now.</div>
        ) : (
          <>
            <div className="tiles compact">
              {outlook.data.map((o) => {
                const isTemp = o.product.includes("temp");
                return (
                  <div className="tile" key={o.product}>
                    <div className="k">{o.label}</div>
                    <div
                      className="v"
                      style={{ color: tercileColor(o.tercile, isTemp), fontSize: "0.95rem" }}
                    >
                      {o.tercile === "near"
                        ? "Near normal"
                        : o.tercile === "above"
                        ? "Above normal"
                        : "Below normal"}
                    </div>
                    <div className="d">
                      {o.raw.startsWith("Equal")
                        ? "Odds not tilted"
                        : `${o.probability.toFixed(0)}% odds`}
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
