/**
 * Unit handling.
 *
 * Internally everything is metric (degC, mm). A Texas grower thinks in degF and
 * inches. Conversion happens here and only at render time — never in storage,
 * never before a statistic is computed.
 */

export type UnitSystem = "imperial" | "metric";

export const cToF = (c: number): number => c * 9 / 5 + 32;
/**
 * The inverse, for the one place a reader types a temperature IN rather than
 * reading one out: their own growing-degree-day base.
 *
 * Everything internal is Celsius, so a typed value has to come back to it
 * immediately. Storing what they typed and remembering which unit it was in
 * would mean a base of 50 silently becoming 50 degC the moment somebody
 * flipped the units toggle.
 */
export const fToC = (f: number): number => (f - 32) * 5 / 9;
/** For DIFFERENCES and GDD, not absolute temperatures — no 32 offset. */
export const cDeltaToF = (c: number): number => c * 9 / 5;
export const mmToIn = (mm: number): number => mm / 25.4;
export const msToMph = (ms: number): number => ms * 2.236936;

export type Quantity = "temp" | "tempDelta" | "precip" | "gdd" | "wind" | "srad" | "rh";

export function convert(value: number, q: Quantity, sys: UnitSystem): number {
  if (sys === "metric") return value;
  switch (q) {
    case "temp":
      return cToF(value);
    case "tempDelta":
    case "gdd":
      return cDeltaToF(value);
    case "precip":
      return mmToIn(value);
    case "wind":
      return msToMph(value);
    default:
      return value;
  }
}

export function unitLabel(q: Quantity, sys: UnitSystem): string {
  if (sys === "metric") {
    switch (q) {
      case "temp":
      case "tempDelta":
        return "°C";
      case "gdd":
        return "GDD °C";
      case "precip":
        return "mm";
      case "wind":
        return "m/s";
      case "srad":
        return "MJ/m²";
      case "rh":
        return "%";
    }
  }
  switch (q) {
    case "temp":
    case "tempDelta":
      return "°F";
    case "gdd":
      return "GDD °F";
    case "precip":
      return "in";
    case "wind":
      return "mph";
    case "srad":
      return "MJ/m²";
    case "rh":
      return "%";
  }
}

/** Sensible decimal places per quantity so tooltips don't read 3.4000000001. */
export function decimals(q: Quantity, sys: UnitSystem): number {
  if (q === "precip") return sys === "imperial" ? 2 : 1;
  if (q === "gdd") return 0;
  return 1;
}

export function fmt(value: number | null | undefined, q: Quantity, sys: UnitSystem): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return convert(value, q, sys).toFixed(decimals(q, sys));
}

export function fmtWithUnit(
  value: number | null | undefined,
  q: Quantity,
  sys: UnitSystem
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${fmt(value, q, sys)} ${unitLabel(q, sys)}`;
}
