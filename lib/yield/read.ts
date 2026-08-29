/**
 * Reading the hosted county-yield store.
 *
 * SERVER-SIDE ONLY. Both files together are ~600 KB and neither is ever sent to
 * a browser; the API route sends one county's slice, which is a few kilobytes.
 *
 * DEGRADES TO NULL, NEVER THROWS OUTWARD. No bucket configured, a missing file,
 * a point outside Texas, a county NASS has no figures for — all return null so
 * the analog table simply shows no yield column data rather than breaking. This
 * is an extra column on an existing panel; it must never be able to take the
 * panel down.
 *
 * The site never calls NASS. That is the point of hosting: Quick Stats outages
 * cannot reach a page load, and a failed quarterly refresh leaves the previous
 * file serving untouched.
 */

import { locateCounty, COUNTY_INDEX_VERSION, type CountyIndex } from "./county";
import {
  YIELD_STORE_VERSION,
  YIELD_STORE_KEY,
  COUNTY_INDEX_KEY,
  type YieldStore,
  type CountyYields,
} from "./types";

export type { CountyYields };

const BASE = process.env.NEXT_PUBLIC_R2_URL?.replace(/\/+$/, "");

export const yieldEnabled = Boolean(BASE);

/** Quarterly data. An hour of staleness is irrelevant; a slow read is not. */
const TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

interface Cached<T> {
  at: number;
  value: T | null;
}

let countyCache: Cached<CountyIndex> | null = null;
let storeCache: Cached<YieldStore> | null = null;

async function getJson<T>(key: string): Promise<T | null> {
  if (!BASE) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/${key}`, { signal: ctrl.signal });
    if (!res.ok) {
      if (res.status !== 404) console.warn(`[yield] ${key} -> ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.warn(`[yield] ${key} ${ctrl.signal.aborted ? "timed out" : "failed"}: ${String(e)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getCountyIndex(): Promise<CountyIndex | null> {
  if (countyCache && Date.now() - countyCache.at < TTL_MS) return countyCache.value;
  const v = await getJson<CountyIndex>(COUNTY_INDEX_KEY);
  const ok = v && v.version === COUNTY_INDEX_VERSION ? v : null;
  if (v && !ok) {
    console.warn(`[yield] county index version ${v.version}, expected ${COUNTY_INDEX_VERSION}`);
  }
  countyCache = { at: Date.now(), value: ok };
  return ok;
}

async function getStore(): Promise<YieldStore | null> {
  if (storeCache && Date.now() - storeCache.at < TTL_MS) return storeCache.value;
  const v = await getJson<YieldStore>(YIELD_STORE_KEY);
  const ok = v && v.version === YIELD_STORE_VERSION ? v : null;
  if (v && !ok) {
    console.warn(`[yield] store version ${v.version}, expected ${YIELD_STORE_VERSION}`);
  }
  storeCache = { at: Date.now(), value: ok };
  return ok;
}

/**
 * Just which county a point is in — no yields.
 *
 * Split out for the visit log, which records the COUNTY someone looked at and
 * nothing finer. It reuses the same cached boundary index, so asking this
 * question costs one point-in-polygon test and no extra network call.
 *
 * Returns null outside Texas, same rule as below.
 */
export async function readCountyOnly(
  lat: number,
  lon: number
): Promise<{ fips: string; name: string } | null> {
  const index = await getCountyIndex();
  if (!index) return null;
  const county = locateCounty(index, lat, lon);
  if (!county) return null;
  // The store holds the tidier display names; fall back to the index's own.
  const store = await getStore();
  return { fips: county.fips, name: store?.countyNames[county.fips] ?? county.name };
}

/**
 * Everything known about one point's county.
 *
 * Returns null outside Texas rather than the nearest county: a field in New
 * Mexico is not "nearly Hudspeth", and snapping would put another state's
 * yields beside Texas weather with nothing to show it had happened.
 */
export async function readCountyYields(lat: number, lon: number): Promise<CountyYields | null> {
  const [index, store] = await Promise.all([getCountyIndex(), getStore()]);
  if (!index || !store) return null;

  const county = locateCounty(index, lat, lon);
  if (!county) return null;

  const entry = store.data[county.fips];
  if (!entry) return null;

  // Preserve the store's crop order, and drop crops this county never grows —
  // a dropdown offering rice in the Panhandle is noise.
  const crops = store.crops
    .filter((c) => entry[c.id])
    .map((c) => ({
      ...c,
      practices: ["all", "irr", "dry"].filter((p) => entry[c.id].series[p]),
    }));

  if (!crops.length) return null;

  return {
    county: { fips: county.fips, name: store.countyNames[county.fips] ?? county.name },
    attribution: store.attribution,
    builtAt: store.builtAt,
    crops,
    data: entry,
  };
}
