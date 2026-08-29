/**
 * The visit log: which COUNTY someone looked at, and when.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN A VERCEL CUSTOM EVENT
 * ---------------------------------------------------------------------------
 * "Which locations are people looking up" is the question worth answering, and
 * Vercel's answer to it — custom events — is a Pro-plan feature. This project
 * already has a Supabase database for the gridMET cache, so the same question
 * can be answered for nothing, kept for years instead of one rolling month, and
 * queried with plain SQL rather than through a dashboard.
 *
 * ---------------------------------------------------------------------------
 * COUNTY ONLY. THIS IS THE PRIVACY DECISION AND IT IS DELIBERATE.
 * ---------------------------------------------------------------------------
 * A coordinate a grower types in is their field. Storing it would be storing
 * where someone farms, on a public site, in a database — and "the Panhandle is
 * busy and the Valley is not" is the actual question, which a county answers
 * completely. So the coordinates are resolved to a county on the server and
 * then discarded; they are never written down.
 *
 * Nothing that could identify a person is stored either: no IP address, no
 * user agent, no session or visitor id, no cookie. A row is a timestamp, a
 * county, and which dataset was selected. Two visits from the same person are
 * indistinguishable from two visits by different people — which is a real
 * limitation of these numbers and is the price of not tracking anyone.
 *
 * ---------------------------------------------------------------------------
 * IT MAY NEVER BREAK A PAGE LOAD
 * ---------------------------------------------------------------------------
 * Same rule as the cache layer: nothing here throws, everything has a hard
 * deadline, and a missing table or absent configuration is a silent no-op. This
 * is a curiosity about traffic. It is not allowed to cost a farmer their
 * rainfall.
 */

const BASE = process.env.SUPABASE_URL?.replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
const KEY = process.env.SUPABASE_SERVICE_KEY;

export const visitLogEnabled = Boolean(BASE && KEY);

const TABLE = "visits";
const WRITE_TIMEOUT_MS = 4000;

export interface VisitRow {
  /** Texas county FIPS, or null when the point is outside Texas. */
  countyFips: string | null;
  countyName: string | null;
  /** Which dataset was selected at the time. */
  source: string | null;
  /** True when the visitor marked this browser as the author's — see lib/analytics/self.ts. */
  self: boolean;
}

/**
 * Record one visit. Resolves to nothing and never rejects.
 *
 * Note this is one row per LOCATION, not per page view: the client calls it
 * when the pin moves, so flipping between sources or panels at one spot does
 * not inflate the count.
 */
export async function logVisit(row: VisitRow): Promise<void> {
  if (!visitLogEnabled) return;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WRITE_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/rest/v1/${TABLE}`, {
      method: "POST",
      headers: {
        // Both headers carry the same value on purpose — see lib/cache/store.ts
        // for why new-style `sb_secret_` keys need that.
        apikey: KEY as string,
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        county_fips: row.countyFips,
        county_name: row.countyName,
        source: row.source,
        self: row.self,
      }),
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // A 404 here almost certainly means the table has not been created yet.
      // Worth one clear line rather than silence, because otherwise the only
      // symptom is a log that stays permanently empty.
      console.warn(`[visits] insert failed ${res.status}: ${body.slice(0, 160)}`);
    }
  } catch (e) {
    console.warn(
      `[visits] insert ${ctrl.signal.aborted ? "timed out" : "errored"}: ` +
        `${e instanceof Error ? e.message : String(e)}`
    );
  } finally {
    clearTimeout(timer);
  }
}
