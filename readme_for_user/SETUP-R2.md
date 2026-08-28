# Setting up the weather archive (Cloudflare R2)

**What this is for.** Right now, the first person to look at a given field waits
18–82 seconds while Google Earth Engine works out 30 years of weather for that
spot. The Supabase cache makes the *second* visitor fast, but the first one still
waits — and with a dozen people each looking at their own field, most visits are
first visits.

This fixes that by keeping our own copy of the Texas weather, arranged so that
one field's whole history is a single small download. Expected: **under half a
second, for everybody, every time.**

**Cost: nothing**, at our size. R2's free tier covers 10 GB of storage and a
million uploads a month. Texas gridMET compressed should be about 3 GB.

> ### ⚠️ One annoyance to know about first
>
> **Cloudflare asks for a credit card before it will switch R2 on**, even though
> the free tier costs nothing. This is normal and it is not a trial that
> auto-charges — but if you would rather not put a card down, say so and we will
> use a different storage provider. Backblaze B2 also has a 10 GB free tier.

---

## Step 1 — Create the account and turn on R2

1. Go to <https://dash.cloudflare.com/sign-up> and sign up (free).
2. In the left sidebar click **R2 Object Storage**.
3. Click **Purchase R2** — despite the wording, this puts you on the free tier.
   Add a card when asked.

## Step 2 — Create the bucket

A "bucket" is just a named folder in the cloud.

1. Click **Create bucket**.
2. **Name**: `texas-climate-data`
3. **Location**: choose **North American East (ENAM)** — closest to where the
   website runs, which keeps the lookups fast.
4. Click **Create bucket**.

## Step 3 — Make it readable by the website

The weather data is public information that gridMET explicitly allows us to
redistribute, so the bucket can be openly readable. That means the website needs
no password to read it, which is one less secret to protect.

1. Open the bucket, click the **Settings** tab.
2. Find **Public Development URL** and click **Enable**.
3. Copy the address it gives you. It looks like:
   `https://pub-1a2b3c4d5e6f.r2.dev`

> This `r2.dev` address is rate-limited by Cloudflare and meant for getting
> started. If the site gets busy we would attach a proper domain name instead —
> a change of address, not a change of design. Noted for later, not needed now.

## Step 4 — Create a key so the upload script can write

Reading is public; **writing** needs a key.

1. Go back to the **R2 Object Storage** overview page.
2. In the right-hand panel click **Manage API Tokens** (or **API** → **Manage
   API Tokens**).
3. You are offered two kinds. Choose **Create Account API token**.

   > An **account** token belongs to the project; a **user** token belongs to
   > you personally and stops working if your user is ever removed or has its
   > role changed. This token is used by an automated script, so it should not
   > depend on one person's membership.

4. Set:
   - **Token name**: `texas-climate-ingest`
   - **Permissions**: **Object Read & Write**
   - **Specify bucket**: choose only `texas-climate-data`
   - **TTL**: leave as is
5. Click **Create API Token**.

You now get **three values shown once and never again**. Copy all three
immediately:

| Shown as | Looks like |
|---|---|
| **Access Key ID** | a long string of letters and numbers |
| **Secret Access Key** | a longer one |
| **Account ID** | shown on the R2 overview page, in the address bar too |

> **The Secret Access Key is a password.** It can write to and delete from your
> bucket. It goes in `.env.local` on your own computer and nowhere else — not in
> a chat, not in a screenshot, not in a committed file. If it leaks, delete the
> token on this page and make a new one.
>
> It does **not** go into Vercel. Only the upload script uses it, and that runs
> on your machine, not on the website.

## Step 5 — Add them to the project

Open `.env.local` and add four lines:

```
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-access-key-id
R2_SECRET_ACCESS_KEY=your-secret-access-key
R2_BUCKET=texas-climate-data

# The public address from Step 3. This one is NOT secret — the website uses it.
NEXT_PUBLIC_R2_URL=https://pub-1a2b3c4d5e6f.r2.dev
```

`.env.local` is already ignored by git, so none of it can be committed by
accident.

## Step 6 — Tell me when it's done

I will then run the one-time upload: about 7.4 GB downloaded from the University
of Idaho, converted, and written to your bucket. Expect roughly 10 minutes of
downloading plus conversion time.

Nothing about the website changes until that finishes and is verified.

---

## What ends up in the bucket

Texas weather on gridMET's 4 km grid, 1995 to now, four measurements — daily
high, daily low, rainfall, and reference evapotranspiration.

It is stored in **Zarr** format, which is a standard way of saving a big grid of
numbers in many small pieces, so that reading one farm's history means fetching
a few small files instead of the whole state. Being a standard format matters
beyond speed: anyone with the public address can open this same archive in
Python or R, which is what would make the data citable in a paper.
