// Weekly lead-finder: scans Google Maps (Places API) for small businesses in
// Nikita's target categories/cities, flags the ones with a genuinely weak
// (or missing) website, and drops them into leads_found.csv with a drafted
// opening line — ready for Nikita to review and send himself.
//
// This script only FINDS and DRAFTS. It never sends anything to anyone.
//
// Required env vars:
//   GOOGLE_PLACES_API_KEY     - Places API (New) key
//   GOOGLE_PAGESPEED_API_KEY  - PageSpeed Insights API key (can be the same key
//                                if both APIs are enabled on it)
// Optional:
//   MAX_TERMS_PER_RUN (default 6)
//   PAGE_SIZE_PER_TERM (default 5)
//
// Timing note: each place with a real website gets a live Google PageSpeed
// (Lighthouse) audit, which routinely takes 10-30s per site — that's Google's
// audit being slow, not a bug here. With up to MAX_TERMS_PER_RUN * PAGE_SIZE_PER_TERM
// places per run, that adds up fast, so keep these two numbers modest relative
// to the workflow's `timeout-minutes` (see find-leads.yml) or a run can get
// killed mid-way (shows up as "The operation was canceled." in the log — not
// an API error, just ran out of time).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { guessComplexity } = require('./complexity-guess');
const { extractEmail } = require('./extract-email');

const ROOT = path.join(__dirname, '..');
const TERMS_PATH = path.join(ROOT, 'lead_search_terms.txt');
const STATE_PATH = path.join(ROOT, 'leads_state.json');
const CSV_PATH = path.join(ROOT, 'leads_found.csv');
const SEEN_PATH = path.join(ROOT, 'leads_seen_ids.txt');

const REPO = process.env.GITHUB_REPOSITORY;
const REF = process.env.GITHUB_REF_NAME || 'main';
const PLACES_KEY = requireEnv('GOOGLE_PLACES_API_KEY');
const PSI_KEY = requireEnv('GOOGLE_PAGESPEED_API_KEY');
const MAX_TERMS_PER_RUN = Number(process.env.MAX_TERMS_PER_RUN || 6);
const PAGE_SIZE_PER_TERM = Number(process.env.PAGE_SIZE_PER_TERM || 5);
const ACTIONS_TOKEN = process.env.GITHUB_TOKEN; // provided automatically by Actions

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// ---------- small file helpers ----------

function readTerms() {
  if (!fs.existsSync(TERMS_PATH)) return [];
  return fs.readFileSync(TERMS_PATH, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [category, city] = l.split('|').map((s) => s.trim());
      return { category, city };
    });
}

function readState() {
  if (!fs.existsSync(STATE_PATH)) return { nextIndex: 0 };
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function readSeenIds() {
  if (!fs.existsSync(SEEN_PATH)) return new Set();
  return new Set(fs.readFileSync(SEEN_PATH, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));
}

function appendSeenIds(ids) {
  if (!ids.length) return;
  fs.appendFileSync(SEEN_PATH, ids.join('\n') + '\n');
}

const CSV_HEADERS = [
  'Дата находки', 'Источник', 'Компания', 'Телефон', 'Email', 'Сайт', 'Ниша', 'Сложность (оценка)',
  'Проблема', 'Черновик сообщения', 'Место (Place ID)',
];

function csvField(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function appendCsvRows(rows) {
  if (!rows.length) return;
  const needsHeader = !fs.existsSync(CSV_PATH) || fs.statSync(CSV_PATH).size === 0;
  const lines = [];
  if (needsHeader) lines.push(CSV_HEADERS.map(csvField).join(','));
  for (const row of rows) lines.push(CSV_HEADERS.map((h) => csvField(row[h])).join(','));
  fs.appendFileSync(CSV_PATH, lines.join('\n') + '\n');
}

// ---------- Google APIs ----------

async function placesTextSearch(category, city) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': PLACES_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber',
    },
    body: JSON.stringify({ textQuery: `${category} in ${city}`, pageSize: PAGE_SIZE_PER_TERM }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Places API error (${res.status}): ${JSON.stringify(json)}`);
  return json.places || [];
}

async function pagespeedScore(url) {
  const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  endpoint.searchParams.set('url', url);
  endpoint.searchParams.set('key', PSI_KEY);
  endpoint.searchParams.set('strategy', 'mobile');
  const res = await fetchWithTimeout(endpoint.toString(), {}, 25000);
  const json = await res.json();
  if (!res.ok) throw new Error(`PSI error (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  const score = json?.lighthouseResult?.categories?.performance?.score;
  return typeof score === 'number' ? Math.round(score * 100) : null;
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function rawSiteSignals(url) {
  try {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 15000);
    const html = (await res.text()).slice(0, 20000);
    return {
      ok: res.ok,
      isHttps: url.startsWith('https://'),
      hasViewport: /<meta[^>]+name=["']viewport["']/i.test(html),
      // Best-effort only — same page we already downloaded, no extra
      // request. Places API has no email field at all, so this (or the
      // one-off backfill-emails.js, which also tries a couple of extra
      // pages like /contact) is the only source for one.
      email: extractEmail(html),
    };
  } catch (e) {
    return { ok: false, isHttps: url.startsWith('https://'), hasViewport: false, email: null, error: String(e) };
  }
}

// ---------- lead evaluation ----------

// Businesses that link a social/messaging page instead of a real website in
// their Google Maps "website" field. Facebook Graph API doesn't let a
// third-party app *search* Pages by category/city (Page Public Metadata
// Access needs Business Verification + App Review, and even then it's scoped
// to analytics, not cold prospecting) — so instead of searching Facebook
// directly, we piggyback on Google Maps' own discovery (which we already do)
// and just check what kind of "website" each business actually links.
const SOCIAL_ONLY_HOSTS = [
  { match: /(^|\.)facebook\.com$/i, platform: 'Facebook' },
  { match: /(^|\.)fb\.com$/i, platform: 'Facebook' },
  { match: /(^|\.)m\.me$/i, platform: 'Facebook Messenger' },
  { match: /(^|\.)instagram\.com$/i, platform: 'Instagram' },
  { match: /(^|\.)wa\.me$/i, platform: 'WhatsApp' },
  { match: /(^|\.)api\.whatsapp\.com$/i, platform: 'WhatsApp' },
  { match: /(^|\.)linktr\.ee$/i, platform: 'Linktree (агрегатор ссылок)' },
];

function detectSocialOnly(website) {
  try {
    const host = new URL(website).hostname;
    for (const s of SOCIAL_ONLY_HOSTS) if (s.match.test(host)) return s.platform;
  } catch {
    // not a parseable URL — treat like a normal (weird) website below
  }
  return null;
}

// Which language the drafted opener message is written in — the "Проблема"
// column stays Russian either way (that's Nikita's own working note, not
// something sent to the business). Currently: Brazilian Portuguese for
// Brazil-based search terms (city contains "Brazil"), English everywhere
// else. Add more cities/countries here if outreach should switch language
// elsewhere too.
function messageLangForCity(city) {
  return /\bbrazil\b/i.test(city) ? 'pt' : 'en';
}

const OPENERS = {
  en: {
    noWebsite: (name) =>
      `Hi! I noticed ${name} doesn't have a website yet — happy to put together a simple one so people can find/book you online. No pressure, just let me know if useful.`,
    socialOnly: (name, platform) =>
      `Hi! Noticed ${name} runs on a ${platform} page instead of its own website — happy to put together a simple site so people can find/book you directly (and own the domain/branding). No pressure, just let me know if useful.`,
    siteDown: (name) =>
      `Hi! Tried to check out ${name}'s website and it seems to be having issues loading — wanted to flag it in case that's costing you visitors. Happy to take a look if useful.`,
    weakSite: (name, detail) =>
      `Hi! Checked out ${name}'s website — noticed it ${detail}, which is probably costing you visitors. Happy to send a quick fix plan if useful, no pressure.`,
    weakSiteDetail: (hasViewport, score) =>
      !hasViewport
        ? "doesn't render well on mobile"
        : typeof score === 'number'
        ? `scores ${score}/100 on Google's mobile speed test`
        : 'has a few technical issues',
  },
  pt: {
    noWebsite: (name) =>
      `Olá! Percebi que a ${name} ainda não tem site — posso montar um simples para que as pessoas encontrem e marquem horário online. Sem compromisso, só avisar se for útil.`,
    socialOnly: (name, platform) =>
      `Olá! Percebi que a ${name} usa uma página do ${platform} em vez de um site próprio — posso montar um site simples para vocês, para que as pessoas encontrem e marquem direto com vocês (e vocês tenham domínio e marca próprios). Sem compromisso, só avisar se for útil.`,
    siteDown: (name) =>
      `Olá! Tentei acessar o site da ${name} e parece que está com problemas para carregar — quis avisar, porque isso pode estar custando visitantes. Posso dar uma olhada se for útil.`,
    weakSite: (name, detail) =>
      `Olá! Dei uma olhada no site da ${name} — percebi que ${detail}, o que provavelmente está custando visitantes. Posso enviar um plano rápido de correção se for útil, sem compromisso.`,
    weakSiteDetail: (hasViewport, score) =>
      !hasViewport
        ? 'não é bem exibido em dispositivos móveis'
        : typeof score === 'number'
        ? `tem nota ${score}/100 no teste de velocidade mobile do Google`
        : 'tem alguns problemas técnicos',
  },
};

async function evaluatePlace(place, category, city) {
  const name = place.displayName?.text || '(без названия)';
  const website = place.websiteUri;
  const lang = messageLangForCity(city);
  const M = OPENERS[lang];

  if (!website) {
    return {
      isLead: true,
      website: '(нет сайта)',
      email: null,
      problem: 'Сайта нет вообще — самый простой питч: помочь появиться онлайн.',
      opener: M.noWebsite(name),
    };
  }

  const socialPlatform = detectSocialOnly(website);
  if (socialPlatform) {
    return {
      isLead: true,
      website,
      email: null, // no email source on a social/messaging-only page
      problem: `Вместо сайта — страница ${socialPlatform} (своего домена/сайта нет).`,
      opener: M.socialOnly(name, socialPlatform),
    };
  }

  let score = null, signals = null, errored = false;
  try {
    score = await pagespeedScore(website);
  } catch (e) {
    errored = true;
  }
  try {
    signals = await rawSiteSignals(website);
  } catch (e) {
    signals = { ok: false, isHttps: website.startsWith('https://'), hasViewport: false, email: null };
  }

  if (errored || !signals.ok) {
    return {
      isLead: true,
      website,
      email: signals?.email || null,
      problem: 'Сайт не отвечает нормально (ошибка/таймаут при проверке) — вероятно, серьёзные проблемы.',
      opener: M.siteDown(name),
    };
  }

  const isWeak = (typeof score === 'number' && score < 50) || !signals.hasViewport || !signals.isHttps;
  if (!isWeak) return { isLead: false };

  const problems = [];
  if (typeof score === 'number' && score < 50) problems.push(`мобильная скорость ${score}/100 (Google PageSpeed)`);
  if (!signals.hasViewport) problems.push('не адаптирован под мобильные (нет viewport)');
  if (!signals.isHttps) problems.push('нет HTTPS');

  return {
    isLead: true,
    website,
    email: signals.email || null,
    problem: problems.join('; '),
    opener: M.weakSite(name, M.weakSiteDetail(signals.hasViewport, score)),
  };
}

// ---------- git + GitHub API ----------

function git(...args) {
  execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });
}

function commitAndPush(message) {
  git('config', 'user.name', 'threads-daily-agent');
  git('config', 'user.email', 'actions@users.noreply.github.com');
  git('add', '-A');
  try {
    git('commit', '-m', message);
  } catch {
    console.log('Nothing to commit (' + message + ')');
    return;
  }
  git('push', 'origin', `HEAD:${REF}`);
}

async function openLeadsIssue(newLeads) {
  if (!ACTIONS_TOKEN || !REPO) return;
  const body = [
    `Найдено ${newLeads.length} новых лидов за этот прогон. Полная таблица — в \`leads_found.csv\`.`,
    '',
    ...newLeads.map((l) => `- **${l['Компания']}** (${l['Ниша']}, ${l['Источник'].replace('Google Maps: ', '')}) — ${l['Проблема']}\n  Телефон: ${l['Телефон']}\n  Email: ${l['Email']}\n  Сайт: ${l['Сайт']}\n  Черновик: ${l['Черновик сообщения']}`),
  ].join('\n');

  const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ACTIONS_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: `Новые лиды — ${new Date().toISOString().slice(0, 10)} (${newLeads.length} шт.)`,
      body,
    }),
  });
  if (!res.ok) console.error('Failed to open issue:', res.status, await res.text());
}

// ---------- main ----------

async function main() {
  const terms = readTerms();
  if (!terms.length) {
    console.error('lead_search_terms.txt is empty — nothing to search.');
    return;
  }

  const state = readState();
  const seenIds = readSeenIds();
  const newSeenIds = [];
  const newLeads = [];

  const startIndex = state.nextIndex % terms.length;
  const batch = [];
  for (let i = 0; i < MAX_TERMS_PER_RUN; i++) batch.push(terms[(startIndex + i) % terms.length]);

  for (const { category, city } of batch) {
    console.log(`Searching: ${category} in ${city}`);
    let places;
    try {
      places = await placesTextSearch(category, city);
    } catch (e) {
      console.error('Search failed, skipping term:', e.message);
      continue;
    }

    for (const place of places) {
      if (!place.id || seenIds.has(place.id) || newSeenIds.includes(place.id)) continue;
      newSeenIds.push(place.id);

      console.log(`  Проверяю: ${place.displayName?.text || place.id}`);
      let evaluation;
      try {
        evaluation = await evaluatePlace(place, category, city);
      } catch (e) {
        console.error('Evaluation failed for', place.displayName?.text, e.message);
        continue;
      }

      if (!evaluation.isLead) continue;

      newLeads.push({
        'Дата находки': new Date().toISOString().slice(0, 10),
        'Источник': `Google Maps: ${category} in ${city}`,
        'Компания': place.displayName?.text || '(без названия)',
        'Телефон': place.nationalPhoneNumber || '—',
        'Email': evaluation.email || '—',
        'Сайт': evaluation.website,
        'Ниша': category,
        'Сложность (оценка)': guessComplexity(category),
        'Проблема': evaluation.problem,
        'Черновик сообщения': evaluation.opener,
        'Место (Place ID)': place.id,
      });
    }
  }

  appendSeenIds(newSeenIds);
  appendCsvRows(newLeads);
  writeState({ nextIndex: (startIndex + MAX_TERMS_PER_RUN) % terms.length });

  commitAndPush(`Lead search: ${batch.length} terms, ${newLeads.length} new leads`);

  if (newLeads.length) {
    await openLeadsIssue(newLeads);
    console.log(`Done. ${newLeads.length} new leads — opened a GitHub issue.`);
  } else {
    console.log('Done. No new leads this run.');
  }
}

main().catch((e) => {
  console.error('find-leads failed:', e);
  process.exitCode = 1;
});
