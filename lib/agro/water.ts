import type { DailyRecord } from "@/lib/types";
import type { MonthlyEt } from "@/lib/sources/openet";

/**
 * Water balance: what the crop used against what the sky delivered.
 *
 * ============================================================================
 * ONE CONVENTION, EVERYWHERE. DO NOT INTRODUCE A SECOND.
 *
 *     balance = rainfall - ET      (always this way round)
 *
 *     positive -> SURPLUS   more rain fell than the crop used
 *     negative -> SHORT     the crop used more than it rained; irrigation or
 *                           stored soil moisture made up the difference
 *
 * The word "deficit" was previously used as a COLUMN HEADING above this signed
 * value, which produced "Deficit: -1.6" — unreadable, because it can equally
 * mean "short by 1.6" or "the deficit is negative, so there is none". Never
 * label a signed balance "deficit".
 *
 * Anywhere there is room for words, use `balanceWording()` and let the words
 * carry the meaning rather than the sign. Charts may rely on the sign, because
 * a zero line plus a legend makes the direction visible.
 * ============================================================================
 *
 * TWO HONESTY PROBLEMS BUILT INTO THIS NUMBER
 *
 * 1. It inherits the rainfall source's error. Measured at Waco for Jan-Aug 2026
 *    the same field reads 25.0 in (gridMET), 19.8 in (airport gauge) and 19.3 in
 *    (NASA POWER). Against ~24 in of ET that is the difference between a small
 *    surplus and a 4.7 in deficit — opposite decisions. So the balance is always
 *    reported alongside the rainfall source that produced it.
 *
 * 2. It is not a full soil-water budget. No runoff, no deep percolation, no
 *    starting soil moisture, no irrigation already applied. It is
 *    rainfall minus ET over a window, nothing more. Calling it "irrigation
 *    requirement" would overstate it; it is a deficit indicator.
 */

const DAYS_IN_MONTH = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The single source of truth for how a balance figure is described.
 *
 * `short` is the compact word for a legend or a narrow cell; `long` is the
 * sentence for a tile. Both derive from the same sign test, so no two places
 * can drift apart.
 */
export interface BalanceWording {
  short: string;
  long: string;
  isShort: boolean;
  /** CSS variable name for the pole this value belongs to. */
  colorVar: string;
}

export function balanceWording(balance: number): BalanceWording {
  const isShort = balance < 0;
  return {
    short: isShort ? "Short" : "Surplus",
    long: isShort ? "crop used more than it rained" : "more rain than the crop used",
    isShort,
    colorVar: isShort ? "var(--div-warm)" : "var(--div-cool)",
  };
}

/** Legend wording for a signed balance axis. */
export const BALANCE_LEGEND = {
  high: "Surplus — more rain than used",
  low: "Short — used more than it rained",
} as const;

/**
 * Spread monthly ET across the days of that month.
 *
 * OpenET is monthly; every other series here is daily, and the analog windows
 * are arbitrary day counts that do not land on month boundaries. Distributing
 * evenly is an approximation — real ET varies day to day with weather — but it
 * is the honest minimum needed to line monthly ET up against daily rainfall,
 * and over windows of 90+ days the error largely cancels.
 */
export function monthlyEtToDaily(monthly: MonthlyEt[]): Map<string, number> {
  const daily = new Map<string, number>();

  for (const m of monthly) {
    if (m.et === null || !Number.isFinite(m.et)) continue;
    const [ys, ms] = m.month.split("-");
    const year = Number(ys);
    const month = Number(ms);
    if (!Number.isFinite(year) || !Number.isFinite(month)) continue;

    const nDays = DAYS_IN_MONTH(year, month);
    const perDay = m.et / nDays;

    for (let d = 1; d <= nDays; d++) {
      const key = `${ys}-${ms}-${String(d).padStart(2, "0")}`;
      daily.set(key, perDay);
    }
  }

  return daily;
}

/** Total ET over an inclusive date window, prorating partial months. */
export function etOverWindow(
  dailyEt: Map<string, number>,
  startISO: string,
  endISO: string
): { total: number; days: number; covered: number } {
  let total = 0;
  let days = 0;
  let covered = 0;

  const d = new Date(`${startISO}T00:00:00Z`);
  const end = new Date(`${endISO}T00:00:00Z`);

  while (d <= end) {
    const key = d.toISOString().slice(0, 10);
    days++;
    const v = dailyEt.get(key);
    if (v !== undefined) {
      total += v;
      covered++;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }

  return { total, days, covered };
}

export interface WaterWindow {
  /** mm */
  rainfall: number;
  /** mm — null when ET does not reach this window. */
  et: number | null;
  /** rainfall - et, mm. Null when ET is unavailable. */
  balance: number | null;
  /** Fraction of days in the window that ET actually covered. */
  etCoverage: number;
}

/**
 * Rainfall, ET and the balance over one window.
 *
 * ET is reported only when it covers most of the window. A partially covered
 * window would understate ET and flatter the balance — which, for a number
 * meant to inform irrigation, fails in the dangerous direction.
 */
export function waterBalanceForWindow(
  records: DailyRecord[],
  dailyEt: Map<string, number>,
  startISO: string,
  endISO: string,
  minEtCoverage = 0.85
): WaterWindow {
  let rainfall = 0;
  for (const r of records) {
    if (r.date < startISO || r.date > endISO) continue;
    if (r.precip !== null && Number.isFinite(r.precip)) rainfall += r.precip;
  }

  const { total, days, covered } = etOverWindow(dailyEt, startISO, endISO);
  const etCoverage = days > 0 ? covered / days : 0;
  const et = etCoverage >= minEtCoverage ? total : null;

  return {
    rainfall,
    et,
    balance: et === null ? null : rainfall - et,
    etCoverage,
  };
}

/**
 * Merge ET and balance onto the daily record list so the existing climatology,
 * accumulation and charting code can treat them like any other variable.
 *
 * Days before OpenET's record begins are left null rather than zero — a chart
 * must show the line starting late, not sitting on the floor for fifteen years.
 */
export function attachWaterFields(
  records: DailyRecord[],
  dailyEt: Map<string, number>,
  dailyEto?: Map<string, number>
): DailyRecord[] {
  return records.map((r) => {
    const et = dailyEt.get(r.date);
    const hasEt = et !== undefined && Number.isFinite(et);
    const eto = dailyEto?.get(r.date);
    return {
      ...r,
      et: hasEt ? et : null,
      balance: hasEt && r.precip !== null ? r.precip - et : null,
      eto: eto !== undefined && Number.isFinite(eto) ? eto : null,
    };
  });
}
