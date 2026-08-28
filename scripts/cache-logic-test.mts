/**
 * Checks the year-chunking decisions without needing a Supabase project.
 *
 * These are the calls that decide how much upstream work a request costs, so a
 * mistake here is expensive in exactly the way this whole exercise is meant to
 * fix — e.g. a revisit that re-fetches 27 years instead of one.
 *
 * Run: node --experimental-strip-types scripts/cache-logic-test.mts
 */
import { fetchSpan } from "../lib/cache/span.ts";

let failures = 0;

function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) console.log(`        got  ${g}\n        want ${w}`);
}

const START = "2000-01-01";
const END = "2026-08-27";
const ALL = Array.from({ length: 27 }, (_, i) => 2000 + i);

// Cold cell: everything missing -> fetch the whole requested range.
check("cold cell fetches the full range", fetchSpan(ALL, START, END), {
  start: "2000-01-01",
  end: "2026-08-27",
});

// The case this design exists for: a revisit where only the in-progress year
// has expired. This must NOT re-fetch 27 years.
check("revisit fetches only the current year", fetchSpan([2026], START, END), {
  start: "2026-01-01",
  end: "2026-08-27",
});

// Fully cached -> no upstream call at all.
check("fully cached fetches nothing", fetchSpan([], START, END), null);

// Scattered gaps collapse to one covering span; the merge step then lets fresh
// rows win over the cached years caught in the middle.
check("scattered gaps collapse to one span", fetchSpan([2005, 2026], START, END), {
  start: "2005-01-01",
  end: "2026-08-27",
});

// A single old year must not drag the end date to 31 Dec of that year...
check("one old year stays inside its own year", fetchSpan([2005], START, END), {
  start: "2005-01-01",
  end: "2005-12-31",
});

// ...and must not reach past the requested window either.
check("span never exceeds the request", fetchSpan([1999, 2030], START, END), {
  start: "2000-01-01",
  end: "2026-08-27",
});

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
