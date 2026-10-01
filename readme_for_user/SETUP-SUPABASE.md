# Setting up the cache (Supabase)

**What this is for.** Right now, every time someone looks at a location the site
asks Google Earth Engine for 25 years of weather from scratch. That takes
22–82 seconds and it happens again for the next person who looks at the same
field. The cache writes each year down the first time, so the second visitor
gets it back in well under a second.

**Why a year at a time.** A finished past year never changes — 2019 at a given
spot is the same numbers forever. So 26 of the 27 years get stored permanently,
and only the year in progress needs refreshing. On a repeat visit the site asks
Earth Engine for **one year instead of twenty-seven**.

**Cost: nothing.** Supabase's free tier gives 500 MB, which is far more than
this needs. No card required.

**If you skip this, nothing breaks.** With no cache configured the site behaves
exactly as it does today — just slower. Everything below is optional and
reversible.

---

## Step 1 — Create the project

1. Go to <https://supabase.com> and sign up (GitHub login is fine).
2. Click **New project**.
3. Fill in:
   - **Name**: `texas-climate-trends`
   - **Database password**: click *Generate* and let the browser save it. You
     will not need to type it again, but do not lose it.
   - **Region**: choose one physically close to where the site runs. **US East
     (N. Virginia)** is the right answer — that is where Vercel serves from, and
     a cache on the other side of the country adds delay to every read.
4. Click **Create new project** and wait about two minutes.

## Step 2 — Create the table

1. In the left sidebar click **SQL Editor**.
2. Click the **+** button and choose **Create new snippet**.

   > A "snippet" is just what Supabase calls a saved SQL query — older guides
   > call this button *New query*. The other two options on that menu are
   > unrelated: *log query* searches server logs, and *folder* only organises
   > saved snippets. If an empty editor pane is already open on this screen, you
   > can skip this step and type straight into it.

3. Open the file `supabase/schema.sql` from this project, copy everything in it,
   and paste it into the box.
4. Click **Run** (bottom right, or Ctrl+Enter).

You should see *Success. No rows returned.* That is correct — it built an empty
table.

To confirm: click **Table Editor** in the sidebar. You should see
`cache_entries` with no rows in it yet.

## Step 3 — Copy the two settings

1. Click the **gear icon** (Project Settings) at the bottom of the sidebar.
2. Click **API**.
3. You need two values from this page:

| On the page | What it looks like |
|---|---|
| **Project URL** | `https://abcdefgh.supabase.co` |
| **Secret key** (under *API keys*) | `sb_secret_...` — click *Reveal* to see it |

> ### ⚠️ Two keys are shown. Take the right one.
>
> Supabase renamed these in 2026, so you will see one of two sets depending on
> when the project was made. Both generations work here.
>
> | Newer wording | Older wording | |
> |---|---|---|
> | **Secret key** `sb_secret_...` | **service_role** `eyJ...` | ← **take this one** |
> | Publishable key `sb_publishable_...` | anon `eyJ...` | not this one |
>
> The secret / service_role key is the only one that can reach our table — the
> publishable one is deliberately blocked from it.
>
> **It is a password.** It can read and write everything in your database,
> ignoring all permissions. It goes in exactly two places: the `.env.local` file
> on your own computer, and later Vercel's settings page. **Never paste it into
> a chat, an email, a screenshot, or any file that gets committed.** If it is
> ever exposed, rotate it from this same page.

## Step 4 — Add them to the project

Open `.env.local` in the project folder (the same file that holds the Earth
Engine settings) and add two lines:

```
SUPABASE_URL=https://abcdefgh.supabase.co
SUPABASE_SERVICE_KEY=sb_secret_...the secret one...
```

Keep the variable name `SUPABASE_SERVICE_KEY` whichever generation of key you
pasted — the code accepts either.

`.env.local` is already ignored by git, so it cannot be committed by accident.

## Step 5 — Restart and check

Stop the dev server (Ctrl+C in its window) and start it again with `npm run dev`.
Environment settings are only read at startup, so a running server will not pick
them up.

Then load a location in the browser, and load the **same** location again.

- The first time should take as long as it does today.
- The second time should be fast.

To see what the cache did, open this address in your browser (adjust the
coordinates to wherever you looked):

```
http://localhost:3000/api/history?lat=31.30&lon=-97.40&source=gridmet
```

Near the end of the response there is a `cache` section:

```json
"cache": { "enabled": true, "yearsFromCache": 26, "yearsFetched": 1 }
```

- `enabled: false` → the settings were not picked up. Check for typos and that
  you restarted.
- `yearsFromCache: 0` on a repeat visit → the write is failing. Look at the dev
  server window for lines starting `[cache]`; they say exactly what went wrong.

---

## Later: putting it on the live site

Same two values go into Vercel:

1. Vercel dashboard → your project → **Settings** → **Environment Variables**
2. Add `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`
3. Tick **Production only** (the service key can read and change every table, so it must never be
   inside a preview build; see DEPLOY.md)
4. Redeploy

## Later: keeping it tidy

The free tier is 500 MB. Permanently-stored years accumulate, so eventually it
needs trimming. `supabase/schema.sql` installs a function for this, and the end
of that file has a one-line command to run it automatically every night (turn on
the `pg_cron` extension first under Database → Extensions). Or run it from the
SQL Editor whenever you want:

```sql
select * from evict_cache();
```

To see how full it is:

```sql
select pg_size_pretty(pg_total_relation_size('cache_entries'));
```

This is a cache, not records. Everything in it can be fetched again from the
original sources, so it is always safe to empty.
