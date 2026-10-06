import { notFound } from "next/navigation";
import { timingSafeEqual } from "node:crypto";
import type { Metadata } from "next";

import {
  readAnalytics,
  RANGES,
  rangeFor,
  type Analytics,
  type Range,
  type Tally,
} from "@/lib/analytics/summary";
import { readAllCounties } from "@/lib/yield/read";
import { projectCounties, fillFor, BINS, NO_DATA_FILL } from "@/lib/analytics/choropleth";
import { formatDate } from "@/lib/format/date";
import { centralParts, formatCentral, formatCentralHour } from "@/lib/format/central";
import s from "./insights.module.css";

/**
 * Private visitor insights.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ANSWERS, AND WHAT IT CANNOT
 * ---------------------------------------------------------------------------
 * Vercel's free plan gives page views and a rough daily visitor count, but puts
 * the questions actually worth answering — which fields people look up, and
 * what they came to do — behind a Pro-only custom event, and keeps only a
 * rolling month. The two logs here answer them for nothing and keep them
 * forever.
 *
 * It is COUNTY RESOLUTION and can never be finer, because the coordinate is
 * resolved to a county on the server and then discarded. See
 * lib/analytics/visits.ts for that decision.
 *
 * Since 18 September 2026 it can also count PEOPLE rather than only lookups,
 * using a random per-browser code. The limits of that are printed on the page
 * rather than left to be discovered: a code is a browser, so one grower with a
 * phone and a laptop is two, and clearing site data makes somebody new.
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS GUARDED
 * ---------------------------------------------------------------------------
 * A secret in the query string, compared against INSIGHTS_KEY. With no key set,
 * or the wrong one, the route renders the ordinary 404 — not a login prompt and
 * not a 401, so the page's existence is not advertised to anyone guessing.
 *
 * NO CLIENT COMPONENT ANYWHERE. Every chart is markup the server already knows
 * the numbers for. That keeps the megabyte of county geometry on the server and
 * sidesteps the bundling trap documented in CLAUDE.md for 26 August.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Visitor insights",
  robots: { index: false, follow: false },
};

/**
 * Constant-time comparison.
 *
 * A remote timing attack against a random token over HTTPS is not a practical
 * threat here, and the length check below leaks the length regardless. It is
 * four lines and removes the question, which is worth more than the argument.
 */
function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const MAP_WIDTH = 900;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Ids are what the app stores; these are what a person reads.
 *
 * Anything missing falls through to the raw id rather than being hidden, so a
 * newly tracked value shows up as soon as it is recorded instead of silently
 * vanishing from the chart until someone remembers to add it here.
 */
const LABELS: Record<string, string> = {
  // panels
  season: "Season tracker",
  analog: "Similar years",
  forecast: "Forecast",
  trend: "Year-by-year trend",
  // variables
  precip: "Rainfall",
  tmax: "Daily high",
  tmin: "Daily low",
  tmean: "Mean temperature",
  gdd: "Growing degree days",
  dtr: "Day-night range",
  et: "Water used (ET)",
  balance: "Water balance",
  eto: "Reference ET",
  // crops
  corn: "Corn / sorghum",
  cotton: "Cotton",
  wheat: "Wheat",
  // how the pin got there
  map: "Clicked the map",
  search: "Searched a town",
  coords: "Typed coordinates",
  gps: "Used device GPS",
  link: "Opened a shared link",
  default: "Did not choose (landed on the default)",
  // screens
  phone: "Phone",
  tablet: "Tablet",
  desktop: "Desktop",
  // units
  imperial: "Inches and °F",
  metric: "Millimetres and °C",
  // sources
  gridmet: "gridMET",
  nasapower: "NASA POWER",
  daymet: "Daymet",
  stations: "Airport stations",
  openmeteo: "Open-Meteo",
  // exports
  "csv:season": "CSV — season tracker",
  "csv:trend": "CSV — year-by-year",
  "figure:season": "Figure — season tracker",
  "figure:trend": "Figure — year-by-year",
};

const KIND_TITLES: Record<string, string> = {
  panel: "Which panel they opened",
  variable: "Which variable on the season chart",
  trend: "Which variable on the year-by-year chart",
  crop: "Which crop, when looking at growing degree days",
  source: "Which dataset",
  units: "Which units",
  export: "What they downloaded",
};

const KIND_ORDER = ["panel", "variable", "export", "trend", "crop", "source", "units"];

function label(id: string): string {
  return LABELS[id] ?? id;
}

function pct(n: number, of: number): string {
  if (!of) return "0%";
  const v = (n / of) * 100;
  return v >= 10 ? `${Math.round(v)}%` : `${v.toFixed(1)}%`;
}

/** A horizontal bar list. Shares are of `of`, which is not always the sum. */
function BarList({
  items,
  of,
  empty = "Nothing recorded yet.",
}: {
  items: Tally[];
  of: number;
  empty?: string;
}) {
  if (!items.length || !of) return <p className={s.note}>{empty}</p>;
  const max = Math.max(...items.map((i) => i.n), 1);
  return (
    <ul className={s.bars}>
      {items.map((i) => (
        <li key={i.key}>
          <span className={s.barLabel}>{label(i.key)}</span>
          <span className={s.barTrack}>
            {/* Width is relative to the LARGEST row so short bars stay readable;
                the number beside it is the share of the real total. */}
            <span className={s.barFill} style={{ width: `${(i.n / max) * 100}%` }} />
          </span>
          <span className={s.barN}>
            {i.n.toLocaleString()} <span className={s.barPct}>{pct(i.n, of)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Vertical bars for a fixed-length cycle: hours of the day, days of the week. */
function Cycle({ values, ticks }: { values: number[]; ticks: string[] }) {
  const max = Math.max(...values, 1);
  const total = values.reduce((a, b) => a + b, 0);
  if (!total) return <p className={s.note}>Nothing recorded yet.</p>;
  return (
    <div className={s.cycle}>
      {values.map((v, i) => (
        <div key={i} className={s.cycleCol}>
          <div className={s.cycleBarWrap}>
            <div
              className={s.cycleBar}
              style={{ height: `${Math.max(v ? 4 : 0, (v / max) * 100)}%` }}
              title={`${ticks[i]} — ${v} ${v === 1 ? "lookup" : "lookups"}`}
            />
          </div>
          <span className={s.cycleTick}>{ticks[i]}</span>
        </div>
      ))}
    </div>
  );
}

interface Bucket {
  n: number;
  /** Tooltip text. */
  label: string;
}

/**
 * The activity chart's bars, sized to the window.
 *
 * Short windows are cut into equal slices counted back from now (an hour in
 * five-minute slices, a day in hours). From a month up the bars are Central
 * CALENDAR days, or weeks of them, because "Tuesday" is how a person reads a
 * day and a rolling 24 hours ending at 3:40 PM is not.
 */
function activity(a: Analytics, range: Range): { bars: Bucket[]; from: string; to: string; unit: string } {
  const now = a.now;
  const sliceFor: Record<string, [number, string]> = {
    "1h": [5 * MINUTE, "5 minutes"],
    "3h": [15 * MINUTE, "15 minutes"],
    "6h": [15 * MINUTE, "15 minutes"],
    "12h": [30 * MINUTE, "30 minutes"],
    "24h": [HOUR, "hour"],
    "3d": [HOUR, "hour"],
    "7d": [6 * HOUR, "6 hours"],
  };
  const slice = sliceFor[range.id];
  if (slice && range.ms !== null) {
    const [step, unit] = slice;
    const count = Math.round(range.ms / step);
    const bars: Bucket[] = Array.from({ length: count }, (_, i) => {
      const start = now - (count - i) * step;
      return { n: 0, label: step >= HOUR ? formatCentralHour(start) : formatCentral(start) };
    });
    for (const t of a.times) {
      const k = count - 1 - Math.floor((now - t) / step);
      if (k >= 0 && k < count) bars[k].n++;
    }
    for (const b of bars) b.label = `${b.label} — ${b.n} ${b.n === 1 ? "lookup" : "lookups"}`;
    return { bars, from: formatCentral(now - range.ms), to: "now", unit };
  }

  // Calendar days, Central. Stepping twelve hours and de-duplicating can never
  // skip a day, even across the two daylight-saving changes.
  const start = range.ms !== null ? now - range.ms : a.firstAt ? Date.parse(a.firstAt) : now;
  const days: string[] = [];
  for (let t = start; t <= now + HOUR; t += 12 * HOUR) {
    const d = centralParts(Math.min(t, now)).day;
    if (days[days.length - 1] !== d) days.push(d);
  }
  const perDay = new Map(a.byDay.map((d) => [d.day, d.n]));
  if (days.length <= 120) {
    const bars = days.map((d) => {
      const n = perDay.get(d) ?? 0;
      return { n, label: `${formatDate(d)} — ${n} ${n === 1 ? "lookup" : "lookups"}` };
    });
    return { bars, from: formatDate(days[0]), to: formatDate(days[days.length - 1]), unit: "day" };
  }
  const bars: Bucket[] = [];
  for (let i = 0; i < days.length; i += 7) {
    const week = days.slice(i, i + 7);
    const n = week.reduce((sum, d) => sum + (perDay.get(d) ?? 0), 0);
    bars.push({
      n,
      label: `Week of ${formatDate(week[0])} — ${n} ${n === 1 ? "lookup" : "lookups"}`,
    });
  }
  return { bars, from: formatDate(days[0]), to: formatDate(days[days.length - 1]), unit: "week" };
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: { [k: string]: string | string[] | undefined };
}) {
  const expected = process.env.INSIGHTS_KEY;
  const given = searchParams.key;
  if (!expected || !tokenMatches(typeof given === "string" ? given : undefined, expected)) {
    notFound();
  }

  const key = given as string;
  const range = rangeFor(typeof searchParams.range === "string" ? searchParams.range : undefined);
  const [a, counties] = await Promise.all([readAnalytics(range.ms), readAllCounties()]);
  const span = range.ms === null ? "all time" : `the last ${range.label}`;

  /*
    The window picker. Plain links, so it needs no client JavaScript: choosing a
    window reloads the page with ?range= set. The key is carried in each link
    because the page 404s without it. /insights is served with
    Referrer-Policy: no-referrer, so these links do not leak it anywhere.
  */
  const rangeBar = (
    <nav className={s.rangeBar} aria-label="Time window">
      <span className={s.rangeL}>Show</span>
      {RANGES.map((r) => (
        <a
          key={r.id}
          href={`/insights?key=${encodeURIComponent(key)}&range=${r.id}`}
          className={r.id === range.id ? s.rangeOn : undefined}
          aria-current={r.id === range.id ? "page" : undefined}
        >
          {r.label}
        </a>
      ))}
    </nav>
  );

  if (a.error) {
    return (
      <main className={s.page}>
        <header className={s.head}>
          <h1>Visitor insights</h1>
          <p className={s.sub}>Texas Weather Explorer — private</p>
        </header>
        <div className={s.problem}>
          <h2>Nothing to show yet</h2>
          <p>{a.error}</p>
        </div>
      </main>
    );
  }

  const counts = new Map(a.byCounty.map((c) => [c.fips, c.lookups]));
  const map = counties ? projectCounties(counties, MAP_WIDTH) : null;
  const texasLookups = a.lookups - a.outsideTexas;

  /*
    HOW CONCENTRATED IS THE INTEREST?

    This replaced a region rollup, which was built and then removed on
    18 September 2026. Every mechanical way of cutting Texas into named regions
    produced labels that contradict what anyone here knows — equal thirds of the
    bounding box put Bell County in "East Texas" because El Paso drags the
    western edge out, and cutting by county density instead filed Austin, Corpus
    Christi and the Valley together as "South Central". The real answer is the
    AgriLife extension districts, which are a published list this repository
    does not have. A confident wrong answer is worse than a coarse right one, so
    the map stays as the geographic answer and this says only what can be
    counted: how concentrated use is, and how much of the state it has not
    reached.
  */
  const top5 = a.byCounty.slice(0, 5).reduce((sum, c) => sum + c.lookups, 0);
  const countiesUntouched = 254 - a.byCounty.length;

  const act = activity(a, range);
  const actMax = Math.max(1, ...act.bars.map((b) => b.n));

  /*
    Can the new-versus-returning split mean anything for this window?

    Only if the window starts AFTER recording began. Otherwise there is no
    earlier record for anyone to be returning from, so everyone is new by
    definition — "100% new" would be a fact about the calendar dressed up as a
    finding, so it is labelled instead.
  */
  const firstMs = a.firstAt ? Date.parse(a.firstAt) : null;
  const splitIsMeaningful = a.windowFrom !== null && firstMs !== null && a.windowFrom > firstMs;
  const active = a.newVisitors + a.returningVisitors;

  return (
    <main className={s.page}>
      <header className={s.head}>
        <h1>Visitor insights</h1>
        <p className={s.sub}>
          Texas Weather Explorer — private.{" "}
          {a.firstAt ? `Recording since ${formatCentral(a.firstAt)}.` : "Nothing recorded yet."}{" "}
          All dates and times are Texas Central time.
        </p>
      </header>

      {rangeBar}

      {a.warnings.map((w) => (
        <div key={w} className={s.problem}>
          <p>{w}</p>
        </div>
      ))}

      {a.lookups === 0 && a.firstAt !== null && (
        <div className={s.problem}>
          <h2>Nobody in {span}</h2>
          <p>
            No lookups were recorded in this window. Pick a longer one above.
          </p>
        </div>
      )}

      {a.lookups === 0 && a.firstAt === null && (
        <div className={s.problem}>
          <h2>The log is empty</h2>
          <p>
            The tables exist and can be read, but no visits have been recorded.
            That is expected if they were only just created — recording starts
            with the next person who opens the site, and your own browser is
            excluded if you have marked it with <code>?notme=1</code>.
          </p>
        </div>
      )}

      {/* ---- headline ---- */}
      <section className={s.stats}>
        <div className={s.stat}>
          <span className={s.statN}>{a.visitors.toLocaleString()}</span>
          <span className={s.statL}>people</span>
          <span className={s.statF}>distinct browsers, {span}</span>
        </div>
        <div className={s.stat}>
          <span className={s.statN}>{a.lookups.toLocaleString()}</span>
          <span className={s.statL}>lookups</span>
          <span className={s.statF}>{a.sessions.toLocaleString()} separate sittings</span>
        </div>
        <div className={s.stat}>
          <span className={s.statN}>{splitIsMeaningful ? a.newVisitors.toLocaleString() : "—"}</span>
          <span className={s.statL}>first-time visitors</span>
          <span className={s.statF}>
            {splitIsMeaningful
              ? `${a.returningVisitors.toLocaleString()} came back`
              : "needs a shorter window"}
          </span>
        </div>
        <div className={s.stat}>
          <span className={s.statN} style={{ fontSize: "1rem", lineHeight: 1.3 }}>
            {a.lastAt ? formatCentral(a.lastAt) : "—"}
          </span>
          <span className={s.statL}>latest lookup</span>
        </div>
        <div className={s.stat}>
          <span className={s.statN}>{a.byCounty.length}</span>
          <span className={s.statL}>counties reached</span>
          <span className={s.statF}>of 254</span>
        </div>
        <div className={s.stat}>
          <span className={s.statN}>{a.outsideTexas.toLocaleString()}</span>
          <span className={s.statL}>clicks outside Texas</span>
          <span className={s.statF}>{pct(a.outsideTexas, a.lookups)} of lookups</span>
        </div>
      </section>

      {/* ---- new vs returning ---- */}
      <section className={s.card}>
        <div className={s.cardHead}>
          <h2>New and returning, {span}</h2>
          {!splitIsMeaningful && (
            <p className={s.note}>
              <strong>Not readable for this window.</strong> It reaches back to
              when recording began
              {a.firstAt ? ` (${formatCentral(a.firstAt)})` : ""}, so nobody{" "}
              <em>can</em> be returning from before it and everyone shows as new.
              Pick a shorter window above to see who came back.
            </p>
          )}
        </div>
        {active > 0 && splitIsMeaningful ? (
          <>
            <div className={s.split}>
              <div
                className={s.splitNew}
                style={{ flexGrow: Math.max(a.newVisitors, 0.001) }}
                title={`${a.newVisitors} new`}
              />
              <div
                className={s.splitOld}
                style={{ flexGrow: Math.max(a.returningVisitors, 0.001) }}
                title={`${a.returningVisitors} returning`}
              />
            </div>
            <div className={s.splitKey}>
              <span>
                <i className={s.swNew} /> {a.newVisitors.toLocaleString()} first time here (
                {pct(a.newVisitors, active)})
              </span>
              <span>
                <i className={s.swOld} /> {a.returningVisitors.toLocaleString()} came back (
                {pct(a.returningVisitors, active)})
              </span>
            </div>
          </>
        ) : active === 0 ? (
          <p className={s.note}>No identified visitors in {span}.</p>
        ) : null}

        <div className={s.two}>
          <div>
            <h3 className={s.h3}>How many sittings each person has had</h3>
            <BarList items={a.loyalty.filter((l) => l.n > 0)} of={a.visitors} />
          </div>
          <div>
            <h3 className={s.h3}>How many fields they check in one sitting</h3>
            <BarList items={a.depth.filter((d) => d.n > 0)} of={a.sessions} />
          </div>
        </div>
      </section>

      {/* ---- the map ---- */}
      <section className={s.card}>
        <div className={s.cardHead}>
          <h2>Where people looked</h2>
          <p className={s.note}>
            {texasLookups.toLocaleString()} lookups inside Texas in {span}, shaded by county.
          </p>
        </div>

        {map ? (
          <>
            <div className={s.mapWrap}>
              <svg
                viewBox={`0 0 ${map.width} ${map.height}`}
                className={s.map}
                role="img"
                aria-label="Texas counties shaded by number of lookups"
              >
                {map.paths.map((p) => {
                  const n = counts.get(p.fips) ?? 0;
                  return (
                    <path key={p.fips} d={p.d} fill={fillFor(n)} className={s.county}>
                      <title>{`${p.name} County — ${n.toLocaleString()} ${
                        n === 1 ? "lookup" : "lookups"
                      }`}</title>
                    </path>
                  );
                })}
              </svg>
            </div>

            <div className={s.legend}>
              <span className={s.legendL}>Lookups</span>
              <span className={s.key}>
                <i style={{ background: NO_DATA_FILL }} />
                none
              </span>
              {BINS.map((b) => (
                <span key={b.min} className={s.key}>
                  <i style={{ background: b.fill }} />
                  {b.label}
                </span>
              ))}
            </div>
            <p className={s.hint}>Hover a county for its name and count.</p>
          </>
        ) : (
          <p className={s.note}>
            The county boundary file could not be read from R2, so the map cannot
            be drawn. Everything below is unaffected.
          </p>
        )}
      </section>

      {a.byCounty.length > 0 && (
        <section className={s.card}>
          <div className={s.cardHead}>
            <h2>Counties, most looked at first</h2>
            <p className={s.note}>
              The five busiest counties account for{" "}
              <strong>{pct(top5, texasLookups)}</strong> of all Texas lookups.{" "}
              <strong>{countiesUntouched}</strong> of the 254 counties have never
              been looked at — the clearest list of where this has not reached yet.
            </p>
          </div>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>County</th>
                  <th className={s.num}>Lookups</th>
                  <th className={s.num}>People</th>
                  <th className={s.num}>Share</th>
                  <th>Most recent</th>
                </tr>
              </thead>
              <tbody>
                {a.byCounty.map((c) => (
                  <tr key={c.fips}>
                    <td>
                      <i className={s.swatch} style={{ background: fillFor(c.lookups) }} />
                      {c.name}
                    </td>
                    <td className={s.num}>{c.lookups.toLocaleString()}</td>
                    <td className={s.num}>{c.visitors.toLocaleString()}</td>
                    <td className={s.num}>{pct(c.lookups, texasLookups)}</td>
                    <td>{formatCentral(c.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ---- over time ---- */}
      <section className={s.card}>
        <div className={s.cardHead}>
          <h2>Activity, {span}</h2>
          <p className={s.note}>One bar per {act.unit}. Hover a bar for its count.</p>
        </div>
        <div className={s.strip}>
          {act.bars.map((b, i) => (
            <span
              key={i}
              className={s.bar}
              style={{ height: `${Math.max(2, (b.n / actMax) * 100)}%` }}
              title={b.label}
            />
          ))}
        </div>
        <div className={s.stripAxis}>
          <span>{act.from}</span>
          <span>
            peak {actMax} per {act.unit}
          </span>
          <span>{act.to}</span>
        </div>

        {a.byMonth.length > 1 && (
          <div className={s.tableWrap} style={{ marginTop: 16 }}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Month</th>
                  <th className={s.num}>Lookups</th>
                  <th className={s.num}>People</th>
                </tr>
              </thead>
              <tbody>
                {[...a.byMonth].reverse().map((m) => (
                  <tr key={m.month}>
                    <td>{formatDate(`${m.month}-01`).replace(/ \d+,/, "")}</td>
                    <td className={s.num}>{m.lookups.toLocaleString()}</td>
                    <td className={s.num}>{m.visitors.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={s.card}>
        <div className={s.cardHead}>
          <h2>When they look</h2>
          <p className={s.note}>
            Texas Central time, {span}. El Paso runs an hour behind, so its
            visits show an hour later than its own clocks read.
          </p>
        </div>
        <h3 className={s.h3}>Hour of day</h3>
        <Cycle
          values={a.byHour}
          ticks={a.byHour.map((_, i) => (i % 3 === 0 ? String(i) : ""))}
        />
        <h3 className={s.h3} style={{ marginTop: 18 }}>
          Day of week
        </h3>
        <Cycle values={a.byWeekday} ticks={WEEKDAYS} />
      </section>

      {/* ---- how they arrived ---- */}
      <section className={s.card}>
        <div className={s.cardHead}>
          <h2>How they arrive</h2>
        </div>
        <div className={s.two}>
          <div>
            <h3 className={s.h3}>Screen they read it on</h3>
            <BarList items={a.byScreen} of={a.lookups} />
          </div>
          <div>
            <h3 className={s.h3}>How they placed the pin</h3>
            <BarList items={a.byVia} of={a.lookups} />
          </div>
        </div>
        <div className={s.two} style={{ marginTop: 6 }}>
          <div>
            <h3 className={s.h3}>Dataset selected</h3>
            <BarList items={a.bySource} of={a.lookups} />
          </div>
          <div>
            <h3 className={s.h3}>Referred from</h3>
            <BarList
              items={a.byReferrer.slice(0, 10)}
              of={a.lookups}
              empty="Nobody arrived from a link on another site — they typed the address, used a bookmark, or came from an app that sends no referrer (most messaging apps and email clients)."
            />
          </div>
        </div>
      </section>

      {/* ---- what they came for ---- */}
      <section className={s.card}>
        <div className={s.cardHead}>
          <h2>What they came for</h2>
          <p className={s.note}>
            Counted in <strong>sittings</strong>, not clicks — each thing is
            recorded at most once per visit, so this reads as &ldquo;in what
            fraction of visits did anyone open this&rdquo; rather than rewarding
            whoever clicked most. Out of {a.sessionsWithEvents.toLocaleString()}{" "}
            sittings that recorded anything.
          </p>
        </div>
        {Object.keys(a.features).length === 0 ? (
          <p className={s.note}>
            Nothing recorded yet. This fills in as people use the site.
          </p>
        ) : (
          <div className={s.two}>
            {KIND_ORDER.filter((k) => a.features[k]?.length).map((kind) => (
              <div key={kind}>
                <h3 className={s.h3}>{KIND_TITLES[kind] ?? kind}</h3>
                <BarList items={a.features[kind]} of={a.sessionsWithEvents} />
              </div>
            ))}
            {Object.keys(a.features)
              .filter((k) => !KIND_ORDER.includes(k))
              .map((kind) => (
                <div key={kind}>
                  <h3 className={s.h3}>{kind}</h3>
                  <BarList items={a.features[kind]} of={a.sessionsWithEvents} />
                </div>
              ))}
          </div>
        )}
      </section>

      {/* ---- caveats ---- */}
      <section className={s.footnotes}>
        <h2>How to read these numbers</h2>
        <ul>
          <li>
            <strong>&ldquo;People&rdquo; means browsers.</strong> One grower who
            uses a phone in the field and a laptop at home counts as two, and
            anyone who clears their browsing data becomes somebody new. It is a
            good estimate, not a headcount — and it is the closest thing to one
            that does not involve asking people to log in.
          </li>
          <li>
            <strong>{a.unidentified.toLocaleString()} lookups</strong> carry no
            visitor code, so they count in the lookup totals but cannot be
            attributed to a person. There are two causes and this figure cannot
            tell them apart: visits recorded before 18 September 2026, when codes
            did not exist yet, and browsers that refuse to store one (private
            windows, strict privacy settings). Either way it nudges the visitor
            count slightly low and the &ldquo;new&rdquo; share slightly high.
          </li>
          <li>
            <strong>County resolution only.</strong> The coordinate is turned
            into a county on the server and thrown away — a typed coordinate is
            somebody&apos;s field. Nothing finer exists to map, by design.
          </li>
          <li>
            <strong>One lookup per location, not per page view.</strong> Changing
            source, variable or panel at one spot does not add a lookup.
          </li>
          <li>
            <strong>{a.selfLookups.toLocaleString()} lookups</strong> in {span} came from
            browsers marked with <code>?notme=1</code> and are excluded from
            every figure above. They are kept rather than dropped so the
            exclusion can be seen to be working — if that number is zero and you
            have been using the site, the mark is not set on this device.
          </li>
          {a.truncated && (
            <li>
              <strong>The log has outgrown this page.</strong> Only the most
              recent rows were read, so the earliest history is missing from
              these totals. Time to move the counting into a Postgres view.
            </li>
          )}
        </ul>
      </section>
    </main>
  );
}
