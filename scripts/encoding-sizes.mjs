/**
 * How much space each candidate encoding change actually saves.
 *
 * Estimating this by eye has already gone wrong once (5-10 KB guessed, 52 KB
 * measured), so it gets measured on a real stored year rather than argued from
 * character counts.
 *
 * Run with the dev server up: node scripts/encoding-sizes.mjs
 */
const url =
  "http://localhost:3000/api/history?lat=33.90&lon=-98.50&startYear=2024&endYear=2024&source=gridmet";

const res = await fetch(url);
const json = await res.json();

// `provenance` is added by the route for the client; it is not what gets stored.
const stored = json.records.map(({ provenance, ...r }) => r);

const bytes = (o) => Buffer.byteLength(JSON.stringify(o));
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

const variants = {
  "now, 2 decimals": stored,
  "temps at 1 decimal": stored.map((r) => ({
    ...r,
    tmax: r1(r.tmax),
    tmin: r1(r.tmin),
    tmean: r1(r.tmean),
  })),
  'drop "origin"': stored.map(({ origin, ...r }) => r),
  "drop origin + tmean": stored.map(({ origin, tmean, ...r }) => r),
  "all three together": stored.map(({ origin, tmean, ...r }) => ({
    ...r,
    tmax: r1(r.tmax),
    tmin: r1(r.tmin),
  })),
};

const base = bytes(stored);
console.log(`one year, ${stored.length} days\n`);
for (const [label, v] of Object.entries(variants)) {
  const b = bytes(v);
  const saved = ((1 - b / base) * 100).toFixed(1);
  console.log(
    `  ${label.padEnd(22)} ${String(b).padStart(6)} B   ${
      label.startsWith("now") ? "" : `saves ${saved.padStart(5)}%`
    }`
  );
}

console.log(`\nsample record now:  ${JSON.stringify(stored[100])}`);
console.log(
  `sample, all three:  ${JSON.stringify(variants["all three together"][100])}`
);
