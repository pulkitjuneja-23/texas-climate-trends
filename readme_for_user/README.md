# Guides for you

Everything in this folder is written for **you**, in plain language, no coding knowledge assumed.
Nothing here affects how the website runs — these are notes, not code. Read them in any order,
but this is roughly the useful order.

---

### 1. [START-HERE.md](START-HERE.md) — how to open and read the site
Start the website, stop it, fix it when it looks broken. Then a walk through every panel on the
page and what the numbers mean, including the honest limits of each one.

**Read this one first**, and re-read the panel section whenever a number surprises you.

---

### 2. [DEPLOY.md](DEPLOY.md) — putting the site on the internet
What "deploying" means, why Docker isn't needed, what it costs, and the steps to publish so other
people can open it. Also lists what to watch once it's public.

---

### 3. [GIT-BASICS.md](GIT-BASICS.md) — saving your work safely
Git in plain terms: the three places your work lives, the four commands you'll actually use, and
the two scary-sounding errors defused. Also explains what deliberately never gets uploaded, and why.

**The routine is three lines**, and it's at the top of that file.

---

### 4. [SETUP-EARTHENGINE.md](SETUP-EARTHENGINE.md) — the Google setup (already done)
Click-by-click instructions for the Earth Engine account that powers the satellite water-use data.
You've already completed this. Keep it for if you ever set the project up on another computer, or
need to replace the key.

---

## What is NOT in this folder

| File | What it is |
|---|---|
| `../CLAUDE.md` | Technical notes for Claude — every trap hit, every bug and why it mattered. Not written for humans to read start to finish, but it is what lets a future session pick up cold. **Don't delete it.** |
| `../README.md` | The standard technical summary programmers expect at the top of a project. |
| `../install-key.ps1` | A helper script. Must stay in the main folder to work. |

---

## The one rule worth remembering

**Your Earth Engine key (`earthengine-key.json`) and `.env.local` are passwords.**
They stay on your computer. They are never uploaded to GitHub, and they are not in this folder.
If you ever need them on another machine, follow SETUP-EARTHENGINE.md again rather than emailing
the file to yourself.
