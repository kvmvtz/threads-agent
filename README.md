# Lead finder — Google Maps + Telegram

A bot that finds potential clients for you and drafts an opening message.
**It only finds and drafts — it never sends anything.** You review
`leads_found.csv` and reach out yourself.

Two sources, both running on GitHub's free Actions runners on a schedule:

1. **Google Maps** (`scripts/find-leads.js`) — scans Google Places for small
   businesses in your target categories/cities and flags the ones with a
   weak, missing, or social-media-only "website" (see below).
2. **Telegram** (`scripts/find-leads-telegram.js`) — monitors specific
   Telegram chats/channels you've already joined for messages matching your
   keywords (e.g. "нужен сайт"), and drops matches into the same tracker.

Both append to the same `leads_found.csv`, so you have one place to work
from regardless of source.

## Why no Facebook search

Facebook's Graph API doesn't let third-party apps search Pages by
category/city (`pages/search` sits behind Page Public Metadata Access, which
needs Business Verification + App Review, and even then is scoped to
engagement analytics — not cold prospecting, and doesn't reliably return a
`website` field). Instead of scraping Facebook (against its ToS, high
ban/legal risk), the Google Maps script does the next best thing: when a
business's Google Maps "website" is actually a `facebook.com` / `m.me` /
`instagram.com` / `wa.me` / `linktr.ee` link, that counts as a lead too — no
real site, just a social page. See `detectSocialOnly()` in
`scripts/find-leads.js`.

## Setting up the Google Maps lead finder

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

Repo → Settings → Secrets and variables → Actions → New repository secret:

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

## Setting up the Telegram lead finder

This one reads a real Telegram account's chats, so read this section fully
before turning it on — there are real account-safety tradeoffs, not just
config steps.

### 0. Use a dedicated Telegram account, not your personal one

Automated chat-reading via Telegram's client protocol is a ToS grey area —
Telegram can flag/limit accounts for automated-looking behavior. Make a
**separate Telegram account** just for this (new number). If anything ever
goes wrong, it's not your real account on the line.

Before turning on automation, **use the new account like a normal person for
a few days first**: set a profile photo and bio, join the chats you plan to
monitor manually (browsing the app normally), maybe send a couple of
messages. An account with zero activity history that suddenly starts reading
100 messages every 6 hours looks a lot more automated than one with a normal
usage pattern behind it.

### 1. Get an API ID / API Hash

Go to https://my.telegram.org, log in **with the dedicated account's phone
number**, open "API development tools", create an app (any name/platform is
fine — this is just an identifier, not a public app listing). You'll get an
**API ID** (number) and **API Hash** (string).

### 2. Join the chats you want monitored

The bot **only reads chats the account has already joined** — it never joins
anything itself (auto-joining lots of chats is exactly the kind of pattern
that gets accounts flagged). Join them yourself, from the Telegram app,
using the dedicated account.

### 3. Log in once, locally

On your own computer (not in CI — this step needs the SMS code from your
phone):

```bash
cd threads-agent   # or whatever you named the repo
npm install
node scripts/telegram-login.js
```

Follow the prompts (API ID, API Hash, phone number, the code Telegram sends
you, and your 2FA password if you have one set). It prints a **session
string** — this is effectively the account's login key, treat it like a
password.

### 4. Add repo secrets

- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `TELEGRAM_SESSION` — the session string from step 3

### 5. Fill in the chat list

`telegram_chats.txt` — one chat per line (username without `@`, or a t.me
link). **Empty by default** — which chats are actually worth monitoring for
your niche needs its own research pass (which chats have real people asking
"нужен сайт" vs. which are dead/spammy), rather than guessing. Until this
file has entries, the workflow runs and does nothing (logs and exits — safe
to leave the schedule on).

### 6. Keywords / stop-words

`telegram_keywords.txt` and `telegram_stopwords.txt` come pre-seeded with a
reasonable starting set for "someone needs a website/developer" — edit
freely. A stop-word match always wins over a keyword match (filters out job
postings, courses, etc. that happen to contain your keywords).

### 7. Test it

Actions tab → "Telegram lead finder" → Run workflow. Same output as the Maps
finder: rows in `leads_found.csv`, a GitHub Issue if anything new was found.

## What it deliberately does NOT do (Telegram)

- Doesn't join chats itself.
- Doesn't mark messages as read or react/reply — read-only history fetch,
  same as opening a chat in any Telegram client.
- Doesn't classify leads with AI (hot/warm/cold scoring, auto-drafted
  personalized replies) — that's a possible v2, intentionally skipped for
  now to ship something simple and working first.
- Runs every 6 hours, not continuously — deliberately not real-time, to keep
  the account's usage pattern from looking automated.
- Respects Telegram's flood-wait errors by sleeping, never retries harder.

## Day to day

Nothing — that's the point. Both finders run on their own schedule and open
a GitHub Issue (→ email) when they find something. `leads_found.csv` logs
every lead ever surfaced (never de-duplicated away — old rows stay so you
have a full record). `leads_seen_ids.txt` (Maps) and
`telegram_leads_state.json` (Telegram) are internal dedup state so
already-checked businesses/messages aren't re-processed.

## Known limitations / things worth knowing

- **Lead finder is a filter, not a verdict**: the "weak site" flag is based
  on Google PageSpeed's mobile score + a couple of crude heuristics (viewport
  tag, HTTPS, social-page-instead-of-website). It'll have false positives and
  misses — treat every row in `leads_found.csv` as "worth a human look", not
  gospel. Same for the Telegram matches — a keyword hit isn't automatically a
  real lead, that's why there's no AI triage yet forcing you to read them.
- **Lead finder costs real (small) money past the free tier**: Places API
  needs billing enabled on the Google Cloud project. The script hard-caps
  volume (`MAX_TERMS_PER_RUN`, `PAGE_SIZE_PER_TERM`) specifically to stay
  inside the free monthly credit at this scale — don't raise those without
  checking current Google Cloud pricing first, and keep the budget alert on.
- **Telegram account risk is real, not theoretical** — read the "Setting up
  the Telegram lead finder" section above before turning the schedule on.
  Using a dedicated account (not your personal one) is the whole point of
  step 0.
- **Lead finder never sends messages** — by design, on both sources. It only
  researches and drafts. Sending cold DMs/emails at bot scale is a fast way
  to get every account involved banned and performs worse than genuine
  personalized outreach anyway.
