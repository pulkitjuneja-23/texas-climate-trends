# Keeping the weather data up to date — automatically

This file is for **you**, not the computer. No jargon.

---

## What this is for

The site keeps its own copy of the Texas weather data, so a farmer clicking a field gets an
answer in under two seconds instead of waiting a minute and a half. That copy has to be topped
up as new days arrive, or it slowly falls behind.

You don't want to do that by hand every morning. So there are **two automatic jobs**:

| Job | When | What it does |
|---|---|---|
| **Refresh** | Every day, ~4:20am Texas time | Adds the newest few days of weather |
| **Rollover** | Once a year, 2 February | Files the finished year away permanently |
| **Crop yields** | Four times a year, 5 Jan/Apr/Jul/Oct | Re-pulls county harvest figures from USDA |

They run on GitHub's computers, not yours. Your laptop can be closed.

The crop-yield job is quarterly because USDA publishes county figures once, months after harvest —
there is nothing new to fetch most weeks. It is also why the site keeps its own copy of that data:
USDA's service is not reliably up, and nobody loading the page should ever wait on it. If a
quarterly run fails, the previous copy carries on serving and the job simply tries again.

---

## Setting it up — once, about five minutes

The jobs need the four passwords for the Cloudflare storage. GitHub keeps these in a locked box
called **Secrets** — you paste them in once, and nobody can read them back out afterwards, not
even you.

**1.** Go to your repository on GitHub:
**https://github.com/pulkitjuneja-23/texas-climate-trends**

**2.** Click **Settings** (top right of the repository, not your account settings).

**3.** In the left sidebar: **Secrets and variables** → **Actions**.

**4.** Click the green **New repository secret** button, and add these **five**, one at a time.
The values are already in your `.env.local` file on this computer — open it in a text editor and
copy each one after the `=` sign.

| Name (type it exactly) | Where to find the value |
|---|---|
| `R2_ACCOUNT_ID` | `.env.local`, the line starting `R2_ACCOUNT_ID=` |
| `R2_ACCESS_KEY_ID` | `.env.local`, the line starting `R2_ACCESS_KEY_ID=` |
| `R2_SECRET_ACCESS_KEY` | `.env.local`, the line starting `R2_SECRET_ACCESS_KEY=` |
| `R2_BUCKET` | `.env.local`, the line starting `R2_BUCKET=` |
| `NEXT_PUBLIC_R2_URL` | `.env.local`, the line starting `NEXT_PUBLIC_R2_URL=` |
| `NASS_API` | `.env.local`, the line starting `NASS_API=` (the USDA crop-yield key) |

> **Careful with copy and paste.** Take everything after the `=` and nothing else — no spaces at
> either end, no quote marks. A stray space is the single most common cause of these jobs
> failing, and the error message won't say so.

**5.** That's it. The daily job starts running the next morning on its own.

---

## Checking it worked

Click the **Actions** tab at the top of the repository. You'll see the two jobs listed.

- A **green tick** means it ran fine.
- A **red cross** means it failed — and GitHub emails you when that happens, so you don't have to
  keep checking.

To try it right now instead of waiting until tomorrow: click **Refresh gridMET (daily)** in the
left sidebar, then the **Run workflow** button on the right, then the green **Run workflow**.
Give it a couple of minutes and refresh the page.

---

## What it costs

Nothing. But here are the real numbers, because "free tier" always has a ceiling somewhere:

| | Used per month | Free allowance | Headroom |
|---|---|---|---|
| Cloudflare uploads | ~41,700 | 1,000,000 | **96% spare** |
| Cloudflare storage | 1.4 GB | 10 GB | 86% spare |
| GitHub minutes | ~75 | 2,000 | 96% spare |

The crop-yield data does not move any of those numbers: the whole Texas record — every county, ten
crops, thirty years — is about 600 KB in two files, replaced eight times a year.

Storage does not grow day by day — each refresh writes over the same files rather than adding
new ones. The only thing that grows is the once-a-year rollover, by about 45 MB a year.

There is deliberate headroom for a **second** data source later. That is why the storage is
arranged the way it is; a more obvious arrangement would have used 15 times as many uploads and
left no room.

**One thing that would change this:** if the site ever becomes commercial, Cloudflare's free tier
is fine but Open-Meteo's and Earth Engine's are not — see the notes in `CLAUDE.md`.

---

## Two things worth knowing

**The daily job usually does nothing, and that's correct.** The University of Idaho publishes
gridMET on its own schedule and often goes several days without adding anything. When there's
nothing new, the job checks, says "already current", and stops without uploading. You'll see a
green tick and a run that took twenty seconds. That is the job working properly, not skipping.

**The "60-day rule" probably doesn't apply to you.** GitHub switches off scheduled jobs in a
repository that has been quiet for 60 days — but its documentation says that applies to *public*
repositories, and yours is private. So this most likely never happens.

It's still worth knowing, because a few people report seeing it on private repositories too. If it
ever does: GitHub emails you, and clicking **Enable workflow** in the Actions tab turns it straight
back on. Any change pushed to the repository resets the clock. If the data ever seems stuck, check
this before anything else — it is much more likely than a real fault.

---

## Why the yearly job waits until February

When a year ends, it has to move from the "this year" pile into the permanent archive.

The obvious moment is 1 January. That would be a mistake. gridMET's most recent days are
**provisional** — the University of Idaho revises them as better observations come in. Because the
daily job re-downloads the whole current year from scratch every time, any day still in that pile
keeps picking up those corrections.

Sealing 31 December into the permanent archive on 1 January would freeze the *least* settled month
in the entire record, and every later correction to it would be lost silently — the worst kind of
error, because nothing would look wrong.

So the year sits in the daily pile for one extra month, collecting revisions, and moves across on
2 February. The only cost is that the working files are about 70% bigger during January.

**While the yearly job runs**, the site goes back to its old slow method for about 25 minutes —
answers still correct, just 20–80 seconds instead of 2. It does this on purpose: the archive is
being rewritten underneath it, and reading a half-rewritten archive would produce numbers that
look completely normal and are completely wrong. Slow for 25 minutes once a year is the better
trade.

If that yearly job ever fails half-way, the site **stays** on the slow method until it's re-run.
That's deliberate too — but it does mean a failed February job needs attention rather than
waiting until next year. The email will tell you.
