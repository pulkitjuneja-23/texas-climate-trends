/**
 * Reading the visit and event logs back out.
 *
 * The write side (lib/analytics/visits.ts) is deliberately mute: it may never
 * break a page load, so a missing table is a silent no-op. THIS side is the
 * opposite. It feeds a private page whose entire job is to say what the logs
 * contain, so when something is wrong it has to say so in words rather than
 * draw an empty map — an empty map and a broken database look identical, and
 * the difference is the whole answer.
 *
 * That is not hypothetical. The `visits` table went uncreated from 29 August to
 * 18 September 2026 and every write failed with a 404 that only ever appeared
 * in a server log nobody reads.
 *
 * SERVER-SIDE ONLY. It uses the Supabase service key.
 */

const BASE = process.env.SUPABASE_URL?.replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
const KEY = process.env.SUPABASE_SERVICE_KEY;

const READ_TIMEOUT_MS = 15_000;

/**
 * Rows are pulled in pages because PostgREST caps a single response.
 *
 * Supabase sets that cap per project (commonly 1,000) and it is not visible
 * from here, so asking for everything in one request would silently return a
 * truncated answer that looks complete — the worst failure mode this page could
 * have. Paging with an explicit Range header works whatever the cap is.
 */
const PAGE = 1000;
/**
 * Hard ceiling on rows pulled into memory, per table.
 *
 * A row is around a hundred bytes, so this is tens of megabytes at the very
 * worst. If a log ever passes it the honest fix is a grouped view in Postgres,
 * not a bigger number here — and the page says so rather than quietly showing a
 * partial picture.
 */
const MAX_ROWS = 200_000;

const DAY = 86_400_000;

/** How far back "recent" reaches, for new-versus-returning. */
export const RECENT_DAYS = 30;

interface RawVisit {
  at: string;
  county_fips: string | null;
  county_name: string | null;
  source: string | null;
  via: string | null;
  referrer: string | null;
  visitor: string | null;
  session: string | null;
  screen: string | null;
  hour: number | null;
  weekday: number | null;
  self: boolean;
}

interface RawEvent {
  at: string;
  kind: string;
  label: string;
  visitor: string | null;
  session: string | null;
  self: boolean;
}

export interface CountyTally {
  fips: string;
  name: string;
  lookups: number;
  /** Distinct people, as far as the visitor code can tell. */
  visitors: number;
  lastAt: string;
}

export interface Tally {
  key: string;
  n: number;
}

export interface Analytics {
  /**
   * Set when the numbers cannot be trusted, in plain language. Everything else
   * is zeroed when this is non-null.
   */
  error: string | null;
  /** Non-fatal notes, e.g. the events table missing while visits works. */
  warnings: string[];

  /* ---- headline ---- */
  /** Location lookups by real visitors. Excludes marked browsers and dev. */
  lookups: number;
  /** Distinct visitor codes seen. */
  visitors: number;
  /** Distinct tab-sessions. */
  sessions: number;
  /** Lookups from browsers that would not store a code — counted, not identified. */
  unidentified: number;
  /** Lookups from browsers marked with ?notme=1. Kept, never counted. */
  selfLookups: number;
  /** Real lookups whose point fell outside Texas. */
  outsideTexas: number;

  firstAt: string | null;
  lastAt: string | null;

  /* ---- recent activity ---- */
  lookups7: number;
  lookups30: number;
  visitors7: number;
  visitors30: number;
  /** Visitors active in the last RECENT_DAYS whose FIRST ever visit was inside it. */
  newVisitors: number;
  /** Active in the last RECENT_DAYS, but first seen before it. */
  returningVisitors: number;

  /* ---- distributions ---- */
  /** Sessions per visitor, bucketed: how many people came back. */
  loyalty: Tally[];
  /** Lookups per session, bucketed: how deep a sitting goes. */
  depth: Tally[];
  byScreen: Tally[];
  byVia: Tally[];
  bySource: Tally[];
  byReferrer: Tally[];
  /** 24 entries, index = local hour. */
  byHour: number[];
  /** 7 entries, index 0 = Sunday. */
  byWeekday: number[];

  /* ---- place and time ---- */
  byCounty: CountyTally[];
  byDay: Array<{ day: string; n: number }>;
  byMonth: Array<{ month: string; lookups: number; visitors: number }>;

  /* ---- what people used ---- */
  /** Keyed by event kind; each a descending list of labels by SESSION count. */
  features: Record<string, Tally[]>;
  /** Sessions that produced at least one event of any kind. */
  sessionsWithEvents: number;

  truncated: boolean;
}

function blank(error: string | null): Analytics {
  return {
    error,
    warnings: [],
    lookups: 0,
    visitors: 0,
    sessions: 0,
    unidentified: 0,
    selfLookups: 0,
    outsideTexas: 0,
    firstAt: null,
    lastAt: null,
    lookups7: 0,
    lookups30: 0,
    visitors7: 0,
    visitors30: 0,
    newVisitors: 0,
    returningVisitors: 0,
    loyalty: [],
    depth: [],
    byScreen: [],
    byVia: [],
    bySource: [],
    byReferrer: [],
    byHour: Array(24).fill(0),
    byWeekday: Array(7).fill(0),
    byCounty: [],
    byDay: [],
    byMonth: [],
    features: {},
    sessionsWithEvents: 0,
    truncated: false,
  };
}

/** A table read that distinguishes "not there" from "broken". */
type TableRead<T> =
  | { ok: true; rows: T[]; truncated: boolean; reduced: boolean }
  | { ok: false; missing: boolean; why: string };

/**
 * Read a whole table, paging, with an optional older column list to retry with.
 *
 * The fallback mirrors the one on the write side and exists for the same
 * reason: the code deploys the moment it is pushed, the `alter table` happens
 * whenever a person gets round to pasting it. Between those two moments asking
 * for the new columns fails with Postgres 42703, and without this the whole
 * page would read as "your database is broken" when it is merely older than the
 * code. It says which, instead.
 */
async function readTable<T>(
  table: string,
  columns: string,
  legacyColumns?: string
): Promise<TableRead<T>> {
  const rows: T[] = [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), READ_TIMEOUT_MS);
  let select = columns;
  let reduced = false;

  try {
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const to = Math.min(from + PAGE, MAX_ROWS) - 1;
      // NEWEST first, with id breaking ties so no row is skipped or repeated
      // across pages. If the table outgrows MAX_ROWS it is the oldest history
      // that is left out — what the page's note says. Reading oldest-first (as
      // before 2026-10-01) dropped the NEWEST rows instead, so a burst of junk
      // beacons could have hidden every genuine visit after it. The rows are put
      // back into oldest-first order below, which is what fold() expects.
      const res = await fetch(`${BASE}/rest/v1/${table}?select=${select}&order=at.desc,id.desc`, {
        headers: {
          apikey: KEY as string,
          Authorization: `Bearer ${KEY}`,
          Range: `${from}-${to}`,
          "Range-Unit": "items",
        },
        signal: ctrl.signal,
        cache: "no-store",
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");

        // The table is older than the code: drop to the columns it does have
        // and start the paging again from the top.
        if (
          legacyColumns &&
          !reduced &&
          (body.includes("42703") || body.includes("does not exist"))
        ) {
          reduced = true;
          select = legacyColumns;
          from = -PAGE; // the loop's own increment puts this back to 0
          rows.length = 0;
          continue;
        }

        const missing =
          res.status === 404 || body.includes("PGRST205") || body.includes("PGRST204");
        return {
          ok: false,
          missing,
          why: missing
            ? `the \`${table}\` table does not exist yet`
            : `the database returned ${res.status} for \`${table}\` — ${body.slice(0, 160)}`,
        };
      }

      const page = (await res.json()) as T[];
      rows.push(...page);
      if (page.length < to - from + 1) break;
    }
  } catch (e) {
    return {
      ok: false,
      missing: false,
      why: ctrl.signal.aborted
        ? `\`${table}\` did not answer within fifteen seconds`
        : `\`${table}\` could not be reached: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    clearTimeout(timer);
  }
  rows.reverse();
  return { ok: true, rows, truncated: rows.length >= MAX_ROWS, reduced };
}

export async function readAnalytics(): Promise<Analytics> {
  if (!BASE || !KEY) {
    return blank(
      "SUPABASE_URL and SUPABASE_SERVICE_KEY are not both set on this deployment, " +
        "so there is no database to read."
    );
  }

  const [v, e] = await Promise.all([
    readTable<RawVisit>(
      "visits",
      "at,county_fips,county_name,source,via,referrer,visitor,session,screen,hour,weekday,self",
      // The shape this table had before 18 September 2026.
      "at,county_fips,county_name,source,self"
    ),
    readTable<RawEvent>("events", "at,kind,label,visitor,session,self"),
  ]);

  if (!v.ok) {
    return blank(
      v.missing
        ? "The `visits` table does not exist yet, so nothing has been recorded. " +
            "Create it with the SQL in readme_for_user/SETUP-ANALYTICS.md. Recording " +
            "starts with the next visitor — there is no way to backfill what was missed."
        : `Could not read the visit log: ${v.why}.`
    );
  }

  const out = fold(v.rows, e.ok ? e.rows : [], v.truncated || (e.ok && e.truncated));

  if (v.reduced) {
    out.warnings.push(
      "The database is older than the site. The `visits` table does not have the " +
        "columns that identify people, so the sections about visitors, devices, timing " +
        "and how the pin was placed are empty — lookups and counties are unaffected. " +
        "Run the second SQL block in readme_for_user/SETUP-ANALYTICS.md; it takes a minute."
    );
  }

  if (!e.ok) {
    out.warnings.push(
      e.missing
        ? "The `events` table does not exist yet, so the sections about what people " +
            "used are empty. It is the second block of SQL in SETUP-ANALYTICS.md; the " +
            "rest of this page is unaffected."
        : `The event log could not be read: ${e.why}. Everything else on this page is unaffected.`
    );
  }

  return out;
}

/* -------------------------------------------------------------------------- */

function bucketLabel(n: number): string {
  if (n <= 1) return "1";
  if (n === 2) return "2";
  if (n <= 5) return "3-5";
  if (n <= 10) return "6-10";
  return "11+";
}

/** Fixed order so a bucket with no members still holds its place in the chart. */
const BUCKETS = ["1", "2", "3-5", "6-10", "11+"];

function descend(m: Map<string, number>): Tally[] {
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, n]) => ({ key, n }));
}

function bump(m: Map<string, number>, k: string | null, by = 1): void {
  if (!k) return;
  m.set(k, (m.get(k) ?? 0) + by);
}

/**
 * Fold both logs into the numbers the page shows. Pure, so the shaping can be
 * reasoned about — and tested — without a database.
 */
export function fold(visits: RawVisit[], events: RawEvent[], truncated: boolean): Analytics {
  const out = blank(null);
  out.truncated = truncated;

  const now = Date.now();
  const recentFrom = now - RECENT_DAYS * DAY;

  const counties = new Map<string, CountyTally>();
  const countyVisitors = new Map<string, Set<string>>();
  const days = new Map<string, number>();
  const months = new Map<string, { lookups: number; visitors: Set<string> }>();
  const screens = new Map<string, number>();
  const vias = new Map<string, number>();
  const sources = new Map<string, number>();
  const referrers = new Map<string, number>();

  const allVisitors = new Set<string>();
  const allSessions = new Set<string>();
  const visitors7 = new Set<string>();
  const visitors30 = new Set<string>();
  /** visitor -> epoch ms of their first ever lookup. */
  const firstSeen = new Map<string, number>();
  /** visitor -> the distinct sessions they have had. */
  const sessionsOf = new Map<string, Set<string>>();
  /** session -> how many lookups it contained. */
  const lookupsInSession = new Map<string, number>();

  for (const r of visits) {
    if (r.self) {
      out.selfLookups++;
      continue;
    }
    out.lookups++;

    if (out.firstAt === null) out.firstAt = r.at;
    out.lastAt = r.at;

    const t = Date.parse(r.at);
    const recent30 = t >= recentFrom;
    const recent7 = t >= now - 7 * DAY;
    if (recent7) out.lookups7++;
    if (recent30) out.lookups30++;

    if (r.visitor) {
      allVisitors.add(r.visitor);
      const prev = firstSeen.get(r.visitor);
      if (prev === undefined || t < prev) firstSeen.set(r.visitor, t);
      if (recent7) visitors7.add(r.visitor);
      if (recent30) visitors30.add(r.visitor);
      if (r.session) {
        let s = sessionsOf.get(r.visitor);
        if (!s) sessionsOf.set(r.visitor, (s = new Set()));
        s.add(r.session);
      }
    } else {
      out.unidentified++;
    }

    if (r.session) {
      allSessions.add(r.session);
      lookupsInSession.set(r.session, (lookupsInSession.get(r.session) ?? 0) + 1);
    }

    // `at` is timestamptz and comes back in UTC. The DAY buckets use it as-is;
    // the hour and weekday buckets use the visitor's OWN clock, sent with the
    // beacon, because "growers check this over breakfast" is a claim about
    // their morning and Texas spans two time zones.
    const day = r.at.slice(0, 10);
    days.set(day, (days.get(day) ?? 0) + 1);

    const month = r.at.slice(0, 7);
    let mo = months.get(month);
    if (!mo) months.set(month, (mo = { lookups: 0, visitors: new Set() }));
    mo.lookups++;
    if (r.visitor) mo.visitors.add(r.visitor);

    if (r.hour !== null && r.hour >= 0 && r.hour < 24) out.byHour[r.hour]++;
    if (r.weekday !== null && r.weekday >= 0 && r.weekday < 7) out.byWeekday[r.weekday]++;

    bump(screens, r.screen);
    bump(vias, r.via);
    bump(sources, r.source ?? "(not recorded)");
    bump(referrers, r.referrer);

    if (!r.county_fips) {
      out.outsideTexas++;
      continue;
    }
    const c = counties.get(r.county_fips);
    if (c) {
      c.lookups++;
      c.lastAt = r.at;
    } else {
      counties.set(r.county_fips, {
        fips: r.county_fips,
        name: r.county_name ?? r.county_fips,
        lookups: 1,
        visitors: 0,
        lastAt: r.at,
      });
    }
    if (r.visitor) {
      let set = countyVisitors.get(r.county_fips);
      if (!set) countyVisitors.set(r.county_fips, (set = new Set()));
      set.add(r.visitor);
    }
  }

  out.visitors = allVisitors.size;
  out.sessions = allSessions.size;
  out.visitors7 = visitors7.size;
  out.visitors30 = visitors30.size;

  /*
    NEW versus RETURNING, and the one way this can mislead.

    "New" means: active in the last 30 days, and the first time we ever saw this
    code was also inside those 30 days. Anyone whose first visit predates the
    window counts as returning.

    THE CAVEAT THAT MATTERS: for the first 30 days after this shipped, EVERY
    visitor is necessarily new, because there is no earlier record for anyone to
    be returning from. The page says so rather than letting a meaningless 100%
    be read as a finding.
  */
  for (const v of visitors30) {
    const first = firstSeen.get(v);
    if (first !== undefined && first >= recentFrom) out.newVisitors++;
    else out.returningVisitors++;
  }

  const loyalty = new Map<string, number>();
  for (const b of BUCKETS) loyalty.set(b, 0);
  for (const v of allVisitors) {
    const b = bucketLabel(sessionsOf.get(v)?.size ?? 1);
    loyalty.set(b, (loyalty.get(b) ?? 0) + 1);
  }
  out.loyalty = BUCKETS.map((key) => ({ key, n: loyalty.get(key) ?? 0 }));

  const depth = new Map<string, number>();
  for (const b of BUCKETS) depth.set(b, 0);
  for (const n of lookupsInSession.values()) {
    depth.set(bucketLabel(n), (depth.get(bucketLabel(n)) ?? 0) + 1);
  }
  out.depth = BUCKETS.map((key) => ({ key, n: depth.get(key) ?? 0 }));

  for (const c of counties.values()) c.visitors = countyVisitors.get(c.fips)?.size ?? 0;
  out.byCounty = [...counties.values()].sort(
    (a, b) => b.lookups - a.lookups || a.name.localeCompare(b.name)
  );

  out.byDay = [...days.entries()].sort().map(([day, n]) => ({ day, n }));
  out.byMonth = [...months.entries()]
    .sort()
    .map(([month, m]) => ({ month, lookups: m.lookups, visitors: m.visitors.size }));

  out.byScreen = descend(screens);
  out.byVia = descend(vias);
  out.bySource = descend(sources);
  out.byReferrer = descend(referrers);

  /*
    FEATURES ARE COUNTED IN SESSIONS, NOT ROWS.

    The client already sends at most one row per session per kind+label, but a
    browser with no session storage sends every time. Counting distinct sessions
    here makes the figure mean the same thing either way: "in how many sittings
    did anyone open this". Rows would quietly over-weight privacy-mode visitors.
  */
  const featureSessions = new Map<string, Map<string, Set<string>>>();
  const withEvents = new Set<string>();
  for (const ev of events) {
    if (ev.self) continue;
    const sessionKey = ev.session ?? `~${ev.visitor ?? Math.random()}`;
    withEvents.add(sessionKey);
    let byLabel = featureSessions.get(ev.kind);
    if (!byLabel) featureSessions.set(ev.kind, (byLabel = new Map()));
    let set = byLabel.get(ev.label);
    if (!set) byLabel.set(ev.label, (set = new Set()));
    set.add(sessionKey);
  }
  out.sessionsWithEvents = withEvents.size;
  for (const [kind, byLabel] of featureSessions) {
    out.features[kind] = [...byLabel.entries()]
      .map(([key, set]) => ({ key, n: set.size }))
      .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  }

  return out;
}
