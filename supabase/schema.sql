-- Texas Climate Trends — cache table
--
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: everything is guarded with "if not exists".
--
-- This table is a CACHE, not a record of truth. Everything in it can be
-- recomputed from the upstream sources, so it can be emptied at any time
-- without losing anything.

create table if not exists cache_entries (
  -- e.g. "hist:gridmet:31.29167,-97.37500:2024"
  key           text primary key,

  -- Coarse grouping, so entries can be evicted or inspected by kind.
  scope         text        not null,
  source        text        not null,

  payload       jsonb       not null,

  -- Which upstream services produced this value. A stored series can be a
  -- splice (gridded source + station top-up), and a value whose composition
  -- changes between reads is a real discontinuity worth being able to trace.
  contributors  text[]      not null default '{}',

  rows          int         not null default 0,

  -- True for a completed past year, which can never change upstream. These
  -- never expire; everything else carries expires_at.
  immutable     boolean     not null default false,

  fetched_at    timestamptz not null default now(),
  expires_at    timestamptz
);

create index if not exists cache_entries_scope_source_idx on cache_entries (scope, source);
create index if not exists cache_entries_expires_idx      on cache_entries (expires_at)
  where expires_at is not null;
create index if not exists cache_entries_fetched_idx      on cache_entries (fetched_at);

-- SECURITY
--
-- Row Level Security is enabled with NO policies, which denies everything to
-- the anon and authenticated keys. Only the service key reaches this table, and
-- the service key bypasses RLS by design.
--
-- The service key is a password. It belongs in SUPABASE_SERVICE_KEY on the
-- server and must never appear in browser code or in the repository.
alter table cache_entries enable row level security;


-- ---------------------------------------------------------------------------
-- Eviction
-- ---------------------------------------------------------------------------
-- The free tier allows 500 MB. Immutable year rows accumulate forever by
-- design, so this trims two things: entries that have expired, and the
-- least-recently-written entries once the table grows past a ceiling.
--
-- Run manually, or schedule with pg_cron if it is enabled on the project.
--
-- THE DEFAULT CEILING IS MEASURED, NOT GUESSED. A stored year costs ~11 kB on
-- disk including indexes (37 kB of JSON, compressed 3.4x by Postgres), so
-- 30,000 entries is roughly 330 MB. That deliberately leaves ~170 MB of the
-- 500 MB budget spare, because the quota covers the WHOLE database, not this
-- table — and because a full database makes writes fail, which this cache
-- survives silently. Failing safe and failing invisibly are the same thing
-- here, so it is better not to get close.
--
-- At 27 years per location that ceiling is roughly 1,100 cached locations.

create or replace function evict_cache(max_rows int default 30000)
returns table (deleted_expired bigint, deleted_overflow bigint)
language plpgsql
as $$
declare
  n_expired  bigint := 0;
  n_overflow bigint := 0;
begin
  delete from cache_entries
   where expires_at is not null and expires_at <= now();
  get diagnostics n_expired = row_count;

  -- KEEP the first max_rows in this order — immutable rows first (refetching
  -- one costs a full upstream call), newest first within each — and delete
  -- the rest, i.e. the oldest-written rows, mutable ones first.
  --
  -- Until 2026-10-01 this read `order by immutable asc, fetched_at asc`, which
  -- kept the rows listed FIRST and so deleted the newest immutable rows — the
  -- opposite of what the comment above it promised.
  delete from cache_entries
   where key in (
     select key from cache_entries
      order by immutable desc, fetched_at desc
      offset max_rows
   );
  get diagnostics n_overflow = row_count;

  return query select n_expired, n_overflow;
end;
$$;

-- Postgres lets every role execute a new function by default, which exposes it
-- through Supabase's public /rpc endpoint. RLS already makes it a no-op for
-- those roles, but nobody except the owner has any reason to call it.
revoke execute on function evict_cache(int) from public, anon, authenticated;

-- Run it automatically, nightly at 08:15 UTC. Enable "pg_cron" first under
-- Database -> Extensions, then run this once. Without a schedule, rows the
-- site writes for every newly visited location only ever accumulate.
--
--   select cron.schedule('evict-cache-nightly', '15 8 * * *', $$select evict_cache()$$);
--
-- Check it is scheduled:  select jobname, schedule from cron.job;

-- Handy checks:
--   select pg_size_pretty(pg_total_relation_size('cache_entries'));
--   select scope, source, count(*), pg_size_pretty(sum(pg_column_size(payload))::bigint)
--     from cache_entries group by 1,2 order by 3 desc;
--   select * from evict_cache();
