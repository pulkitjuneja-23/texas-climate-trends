/**
 * Which date range still has to be fetched upstream.
 *
 * Kept in its own module with no imports so it can be exercised directly — it
 * is the function that decides how much upstream work a request costs, and
 * getting it wrong is expensive in exactly the way the cache exists to prevent
 * (a revisit that re-fetches 27 years instead of one).
 */

/**
 * Sources are fetched by range, not by year, so scattered gaps collapse into
 * one span from the earliest missing year to the latest. In practice `missing`
 * is either every year (a cold cell) or just the current one (a revisit), and
 * both produce exactly the right request.
 *
 * The span is clamped to the caller's window so a missing year at either edge
 * cannot widen the request beyond what was asked for.
 */
export function fetchSpan(
  missing: number[],
  requestStart: string,
  requestEnd: string
): { start: string; end: string } | null {
  if (missing.length === 0) return null;

  const lo = Math.min(...missing);
  const hi = Math.max(...missing);
  const start = `${lo}-01-01`;
  const end = `${hi}-12-31`;

  return {
    start: start < requestStart ? requestStart : start,
    end: end > requestEnd ? requestEnd : end,
  };
}
