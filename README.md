# Threads daily design agent + lead finder

Two automations living in one repo:

1. **Daily Threads poster** — every day it takes the next site off your
   queue, records a scroll-through video of it, and publishes it to your
   Threads account with a "Day N of 100" caption — no manual posting, no
   daily check-in required once it's set up.
2. **Weekly lead finder** — scans Google Maps for small businesses in your
   target categories/cities, flags the ones with a weak or missing website,
   and drops them into `leads_found.csv` with a drafted opening line and a
   GitHub notification. **It only finds and drafts — it never sends
   anything.** You review and send yourself.

Both run entirely on GitHub's free Actions runners (real internet access,
unlike a lot of sandboxed AI tools) on a schedule.

## Desktop buttons (if you got this via the Desktop folder)

Next to this README you should have:

- **🤖 Запустить бота.command** — triggers the lead finder on demand instead
  of waiting for its Wednesday schedule.
- **📋 Таблица лидов.command** — opens `leads_found.csv` on GitHub in your
  browser (GitHub renders CSVs as a nice table — this is always the current
  version, no local file to keep in sync).
- **repo-config.txt** — the ONE file you edit: put your `owner/repo` in
  there (see step 1 below) and both buttons pick it up automatically.
- **🧵 Код агента.zip** — this whole project, ready to push to GitHub (step 1).

The buttons need **GitHub CLI** installed and logged in once:

```bash
brew install gh        # or download from https://cli.github.com
gh auth login           # follow the prompts, choose GitHub.com → HTTPS → login via browser
```

After that, double-clicking `🤖 Запустить бота.command` runs
`gh workflow run find-leads.yml` against whatever repo is in
`repo-config.txt` and opens the run in your browser. If double-clicking a
`.command` file ever just opens it in a text editor instead of running it,
right-click → Open With → Terminal once, or run `chmod +x` on it from
Terminal.

**Want a custom icon on the button instead of the default one?** Totally
optional — Finder: select an image → Cmd+C → select the `.command` file →
Cmd+I (Get Info) → click the small icon top-left of that panel → Cmd+V.
Takes about 10 seconds; the emoji in the filename already makes it stand out
in the file list either way.

## One-time setup (~30-45 min)

### 1. Create the GitHub repo

Create a **new GitHub repo under your own account** (private is fine — Actions
works the same on private repos, you just get 2,000 free CI minutes/month
instead of unlimited; this project uses maybe 5-10 min/day, nowhere close).

Push everything in this folder to that repo:

```bash
cd threads-agent
git init
git add -A
git commit -m "Initial setup"
git branch -M main
git remote add origin https://github.com/<you>/<your-repo>.git
git push -u origin main
```

### 2. Create the Meta app + Threads product

1. Go to https://developers.facebook.com/apps and create a new app (type:
   "Other" / consumer app is fine — you're not building for other users).
2. In the app dashboard, add the **Threads** product/use case.
3. Under the Threads product's settings, add yourself (your Threads account)
   as a **tester** — this is the key step that lets you publish to your own
   account with zero App Review. App Review is only needed if you want
   *other people's* Threads accounts to use this app.
4. Note your **App ID** and **App Secret** (App Settings → Basic).
5. Add an **OAuth redirect URI**. You don't need a real server — any HTTPS
   URL you control works, even `https://github.com/<you>` — you're only
   using it to grab a `?code=...` out of the address bar in step 3 below,
   the page doesn't need to do anything.

### 3. Get your first access token

On your own computer (not in CI — this step needs a real browser):

```bash
cd threads-agent
npm install
node scripts/get-first-token.js authorize-url <APP_ID> <REDIRECT_URI>
```

Open the printed URL, log in with your Threads account, approve access.
You'll land on your redirect URI with `?code=...` in the address bar — copy
everything after `code=` (stop before any `#_` at the end).

```bash
node scripts/get-first-token.js exchange <APP_ID> <APP_SECRET> <REDIRECT_URI> <CODE>
```

This prints your `THREADS_USER_ID` and a 60-day `THREADS_ACCESS_TOKEN`.
**Nothing is sent anywhere except Meta's own API** — this all happens on
your machine.

### 4. Add GitHub repo secrets

Repo → Settings → Secrets and variables → Actions → New repository secret:

- `THREADS_USER_ID` — from step 3
- `THREADS_ACCESS_TOKEN` — from step 3

### 5. (Optional but recommended) Set up automatic token refresh

Long-lived tokens last 60 days. Without this step you'd need to redo step 3
every ~2 months by hand. To automate it:

1. Create a **fine-grained personal access token**: GitHub → Settings →
   Developer settings → Personal access tokens → Fine-grained tokens → new
   token, scoped to **only this one repo**, with **Secrets: Read and write**
   permission (repository secrets), nothing else.
2. Add it as a repo secret named `ADMIN_PAT`.

The `refresh-token.yml` workflow runs weekly, calls Meta's refresh endpoint,
and writes the new token back into `THREADS_ACCESS_TOKEN` automatically. If
you skip this step, just re-run step 3 manually every ~50 days.

### 6. Add sites to the queue

Edit `sites_queue.txt`, one line per site:

```
https://example.com | Example Site | that scroll-triggered hero is the whole reason to visit
```

Commit and push. Add more whenever inspiration strikes — no daily obligation.

### 7. Test it

Actions tab → "Daily Threads post" → Run workflow (this is the
`workflow_dispatch` trigger, lets you fire it on demand instead of waiting
for 17:00 UTC). Watch the run; check your Threads profile afterward.

## Setting up the lead finder (separate, optional)

This is independent of the Threads poster — skip it if you only want the
daily video for now.

### 1. Get a Google Cloud API key

1. Go to https://console.cloud.google.com, create a project (or reuse one).
2. **Enable billing** on the project. This sounds scarier than it is: Places
   API requires a billing account even to use the free monthly credit, but
   at the volumes this script runs (a handful of searches a week, hard-capped
   — see `MAX_TERMS_PER_RUN` in `scripts/find-leads.js`), you should stay
   comfortably inside the free credit. **Set a budget alert** in Cloud
   Console (Billing → Budgets & alerts) for something like $5 as a safety
   net regardless — costs and free-tier amounts change over time, so check
   current pricing in the console before scaling this up.
3. Enable two APIs: **Places API (New)** and **PageSpeed Insights API**.
4. Create an API key (APIs & Services → Credentials). For safety, restrict
   it to just those two APIs.

### 2. Add repo secrets

- `GOOGLE_PLACES_API_KEY`
- `GOOGLE_PAGESPEED_API_KEY` (can be the same key if both APIs are enabled on it)

### 3. Edit the target list

`lead_search_terms.txt` — one `Category | City` per line, already seeded
with ~225 combinations across expat-hub cities and common small-business
categories. Trim it down or add more any time; it's a queue the bot cycles
through forever (a handful of terms per run, see the cron in
`find-leads.yml`), so re-scanning the same city later just picks up newly
opened businesses.

### 4. Test it

Actions tab → "Weekly lead finder" → Run workflow. Check the run log, then
`leads_found.csv` in the repo, and (if it found anything) a new GitHub Issue
summarizing the batch — that Issue is what triggers GitHub's normal email
notification to you, so you don't have to remember to check the repo.

### 5. (Optional) Route the bot's emails to a dedicated work inbox

If you want a separate mailbox just for this — bot notifications in, and the
same inbox for actually writing to prospects — create that mailbox yourself
first (Gmail, or whatever you prefer; account creation isn't something
Claude can do on your behalf). Then point GitHub's notifications at it:

1. GitHub → Settings → **Emails** → add the new address, verify it (click
   the link GitHub emails you).
2. Same page → **"Send notifications to"** (or Settings → Notifications, the
   exact label has moved around over the years) → pick the new address
   instead of your primary one.

That's it — no code changes needed, GitHub just starts emailing the new
inbox for the lead-finder Issues (and everything else on the account, so
this is an all-or-nothing switch unless you keep a separate GitHub account
just for this repo).

## Day to day

Nothing — that's the point. If the video queue runs dry, the scheduled
posting run fails on purpose and GitHub emails you automatically (default
behavior for failed scheduled workflows) — that's your signal to add more
URLs. The lead finder just quietly runs weekly and opens an Issue when it
finds something.

`history.md` logs every successful Threads post. `leads_found.csv` logs
every lead the finder has ever surfaced (never de-duplicated away — old rows
stay so you have a full record; `leads_seen_ids.txt` is the internal
dedup list so already-checked businesses aren't re-evaluated every week).

## Known limitations / things worth knowing

- **DST**: the cron is hardcoded in UTC. It'll post at 19:00 Prague time
  while Prague is on CEST (roughly late March–late October) and drift to
  18:00 after the switch to CET in late October — update the cron in
  `.github/workflows/daily-post.yml` when that happens (or ping Claude to do
  it).
- **Video hosting**: the recorded video is committed to the repo and served
  via `raw.githubusercontent.com` for Meta to fetch during publish — this
  means **the repo needs to stay public** (or at least the video path needs
  to be publicly reachable) for the Threads API to be able to download it.
  Old videos are auto-deleted 2 days after posting to keep the repo small.
- **Site quality**: nothing here judges whether a site is "good" — that's
  entirely on you via what you add to the queue. Some sites may render
  oddly headless (fonts, animations, cookie banners) — spot-check a new
  domain with `workflow_dispatch` before trusting it unattended, or just
  eyeball the video in `videos/day-N.mp4` after a run.
- **Threads platform rules**: this only *publishes your own original video
  posts* via the official API — it doesn't auto-comment, auto-follow, or
  interact with other people's content, so it doesn't carry the ban risk
  that mass-automation/engagement tools do.
- **Lead finder is a filter, not a verdict**: the "weak site" flag is based
  on Google PageSpeed's mobile score + a couple of crude heuristics (viewport
  tag, HTTPS). It'll have false positives and misses — treat every row in
  `leads_found.csv` as "worth a human look", not gospel. Same for the
  complexity guess — it's a category-based rule of thumb, not a quote.
- **Lead finder costs real (small) money past the free tier**: Places API
  needs billing enabled on the Google Cloud project. The script hard-caps
  volume (`MAX_TERMS_PER_RUN`, `PAGE_SIZE_PER_TERM`) specifically to stay
  inside the free monthly credit at this scale — don't raise those without
  checking current Google Cloud pricing first, and keep the budget alert on.
- **Lead finder never sends messages** — by design. It only researches and
  drafts. Sending cold DMs/emails at bot scale is a fast way to get every
  account involved banned and, per the actual research on this (see the
  Threads project notes), performs worse than genuine personalized outreach
  anyway.
