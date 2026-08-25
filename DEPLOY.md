# Putting the site on the internet

Plain-language guide. No prior knowledge assumed.

---

## First: do you need Docker?

**No.**

Here's what Docker actually is, so the question stops nagging. When you run software on a
different computer, it often breaks — different operating system, different versions of things,
a missing library. Docker solves that by packaging your app *together with a miniature copy of
the whole operating system it needs*. You ship that bundle, and it runs identically anywhere.

That's genuinely useful when:
- you're running on your own server and control the machine, or
- your app needs unusual system software, or
- you have several apps that must not interfere with each other.

None of that applies here. This site is built with **Next.js**, and Vercel is the company that
*makes* Next.js. Their service already knows exactly how to build and run it. Adding Docker would
mean maintaining a description of an operating system, for no benefit.

**Rule of thumb:** Docker is for when the hosting doesn't understand your app. Vercel understands
this app better than Docker would.

---

## What "deploying" actually means

Right now the site runs only on your laptop, at `localhost:3000`. "Localhost" literally means
*this computer* — nobody else can reach it, and it disappears when you close the terminal.

Deploying means copying the site onto a computer that is always on and has a public address, so
anyone with the link can open it. That computer is called a **server**, and renting one used to be
a whole job. Now a service does it for you.

You will end up with a link like `https://texas-climate-trends.vercel.app` that you can send to
anyone.

---

## What it costs

**Nothing**, for this project.

Vercel's free plan ("Hobby") covers a site like this comfortably. Two conditions attached, and both
already match what you told me:

1. **Non-commercial only.** No charging, no advertising, no paid consulting deliverables. Same
   condition Earth Engine's free tier has, so if one ever changes, both do.
2. Fair usage limits, which an extension tool for farmers will not come close to.

---

## Before you start

You need **git** — a tool for tracking file changes. It isn't installed yet:

```
winget install Git.Git
```

Close and reopen your terminal afterwards so it takes effect.

You do *not* strictly need git for Option A below, but you should install it anyway — see the
backup warning at the bottom.

---

## Option A — quickest, no accounts to wire up (recommended first)

From a terminal in the project folder:

```
npx vercel
```

The first time, it will:
1. Ask you to log in — a browser window opens, sign in with Google or email.
2. Ask a few setup questions. **Press Enter to accept the default for every one of them.**
   It will detect Next.js on its own.
3. Upload the site and give you a link.

That link is a *preview*. To publish the real one:

```
npx vercel --prod
```

**Then you must add the Earth Engine credentials**, or the water-use features will be blank on the
live site. See "Adding the secret settings" below.

**To update the site later:** make the changes, then run `npx vercel --prod` again. That's it.

---

## Option B — connect GitHub (better for the long run)

GitHub stores your code online. Two advantages worth having:

- **A backup.** Right now this project exists on exactly one laptop.
- **Automatic updates.** Once connected, saving changes to GitHub republishes the site by itself.

Steps:
1. Make a free account at **https://github.com**
2. Create a new empty repository called `texas-climate-trends`. Set it to **Private** unless you
   want the code public.
3. In the project folder:
   ```
   git init
   git add -A
   git commit -m "Texas Climate Trends"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/texas-climate-trends.git
   git push -u origin main
   ```
4. Go to **https://vercel.com/new**, sign in, and pick that repository.
5. Add the secret settings (below), then click **Deploy**.

After that, every time you want to publish changes:
```
git add -A
git commit -m "describe what changed"
git push
```
The site updates by itself a minute later.

> **Your key file and `.env.local` will NOT be uploaded.** They are listed in `.gitignore`, which is
> a list of files git deliberately ignores. That is on purpose — they are passwords.

---

## Adding the secret settings

The site needs your Earth Engine credentials, and on a server there are no files to put them in —
they go in as **environment variables** (settings attached to the project).

1. Go to your project on **https://vercel.com/dashboard**
2. **Settings → Environment Variables**
3. Add these two:

| Name | Value |
|---|---|
| `GEE_PROJECT_ID` | `texas-climate-trends` |
| `GEE_KEY_JSON` | the **entire contents** of `earthengine-key.json` |

For the second one: open `earthengine-key.json` in Notepad, select all (Ctrl+A), copy (Ctrl+C),
and paste the whole thing into the value box. It is a long block of text starting with `{` and
ending with `}`. Paste all of it.

4. Tick all three environments (Production, Preview, Development).
5. **Redeploy** — Vercel only picks up new settings on the next deploy. Either run
   `npx vercel --prod` again, or use **Deployments → ⋯ → Redeploy** in the dashboard.

This exact arrangement has been tested locally, so if the water data works on your laptop it will
work on the server.

---

## Checking it worked

Open your live link and confirm:

- [ ] The map loads and you can click a spot
- [ ] The season chart draws
- [ ] "Which year is this one tracking like?" fills in
- [ ] Switch the variable to **Water used (ET)** — if it says *"Earth Engine is not connected"*,
      the settings above are missing or you haven't redeployed
- [ ] The forecast section shows days 1–7

---

## Things to keep an eye on once it's public

Everything here runs on other people's free services. With a handful of users that is completely
fine. If it ever gets popular, these are the three that would complain first:

| Service | What it does | The limit |
|---|---|---|
| **Nominatim** | the town/address search | 1 request per second, shared across all your users |
| **gridMET** | the 4 km weather data | ~81 requests per new location; heavy if many people look up many places |
| **Earth Engine** | the water-use data | limits on how many requests run at the same time |

Results are cached, so repeat visits to the same location are nearly free — the cost is only for
*new* places. If you start sharing this widely and something stops responding, tell me and I'll add
proper rate limiting.

---

## The backup warning

**This project currently exists on one laptop.** If that machine fails, everything is gone —
the code, and all the reasoning written into `CLAUDE.md`.

Option B fixes that. Even if you deploy with Option A today, it is worth doing the GitHub step
soon. It takes about ten minutes.
