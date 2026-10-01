-- Visit log and feature-use log, read by the private /insights page.
--
-- Run once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: everything is guarded with "if not exists".
--
-- Nothing personal is stored. A looked-up location is resolved to its COUNTY
-- on the server and the coordinates are discarded; no IP address, user agent
-- or cookie is recorded. `visitor` is a random code kept in the browser.
--
-- Row Level Security is enabled with NO policies, so only the server's secret
-- key can read or write these tables.

-- Where people looked.
create table if not exists visits (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  county_fips  text,
  county_name  text,
  source       text,
  self         boolean not null default false
);

create index if not exists visits_at_idx     on visits (at desc);
create index if not exists visits_county_idx on visits (county_fips);

alter table visits enable row level security;

-- Extra context on each lookup. Added after the table first shipped, so these
-- are separate statements that also upgrade an older table in place.
alter table visits add column if not exists visitor  text;
alter table visits add column if not exists session  text;
alter table visits add column if not exists screen   text;
alter table visits add column if not exists hour     smallint;
alter table visits add column if not exists weekday  smallint;
alter table visits add column if not exists via      text;
alter table visits add column if not exists referrer text;

create index if not exists visits_visitor_idx on visits (visitor);

-- What people used, as opposed to where they looked.
create table if not exists events (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  kind     text not null,
  label    text not null,
  visitor  text,
  session  text,
  screen   text,
  hour     smallint,
  weekday  smallint,
  self     boolean not null default false
);

create index if not exists events_at_idx      on events (at desc);
create index if not exists events_kind_idx    on events (kind, label);
create index if not exists events_session_idx on events (session);

alter table events enable row level security;

-- Handy checks:
--   select date(at) as day, count(*) from visits where not self group by 1 order by 1 desc limit 30;
--   select coalesce(county_name, '(outside Texas)') as county, count(*) as looks
--     from visits where not self group by 1 order by looks desc limit 25;
