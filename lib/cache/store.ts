/**
 * Cache store, backed by Supabase.
 *
 * THE ONE RULE: this layer may make the site faster. It may never make the site
 * slower, and it may never make the site wrong. Every operation here degrades to
 * a no-op — on a missing configuration, a network failure, a timeout, or a
 * malformed row. A cache miss and a cache outage are the same thing to the
 * caller: `undefined`, followed by a live fetch.
 *
 * That is why nothing in this file throws.
 *
 * WHY NO SUPABASE CLIENT LIBRARY
 * Supabase serves its tables over PostgREST, which is ordinary HTTPS. Reaching
 * it with `fetch` avoids a dependency, keeps the serverless bundle small, and —
 * the reason that actually matters — lets us put a hard AbortSignal timeout on
 * every call. A hung cache read must cost milliseconds, not seconds.
 */

/**
 * Accept the project URL in whichever form the dashboard offered it.
 *
 * Supabase shows it as a bare host on the settings page but as
 * `https://<id>.supabase.co/rest/v1/` in the API docs panel, and both look
 * equally like "the Project URL". Pasting the second one used to produce
 * `/rest/v1/rest/v1/cache_entries` and a PGRST125 "Invalid path" on every
 * single call — a failure that is silent by design here, so the only symptom
 * was a cache that never hit.
 */
const BASE = process.env.SUPABASE_URL?.replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
const KEY = process.env.SUPABASE_SERVICE_KEY;

/** Whether a cache is configured at all. Absent config is a valid state. */
export const cacheEnabled = Boolean(BASE && KEY);

const TABLE = "cache_entries";

/**
 * Reads are on the critical path, so they get a short leash: if Supabase has
 * not answered in this long, give up and go upstream. Writes happen after the
 * answer is already known, so they can afford longer.
 */
const READ_TIMEOUT_MS = 2500;
const WRITE_TIMEOUT_MS = 6000;

export interface CacheEntry<T> {
  key: string;
  payload: T;
  /**
   * Which upstream services produced this value.
   *
   * A stored series can be a splice — a gridded source plus a station top-up —
   * and a value whose composition changed between two reads is a real
   * discontinuity. Recording it means that is traceable later even though
   * nothing renders it today.
   */
  contributors: string[];
  fetchedAt: string;
}

export interface PutEntry<T> {
  key: string;
  /** Coarse grouping, for eviction and for reading the table by hand. */
  scope: string;
  source: string;
  payload: T;
  contributors: string[];
  rows: number;
  /**
   * True when the value can never change upstream — a completed past year.
   * Immutable entries never expire; everything else gets `ttlSeconds`.
   */
  immutable?: boolean;
  ttlSeconds?: number;
}

/**
 * Both headers carry the SAME value, and that is deliberate — do not "tidy" one
 * away.
 *
 * Supabase now issues `sb_secret_...` keys instead of the old `eyJ...` JWTs, and
 * those may not appear in `Authorization: Bearer` *unless the value is
 * identical to the `apikey` header*. Legacy JWT keys, meanwhile, expect Bearer.
 * Sending the same string in both satisfies each rule, so either generation of
 * key works without the code having to know which it was handed.
 */
function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: KEY as string,
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

/** Fetch with a hard deadline. Returns null rather than throwing. */
async function call(
  path: string,
  init: RequestInit,
  timeoutMs: number,
  what: string
): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/rest/v1/${path}`, {
      ...init,
      signal: ctrl.signal,
      // Next must not try to cache this itself; the table IS the cache.
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[cache] ${what} failed ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    return res;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    // An abort here means the deadline fired — worth seeing, because a cache
    // that times out on every read is invisible otherwise: the site just runs
    // at uncached speed while appearing to have a cache.
    console.warn(`[cache] ${what} ${ctrl.signal.aborted ? "timed out" : "errored"}: ${why}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface Row {
  key: string;
  payload: unknown;
  contributors: string[] | null;
  fetched_at: string;
  expires_at: string | null;
}

/**
 * Look up many keys at once.
 *
 * Returns only the keys that were present AND unexpired. Absent keys are simply
 * absent from the map — callers treat that identically to a cache being down.
 */
export async function readMany<T>(keys: string[]): Promise<Map<string, CacheEntry<T>>> {
  const out = new Map<string, CacheEntry<T>>();
  if (!cacheEnabled || keys.length === 0) return out;

  // PostgREST `in.(...)` — quote each key, since ours contain commas.
  const list = keys.map((k) => `"${k.replace(/"/g, '""')}"`).join(",");
  const qs = `${TABLE}?select=key,payload,contributors,fetched_at,expires_at&key=in.(${list})`;

  const res = await call(qs, { method: "GET", headers: headers() }, READ_TIMEOUT_MS, "read");
  if (!res) return out;

  let rows: Row[];
  try {
    rows = (await res.json()) as Row[];
  } catch (e) {
    console.warn(`[cache] read returned unparseable body: ${String(e)}`);
    return out;
  }
  if (!Array.isArray(rows)) return out;

  // Expiry is filtered here rather than in the query so that a clock skew or a
  // PostgREST syntax change degrades to "cache miss" instead of "cache error".
  const now = Date.now();
  for (const r of rows) {
    if (!r || typeof r.key !== "string") continue;
    if (r.expires_at && Date.parse(r.expires_at) <= now) continue;
    out.set(r.key, {
      key: r.key,
      payload: r.payload as T,
      contributors: Array.isArray(r.contributors) ? r.contributors : [],
      fetchedAt: r.fetched_at,
    });
  }
  return out;
}

/**
 * Insert or replace many entries.
 *
 * Awaited by the caller, but a failure never propagates: the answer has already
 * been computed by this point, and refusing to serve it because we could not
 * write it down would be absurd.
 */
export async function writeMany<T>(entries: PutEntry<T>[]): Promise<void> {
  if (!cacheEnabled || entries.length === 0) return;

  const now = Date.now();
  const body = entries.map((e) => ({
    key: e.key,
    scope: e.scope,
    source: e.source,
    payload: e.payload,
    contributors: e.contributors,
    rows: e.rows,
    immutable: e.immutable ?? false,
    fetched_at: new Date(now).toISOString(),
    expires_at:
      e.immutable || !e.ttlSeconds
        ? e.immutable
          ? null
          : new Date(now + 3 * 3600 * 1000).toISOString()
        : new Date(now + e.ttlSeconds * 1000).toISOString(),
  }));

  await call(
    TABLE,
    {
      method: "POST",
      // merge-duplicates makes this an upsert on the primary key.
      headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify(body),
    },
    WRITE_TIMEOUT_MS,
    `write(${entries.length})`
  );
}
