# Putting the site on the internet

Plain-language guide. No prior knowledge assumed.

---

## ✅ ALREADY DONE — the site is live

**https://farmwth.com**

Anyone with that link can open it. No login needed. The original address,
`texas-climate-trends.vercel.app`, still works too and forwards here — so anything you shared
before the domain existed keeps working.

Code lives at **https://github.com/pulkitjuneja-23/texas-climate-trends** (private).

**To publish a change from now on, that is the whole procedure:**

```
git add -A
git commit -m "say what changed"
git push
```

Vercel notices the push and rebuilds the site by itself, usually within a minute. There is no
separate "deploy" step any more.

> **Preview links.** Vercel also creates addresses like
> `texas-climate-trends-pulkitjuneja-23.vercel.app`. Those are private test builds and will show a
> Vercel login page — that is normal and not a fault. Share only the short link above.

---

## The custom domain — `farmwth.com` (done, 24 Sep 2026)

**The site is live at https://farmwth.com**, which lands on `www.farmwth.com` — that is the
production domain in Vercel. The original `texas-climate-trends.vercel.app` still works and
forwards to it, so every link ever shared keeps working.

**How it is wired.** Registered at Cloudflare. Both `farmwth.com` and `www.farmwth.com` are CNAME
records pointing at `80122c051715fcef.vercel-dns-017.com`, both set to **DNS only** (the grey
cloud, not the orange one). Leave them grey: Cloudflare's proxy sitting in front of Vercel stops
Vercel issuing its HTTPS certificate, and it fails as a certificate warning or a page that
reloads forever — which looks nothing like a DNS problem and wastes an afternoon.

Cloudflare shows a standing banner recommending you turn proxying on. **Ignore it.** It is an
advert for Cloudflare's own features, and Vercel's panel explicitly asks for proxy disabled.

**Two things that caught us out, recorded so they do not again:**

- **A campus firewall blocked the new domain.** Allowing `www.farmwth.com` did NOT cover the bare
  `farmwth.com` — to a web filter those are two different names, and a wildcard `*.farmwth.com`
  does not match the bare name either. Both had to be listed separately. If the site is ever
  unreachable from one network but fine from a phone, suspect this before suspecting the code.
- **A tool reporting "connection reset" is not proof the site is down.** The bare domain looked
  dead from three separate checks while it was in fact serving perfectly — an independent TLS scan
  showed valid certificates at grades A+ and A. Check your checking tool against a site you know
  is healthy before believing it.

**If you ever want the short name in the address bar** instead of `www.`, that is **Settings →
Domains** in Vercel: make `farmwth.com` the production domain and set `www` to redirect to it.
Both work either way — it only changes which one people see. One consequence: a browser treats the
two as separate sites for storage, so switching resets the visitor codes behind your analytics and
you would need to set `?notme=1` again on your own devices.

**One thing left for later.** The redirect from the old address is TEMPORARY on purpose, so that
if the domain ever lapsed the old link would still work. Once `farmwth.com` has run quietly for a
few months, ask Claude to make it permanent — that is what lets search engines transfer the old
address to the new one properly.

**What is already safe.** The address printed inside every exported CSV is not a hardcoded string;
it is read from whatever address the reader is actually on. So an export made from the new domain
names the new domain, one made from the old names the old, and neither can rot.

**What must not be renamed**, whatever the site is called: the Vercel URL, the GitHub repo slug,
`GEE_PROJECT_ID`, the R2 bucket, and the Supabase project. Other systems resolve those.

The rest of this file explains what all of that means, and is worth reading once.

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
