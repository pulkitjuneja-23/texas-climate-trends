/**
 * Texas Central time, for the private insights page.
 *
 * The visit log stores `at` as a UTC timestamp. Slicing the date off that
 * string gives the UTC date, which runs five or six hours ahead of Texas: a
 * visit at 8 PM on October 5 in Temple is 01:00 UTC on October 6, and the page
 * duly reported a visit "tomorrow". Every date, day bucket, hour and weekday on
 * that page goes through here instead.
 *
 * "America/Chicago" rather than a fixed offset, so the switch between CST
 * (UTC-6, winter) and CDT (UTC-5, summer) is handled by the runtime's own
 * time-zone table. The label printed beside a time is whichever is in force at
 * that moment.
 */

export const CENTRAL_TZ = "America/Chicago";

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  weekday: "short",
  // h23, not hour12:false: some engines render midnight as "24" with the latter.
  hourCycle: "h23",
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export interface CentralParts {
  /** YYYY-MM-DD, the Central calendar day. */
  day: string;
  /** YYYY-MM */
  month: string;
  /** 0-23 */
  hour: number;
  /** 0 = Sunday */
  weekday: number;
}

export function centralParts(ms: number): CentralParts {
  const p: Record<string, string> = {};
  for (const x of PARTS.formatToParts(new Date(ms))) p[x.type] = x.value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    month: `${p.year}-${p.month}`,
    hour: Number(p.hour) % 24,
    weekday: WEEKDAY_INDEX[p.weekday] ?? 0,
  };
}

const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_TZ,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

/** `Oct 5, 2026, 8:14 PM CDT` */
export function formatCentral(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined) return "—";
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return DATE_TIME.format(new Date(ms));
}

const HOUR_LABEL = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_TZ,
  weekday: "short",
  hour: "numeric",
});

/** `Mon 8 PM`, for hourly bars. */
export function formatCentralHour(ms: number): string {
  return HOUR_LABEL.format(new Date(ms));
}
