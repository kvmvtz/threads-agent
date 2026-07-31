// Telegram lead monitor — MVP, no AI classification (per plan: ship the
// simple version first, add AI scoring later only if it's clearly needed).
//
// How it works: connects as a regular Telegram account (MTProto, via the
// `teleproto` library — a maintained fork of GramJS, same protocol official
// Telegram apps use) using a session saved once locally with
// scripts/telegram-login.js.
// It only reads chats that account has ALREADY joined manually — it never
// joins chats itself and never sends/reads-marks anything. For each chat in
// telegram_chats.txt, it fetches new messages since the last run, matches
// them against telegram_keywords.txt / telegram_stopwords.txt, and appends
// matches to leads_found.csv as drafts. Nikita reviews and replies himself.
//
// Anti-flag hygiene (this reads a real account's chats, so it matters):
//   - runs on a schedule of hours, not minutes — see the workflow cron
//   - small random delay between chats instead of hammering requests
//   - respects Telegram FLOOD_WAIT errors (sleeps, doesn't retry harder)
//   - read-only: GetHistory only, no join/read-mark/send calls
//   - first run per chat caps how far back it looks (no history dump)
//
// Required env vars: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION
// (all produced once by scripts/telegram-login.js, run locally by Nikita).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { FloodWaitError } = require('teleproto/errors');

const ROOT = path.join(__dirname, '..');
const CHATS_PATH = path.join(ROOT, 'telegram_chats.txt');
const KEYWORDS_PATH = path.join(ROOT, 'telegram_keywords.txt');
const STOPWORDS_PATH = path.join(ROOT, 'telegram_stopwords.txt');
const STATE_PATH = path.join(ROOT, 'telegram_leads_state.json');
const CSV_PATH = path.join(ROOT, 'leads_found.csv');

const REPO = process.env.GITHUB_REPOSITORY;
const REF = process.env.GITHUB_REF_NAME || 'main';
const ACTIONS_TOKEN = process.env.GITHUB_TOKEN;

const API_ID = Number(requireEnv('TELEGRAM_API_ID'));
const API_HASH = requireEnv('TELEGRAM_API_HASH');
const SESSION = requireEnv('TELEGRAM_SESSION');

const MAX_MESSAGES_PER_FETCH = Number(process.env.MAX_MESSAGES_PER_FETCH || 100);
const MIN_DELAY_MS = 3000;
const MAX_DELAY_MS = 9000;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitterDelay() {
  return sleep(MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

// ---------- file helpers ----------

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function readState() {
  if (!fs.existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

const CSV_HEADERS = [
  'Дата находки', 'Источник', 'Компания', 'Сайт', 'Ниша', 'Сложность (оценка)',
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

// ---------- matching ----------

function matchKeyword(text, keywords) {
  const lower = text.toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) return kw;
  }
  return null;
}

function hasStopword(text, stopwords) {
  const lower = text.toLowerCase();
  return stopwords.some((sw) => lower.includes(sw.toLowerCase()));
}

async function senderLabel(message) {
  try {
    const sender = await message.getSender();
    if (!sender) return 'неизвестно';
    if (sender.username) return '@' + sender.username;
    const name = [sender.firstName, sender.lastName].filter(Boolean).join(' ');
    return name || 'без имени';
  } catch {
    return 'неизвестно';
  }
}

function messageLink(chatLabel, chatEntity, messageId) {
  if (chatEntity?.username) return `https://t.me/${chatEntity.username}/${messageId}`;
  // Private chat/group without a public username — only reachable by members.
  const internalId = chatEntity?.id ? String(chatEntity.id).replace(/^-100/, '') : null;
  return internalId ? `https://t.me/c/${internalId}/${messageId}` : `(чат: ${chatLabel})`;
}

// ---------- git ----------

function git(...args) {
  execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });
}

function commitAndPush(message) {
  git('config', 'user.name', 'leads-agent');
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
  if (!ACTIONS_TOKEN || !REPO || !newLeads.length) return;
  const body = [
    `Найдено ${newLeads.length} новых лидов в Telegram за этот прогон. Полная таблица — в \`leads_found.csv\`.`,
    '',
    ...newLeads.map((l) => `- **${l['Компания']}** (по ключу «${l['Ниша']}») — ${l['Проблема']}\n  ${l['Место (Place ID)']}\n  Черновик: ${l['Черновик сообщения']}`),
  ].join('\n');

  const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ACTIONS_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: `Новые лиды (Telegram) — ${new Date().toISOString().slice(0, 10)} (${newLeads.length} шт.)`,
      body,
    }),
  });
  if (!res.ok) console.error('Failed to open issue:', res.status, await res.text());
}

// ---------- main ----------

async function main() {
  const chats = readLines(CHATS_PATH);
  if (!chats.length) {
    console.log('telegram_chats.txt пуст — список чатов ещё не составлен, пропускаю прогон.');
    return;
  }

  const keywords = readLines(KEYWORDS_PATH);
  if (!keywords.length) {
    console.error('telegram_keywords.txt пуст — нечего искать.');
    return;
  }
  const stopwords = readLines(STOPWORDS_PATH);

  const state = readState();
  const newLeads = [];

  const client = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, {
    connectionRetries: 3,
  });
  await client.connect();

  try {
    for (const chatRaw of chats) {
      console.log(`Проверяю чат: ${chatRaw}`);
      let entity;
      try {
        entity = await client.getEntity(chatRaw);
      } catch (e) {
        console.error(`  Не удалось получить чат "${chatRaw}" — аккаунт точно уже вступил туда вручную? (${e.message})`);
        await jitterDelay();
        continue;
      }

      const chatKey = String(entity.id);
      const lastSeenId = state[chatKey] || 0;

      let messages;
      try {
        messages = await client.getMessages(entity, {
          limit: MAX_MESSAGES_PER_FETCH,
          ...(lastSeenId ? { minId: lastSeenId } : {}),
        });
      } catch (e) {
        if (e instanceof FloodWaitError) {
          const waitSec = Math.min(e.seconds || 60, 600); // cap so one run can't hog the whole job
          console.error(`  Flood wait — жду ${waitSec}s`);
          await sleep(waitSec * 1000);
        } else {
          console.error(`  Ошибка чтения "${chatRaw}": ${e.message}`);
        }
        await jitterDelay();
        continue;
      }

      let maxIdSeen = lastSeenId;
      for (const message of messages) {
        if (message.id > maxIdSeen) maxIdSeen = message.id;
        const text = message.message;
        if (!text) continue;
        if (hasStopword(text, stopwords)) continue;
        const matched = matchKeyword(text, keywords);
        if (!matched) continue;

        const chatLabel = entity.username || entity.title || chatRaw;
        const excerpt = text.length > 200 ? text.slice(0, 200) + '…' : text;

        newLeads.push({
          'Дата находки': new Date().toISOString().slice(0, 10),
          'Источник': `Telegram: ${chatLabel}`,
          'Компания': await senderLabel(message),
          'Сайт': '—',
          'Ниша': matched,
          'Сложность (оценка)': '—',
          'Проблема': `Написал(а) в чате: «${excerpt}»`,
          'Черновик сообщения': `Привет! Видел твоё сообщение в чате про «${matched}» — если ещё актуально, могу помочь. Портфолио скину, если интересно.`,
          'Место (Place ID)': messageLink(chatLabel, entity, message.id),
        });
      }

      state[chatKey] = maxIdSeen;
      await jitterDelay();
    }
  } finally {
    await client.disconnect();
  }

  writeState(state);
  appendCsvRows(newLeads);
  commitAndPush(`Telegram lead search: ${chats.length} chats, ${newLeads.length} new leads`);

  if (newLeads.length) {
    await openLeadsIssue(newLeads);
    console.log(`Done. ${newLeads.length} new leads — opened a GitHub issue.`);
  } else {
    console.log('Done. No new leads this run.');
  }
}

main().catch((e) => {
  console.error('find-leads-telegram failed:', e);
  process.exitCode = 1;
});
