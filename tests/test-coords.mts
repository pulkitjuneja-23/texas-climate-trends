/**
 * Does the coordinate box accept what people actually paste?
 *
 * Written after two silent failures were found by trying real formats rather
 * than reading the regex: "31.0982 deg N, 97.3428 deg W" parsed as 982/-428,
 * and degrees-with-decimal-minutes parsed as a latitude and a longitude. Both
 * returned a confident wrong place instead of refusing.
 *
 * Run all tests: npm test
 */
import { parseCoords } from "../lib/geo.ts";

/** Temple, TX. */
const T = { lat: 31.0982, lon: -97.3428 };

interface Case {
  label: string;
  input: string;
  /** "temple" = must land on Temple; "reject" = must return null. */
  expect: "temple" | "reject" | { lat: number; lon: number };
}

const CASES: Case[] = [
  { label: "decimal, comma", input: "31.0982, -97.3428", expect: "temple" },
  { label: "decimal, space", input: "31.0982 -97.3428", expect: "temple" },
  { label: "decimal, minus dropped", input: "31.0982, 97.3428", expect: "temple" },
  { label: "decimal + hemispheres", input: "31.0982N, 97.3428W", expect: "temple" },
  { label: "decimal + degree signs", input: "31.0982° N, 97.3428° W", expect: "temple" },
  { label: "DMS with symbols", input: `31°5'53"N 97°20'34"W`, expect: "temple" },
  { label: "DMS with primes", input: "31°5′53″N 97°20′34″W", expect: "temple" },
  { label: "DMS lowercase hemis", input: `31°5'53"n 97°20'34"w`, expect: "temple" },
  { label: "deg + decimal minutes", input: "31 5.892 N 97 20.568 W", expect: "temple" },
  { label: "deg + dec min, symbols", input: `31° 5.892' N, 97° 20.568' W`, expect: "temple" },
  { label: "Google Maps paste", input: "31.0982, -97.3428", expect: "temple" },
  { label: "tab separated", input: "31.0982\t-97.3428", expect: "temple" },
  { label: "newline separated", input: "31.0982\n-97.3428", expect: "temple" },
  { label: "labelled", input: "lat 31.0982 lon -97.3428", expect: "temple" },

  // Elsewhere on Earth — the Texas sign heuristic must not fire.
  { label: "Sydney (S/E)", input: "-33.8688, 151.2093", expect: { lat: -33.8688, lon: 151.2093 } },
  { label: "Sydney with hemis", input: "33.8688S, 151.2093E", expect: { lat: -33.8688, lon: 151.2093 } },

  // Projected systems need a datum and a projection; refusing beats guessing.
  { label: "UTM", input: "14R 657000 3441000", expect: "reject" },
  { label: "MGRS", input: "14RPU5700041000", expect: "reject" },
  { label: "State Plane feet", input: "3125000, 10150000", expect: "reject" },

  // Impossible or unreadable.
  { label: "latitude out of range", input: "982, -428", expect: "reject" },
  { label: "minutes >= 60", input: `31°75'N 97°20'W`, expect: "reject" },
  { label: "one number only", input: "31.0982", expect: "reject" },
  { label: "prose", input: "somewhere near the barn", expect: "reject" },
  { label: "empty", input: "   ", expect: "reject" },
];

let failed = 0;
console.log("  result  case                          input");
for (const c of CASES) {
  const got = parseCoords(c.input);

  let ok: boolean;
  if (c.expect === "reject") {
    ok = got === null;
  } else {
    const want = c.expect === "temple" ? T : c.expect;
    // 0.002 deg is ~200 m — tight enough to catch a real error, loose enough
    // that a DMS value rounded to whole seconds still passes.
    ok =
      got !== null &&
      Math.abs(got.lat - want.lat) < 0.002 &&
      Math.abs(got.lon - want.lon) < 0.002;
  }

  if (!ok) failed++;
  const shown = got ? `${got.lat.toFixed(4)}, ${got.lon.toFixed(4)}` : "(rejected)";
  console.log(
    `  ${ok ? "ok    " : "FAIL  "} ${c.label.padEnd(28)} ${JSON.stringify(c.input).padEnd(32)} -> ${shown}`
  );
}

console.log(
  failed === 0 ? `\nall ${CASES.length} passed` : `\n${failed} of ${CASES.length} FAILED`
);
process.exit(failed === 0 ? 0 : 1);
