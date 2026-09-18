/**
 * Reading the visit log back out.
 *
 * The write side (lib/analytics/visits.ts) is deliberately mute: it may never
 * break a page load, so a missing table is a silent no-op. THIS side is the
 * opposite. It feeds a private page whose entire job is to tell the author what
 * the log contains, so when something is wrong it has to say so in words rather
 * than draw an empty map — an empty map and a broken database look identical,
 * and the difference is the whole answer.
 *
 * That distinction is not hypothetical. The `visits` table went uncreated from
 * 29 August to 18 September 2026 and every write failed with a 404 that only
 * ever appeared in a server log nobody reads. The page this feeds now says
 * "the table does not exist" in that situation.
 *
 * SERVER-SIDE ONLY. It uses the Supabase service key.
 */

const BASE = process.env.SUPABASE_URL?.replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
const KEY = process.env.SUPABASE_SERVICE_KEY;

const TABLE = "visits";
const READ_TIMEOUT_MS = 10_000;

/**
 * Rows are pulled in pages because PostgREST caps a single response.
 *
 * Supabase sets that cap per project (commonly 1,000) and it is not visible
 * from here, so asking for everything in one request would silently return a
 * truncated answer that looks complete — the worst failure mode this page
 * could have. Paging with an explicit Range header works whatever the cap is.
 */
const PAGE = 1000;
/**
 * Hard ceiling on rows pulled into memory.
 *
 * A row is around 80 bytes, so this is a few megabytes at worst. If the log
 * ever gets past it, the honest fix is a grouped view in Postgres rather than a
 * bigger number here — and the page says so rather than quietly showing a
 * partial picture.
 */
const MAX_ROWS = 200_000;

interface RawVisit {
  at: string;
  county_fips: string | null;
  county_name: string | null;
  source: string | null;
  self: boolean;
}

export interface CountyTally {
  fips: string;
  name: string;
  lookups: number;
  /** ISO timestamp of the most recent lookup here. */
  lastAt: string;
}

export interface VisitSummary {
  /**
   * Set when the numbers cannot be trusted, in plain language. Everything else
   * is zeroed when this is non-null.
   */
  error: string | null;

  /** Lookups by real visitors — the headline figure. Excludes self and dev. */
  total: number;
  /** Lookups from browsers marked with ?notme=1. Kept, never counted. */
  selfTotal: number;
  /** Real lookups whose point fell outside Texas. */
  outsideTexas: number;

  firstAt: string | null;
  lastAt: string | null;

  last7: number;
  last30: number;

  /** Descending by lookups. Texas counties only. */
  byCounty: CountyTally[];
  /** Ascending by date, one entry per day that saw activity. */
  byDay: Array<{ day: string; n: number }>;
  /** Descending. Which dataset was selected at the moment of the lookup. */
  bySource: Array<{ source: string; n: number }>;

  /** True when MAX_ROWS was hit and the oldest rows are missing. */
  truncated: boolean;
}

function empty(error: string | null): VisitSummary {
  return {
    error,
    total: 0,
    selfTotal: 0,
    outsideTexas: 0,
    firstAt: null,
    lastAt: null,
    last7: 0,
    last30: 0,
    byCounty: [],
    byDay: [],
    bySource: [],
    truncated: false,
  };
}

/**
 * Pull the whole log and fold it into the numbers the page shows.
 *
 * Returns a summary carrying an `error` string rather than throwing, so the
 * page can render the explanation instead of a stack trace.
 */
export async function readVisitSummary(): Promise<VisitSummary> {
  if (!BASE || !KEY) {
    return empty(
      "SUPABASE_URL and SUPABASE_SERVICE_KEY are not both set on this deployment, " +
        "so there is no database to read."
    );
  }

  const rows: RawVisit[] = [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), READ_TIMEOUT_MS);

  try {
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const to = Math.min(from + PAGE, MAX_ROWS) - 1;
      const res = await fetch(
        `${BASE}/rest/v1/${TABLE}?select=at,county_fips,county_name,source,self&order=at.asc`,
        {
          headers: {
            // Both headers carry the same value on purpose — see
            // lib/cache/store.ts for why new-style sb_secret_ keys need that.
            apikey: KEY,
            Authorization: `Bearer ${KEY}`,
            Range: `${from}-${to}`,
            "Range-Unit": "items",
          },
          signal: ctrl.signal,
          cache: "no-store",
        }
      );

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (body.includes("PGRST205") || res.status === 404) {
          return empty(
            "The `visits` table does not exist yet. Nothing has been recorded. " +
              "Create it with the SQL in readme_for_user/SETUP-ANALYTICS.md, and " +
              "recording starts with the next visitor — there is no way to " +
              "backfill what was missed."
          );
        }
        return empty(`The database returned ${res.status}. ${body.slice(0, 200)}`);
      }

      const page = (await res.json()) as RawVisit[];
      rows.push(...page);
      if (page.length < to - from + 1) break;
    }
  } catch (e) {
    return empty(
      ctrl.signal.aborted
        ? "The database did not answer within ten seconds."
        : `The database could not be reached: ${e instanceof Error ? e.message : String(e)}`
    );
  } finally {
    clearTimeout(timer);
  }

  return fold(rows, rows.length >= MAX_ROWS);
}

/** Pure, so the shaping can be reasoned about without a database. */
export function fold(rows: RawVisit[], truncated: boolean): VisitSummary {
  const out = empty(null);
  out.truncated = truncated;
  if (!rows.length) return out;

  const now = Date.now();
  const DAY = 86_400_000;

  const counties = new Map<string, CountyTally>();
  const days = new Map<string, number>();
  const sources = new Map<string, number>();

  for (const r of rows) {
    if (r.self) {
      out.selfTotal++;
      continue;
    }
    out.total++;

    if (out.firstAt === null) out.firstAt = r.at;
    out.lastAt = r.at;

    const age = now - Date.parse(r.at);
    if (age < 7 * DAY) out.last7++;
    if (age < 30 * DAY) out.last30++;

    // `at` is stored as timestamptz and comes back in UTC. Bucketing on the
    // UTC date rather than a Texas date is a deliberate simplification: it
    // shifts late-evening lookups into the next day, which matters for nothing
    // this page is used to decide.
    const day = r.at.slice(0, 10);
    days.set(day, (days.get(day) ?? 0) + 1);

    const src = r.source ?? "(not recorded)";
    sources.set(src, (sources.get(src) ?? 0) + 1);

    if (!r.county_fips) {
      out.outsideTexas++;
      continue;
    }
    const prev = counties.get(r.county_fips);
    if (prev) {
      prev.lookups++;
      prev.lastAt = r.at;
    } else {
      counties.set(r.county_fips, {
        fips: r.county_fips,
        name: r.county_name ?? r.county_fips,
        lookups: 1,
        lastAt: r.at,
      });
    }
  }

  out.byCounty = [...counties.values()].sort(
    (a, b) => b.lookups - a.lookups || a.name.localeCompare(b.name)
  );
  out.byDay = [...days.entries()].sort().map(([day, n]) => ({ day, n }));
  out.bySource = [...sources.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([source, n]) => ({ source, n }));

  return out;
}
