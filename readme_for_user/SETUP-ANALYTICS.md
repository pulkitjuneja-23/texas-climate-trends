# Seeing who is using the site

Two separate things, both free:

1. **Vercel Web Analytics** — how many people came, from where, on what device.
2. **Our own visit log** — which Texas *counties* people looked up. Vercel
   charges $20/month for this; we do it in the Supabase database you already
   have.

Neither uses cookies. Neither stores anything that could identify a person.

---

## Part 1 — Turn on Vercel Web Analytics

The code is already deployed. You only need to flip the switch:

1. Go to **https://vercel.com/dashboard**
2. Click the **texas-climate-trends** project
3. Click **Analytics** in the top tabs
4. Click **Enable**

That's it. Data starts appearing within a few minutes of the next real visit.

### What you will see

Visitors, page views, which country and city they came from, what referred them,
and what device they used.

### Two things to know before you read the numbers

**"Visitors" means unique per DAY, not per person.** Vercel identifies a visitor
by a scrambled fingerprint of the request and throws it away after 24 hours —
that is how it avoids cookies. One farmer checking the site on five days shows
up as five visitors. Read it as traffic, not as a headcount.

**Only one month of history is kept** on the free plan, on a rolling basis. Last
March will be gone. This is the main reason we keep our own visit log as well.

---

## Part 2 — Create the visit-log table

One-time, about two minutes.

1. Go to **https://supabase.com/dashboard**, open your project
2. Click **SQL Editor** in the left sidebar, then **New query**
3. Paste all of this in and click **Run**:

```sql
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

-- Locks the table to the server's secret key only. The site's own key, and
-- anyone poking at the database from outside, can read nothing.
alter table visits enable row level security;
```

You should see **Success. No rows returned**. Nothing else to configure — the
site already knows how to write to it, using the same credentials as the cache.

---

## Part 3 — The insights page (the map)

There is a private page on the site that draws all of this for you: headline
counts, a map of Texas shaded by how often each county has been looked up, a
ranked table, and an activity strip for the last 60 days. It reads the table
above, so it needs nothing else set up.

It is hidden behind a password in the link. Without the right link the page
returns an ordinary "not found", exactly as if it did not exist.

### Switching it on

1. Go to **https://vercel.com/dashboard**, open the project
2. **Settings → Environment Variables**
3. Add one:

   | Name | Value |
   |---|---|
   | `INSIGHTS_KEY` | a long random string — treat it like a password |

4. Tick all three environments (Production, Preview, Development)
5. **Redeploy** — Vercel only picks up new settings on the next deploy.
   **Deployments → ⋯ → Redeploy** is the quickest way.

Then open, using whatever you put in the box:

```
https://texas-climate-trends.vercel.app/insights?key=YOUR-KEY-HERE
```

Bookmark that. It works on a phone.

### Honest limits of that password

It sits in the web address, so it will be in your browser history, and it would
be visible to anyone you handed a screenshot of the address bar to. Change it
whenever you like — set a new value in Vercel, redeploy, and the old link stops
working immediately.

That is a deliberate trade rather than an oversight. Proper login accounts are a
Vercel paid feature, and what is behind this page is county-level visit counts
with nothing personal in it by construction. The worst a leak could do is tell
somebody that the Panhandle is busier than the Valley.

**If you forget to set `INSIGHTS_KEY` the page simply 404s.** It fails closed,
so an unset password can never leave it open.

---

## Reading the results

The insights page covers most of this. For anything it does not show, go back to
the **SQL Editor** and paste any of these.

### How many visits, by day

```sql
select date(at) as day, count(*) as visits
from visits
where not self
group by 1
order by 1 desc
limit 30;
```

### Which counties people are looking at

```sql
select coalesce(county_name, '(outside Texas)') as county, count(*) as looks
from visits
where not self
group by 1
order by looks desc
limit 25;
```

### Which data source people choose

```sql
select source, count(*) from visits where not self group by 1 order by 2 desc;
```

### How much of the traffic is you

```sql
select self, count(*) from visits group by 1;
```

Useful as a sanity check: if that shows zero `true` rows, the "don't count me"
switch below has not been set on the browser you are using.

---

## Stopping the site from counting you

Visit this once, in each browser you use:

```
https://texas-climate-trends.vercel.app/?notme=1
```

From then on that browser is marked as yours. Vercel will not record it at all,
and the visit log will record it with `self = true` so the queries above can
leave it out.

To undo it: `?notme=0`

**Limits worth knowing.** This is per browser and per device — your phone and
your laptop each need it once. Clearing your browsing data unsets it. And it
cannot work retroactively: anything recorded before you set it stays recorded.

Localhost and preview deployments are never counted, so ordinary development
does not pollute anything.

---

## What is and is not recorded

| Recorded | Not recorded |
|---|---|
| The date and time | Any coordinates |
| The **county** looked at | The exact field |
| Which dataset was selected | IP address |
| Whether it was you | Browser, device, or any session id |

The coordinates you type in *are* sent to the server — they have to be, to work
out the county — but they are turned into a county name there and then thrown
away. Nothing finer than a county is ever written down.

Two consequences of keeping it this anonymous, both real:

- **Two visits by the same person look exactly like two people.** The visit log
  counts *lookups*, not visitors. Use Vercel's numbers for visitor counts and
  this for what they were interested in.
- **The county count is per location viewed**, so one person moving the pin
  around five fields in one county registers five.

---

## What this does not tell you

- Whether anyone came back a second time.
- Whether they found what they wanted.
- How long they stayed.

If those become the questions, they need a different tool and a real decision
about tracking people, rather than counting events.
