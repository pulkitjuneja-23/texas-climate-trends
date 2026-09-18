import { notFound } from "next/navigation";
import { timingSafeEqual } from "node:crypto";
import type { Metadata } from "next";

import { readVisitSummary } from "@/lib/analytics/summary";
import { readAllCounties } from "@/lib/yield/read";
import { projectCounties, fillFor, BINS, NO_DATA_FILL } from "@/lib/analytics/choropleth";
import { formatDate } from "@/lib/format/date";
import s from "./insights.module.css";

/**
 * Private visitor insights.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ANSWERS, AND WHAT IT CANNOT
 * ---------------------------------------------------------------------------
 * Vercel's free plan gives page views and visitor counts but puts the one
 * useful question — WHICH FIELDS are people looking up — behind a Pro-only
 * custom event, and keeps only a rolling month. The visit log answers it for
 * nothing and keeps it forever. This page is how that log is read.
 *
 * It is COUNTY RESOLUTION and can never be finer, because the coordinate is
 * resolved to a county on the server and then discarded — someone's field is
 * not written down anywhere. See lib/analytics/visits.ts for that decision.
 *
 * It counts LOOKUPS, NOT PEOPLE. There is no visitor id of any kind, so one
 * grower moving the pin across five fields is indistinguishable from five
 * growers. Both limits are printed on the page, because a number like this gets
 * quoted later without its caveats attached.
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS GUARDED
 * ---------------------------------------------------------------------------
 * A secret in the query string, compared against INSIGHTS_KEY. With no key set,
 * or the wrong one, the route renders the ordinary 404 — not a login prompt and
 * not a 401, so the page's existence is not advertised to anyone guessing.
 *
 * The honest limits of that: a query-string secret lands in browser history and
 * would travel in a Referer header to any third-party request this page made.
 * It makes none. The data behind it is county-level visit counts with nothing
 * personal in it by construction, so the consequence of a leak is that someone
 * learns the Panhandle is busier than the Valley.
 *
 * NO CLIENT COMPONENT ANYWHERE. The map is server-rendered SVG with native
 * <title> tooltips, which keeps the megabyte of boundary geometry on the server
 * and sidesteps the bundling trap documented in CLAUDE.md for 26 August.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Visitor insights",
  // Belt and braces. Without the key this 404s, so a crawler could not index it
  // anyway — but if the link is ever pasted somewhere public, this still holds.
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
/** Days of history in the activity strip. Longer than this stops being read. */
const STRIP_DAYS = 60;

function pct(n: number, of: number): string {
  if (!of) return "0%";
  const v = (n / of) * 100;
  return v >= 10 ? `${Math.round(v)}%` : `${v.toFixed(1)}%`;
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: { [k: string]: string | string[] | undefined };
}) {
  const expected = process.env.INSIGHTS_KEY;
  const given = searchParams.key;
  if (!expected || tokenMatches(typeof given === "string" ? given : undefined, expected) === false) {
    notFound();
  }

  const [summary, counties] = await Promise.all([readVisitSummary(), readAllCounties()]);

  if (summary.error) {
    return (
      <main className={s.page}>
        <header className={s.head}>
          <h1>Visitor insights</h1>
          <p className={s.sub}>Texas Weather Explorer — private</p>
        </header>
        <div className={s.problem}>
          <h2>Nothing to show yet</h2>
          <p>{summary.error}</p>
        </div>
      </main>
    );
  }

  const counts = new Map(summary.byCounty.map((c) => [c.fips, c.lookups]));
  const map = counties ? projectCounties(counties, MAP_WIDTH) : null;

  // The activity strip is a fixed window ending today, with silent days drawn
  // as gaps rather than omitted — a run of nothing is information, and a chart
  // that only plots the days something happened hides it completely.
  const today = new Date();
  const strip: Array<{ day: string; n: number }> = [];
  const byDay = new Map(summary.byDay.map((d) => [d.day, d.n]));
  for (let i = STRIP_DAYS - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    strip.push({ day: d, n: byDay.get(d) ?? 0 });
  }
  const stripMax = Math.max(1, ...strip.map((d) => d.n));

  const texasLookups = summary.total - summary.outsideTexas;

  return (
    <main className={s.page}>
      <header className={s.head}>
        <h1>Visitor insights</h1>
        <p className={s.sub}>
          Texas Weather Explorer — private.{" "}
          {summary.firstAt
            ? `Recording since ${formatDate(summary.firstAt)}.`
            : "Nothing recorded yet."}
        </p>
      </header>

      {summary.total === 0 && (
        <div className={s.problem}>
          <h2>The log is empty</h2>
          <p>
            The table exists and can be read, but no visits have been recorded.
            That is expected if it was only just created — recording starts with
            the next person who opens the site, and your own browser is excluded
            if you have marked it with <code>?notme=1</code>.
          </p>
        </div>
      )}

      <section className={s.stats}>
        <div className={s.stat}>
          <span className={s.statN}>{summary.total.toLocaleString()}</span>
          <span className={s.statL}>lookups</span>
        </div>
        <div className={s.stat}>
          <span className={s.statN}>{summary.byCounty.length}</span>
          <span className={s.statL}>counties reached</span>
          <span className={s.statF}>of 254</span>
        </div>
        <div className={s.stat}>
          <span className={s.statN}>{summary.last7.toLocaleString()}</span>
          <span className={s.statL}>last 7 days</span>
        </div>
        <div className={s.stat}>
          <span className={s.statN}>{summary.last30.toLocaleString()}</span>
          <span className={s.statL}>last 30 days</span>
        </div>
        <div className={s.stat}>
          <span className={s.statN}>{summary.outsideTexas.toLocaleString()}</span>
          <span className={s.statL}>outside Texas</span>
          <span className={s.statF}>{pct(summary.outsideTexas, summary.total)} of lookups</span>
        </div>
      </section>

      <section className={s.card}>
        <div className={s.cardHead}>
          <h2>Where people looked</h2>
          <p className={s.note}>
            {texasLookups.toLocaleString()} lookups inside Texas, shaded by county.
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
            be drawn. The table below is unaffected.
          </p>
        )}
      </section>

      <section className={s.card}>
        <div className={s.cardHead}>
          <h2>Activity, last {STRIP_DAYS} days</h2>
        </div>
        <div className={s.strip}>
          {strip.map((d) => (
            <span
              key={d.day}
              className={s.bar}
              style={{ height: `${Math.max(2, (d.n / stripMax) * 100)}%` }}
              title={`${formatDate(d.day)} — ${d.n} ${d.n === 1 ? "lookup" : "lookups"}`}
            />
          ))}
        </div>
        <div className={s.stripAxis}>
          <span>{formatDate(strip[0].day)}</span>
          <span>peak {stripMax}/day</span>
          <span>{formatDate(strip[strip.length - 1].day)}</span>
        </div>
      </section>

      {summary.byCounty.length > 0 && (
        <section className={s.card}>
          <div className={s.cardHead}>
            <h2>Counties, most looked at first</h2>
          </div>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>County</th>
                  <th className={s.num}>Lookups</th>
                  <th className={s.num}>Share</th>
                  <th>Most recent</th>
                </tr>
              </thead>
              <tbody>
                {summary.byCounty.map((c) => (
                  <tr key={c.fips}>
                    <td>
                      <i className={s.swatch} style={{ background: fillFor(c.lookups) }} />
                      {c.name}
                    </td>
                    <td className={s.num}>{c.lookups.toLocaleString()}</td>
                    <td className={s.num}>{pct(c.lookups, texasLookups)}</td>
                    <td>{formatDate(c.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {summary.bySource.length > 0 && (
        <section className={s.card}>
          <div className={s.cardHead}>
            <h2>Dataset selected</h2>
            <p className={s.note}>
              Which source was active at the moment of the lookup — almost always
              the default unless someone changed it.
            </p>
          </div>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <tbody>
                {summary.bySource.map((x) => (
                  <tr key={x.source}>
                    <td>{x.source}</td>
                    <td className={s.num}>{x.n.toLocaleString()}</td>
                    <td className={s.num}>{pct(x.n, summary.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className={s.footnotes}>
        <h2>How to read these numbers</h2>
        <ul>
          <li>
            <strong>Lookups, not people.</strong> There is no visitor id, cookie
            or IP address in the log. One grower moving the pin across five
            fields registers five lookups and is indistinguishable from five
            growers. Treat the totals as interest, never as an audience size.
          </li>
          <li>
            <strong>County resolution only.</strong> The coordinate is turned
            into a county on the server and thrown away. Nothing finer exists to
            map, by design — a typed coordinate is somebody&apos;s field.
          </li>
          <li>
            <strong>One row per location, not per page view.</strong> Changing
            source, variable or panel at one spot does not add a row.
          </li>
          <li>
            <strong>{summary.selfTotal.toLocaleString()} lookups</strong> came
            from browsers marked with <code>?notme=1</code> and are excluded from
            every figure above. They are kept rather than dropped so the
            exclusion can be seen to be working — if that number is zero and you
            have been using the site, the mark is not set on this device.
          </li>
          {summary.truncated && (
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
