import { NextResponse } from "next/server";
import type { Envelope } from "@/lib/analytics/visits";

/**
 * Shared behaviour for the two telemetry beacons.
 *
 * A file prefixed with `_` is not a route — Next.js only treats `route.ts` as
 * an endpoint — so this sits inside app/api without becoming an endpoint of its
 * own.
 */

/**
 * ALWAYS 204, whatever happened.
 *
 * The caller is a fire-and-forget beacon from a page that has already rendered.
 * There is no failure here worth telling a browser about, and returning an
 * error status would only produce noise in somebody's console about a feature
 * that is none of their concern.
 */
export function beaconOk(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Pull the shared context out of a beacon body.
 *
 * Everything is treated as hostile: a beacon is an unauthenticated POST from
 * the open internet, so each field is type-checked and the writer bounds every
 * string length again on the way to the database. The numeric fields are range
 * checked here because an hour of 4,000 would sail through a length check and
 * quietly corrupt a chart.
 */
export function envelopeFrom(body: Record<string, unknown>): Envelope {
  const int = (v: unknown, lo: number, hi: number): number | null => {
    const n = typeof v === "number" ? v : Number.NaN;
    return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
  };
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

  return {
    visitor: str(body.visitor),
    session: str(body.session),
    screen: str(body.screen),
    hour: int(body.hour, 0, 23),
    weekday: int(body.weekday, 0, 6),
    self: body.self === true,
  };
}
