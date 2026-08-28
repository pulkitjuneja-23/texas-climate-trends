/**
 * Round-trip test for the cache encoding.
 *
 * A bug here corrupts stored weather SILENTLY — the site would keep working and
 * keep drawing charts, just from slightly wrong numbers. That is the worst
 * failure mode this project has, so the encoding gets checked rather than
 * trusted.
 *
 * Run: node --experimental-strip-types scripts/encode-roundtrip-test.mts
 */
import { encodeYear, decodeYear } from "../lib/cache/encode.ts";

let failures = 0;

/**
 * Compare by VALUE, not by key order.
 *
 * decodeYear rebuilds `tmean` by assignment, so it lands at the end of the
 * object rather than where it originally sat. JSON has no ordering semantics
 * and nothing reads these by position, so a plain stringify comparison reports
 * a difference that does not exist.
 */
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val
  );
}

function check(name: string, got: unknown, want: unknown) {
  const g = stable(got);
  const w = stable(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) console.log(`        got  ${g}\n        want ${w}`);
}

function roundTrip(records: any[]) {
  const enc = encodeYear(records);
  return decodeYear(enc.records, enc.origin);
}

// 1. The ordinary case: gridMET, tmean is the midpoint, one origin.
const gridmet = [
  { date: "2024-04-10", tmax: 19.75, tmin: 8.85, tmean: 14.3, precip: 38.4, origin: "gridmet" },
  { date: "2024-04-11", tmax: 22.05, tmin: 11.15, tmean: 16.6, precip: 0, origin: "gridmet" },
];
check("gridMET survives the round trip", roundTrip(gridmet), gridmet);
check("gridMET actually gets smaller", encodeYear(gridmet).records[0], {
  date: "2024-04-10",
  tmax: 19.75,
  tmin: 8.85,
  precip: 38.4,
});

// 2. NASA POWER: tmean is an independent measurement, NOT the midpoint. It must
//    be stored verbatim — this is the case that would silently corrupt data.
const power = [
  { date: "2024-04-10", tmax: 20.0, tmin: 10.0, tmean: 16.4, precip: 1.2, origin: "nasapower" },
];
check("POWER's independent tmean survives", roundTrip(power), power);
check(
  "POWER's tmean is NOT dropped",
  Object.prototype.hasOwnProperty.call(encodeYear(power).records[0], "tmean"),
  true
);

// 3. An explicit null tmean must stay null — not be rebuilt as a midpoint.
const explicitNull = [
  { date: "2024-04-10", tmax: 20.0, tmin: 10.0, tmean: null, precip: 0, origin: "nasapower" },
];
check("explicit null tmean stays null", roundTrip(explicitNull), explicitNull);

// 4. A day with no temperatures at all.
const empty = [
  { date: "2024-04-10", tmax: null, tmin: null, tmean: null, precip: 0, origin: "gridmet" },
];
check("all-null day survives", roundTrip(empty), empty);

// 5. Airport stations: origin carries the station id and must come back exactly.
const station = [
  {
    date: "2024-04-10",
    tmax: 21.11,
    tmin: 9.44,
    tmean: 15.28,
    precip: 2.54,
    origin: "stations:ACT",
  },
];
check("station id preserved in origin", roundTrip(station), station);
check("station origin lifted out", encodeYear(station).origin, "stations:ACT");

// 6. Mixed origins in one year — a gridded source spliced with a station fill.
//    Lifting one value out would mislabel the others, so nothing is lifted.
const mixed = [
  { date: "2024-04-10", tmax: 19.75, tmin: 8.85, tmean: 14.3, precip: 0, origin: "gridmet" },
  { date: "2024-04-11", tmax: 21.11, tmin: 9.44, tmean: 15.28, precip: 0, origin: "stations:ACT" },
];
check("mixed origins survive", roundTrip(mixed), mixed);
check("mixed origins are not lifted", encodeYear(mixed).origin, null);

// 7. Backward compatibility: rows written before this encoding have every field
//    present and must pass straight through.
const legacy = [
  { date: "2024-04-10", tmax: 19.75, tmin: 8.85, tmean: 14.3, precip: 0, origin: "gridmet" },
];
check("pre-encoding rows still decode", decodeYear(legacy as any, null), legacy);

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
