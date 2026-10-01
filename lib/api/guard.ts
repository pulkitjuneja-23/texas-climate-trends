import { HISTORY_START_YEAR } from "@/lib/sources/defaults";
import { inTexas } from "@/lib/geo";

/**
 * Request limits shared by the API routes.
 *
 * Every route is public and unauthenticated, and each one spends something the
 * operator pays for or depends on: Earth Engine quota, Supabase storage, Vercel
 * function time, and standing with free upstream services (NWS, Open-Meteo,
 * Nominatim, IEM, NASA POWER). The page only ever asks for points inside Texas
 * and years from HISTORY_START_YEAR on, so the server now refuses anything
 * wider. A security review on 2026-10-01 found each route accepting the whole
 * globe, any year (one request with endYear=1e300 looped until the function ran
 * out of memory), and any OpenET buffer up to 2 km.
 */

/** Thrown for a request the server deliberately refuses; routes map it to 4xx. */
export class RequestRejected extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
  }
}

/** The response a route sends for a RequestRejected. */
export function rejection(e: unknown): { error: string; status: number } | null {
  return e instanceof RequestRejected ? { error: e.message, status: e.status } : null;
}

/**
 * Same box the page uses to decide whether to call these routes at all
 * (`inTexas` in app/page.tsx), so no request the site itself makes is refused.
 */
export function requireTexas(lat: number, lon: number): void {
  if (!inTexas(lat, lon)) {
    throw new RequestRejected("This site serves locations in Texas only.", 422);
  }
}

/**
 * Integer years, clamped to what the site actually serves.
 *
 * Clamped rather than refused, so an old shared link with a different range
 * still opens. Non-integers are refused: "1996.5" once became a cache key that
 * collided with 1996's while fetching a series missing that whole year.
 */
export function parseYears(
  startRaw: string | null,
  endRaw: string | null,
  sourceStartYear: number,
  currentYear: number
): { startYear: number; endYear: number } {
  const start = startRaw === null || startRaw === "" ? HISTORY_START_YEAR : Number(startRaw);
  const end = endRaw === null || endRaw === "" ? currentYear : Number(endRaw);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new RequestRejected("startYear and endYear must be whole years.");
  }
  const floor = Math.max(HISTORY_START_YEAR, sourceStartYear);
  const startYear = Math.min(Math.max(start, floor), currentYear);
  const endYear = Math.min(Math.max(end, startYear), currentYear);
  return { startYear, endYear };
}

/**
 * Who is asking, as far as a rate limit needs to know.
 *
 * Vercel sets x-real-ip and x-forwarded-for from the connecting address. Used
 * only as an in-memory counter key; never stored or logged.
 */
export function clientKey(req: Request): string {
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "unknown";
}

/**
 * A fixed-window counter per (bucket, client), held in this instance's memory.
 *
 * HONEST LIMIT: Vercel runs several instances, each with its own counters, and
 * a cold instance starts at zero. So this caps one script hammering one
 * instance; it is not a global guarantee. The global control is a rate-limit
 * rule in the Vercel Firewall (see readme_for_user/DEPLOY.md). The ceilings are
 * set well above anything a person clicking around the map produces.
 */
const windows = new Map<string, { start: number; count: number }>();

export function overLimit(bucket: string, key: string, max: number, windowMs = 60_000): boolean {
  const now = Date.now();
  if (windows.size > 10_000) {
    for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k);
  }
  const id = `${bucket}:${key}`;
  const w = windows.get(id);
  if (!w || now - w.start >= windowMs) {
    windows.set(id, { start: now, count: 1 });
    return false;
  }
  w.count++;
  return w.count > max;
}

/**
 * Requests per minute, per internet address, per server instance.
 *
 * SET FOR A FULL LECTURE HALL, NOT ONE PERSON. Everyone on one campus or
 * workshop Wi-Fi usually shares one public address, so these counters see a
 * room of growers as a single caller. Picking a field costs about one request
 * per data route, so 600 a minute lets hundreds of people on one network pick
 * fields in the same minute. Page loads that hit Vercel's cache (the default
 * view, any place someone viewed recently) never reach these counters at all.
 *
 * The heavy lifting against abuse is done elsewhere and costs real users
 * nothing: Texas-only, 1996..now, the fixed 100 m buffer, rounded forecast
 * coordinates. These limits are only a brake on one address hammering one
 * instance. The global cap is a Vercel Firewall rule.
 *
 * Search is the real bottleneck in a crowd, and not by our choice: Nominatim
 * allows about one search a second (see `spaced`). Its per-address limit is
 * therefore only a backstop.
 */
export const LIMITS = {
  /** /api/history, /api/et, /api/forecast, /api/yield — each counted separately. */
  data: 600,
  geocode: 120,
  visit: 600,
  event: 1200,
} as const;

/** Throws a 429 when the caller is over the limit for this bucket. */
export function enforceLimit(req: Request, bucket: string, max: number): void {
  if (overLimit(bucket, clientKey(req), max)) {
    throw new RequestRejected("Too many requests. Please wait a minute and try again.", 429);
  }
}

/**
 * Space calls to one upstream at least `gapMs` apart within this instance.
 *
 * For Nominatim, whose policy is one request per second per application. A call
 * that would have to wait longer than `maxWaitMs` is refused instead of queued,
 * so a burst cannot pile up waiting functions.
 */
const nextSlot = new Map<string, number>();

export async function spaced(name: string, gapMs: number, maxWaitMs: number): Promise<boolean> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(name) ?? 0);
  if (slot - now > maxWaitMs) return false;
  nextSlot.set(name, slot + gapMs);
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  return true;
}

/**
 * Cache-Control for an answer that carries an upstream failure.
 *
 * A failed or partial answer must not sit in the shared CDN for hours: one
 * five-minute Earth Engine hiccup would otherwise be replayed to every visitor
 * of that URL for the route's full s-maxage. One minute still absorbs a burst.
 */
export const DEGRADED_CACHE = "public, max-age=0, must-revalidate, s-maxage=60";
