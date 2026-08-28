/**
 * Build the Texas gridMET archive and upload it to R2.
 *
 * WHAT IT DOES
 * Downloads gridMET from the University of Idaho for the Texas bounding box,
 * turns it inside out — from "all of Texas on one day" into "one field across
 * thirty years" — and writes it as a Zarr store. That transposition is the
 * whole point: it changes a farmer's lookup from an 18-82 second Earth Engine
 * computation into a couple of small downloads.
 *
 * USAGE
 *   node --experimental-strip-types scripts/ingest-gridmet.mts --out ./tmp/zarr
 *   node --experimental-strip-types scripts/ingest-gridmet.mts --r2
 *   node --experimental-strip-types scripts/ingest-gridmet.mts --r2 --part current
 *   node --experimental-strip-types scripts/ingest-gridmet.mts --out ./tmp --bands 1 --vars pr
 *
 *   --out DIR    write to a local directory instead of R2 (for verification)
 *   --r2         upload to R2 using credentials from .env.local
 *   --part P     only "archive" or only "current" (default: both)
 *   --bands N    stop after N latitude bands (for a quick trial run)
 *   --vars a,b   only these variables (default: all four)
 *   --start YYYY first year of the archive (default 1995)
 *
 * MEMORY
 * One latitude band at a time, so peak usage is a few hundred MB rather than
 * the ~7.6 GB the whole state would need. Bands are 16 grid rows tall because
 * that is a multiple of BOTH parts' chunk widths (4 and 16) — a band that
 * straddled a chunk boundary would write half-filled chunks that the next band
 * would then overwrite, silently losing rows.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { zstdCompressSync, constants as zlibConstants } from "node:zlib";
import {
  parseNetCDF3,
  readShorts,
  readDoubles,
  dataVariable,
} from "../lib/archive/netcdf3.ts";
import {
  ARCHIVE_VARS,
  PART_CHUNK_PX,
  PREFIX,
  MANIFEST_VERSION,
  MANIFEST_KEY,
  dayCount,
  type Manifest,
  type Part,
} from "../lib/archive/layout.ts";
import { r2ConfigFromEnv, putMany, type R2Config } from "../lib/archive/r2.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Texas, generously bounded. Trimmed to gridMET's own grid on first contact. */
const BBOX = { north: 36.6, south: 25.8, west: -106.7, east: -93.4 };

/** Grid rows per download. Must divide by every value in PART_CHUNK_PX. */
const BAND_ROWS = 16;

const NCSS = (v: string) =>
  `https://thredds.northwestknowledge.net/thredds/ncss/agg_met_${v}_1979_CurrentYear_CONUS.nc`;

/** zstd level 10: near-maximum ratio, still fast enough for a batch job. */
const ZSTD_LEVEL = 10;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name: string) => argv.includes(`--${name}`);

const OUT_DIR = arg("out");
const TO_R2 = flag("r2");
const ONLY_PART = arg("part") as Part | undefined;
const MAX_BANDS = arg("bands") ? Number(arg("bands")) : Infinity;
/** Resume point, 0-based. Bands are independent, so a failure loses only its own. */
const FROM_BAND = Number(arg("from-band") ?? 0);
const ONLY_VARS = arg("vars")?.split(",");
const START_YEAR = Number(arg("start") ?? 1995);

if (!OUT_DIR && !TO_R2) {
  console.error("Choose an output: --out <dir> for a local trial, or --r2 to upload.");
  process.exit(1);
}

const VARS = ARCHIVE_VARS.filter((v) => !ONLY_VARS || ONLY_VARS.includes(v.key));
if (!VARS.length) {
  console.error(`No variables matched. Known: ${ARCHIVE_VARS.map((v) => v.key).join(", ")}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Output sinks
// ---------------------------------------------------------------------------

function loadEnv(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(".env.local", "utf8")
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
    );
  } catch {
    return {};
  }
}

let r2: R2Config | null = null;
if (TO_R2) {
  r2 = r2ConfigFromEnv({ ...process.env, ...loadEnv() });
  if (!r2) {
    console.error(
      "R2 credentials missing. Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,\n" +
        "R2_SECRET_ACCESS_KEY and R2_BUCKET in .env.local — see readme_for_user/SETUP-R2.md"
    );
    process.exit(1);
  }
}

interface Blob {
  key: string;
  body: Buffer;
  opts?: { contentType?: string; cacheControl?: string };
}

/**
 * Chunks are immutable once written for a given rebuild, so they are cached
 * hard. The manifest changes on every rebuild and must not be.
 */
const CHUNK_CACHE = "public, max-age=31536000, immutable";
const META_CACHE = "public, max-age=300";

async function flush(blobs: Blob[], label: string): Promise<number> {
  if (!blobs.length) return 0;
  const bytes = blobs.reduce((n, b) => n + b.body.length, 0);

  if (r2) {
    await putMany(r2, blobs, {
      onProgress: (done, total) => {
        if (done === total) process.stdout.write(`      uploaded ${total} objects\n`);
      },
    });
  } else {
    for (const b of blobs) {
      const path = join(OUT_DIR as string, b.key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, b.body);
    }
  }
  console.log(
    `      ${label}: ${blobs.length} objects, ${(bytes / 1048576).toFixed(1)} MB`
  );
  return bytes;
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

async function fetchSlab(
  v: { file: string; grid: string },
  bbox: { north: number; south: number; west: number; east: number },
  start: string,
  end: string
): Promise<Buffer> {
  const qs = new URLSearchParams({
    var: v.grid,
    north: String(bbox.north),
    south: String(bbox.south),
    west: String(bbox.west),
    east: String(bbox.east),
    time_start: `${start}T00:00:00Z`,
    time_end: `${end}T00:00:00Z`,
    // NOT netcdf4 — that returns "NetCDF: HDF error" from this server.
    accept: "netcdf",
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${NCSS(v.file)}?${qs}`);
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt === 2) throw e;
      console.log(`      retrying (${e instanceof Error ? e.message : e})`);
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// Zarr metadata
// ---------------------------------------------------------------------------

function zarray(shape: number[], chunks: number[], dtype: string, fill: number | null) {
  return {
    zarr_format: 2,
    shape,
    chunks,
    dtype,
    // numcodecs' zstd codec. Node emits standard zstd frames, so Python's
    // zarr/xarray reads these without anything special.
    compressor: { id: "zstd", level: ZSTD_LEVEL },
    fill_value: fill,
    order: "C",
    filters: null,
  };
}

function json(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj, null, 1));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(0).padStart(4);

// --- 1. Establish the grid from the server, not from assumed parameters ---
console.log("probing the grid ...");
const probe = parseNetCDF3(
  await fetchSlab(VARS[0], BBOX, "2024-07-01", "2024-07-01")
);
const lats = Array.from(readDoubles(probe, "lat"));
const lons = Array.from(readDoubles(probe, "lon"));
const nLat = lats.length;
const nLon = lons.length;
const latStep = lats[1] - lats[0];
const lonStep = lons[1] - lons[0];

console.log(
  `  ${nLat} x ${nLon} cells   lat ${lats[0].toFixed(4)} -> ${lats[nLat - 1].toFixed(4)} ` +
    `(step ${latStep.toFixed(5)})   lon ${lons[0].toFixed(4)} -> ${lons[nLon - 1].toFixed(4)}`
);

// --- 2. Work out the two time ranges ---
const dsXml = await (await fetch(`${NCSS(VARS[0].file)}/dataset.xml`)).text();
const latest = (dsXml.match(/<end>([^<]+)<\/end>/)?.[1] ?? "").slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(latest)) {
  throw new Error(`Could not read the latest available date from THREDDS (got "${latest}")`);
}
const thisYear = Number(latest.slice(0, 4));

const RANGES: Record<Part, { start: string; end: string }> = {
  archive: { start: `${START_YEAR}-01-01`, end: `${thisYear - 1}-12-31` },
  current: { start: `${thisYear}-01-01`, end: latest },
};
const PARTS: Part[] = ONLY_PART ? [ONLY_PART] : ["archive", "current"];

for (const p of PARTS) {
  console.log(
    `  ${p}: ${RANGES[p].start} -> ${RANGES[p].end}  (${dayCount(RANGES[p].start, RANGES[p].end)} days)`
  );
}

// --- 3. Per-variable packing metadata, read from the header ---
const varMeta: Manifest["vars"] = {};
for (const v of VARS) {
  const a = dataVariable(probe).attrs;
  const head =
    v.key === VARS[0].key
      ? probe
      : parseNetCDF3(await fetchSlab(v, BBOX, "2024-07-01", "2024-07-01"));
  const at = dataVariable(head).attrs;
  varMeta[v.key] = {
    grid: v.grid,
    field: v.field,
    scaleFactor: Number(at.scale_factor ?? 1),
    addOffset: Number(at.add_offset ?? 0),
    fillValue: Number(at._FillValue ?? 32767),
    units: String(at.units ?? ""),
  };
  void a;
  console.log(
    `  ${v.key.padEnd(5)} scale=${varMeta[v.key].scaleFactor} offset=${varMeta[v.key].addOffset} ` +
      `fill=${varMeta[v.key].fillValue} units=${varMeta[v.key].units}`
  );
}

// --- 4. Band loop ---
const nBands = Math.min(Math.ceil(nLat / BAND_ROWS), MAX_BANDS);
let totalBytes = 0;
let totalObjects = 0;

for (let band = FROM_BAND; band < nBands; band++) {
  const row0 = band * BAND_ROWS;
  const row1 = Math.min(row0 + BAND_ROWS, nLat); // exclusive
  const rows = row1 - row0;

  /**
   * A QUARTER of a cell of slack, not a half.
   *
   * A half-step lands exactly on the boundary between two cells, and NCSS
   * selects every cell its box touches — so rounding decided whether the
   * neighbouring row came too. Band 1 asked for 16 rows and got 18. A quarter
   * step stays strictly inside the intended cells' extents, so no neighbour can
   * be caught. The extraction below no longer depends on this being exact, but
   * getting it right keeps the downloads the size they should be.
   */
  const padLat = Math.abs(latStep) / 4;
  const bandBox = {
    north: lats[row0] + padLat,
    south: lats[row1 - 1] - padLat,
    west: BBOX.west,
    east: BBOX.east,
  };

  for (const v of VARS) {
    for (const part of PARTS) {
      const { start, end } = RANGES[part];
      const nDays = dayCount(start, end);
      const px = PART_CHUNK_PX[part];

      const t0 = Date.now();
      const raw = await fetchSlab(v, bandBox, start, end);
      const nc = parseNetCDF3(raw);
      const dv = dataVariable(nc);

      /**
       * Find the wanted rows and columns INSIDE whatever came back.
       *
       * The server decides for itself which cells its bounding box touches, so
       * a request can legitimately return a row or column more than asked for.
       * Matching on the coordinate values rather than assuming the shape means
       * an extra edge row is trimmed instead of silently shifting every value
       * in the band by one cell — which would look entirely normal downstream.
       */
      const gotLats = readDoubles(nc, "lat");
      const gotLons = readDoubles(nc, "lon");
      const gotRows = dv.shape[1];
      const gotCols = dv.shape[2];
      const tol = Math.abs(latStep) / 100;

      const nearest = (arr: Float64Array, want: number) => {
        for (let i = 0; i < arr.length; i++) if (Math.abs(arr[i] - want) < tol) return i;
        return -1;
      };

      const latOff = nearest(gotLats, lats[row0]);
      const lonOff = nearest(gotLons, lons[0]);

      if (dv.shape[0] !== nDays) {
        throw new Error(
          `Band ${band} ${v.key}/${part}: expected ${nDays} days, got ${dv.shape[0]}`
        );
      }
      if (latOff < 0 || lonOff < 0) {
        throw new Error(
          `Band ${band} ${v.key}/${part}: could not find lat ${lats[row0]} / lon ${lons[0]} ` +
            `in the response (lat ${gotLats[0]}..${gotLats[gotRows - 1]})`
        );
      }
      if (latOff + rows > gotRows || lonOff + nLon > gotCols) {
        throw new Error(
          `Band ${band} ${v.key}/${part}: response covers [${gotRows}, ${gotCols}] from ` +
            `offset [${latOff}, ${lonOff}], too small for [${rows}, ${nLon}]`
        );
      }
      // Every row must line up, not just the first — a server that returned a
      // coarser or reordered grid would pass the offset check alone.
      for (let r = 0; r < rows; r++) {
        if (Math.abs(gotLats[latOff + r] - lats[row0 + r]) > tol) {
          throw new Error(
            `Band ${band} row ${r}: latitude ${gotLats[latOff + r]}, expected ${lats[row0 + r]}`
          );
        }
      }

      const src = readShorts(nc, dv.name); // [day][lat][lon], C order

      // --- transpose into chunks ---
      const latChunk0 = row0 / px; // exact: BAND_ROWS divides by every px
      const nLatChunks = Math.ceil(rows / px);
      const nLonChunks = Math.ceil(nLon / px);
      const fill = varMeta[v.key].fillValue;

      const blobs: Blob[] = [];
      for (let ci = 0; ci < nLatChunks; ci++) {
        for (let cj = 0; cj < nLonChunks; cj++) {
          // Zarr pads edge chunks to the full shape, so every chunk is the
          // same size and readers can use a constant stride.
          const out = new Int16Array(nDays * px * px).fill(fill);

          // Source indices carry latOff/lonOff so any extra edge rows or
          // columns the server included are skipped rather than shifting
          // everything by a cell.
          for (let t = 0; t < nDays; t++) {
            const srcDay = t * gotRows * gotCols;
            const dstDay = t * px * px;
            for (let la = 0; la < px; la++) {
              const srcRow = ci * px + la;
              if (srcRow >= rows) break;
              const srcBase = srcDay + (latOff + srcRow) * gotCols + lonOff + cj * px;
              const dstBase = dstDay + la * px;
              for (let lo = 0; lo < px; lo++) {
                if (cj * px + lo >= nLon) break;
                out[dstBase + lo] = src[srcBase + lo];
              }
            }
          }

          const bytes = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
          blobs.push({
            key: `${PREFIX}/${part}/${v.key}/0.${latChunk0 + ci}.${cj}`,
            body: zstdCompressSync(bytes, {
              params: { [zlibConstants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
            }),
            opts: { cacheControl: CHUNK_CACHE },
          });
        }
      }

      const written = await flush(
        blobs,
        `band ${band + 1}/${nBands} ${v.key}/${part}`
      );
      totalBytes += written;
      totalObjects += blobs.length;
      console.log(
        `[${elapsed()}s] band ${band + 1}/${nBands} rows ${row0}-${row1 - 1} ${v.key}/${part}` +
          `  ${(raw.length / 1048576).toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(0)}s` +
          `  -> ${(written / 1048576).toFixed(1)} MB  (${((written / raw.length) * 100).toFixed(0)}% of source)`
      );
    }
  }
}

// --- 5. Zarr metadata and the manifest ---
const meta: Blob[] = [{ key: `${PREFIX}/.zgroup`, body: json({ zarr_format: 2 }) }];

for (const part of PARTS) {
  const nDays = dayCount(RANGES[part].start, RANGES[part].end);
  const px = PART_CHUNK_PX[part];
  meta.push({ key: `${PREFIX}/${part}/.zgroup`, body: json({ zarr_format: 2 }) });

  for (const v of VARS) {
    const vm = varMeta[v.key];
    meta.push({
      key: `${PREFIX}/${part}/${v.key}/.zarray`,
      body: json(zarray([nDays, nLat, nLon], [nDays, px, px], "<i2", vm.fillValue)),
    });
    // _ARRAY_DIMENSIONS is what lets xarray open this as a labelled dataset;
    // scale_factor/add_offset let it unpack the integers automatically.
    meta.push({
      key: `${PREFIX}/${part}/${v.key}/.zattrs`,
      body: json({
        _ARRAY_DIMENSIONS: ["day", "lat", "lon"],
        scale_factor: vm.scaleFactor,
        add_offset: vm.addOffset,
        units: vm.units,
        long_name: vm.grid,
        missing_value: vm.fillValue,
      }),
    });
  }
}

const manifest: Manifest = {
  version: MANIFEST_VERSION,
  builtAt: new Date().toISOString(),
  lat0: lats[0],
  lon0: lons[0],
  latStep,
  lonStep,
  nLat,
  nLon,
  parts: {
    archive: { ...RANGES.archive, nDays: dayCount(RANGES.archive.start, RANGES.archive.end) },
    current: { ...RANGES.current, nDays: dayCount(RANGES.current.start, RANGES.current.end) },
  },
  vars: varMeta,
};

meta.push({
  key: MANIFEST_KEY,
  body: json(manifest),
  opts: { contentType: "application/json", cacheControl: META_CACHE },
});

await flush(meta, "metadata");

console.log(
  `\ndone in ${elapsed()}s — ${totalObjects + meta.length} objects, ` +
    `${(totalBytes / 1073741824).toFixed(2)} GB` +
    (MAX_BANDS < Infinity ? `  (PARTIAL: only ${nBands} of ${Math.ceil(nLat / BAND_ROWS)} bands)` : "")
);
