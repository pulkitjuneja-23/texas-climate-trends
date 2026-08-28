/**
 * What the cache actually holds, and what it costs.
 *
 * The free tier is 500 MB, and how many locations fit inside it depends
 * entirely on the size of one stored year — which was an estimate until this
 * measured it. Reads .env.local directly so it can run without the dev server.
 *
 * Prints no secrets.
 *
 * Run: node scripts/cache-stats.mjs
 */
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const BASE = env.SUPABASE_URL?.replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
const KEY = env.SUPABASE_SERVICE_KEY;
if (!BASE || !KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY not found in .env.local");
  process.exit(1);
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function get(path, extraHeaders = {}) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    headers: { ...H, ...extraHeaders },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res;
}

// Exact row count via PostgREST's count header.
const head = await get("cache_entries?select=key&limit=1", {
  Prefer: "count=exact",
});
const total = Number(head.headers.get("content-range")?.split("/")[1] ?? 0);

const meta = await (await get("cache_entries?select=key,scope,source,rows,immutable")).json();

const byScope = new Map();
for (const r of meta) {
  const k = `${r.scope}/${r.source}`;
  const s = byScope.get(k) ?? { n: 0, rows: 0, immutable: 0 };
  s.n++;
  s.rows += r.rows ?? 0;
  if (r.immutable) s.immutable++;
  byScope.set(k, s);
}

console.log(`entries: ${total}\n`);
console.log("scope/source            entries   data rows   permanent");
for (const [k, s] of [...byScope].sort((a, b) => b[1].n - a[1].n)) {
  console.log(
    `${k.padEnd(22)} ${String(s.n).padStart(7)} ${String(s.rows).padStart(11)} ${String(s.immutable).padStart(11)}`
  );
}

// Measure one real stored year, uncompressed. Postgres stores jsonb TOAST-
// compressed, so the on-disk figure is smaller — this is the upper bound.
const sample = meta.find((r) => r.scope === "history");
if (sample) {
  const body = await (
    await get(`cache_entries?select=payload&key=eq.${encodeURIComponent(sample.key)}`)
  ).text();
  const kb = body.length / 1024;
  console.log(`\none stored year, uncompressed JSON: ${kb.toFixed(1)} KB`);
  console.log(`27 years (one location):            ${((kb * 27) / 1024).toFixed(1)} MB`);
  console.log(
    `locations inside 500 MB (uncompressed): ~${Math.floor(500 / ((kb * 27) / 1024))}`
  );
  console.log(
    "\nPostgres compresses jsonb, so the real figure is larger than this.\n" +
      "For the true on-disk size run in the Supabase SQL editor:\n" +
      "  select pg_size_pretty(pg_total_relation_size('cache_entries'));"
  );
}
