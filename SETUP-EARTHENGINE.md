# Setting up Earth Engine (one-time, ~10 minutes)

This is the only part I can't do for you — it has to be your Google account.
No coding. Follow the steps in order.

At the end you'll have a small file called a **service account key**. That file is what lets
the website read OpenET water-use data. Treat it like a password.

---

## Before you start

Use a Google account you're happy to have associated with this project. A personal Gmail is fine.

---

## Step 1 — Create and register the project

1. Go to **https://console.cloud.google.com/earth-engine**
2. If asked, sign in with your Google account.
3. Click **Register a new project** (or pick an existing one if you already made one).
4. Give it a name: `texas-climate-trends`
5. When asked what kind of use, choose **Unpaid usage / Noncommercial**.
6. Fill in the short eligibility questionnaire. You are an individual using it for
   noncommercial agricultural extension work — that qualifies.
7. Submit. **Access turns on immediately.**

> This page does the fiddly parts for you: it creates the project, switches on the
> Earth Engine service, and registers it, all in one go.

**Write down the Project ID** it gives you. It looks like `texas-climate-trends-472913` —
note it is *not* always the same as the name you typed. You'll need it in Step 4.

---

## Step 2 — Create the service account

A "service account" is just a login that belongs to the website rather than to a person.

1. Go to **https://console.cloud.google.com/iam-admin/serviceaccounts**
2. Make sure the project selected at the top is the one from Step 1.
3. Click **+ Create service account**
4. Name it: `weather-site`
5. Click **Create and continue**
6. Under **Grant this service account access to project**, add **BOTH** of these roles
   (click **+ Add another role** to add the second):
   - **Earth Engine Resource Viewer**
   - **Service Usage Consumer**
7. Click **Continue**, then **Done**.

> **Both roles are required.** Earth Engine Resource Viewer lets the account read the data;
> Service Usage Consumer lets it use the project at all. Missing the second one gives
> *"Caller does not have required permission to use project …"*, which is confusing because
> it sounds like the key is wrong when the key is fine.

### Step 2b — if you already made the service account without both roles

1. Go to **https://console.cloud.google.com/iam-admin/iam**
2. Check the project selector at the top is your project.
3. Find the row for `weather-site@…gserviceaccount.com` and click the **pencil** icon.
4. Click **+ Add another role** and add whichever of the two is missing.
5. **Save.** Changes can take a couple of minutes to take effect.

---

## Step 3 — Download the key file

1. In the service account list, click the one you just made (`weather-site@...`)
2. Open the **Keys** tab
3. Click **Add key → Create new key**
4. Choose **JSON**
5. Click **Create** — a `.json` file downloads to your computer

**This file is a password.** Anyone who has it can use your Earth Engine access.
Do not email it, do not put it in a shared folder, do not commit it to GitHub.

---

## Step 4 — Put it where the website can find it

**Easiest way — one command.** Open PowerShell in the project folder and run:

```
.\install-key.ps1
```

It finds the downloaded key, copies it in under the right name, writes `.env.local` with your
project ID, and tells you what it did. If it can't find the file, point it at one:

```
.\install-key.ps1 -Path "C:\path\to\your-key.json"
```

<details>
<summary>Doing it by hand instead</summary>

1. Rename the downloaded file to **`earthengine-key.json`**
2. Move it into `c:\Claude_Modeling\Weather_Project\`
3. Create **`.env.local`** in that same folder with your own project ID:

```
GEE_PROJECT_ID=your-project-id
GEE_KEY_FILE=./earthengine-key.json
```

> **Watch out for the double extension.** Windows hides known file extensions, so renaming a
> file to `earthengine-key.json` often produces `earthengine-key.json.json` — which looks
> right in Explorer but the website will not find. This is why the script above is safer.
> To see real extensions: File Explorer → **View** → tick **File name extensions**.

</details>

Both files are git-ignored, so they will never be uploaded anywhere by accident.

## Step 4b — Restart the website

Environment settings are only read at startup. In the window running the site, press
**Ctrl+C**, then run `npm run dev` again.

---

## Step 5 — Tell me it's done

Say the word and I'll wire it up and test it. If anything fails I'll be able to read the
error and tell you which step to redo.

---

## If something goes wrong

**"Permission denied" or "not registered"** — the project in Step 2 wasn't the one registered
in Step 1. Check the project selector at the top of the Cloud Console page.

**"Earth Engine API has not been used"** — go to
https://console.cloud.google.com/apis/library/earthengine.googleapis.com and click **Enable**.

**Asked for a credit card** — you picked the commercial path by mistake. Go back to
https://console.cloud.google.com/earth-engine and re-register as **Unpaid / Noncommercial**.

---

## Important: this is a noncommercial licence

Earth Engine is free for nonprofits, academic work, and individuals doing noncommercial work.
It is **not** free if the tool ever charges money, carries advertising, or is used to deliver
paid consulting work.

If that ever changes, tell me before it happens. We would switch to the OpenET REST API
(your existing key, 400 requests/month) or a paid Earth Engine licence. The code is being
written so that swap is a config change, not a rebuild.
