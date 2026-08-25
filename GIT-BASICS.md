# Git, in plain language

You said you know what push, pull and commit mean. This fills in the rest — just enough to use
it confidently, nothing more.

---

## The one idea

Git is a **history of your project**. Not a backup of the current state — a record of every
version, with a note on each explaining what changed. You can go back to any of them.

GitHub is a website that stores a copy of that history online, so it survives your laptop and
other people can see it.

---

## The three places your work lives

```
   your folder            the staging area           the history
   (working tree)             (index)                  (commits)
        |                        |                         |
        |------ git add -A ----->|                         |
        |                        |----- git commit ------->|
        |                        |                         |
        |                                                  |
        |<---------------- git push ---------------------->|  GitHub
```

- **Your folder** — the actual files, as you see them in Explorer.
- **Staging area** — a holding pen. `git add` puts changes there. This exists so you can commit
  *some* changes and not others. You will almost always just stage everything with `git add -A`.
- **History** — `git commit` takes whatever is staged and records it permanently with a message.
- **GitHub** — `git push` sends new commits up. `git pull` brings other people's down.

A **commit** is one saved point in the history. The message is a note to your future self.

---

## The four commands you'll actually use

```
git status              What has changed? Run this whenever unsure. It is always safe.

git add -A              Stage everything that changed. (-A means "all")

git commit -m "..."     Record the staged changes, with a message in the quotes.

git push                Send your commits to GitHub.
```

The normal rhythm, every time you change something:

```
git add -A
git commit -m "made the deficit wording clearer"
git push
```

Three lines. That's the whole day-to-day.

---

## Useful when something feels wrong

```
git status              Always start here.

git log --oneline       List past commits, newest first. Press q to exit.

git diff                Show exactly what changed since the last commit. Press q to exit.

git restore <file>      Throw away your changes to one file, back to the last commit.
```

> If a git command fills the screen and won't take input, press **q**. Git pipes long output
> through a pager and `q` quits it. This confuses everyone the first time.

---

## What does NOT go to GitHub

A file called `.gitignore` lists things git deliberately never touches. Ours protects:

| Ignored | Why |
|---|---|
| `earthengine-key.json` | **This is a password.** Never publish it. |
| `.env.local` | Contains your project settings |
| `node_modules/` | 300 MB of downloaded libraries; rebuilt by one command |
| `.next/` | Built output; regenerated every time |

So your secrets stay on your machine. That is by design, and it's why the site needs those values
entered separately into Vercel.

**If you ever add a new file with a password in it, tell me before committing.**

---

## Writing commit messages

Say what changed and why, not how. Present tense. You are writing to yourself in six months.

Good:
```
git commit -m "stop ET line at satellite data gaps"
git commit -m "add water balance to year-by-year trend"
```

Less useful:
```
git commit -m "update"
git commit -m "changes"
```

---

## Two things that scare people, defused

**"Detached HEAD"** — you're looking at an old commit rather than the latest. Get back with
`git checkout main`. Nothing is lost.

**A merge conflict** — two edits to the same line, git can't choose. Only happens when more than
one person edits, or you edit on two machines. If you see it, stop and ask me; it's fixable and
nothing is destroyed.

**Nothing in git is really deleted.** Committed work can almost always be recovered. The only
genuinely unsafe thing is deleting work you never committed — which is an argument for committing
often.
