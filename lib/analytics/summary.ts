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

import { centralParts } from "@/lib/format/central";

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

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * The windows the page can be cut to, picked from the bar at its top.
 *
 * Every figure on the page is computed for the chosen window. Nothing is
 * stored or cached per window: the page already reads the whole log on every
 * load, so a window is a filter applied to rows that are in memory anyway.
 */
export const RANGES = [
  { id: "1h", label: "1 hour", ms: HOUR },
  { id: "3h", label: "3 hours", ms: 3 * HOUR },
  { id: "6h", label: "6 hours", ms: 6 * HOUR },
  { id: "12h", label: "12 hours", ms: 12 * HOUR },
  { id: "24h", label: "24 hours", ms: DAY },
  { id: "3d", label: "3 days", ms: 3 * DAY },
  { id: "7d", label: "7 days", ms: 7 * DAY },
  { id: "30d", label: "30 days", ms: 30 * DAY },
  { id: "1y", label: "1 year", ms: 365 * DAY },
  { id: "all", label: "All time", ms: null },
] as const;

export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE = "all";

export function rangeFor(id: string | undefined): Range {
  return RANGES.find((r) => r.id === id) ?? RANGES.find((r) => r.id === DEFAULT_RANGE)!;
}

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

  /** First real lookup EVER, whatever the window: "recording since". */
  firstAt: string | null;
  /** Most recent real lookup inside the window. */
  lastAt: string | null;

  /** Start of the chosen window (epoch ms), or null for all time. */
  windowFrom: number | null;
  /** When the figures were computed, epoch ms. The window ends here. */
  now: number;
  /** Every real lookup in the window, epoch ms, oldest first. Feeds the activity chart. */
  times: number[];

  /** Visitors active in the window whose FIRST ever visit was also inside it. */
  newVisitors: number;
  /** Active in the window, but first seen before it. */
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
  /** 24 entries, index = hour in Central time. */
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
    windowFrom: null,
    now: Date.now(),
    times: [],
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

export async function readAnalytics(windowMs: number | null = null): Promise<Analytics> {
  if (!BASE || !KEY) {
    return blank(
      "SUPABASE_URL and SUPABASE_SERVICE_KEY are not both set on this deployment, " +
        "so there is no database to read."
    );
  }

  const [v, e] = await Promise.all([
    readTable<RawVisit>(
      "visits",
      "at,county_fips,county_name,source,via,referrer,visitor,session,screen,self",
      // The shape this table had before 18 September 2026.
      "at,county_fips,county_name,source,self"
    ),
    readTable<RawEvent>("events", "at,kind,label,visitor,session,self"),
  ]);

  if (!v.ok) {
    return blank(
      v.missing
        ? "The `visits` table does not exist yet, so nothing has been recorded. " +
            "Create it by running supabase/analytics.sql in the Supabase SQL editor. Recording " +
            "starts with the next visitor — there is no way to backfill what was missed."
        : `Could not read the visit log: ${v.why}.`
    );
  }

  const out = fold(v.rows, e.ok ? e.rows : [], v.truncated || (e.ok && e.truncated), windowMs);

  if (v.reduced) {
    out.warnings.push(
      "The database is older than the site. The `visits` table does not have the " +
        "columns that identify people, so the sections about visitors, devices, timing " +
        "and how the pin was placed are empty — lookups and counties are unaffected. " +
        "Run supabase/analytics.sql in the Supabase SQL editor; it adds them in a minute."
    );
  }

  if (!e.ok) {
    out.warnings.push(
      e.missing
        ? "The `events` table does not exist yet, so the sections about what people " +
            "used are empty. Run supabase/analytics.sql to create it; the " +
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
export function fold(
  visits: RawVisit[],
  events: RawEvent[],
  truncated: boolean,
  windowMs: number | null = null,
  now: number = Date.now()
): Analytics {
  const out = blank(null);
  out.truncated = truncated;
  out.now = now;
  const from = windowMs === null ? -Infinity : now - windowMs;
  out.windowFrom = windowMs === null ? null : from;

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
  /**
   * visitor -> epoch ms of their first ever lookup. Taken over the WHOLE log,
   * not the window: whether somebody is new or returning depends on what came
   * before the window, which is exactly what the window leaves out.
   */
  const firstSeen = new Map<string, number>();
  for (const r of visits) {
    if (r.self) continue;
    if (out.firstAt === null) out.firstAt = r.at;
    if (!r.visitor) continue;
    const t = Date.parse(r.at);
    const prev = firstSeen.get(r.visitor);
    if (prev === undefined || t < prev) firstSeen.set(r.visitor, t);
  }
  /** visitor -> the distinct sessions they have had. */
  const sessionsOf = new Map<string, Set<string>>();
  /** session -> how many lookups it contained. */
  const lookupsInSession = new Map<string, number>();

  for (const r of visits) {
    const t = Date.parse(r.at);
    if (!(t >= from)) continue;
    if (r.self) {
      out.selfLookups++;
      continue;
    }
    out.lookups++;
    out.lastAt = r.at;
    out.times.push(t);

    if (r.visitor) {
      allVisitors.add(r.visitor);
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

    // `at` comes back in UTC. Slicing the date off it gave the UTC day, which
    // put every visit after about 7 PM in Texas on the following date (fixed
    // 5 October 2026). Days, months, hours and weekdays are all Central time
    // now, so the whole page reads on one clock.
    //
    // Hour and weekday used to come from the visitor's own clock, sent with the
    // beacon. That is truer for El Paso, an hour behind, but it also put
    // visitors abroad on their own clocks and disagreed with the rest of the
    // page. The beacon still sends them; they are simply not read here.
    const c = centralParts(t);
    days.set(c.day, (days.get(c.day) ?? 0) + 1);

    let mo = months.get(c.month);
    if (!mo) months.set(c.month, (mo = { lookups: 0, visitors: new Set() }));
    mo.lookups++;
    if (r.visitor) mo.visitors.add(r.visitor);

    out.byHour[c.hour]++;
    out.byWeekday[c.weekday]++;

    bump(screens, r.screen);
    bump(vias, r.via);
    bump(sources, r.source ?? "(not recorded)");
    bump(referrers, r.referrer);

    if (!r.county_fips) {
      out.outsideTexas++;
      continue;
    }
    const ct = counties.get(r.county_fips);
    if (ct) {
      ct.lookups++;
      ct.lastAt = r.at;
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

  /*
    NEW versus RETURNING, and the one way this can mislead.

    "New" means: active in the chosen window, and the first time we ever saw
    this code was also inside it. Anyone whose first visit predates the window
    counts as returning.

    THE CAVEAT THAT MATTERS: for "All time", or any window reaching back to the
    start of the log, EVERY visitor is necessarily new, because there is no
    earlier record for anyone to be returning from. The page says so rather
    than letting a meaningless 100% be read as a finding.
  */
  for (const v of allVisitors) {
    const first = firstSeen.get(v);
    if (first !== undefined && first >= from) out.newVisitors++;
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
    if (ev.self || !(Date.parse(ev.at) >= from)) continue;
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
