/**
 * Trim a converted value back to the precision the instrument actually had.
 *
 * WHY THIS EXISTS
 * Unit conversions manufacture digits. Earth Engine serves gridMET temperature
 * in Kelvin, and subtracting 273.15 turns a value stored at 0.1 degC precision
 * into `19.749993896484398` — eighteen characters asserting a precision of
 * 10^-15 degC. The same happens converting station readings from Fahrenheit:
 * `(f - 32) * 5 / 9` lands on 19.444444444444443.
 *
 * Three separate costs, and only the first is obvious:
 *
 *   1. SIZE. Measured on a real stored year: 52 KB, of which roughly half was
 *      trailing noise. That is cache space, and it is also ~1.4 MB of JSON sent
 *      to every visitor's browser for a 25-year series.
 *   2. HONESTY. This project's whole argument is that sources disagree and the
 *      grower should see the real numbers. Printing fifteen decimal places on a
 *      value known to one is the opposite of that.
 *   3. COMPARABILITY. Two sources agreeing to 0.1 degC should compare equal.
 *      Float noise makes them differ in the fifteenth place forever.
 *
 * WHAT IS SAFE TO ROUND
 * Two decimals is far below every source's real precision: gridMET is stored as
 * packed integers with a scale factor of 0.1, ASOS reports whole degrees F and
 * hundredths of an inch, Daymet publishes two decimals. Nothing measurable is
 * lost. Do NOT use this on a value that is genuinely finer than 0.01.
 */
export function q(v: number | null | undefined, dp = 2): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
