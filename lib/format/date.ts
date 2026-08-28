/**
 * One date convention for the whole site: **August 27, 2026**.
 *
 * Every date a grower reads is written with the month spelled out in English.
 * Two reasons this is worth a shared module rather than a `toLocaleDateString`
 * at each call site:
 *
 *  1. `2026-08-27` is the storage format, not a reading format. It appeared on
 *     screen in four places because it happened to be what the API returned.
 *  2. `8/27` is ambiguous outside the US and unreadable at a glance even inside
 *     it. `27/8` means a different day, and nothing on the page says which
 *     convention is in force.
 *
 * ISO STAYS ISO WHERE A MACHINE READS IT. CSV exports, URL parameters and the
 * `<input type="date">` controls are untouched — a spreadsheet parses
 * `2026-08-27` and cannot parse "August 27, 2026", and the date input's display
 * belongs to the browser and the reader's own locale.
 *
 * Parsed at UTC noon throughout. `new Date("2026-08-27")` is midnight UTC, which
 * in Texas is the evening of the 26th — so a naive local-time format silently
 * prints the day before.
 */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Splits `YYYY-MM-DD`, tolerating a full ISO timestamp. */
function parts(iso: string): { y: number; m: number; d: number } | null {
  if (!iso || iso.length < 10) return null;
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

/** `2026-08-27` -> `August 27, 2026`. The site-wide default. */
export function formatDate(iso: string | null | undefined): string {
  const p = iso ? parts(iso) : null;
  if (!p) return "—";
  return `${MONTHS[p.m - 1]} ${p.d}, ${p.y}`;
}

/**
 * `2026-08-27` -> `Aug 27, 2026`.
 *
 * For badges and table cells, where the full month name pushes a row wider than
 * the number it is labelling.
 */
export function formatDateShort(iso: string | null | undefined): string {
  const p = iso ? parts(iso) : null;
  if (!p) return "—";
  return `${MONTHS_SHORT[p.m - 1]} ${p.d}, ${p.y}`;
}

/**
 * `2026-08-27` -> `August 27`.
 *
 * Where the year is already established by the surrounding sentence — a season
 * that is obviously this one, a range whose end carries the year.
 */
export function formatMonthDay(iso: string | null | undefined): string {
  const p = iso ? parts(iso) : null;
  if (!p) return "—";
  return `${MONTHS[p.m - 1]} ${p.d}`;
}

/**
 * `2026-09-01` -> `Mon, Sep 1`.
 *
 * FORECAST TILES ONLY, and deliberately shorter than the site convention. A
 * forecast tile is one of seven in a row; "September 1, 2026" does not fit, and
 * the year is never in question two weeks out. The weekday is the part a reader
 * actually navigates by. Still an English month, never `9/1`.
 */
export function formatForecastDay(iso: string): string {
  const p = parts(iso);
  if (!p) return iso;
  const wd = new Date(Date.UTC(p.y, p.m - 1, p.d, 12)).getUTCDay();
  return `${WEEKDAYS_SHORT[wd]}, ${MONTHS_SHORT[p.m - 1]} ${p.d}`;
}

/**
 * A span, with the year stated once: `Aug 21 – Aug 27, 2026`.
 *
 * Repeating the year on both ends of a seven-day window is noise; repeating it
 * across a year boundary is not, so that case keeps both.
 */
export function formatRange(fromISO: string, toISO: string): string {
  const a = parts(fromISO);
  const b = parts(toISO);
  if (!a || !b) return `${formatDateShort(fromISO)} – ${formatDateShort(toISO)}`;
  if (a.y !== b.y) return `${formatDateShort(fromISO)} – ${formatDateShort(toISO)}`;
  return `${MONTHS_SHORT[a.m - 1]} ${a.d} – ${MONTHS_SHORT[b.m - 1]} ${b.d}, ${b.y}`;
}
