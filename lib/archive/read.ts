/**
 * Reading the Texas weather archive from R2.
 *
 * This is the half that makes the whole exercise worth doing: a lookup that
 * cost 18-82 seconds of Earth Engine computation becomes a handful of small
 * downloads of data that was rearranged, once, months ago.
 *
 * NO CREDENTIALS. The bucket is public-read because gridMET is freely
 * redistributable, so this is plain HTTPS with nothing secret in it. The ingest
 * script holds the only key, and it runs on a laptop, not on the server.
 *
 * DEGRADES TO NULL, NEVER THROWS OUTWARD. Every failure — no bucket configured,
 * a missing chunk, a point outside Texas, a range the archive does not cover —
 * returns null so the caller falls back to Earth Engine. The archive is an
 * accelerator; it must never become a new way for the site to break.
 */

import { zstdDecompressSync } from "node:zlib";
import {
  locate,
  chunkOf,
  extractSeries,
  chunkKey,
  addDays,
  dayCount,
  MANIFEST_KEY,
  MANIFEST_VERSION,
  type Manifest,
  type Part,
} from "./layout";

const BASE = process.env.NEXT_PUBLIC_R2_URL?.replace(/\/+$/, "");

export const archiveEnabled = Boolean(BASE);

/** A chunk is immutable; the manifest is not. Re-read it occasionally. */
const MANIFEST_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

let manifestCache: { at: number; value: Manifest | null } | null = null;

async function get(key: string, kind: "json" | "binary"): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/${key}`, { signal: ctrl.signal });
    if (!res.ok) {
      if (res.status !== 404) console.warn(`[archive] ${key} -> ${res.status}`);
      return null;
    }
    return kind === "json" ? await res.json() : Buffer.from(await res.arrayBuffer());
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.warn(`[archive] ${key} ${ctrl.signal.aborted ? "timed out" : "failed"}: ${why}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getManifest(): Promise<Manifest | null> {
  if (!BASE) return null;
  if (manifestCache && Date.now() - manifestCache.at < MANIFEST_TTL_MS) {
    return manifestCache.value;
  }

  const m = (await get(MANIFEST_KEY, "json")) as Manifest | null;

  // A manifest from a newer, incompatibly-arranged store must be ignored
  // rather than misread — the site falls back to Earth Engine until this code
  // is updated to match.
  if (m && m.version !== MANIFEST_VERSION) {
    console.warn(
      `[archive] manifest version ${m.version}, this build expects ${MANIFEST_VERSION} — ignoring the archive`
    );
    manifestCache = { at: Date.now(), value: null };
    return null;
  }

  manifestCache = { at: Date.now(), value: m };
  return m;
}

export interface ArchivePoint {
  /** The grid cell centre actually read, which is not the point asked for. */
  lat: number;
  lon: number;
  /** Aligned with every array in `values`. */
  dates: string[];
  /** Keyed by the manifest's variable keys (tmmx, tmmn, pr, pet). */
  values: Record<string, (number | null)[]>;
  /** Last date the archive itself covers, before any station top-up. */
  lastDate: string;
}

/**
 * One part's contribution to a point's series.
 *
 * Returns null if any chunk is missing: a partial answer here would be a hole
 * in the middle of a rainfall record, which reads as a drought that never
 * happened.
 */
async function readPart(
  m: Manifest,
  part: Part,
  cell: { latIdx: number; lonIdx: number },
  varKeys: string[]
): Promise<Record<string, Int16Array> | null> {
  const pos = chunkOf(part, cell);
  const nDays = m.parts[part].nDays;

  const results = await Promise.all(
    varKeys.map(async (key) => {
      const raw = (await get(
        chunkKey(part, key, pos.latChunk, pos.lonChunk),
        "binary"
      )) as Buffer | null;
      if (!raw) return null;
      try {
        const flat = zstdDecompressSync(raw);
        const chunk = new Int16Array(flat.buffer, flat.byteOffset, flat.byteLength / 2);
        return { key, series: extractSeries(part, chunk, pos, nDays) };
      } catch (e) {
        console.warn(`[archive] ${part}/${key} failed to decompress: ${String(e)}`);
        return null;
      }
    })
  );

  if (results.some((r) => r === null)) return null;

  const out: Record<string, Int16Array> = {};
  for (const r of results) out[r!.key] = r!.series;
  return out;
}

/**
 * A point's daily series, assembled from the archive.
 *
 * Both parts are fetched together — 8 small requests in parallel rather than
 * two rounds — so the whole read is one network round trip's worth of latency.
 */
export async function readArchivePoint(
  lat: number,
  lon: number,
  start: string,
  end: string
): Promise<ArchivePoint | null> {
  const m = await getManifest();
  if (!m) return null;

  const cell = locate(m, lat, lon);
  if (!cell) return null; // outside Texas — Earth Engine still covers it

  // The archive cannot answer for years before it starts. Rather than return a
  // truncated series that looks complete, decline and let Earth Engine serve
  // the whole request.
  if (start < m.parts.archive.start) return null;

  const varKeys = Object.keys(m.vars);

  /**
   * Fetch only the parts the request actually overlaps.
   *
   * This matters far more than it looks. Past years are cached permanently, so
   * the RECURRING request — every three hours, once the in-progress year goes
   * stale — asks only for the current year. Reading both parts anyway pulled
   * ~580 KB of thirty-year archive chunks to serve ~20 KB of this year, on
   * every refresh, forever. Skipping the untouched part cuts the steady-state
   * cost by around 95%.
   */
  const wanted = (["archive", "current"] as Part[]).filter((p) => {
    const r = m.parts[p];
    return start <= r.end && end >= r.start;
  });
  if (!wanted.length) return null;

  const fetched = await Promise.all(wanted.map((p) => readPart(m, p, cell, varKeys)));
  // A missing chunk in any needed part means an incomplete series, which would
  // read as a drought that never happened. Decline the whole thing.
  if (fetched.some((f) => f === null)) return null;

  // Stitch the parts into one continuous series, then trim to the request.
  const parts = wanted.map((part, i) => ({
    part,
    data: fetched[i] as Record<string, Int16Array>,
  }));

  const dates: string[] = [];
  const values: Record<string, (number | null)[]> = {};
  for (const k of varKeys) values[k] = [];

  for (const { part, data } of parts) {
    const range = m.parts[part];
    for (let i = 0; i < range.nDays; i++) {
      const date = addDays(range.start, i);
      if (date < start || date > end) continue;
      dates.push(date);
      for (const k of varKeys) {
        const vm = m.vars[k];
        const raw = data[k][i];
        values[k].push(raw === vm.fillValue ? null : raw * vm.scaleFactor + vm.addOffset);
      }
    }
  }

  if (!dates.length) return null;

  return {
    lat: cell.lat,
    lon: cell.lon,
    dates,
    values,
    lastDate: m.parts.current.end,
  };
}

/** Whether the archive can serve this request at all, without fetching it. */
export async function archiveCovers(lat: number, lon: number, start: string): Promise<boolean> {
  const m = await getManifest();
  if (!m) return false;
  if (start < m.parts.archive.start) return false;
  return locate(m, lat, lon) !== null;
}

/** How far behind the archive is, for the UI to report honestly. */
export async function archiveLagDays(): Promise<number | null> {
  const m = await getManifest();
  if (!m) return null;
  const today = new Date().toISOString().slice(0, 10);
  return dayCount(m.parts.current.end, today) - 1;
}
