/**
 * Constants that BOTH the browser and the server need.
 *
 * This file exists to keep a wall between them. The page is a client component
 * and needs to know the default source id — but importing that from
 * `registry.ts` drags in every source module, and gridMET now reaches Earth
 * Engine, which reaches `node:fs`. Webpack traced that chain into the browser
 * bundle and the build failed outright:
 *
 *   node:fs/promises -> lib/sources/earthengine.ts -> gridmet.ts
 *                    -> registry.ts -> app/page.tsx
 *
 * Nothing server-only may ever be imported from here. Keep it to plain values.
 */

/**
 * gridMET: 4 km, ~3 days behind, built on PRISM — the best data here.
 *
 * It was briefly demoted to NASA POWER while it took 73-131 s. Serving it
 * through Earth Engine as a single request brought that to ~14 s, and grid
 * snapping means most visits land on an already-cached cell, so it is fit to
 * lead again.
 */
export const DEFAULT_SOURCE_ID = "gridmet";

/**
 * First year of history the site asks for.
 *
 * 1996 so that 1996-2025 is exactly THIRTY complete years — the length a
 * climate normal is conventionally computed over, and long enough that a frost
 * date or a rainfall slope means something. The previous 2000 start gave 25,
 * which is short enough that year-to-year noise swamps most trends (gridMET and
 * NASA POWER disagreed on the very SIGN of Waco's rainfall trend over it).
 *
 * It is NOT the WMO's 1991-2020 normal period, and the page says so — that
 * would need data the archive does not hold and would stop moving forward.
 *
 * The R2 archive deliberately holds 1995 as well. One spare year costs ~45 MB
 * of a 10 GB allowance and means the window can be moved back a year without a
 * 25-minute rebuild.
 */
export const HISTORY_START_YEAR = 1996;

/**
 * How many COMPLETE years the record holds, given the year we are in.
 *
 * A function rather than a constant on purpose. Computing it from `new Date()`
 * at module scope would evaluate separately on the server and in the browser,
 * and around the new year those two answers differ — which is a hydration
 * mismatch, the same trap the URL parameters hit. Callers already know the
 * current year; they pass it in.
 *
 * The in-progress year does not count, matching every other figure on the page:
 * a partial year is never treated as a year.
 */
export function historyYears(currentYear: number): number {
  return currentYear - HISTORY_START_YEAR;
}
