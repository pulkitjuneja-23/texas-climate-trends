/**
 * The visit log: which COUNTY someone looked at, and when — plus, since
 * 18 September 2026, enough context to tell how many distinct people that is.
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
 * COUNTY ONLY. THIS IS STILL THE RULE AND IT HAS NOT LOOSENED.
 * ---------------------------------------------------------------------------
 * A coordinate a grower types in is their field. The server resolves it to a
 * county and DISCARDS it; nothing finer is ever written. "The Panhandle is busy
 * and the Valley is not" is the actual question, and a county answers it
 * completely.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS STORED ABOUT A PERSON — READ THIS BEFORE ADDING A COLUMN
 * ---------------------------------------------------------------------------
 * Still NOT stored, and must not be: IP address, user agent string, precise
 * coordinates, anything a visitor typed, any account or contact detail, any
 * full referring URL.
 *
 * Now stored: a random `visitor` code generated in the browser, a per-tab
 * `session` code, a screen class, the visitor's local hour and weekday, and the
 * referring HOST. The visitor code is the significant change — it is persistent
 * identification of a browser, which the original design deliberately avoided,
 * and it was added as an explicit decision because "how many distinct growers,
 * and do they come back" cannot be answered without it. It is random, derived
 * from nothing, and joinable to nothing.
 *
 * The site's footer says this happens in one plain sentence. That sentence is
 * part of the feature, not decoration.
 *
 * ---------------------------------------------------------------------------
 * IT MAY NEVER BREAK A PAGE LOAD
 * ---------------------------------------------------------------------------
 * Same rule as the cache layer: nothing here throws, everything has a hard
 * deadline, and a missing table or absent configuration is a silent no-op.
 *
 * The cost of that silence is on record. The `visits` table went uncreated from
 * 29 August to 18 September 2026 and three weeks of lookups were dropped, each
 * one warning into a server log nobody reads. The fix is not to make this side
 * noisy — a farmer's rainfall still outranks a counter — but to make the READ
 * side say so out loud. See lib/analytics/summary.ts.
 */

const BASE = process.env.SUPABASE_URL?.replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
const KEY = process.env.SUPABASE_SERVICE_KEY;

export const visitLogEnabled = Boolean(BASE && KEY);

const WRITE_TIMEOUT_MS = 4000;

/** Context carried by both kinds of row. */
export interface Envelope {
  /** Random per-browser code, or null when the browser refuses storage. */
  visitor: string | null;
  /** Random per-tab code. */
  session: string | null;
  /** "phone" | "tablet" | "desktop", as the VIEWPORT reported it. */
  screen: string | null;
  /** The visitor's own local hour, 0-23. Texas spans two time zones. */
  hour: number | null;
  /** The visitor's own local weekday, 0 = Sunday. */
  weekday: number | null;
  /** True when the browser is marked with ?notme=1. Kept, never counted. */
  self: boolean;
}

export interface VisitRow extends Envelope {
  /** Texas county FIPS, or null when the point is outside Texas. */
  countyFips: string | null;
  countyName: string | null;
  /** Which dataset was selected at the time. */
  source: string | null;
  /** How the pin got there: map, search, coords, gps, link, default. */
  via: string | null;
  /** Referring host only, never a full URL. */
  referrer: string | null;
}

export interface EventRow extends Envelope {
  /** Category, e.g. "panel", "variable", "crop", "export". */
  kind: string;
  /** Value within the category, e.g. "forecast", "precip", "csv". */
  label: string;
}

/** Bounded so a malformed or hostile body cannot write a novel into a column. */
function short(v: unknown, n: number): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, n) : null;
}

function envelopeColumns(row: Envelope) {
  return {
    visitor: short(row.visitor, 64),
    session: short(row.session, 64),
    screen: short(row.screen, 16),
    hour: Number.isInteger(row.hour) && row.hour! >= 0 && row.hour! <= 23 ? row.hour : null,
    weekday:
      Number.isInteger(row.weekday) && row.weekday! >= 0 && row.weekday! <= 6 ? row.weekday : null,
    self: row.self === true,
  };
}

/** PostgREST's code for "you sent a column this table does not have". */
function isUnknownColumn(status: number, body: string): boolean {
  return status === 400 && (body.includes("PGRST204") || body.includes("Could not find the"));
}

async function send(
  table: string,
  body: unknown,
  signal: AbortSignal
): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(`${BASE}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      // Both headers carry the same value on purpose — see lib/cache/store.ts
      // for why new-style `sb_secret_` keys need that.
      apikey: KEY as string,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
    signal,
    cache: "no-store",
  });
  return {
    ok: res.ok,
    status: res.status,
    text: res.ok ? "" : await res.text().catch(() => ""),
  };
}

/**
 * Insert one row, with an optional reduced version to fall back to.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FALLBACK EXISTS
 * ---------------------------------------------------------------------------
 * Code and database migrate at different moments. A deploy carrying new columns
 * lands the instant it is pushed; the `alter table` is a human pasting SQL into
 * a dashboard, possibly days later. In that gap every insert would be rejected
 * with PGRST204 and every lookup in it lost — which is precisely how three
 * weeks of records were lost in September, just with a different error code.
 *
 * So a rejected write is retried once with only the columns that have always
 * existed. The new detail is missing for those rows, which is a small and
 * visible loss; the lookup itself is not, which would be an invisible one.
 *
 * The retry is attempted ONCE and only for this specific error. A genuine
 * outage must not turn into two requests per visit.
 */
async function insert(table: string, body: unknown, legacy?: unknown): Promise<void> {
  if (!visitLogEnabled) return;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WRITE_TIMEOUT_MS);
  try {
    const first = await send(table, body, ctrl.signal);
    if (first.ok) return;

    if (legacy && isUnknownColumn(first.status, first.text)) {
      const retry = await send(table, legacy, ctrl.signal);
      if (retry.ok) {
        console.warn(
          `[visits] ${table}: the database is missing the newer columns, so this row was ` +
            `written without them. Run supabase/analytics.sql in the Supabase SQL editor.`
        );
        return;
      }
      console.warn(`[visits] ${table} fallback insert failed ${retry.status}: ${retry.text.slice(0, 200)}`);
      return;
    }

    // A 404 here almost certainly means the table has not been created yet.
    // Worth one clear line rather than silence, because otherwise the only
    // symptom is a log that stays permanently empty — exactly what happened
    // between 29 August and 18 September 2026.
    console.warn(`[visits] ${table} insert failed ${first.status}: ${first.text.slice(0, 200)}`);
  } catch (e) {
    console.warn(
      `[visits] ${table} insert ${ctrl.signal.aborted ? "timed out" : "errored"}: ` +
        `${e instanceof Error ? e.message : String(e)}`
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Record one location lookup. Resolves to nothing and never rejects.
 *
 * One row per LOCATION, not per page view: the client calls it when the pin
 * moves, so flipping between sources or panels at one spot does not inflate it.
 */
export async function logVisit(row: VisitRow): Promise<void> {
  /** The four columns that have existed since this table was first designed. */
  const legacy = {
    county_fips: row.countyFips,
    county_name: row.countyName,
    source: short(row.source, 32),
    self: row.self === true,
  };
  await insert(
    "visits",
    {
      ...legacy,
      ...envelopeColumns(row),
      via: short(row.via, 16),
      referrer: short(row.referrer, 64),
    },
    legacy
  );
}

/**
 * Record one feature being used. Resolves to nothing and never rejects.
 *
 * At most one row per session per kind+label — the client deduplicates, so
 * these count SITTINGS in which something was used rather than clicks. See
 * lib/analytics/client.ts for why that is the useful grain.
 */
export async function logEvent(row: EventRow): Promise<void> {
  const kind = short(row.kind, 24);
  const label = short(row.label, 48);
  if (!kind || !label) return;
  await insert("events", { ...envelopeColumns(row), kind, label });
}
