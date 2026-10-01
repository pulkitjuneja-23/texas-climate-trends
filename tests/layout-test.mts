/**
 * Tests for the archive layout maths.
 *
 * A mistake here does not throw — it returns a neighbouring field's weather, or
 * a time series shuffled by one day, and everything downstream keeps working.
 * That is the failure this project can least afford, so the arithmetic gets
 * checked directly.
 *
 * Run all tests: npm test
 */
import {
  locate,
  chunkOf,
  extractSeries,
  chunkCounts,
  dayCount,
  addDays,
  PART_CHUNK_PX,
  type Manifest,
  type Part,
} from "../lib/archive/layout.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) console.log(`        got  ${g}\n        want ${w}`);
}

const STEP = 1 / 24;

// A stand-in for the real Texas grid: 260 rows south from 36.6N, 320 columns
// east from 106.7W. Latitude descends, so latStep is negative.
const m: Manifest = {
  version: 1,
  builtAt: "2026-08-27T00:00:00Z",
  lat0: 36.6,
  lon0: -106.7,
  latStep: -STEP,
  lonStep: STEP,
  nLat: 260,
  nLon: 320,
  parts: {
    archive: { start: "1995-01-01", end: "2025-12-31", nDays: 11323 },
    current: { start: "2026-01-01", end: "2026-08-25", nDays: 237 },
  },
  vars: {},
};

// --- locate ---
check("top-left corner is index 0,0", locate(m, 36.6, -106.7)?.latIdx, 0);
check("top-left lon index", locate(m, 36.6, -106.7)?.lonIdx, 0);

const one = locate(m, 36.6 - STEP, -106.7 + STEP);
check("one cell in", [one?.latIdx, one?.lonIdx], [1, 1]);

// Nearest-cell rounding: a point 40% of a cell away must snap back, not forward.
check("rounds to the nearest cell", locate(m, 36.6 - STEP * 0.4, -106.7)?.latIdx, 0);
check("rounds up past halfway", locate(m, 36.6 - STEP * 0.6, -106.7)?.latIdx, 1);

// Out of bounds must be null, never a clamped edge cell — a clamped lookup
// would serve El Paso's weather for a field in New Mexico and look normal.
check("north of coverage is null", locate(m, 40.0, -100.0), null);
check("west of coverage is null", locate(m, 31.0, -120.0), null);
check("east of coverage is null", locate(m, 31.0, -80.0), null);
check("south of coverage is null", locate(m, 20.0, -100.0), null);

const waco = locate(m, 31.549, -97.147);
check(
  "Waco lands within one cell of the point asked for",
  [
    Math.abs((waco?.lat ?? 0) - 31.549) < STEP,
    Math.abs((waco?.lon ?? 0) - -97.147) < STEP,
  ],
  [true, true]
);

// --- chunkOf: the two parts chunk the SAME cell differently ---
const cell = { latIdx: 20, lonIdx: 37 };
check("archive chunks at 4 px", chunkOf("archive", cell), {
  latChunk: 5,
  lonChunk: 9,
  latOffset: 0,
  lonOffset: 1,
});
check("current chunks at 16 px", chunkOf("current", cell), {
  latChunk: 1,
  lonChunk: 2,
  latOffset: 4,
  lonOffset: 5,
});

// A cell exactly on a chunk boundary resets its offsets.
check("archive boundary resets offsets", chunkOf("archive", { latIdx: 8, lonIdx: 12 }), {
  latChunk: 2,
  lonChunk: 3,
  latOffset: 0,
  lonOffset: 0,
});

// --- extractSeries: the stride that would silently scramble everything ---
function buildChunk(part: Part, nDays: number): Int16Array {
  const px = PART_CHUNK_PX[part];
  const c = new Int16Array(nDays * px * px);
  for (let t = 0; t < nDays; t++) {
    for (let la = 0; la < px; la++) {
      for (let lo = 0; lo < px; lo++) {
        c[t * px * px + la * px + lo] = t * 100 + la * 10 + lo;
      }
    }
  }
  return c;
}

const aChunk = buildChunk("archive", 5);
check(
  "archive cell (0,0) reads its own days",
  [...extractSeries("archive", aChunk, { latOffset: 0, lonOffset: 0 }, 5)],
  [0, 100, 200, 300, 400]
);
check(
  "archive cell (2,3) reads its own days",
  [...extractSeries("archive", aChunk, { latOffset: 2, lonOffset: 3 }, 5)],
  [23, 123, 223, 323, 423]
);
check(
  "archive (3,0) is not confused with (0,3)",
  [...extractSeries("archive", aChunk, { latOffset: 3, lonOffset: 0 }, 5)],
  [30, 130, 230, 330, 430]
);

// The same test at the current part's 16 px stride — a stride taken from the
// wrong part would read a neighbouring pixel and look entirely plausible.
const cChunk = buildChunk("current", 4);
check(
  "current cell (5,11) reads its own days",
  [...extractSeries("current", cChunk, { latOffset: 5, lonOffset: 11 }, 4)],
  [61, 161, 261, 361]
);
check(
  "current cell (0,0) reads its own days",
  [...extractSeries("current", cChunk, { latOffset: 0, lonOffset: 0 }, 4)],
  [0, 100, 200, 300]
);

// --- chunk counts, including the ragged edge ---
check("archive chunk grid covers every pixel", chunkCounts(m, "archive"), { lat: 65, lon: 80 });
check("current chunk grid covers every pixel", chunkCounts(m, "current"), { lat: 17, lon: 20 });
check(
  "a grid that does not divide evenly still covers",
  chunkCounts({ ...m, nLat: 261, nLon: 321 }, "archive"),
  { lat: 66, lon: 81 }
);

// --- dates ---
check("dayCount is inclusive of both ends", dayCount("2024-01-01", "2024-01-01"), 1);
check("dayCount spans a leap year", dayCount("2024-01-01", "2024-12-31"), 366);
check("dayCount spans a normal year", dayCount("2023-01-01", "2023-12-31"), 365);
check("addDays crosses a month", addDays("2024-01-31", 1), "2024-02-01");
check("addDays crosses 29 February", addDays("2024-02-28", 1), "2024-02-29");
check("addDays round-trips with dayCount", addDays("1995-01-01", 11322), "2025-12-31");

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
