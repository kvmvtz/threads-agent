// One-off maintenance script (sibling of backfill-phones.js): leads_found.csv
// rows created before the "Email" column existed have no email saved.
// Google Places API has no email field at all — the only source is the
// business's own website (when it has one), so this fetches each lead's
// "Сайт" (homepage, plus a couple of common contact-page paths as a
// fallback) and best-effort extracts an address via scripts/extract-email.js.
//
// Skips rows that already have a real email, rows with no website
// ("(нет сайта)"), and rows whose "website" is actually a social/messaging
// page (facebook.com, wa.me, etc. — no email to find there via a plain
// fetch). Safe to re-run.
//
// No API key needed — just needs outbound internet access, which is why
// this runs on a GitHub Actions runner rather than in a sandboxed dev
// environment that only allowlists a handful of hosts.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { extractEmail } = require('./extract-email');

const ROOT = path.join(__dirname, '..');
const CSV_PATH = path.join(ROOT, 'leads_found.csv');
const REF = process.env.GITHUB_REF_NAME || 'main';

const SOCIAL_HOSTS = /(^|\.)(facebook\.com|fb\.com|m\.me|instagram\.com|wa\.me|api\.whatsapp\.com|linktr\.ee)$/i;

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (c === '\r') {
      // skip
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

function csvField(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// Try the homepage first; if nothing found, try a couple of common
// contact-page paths (PT-language sites often use "contactos"/"contacto").
const CONTACT_PATHS = ['/contacto', '/contactos', '/contact', '/kontakt'];

async function findEmailOnSite(baseUrl) {
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return null;
  }

  const candidates = [baseUrl, ...CONTACT_PATHS.map((p) => origin + p)];
  for (const url of candidates) {
    try {
      const res = await fetchWithTimeout(url, 12000);
      if (!res.ok) continue;
      const html = (await res.text()).slice(0, 30000);
      const email = extractEmail(html);
      if (email) return email;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function git(...args) {
  execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.log('No leads_found.csv yet — nothing to backfill.');
    return;
  }
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
  const header = rows[0];
  let idxWebsite = header.indexOf('Сайт');
  const idxCompany = header.indexOf('Компания');
  if (idxWebsite === -1 || idxCompany === -1) {
    console.error('leads_found.csv is missing expected columns — nothing to do.');
    return;
  }

  // Add the "Email" column (right after "Телефон" if present, else after
  // "Компания") if this CSV predates it. Recompute every index derived from
  // the header AFTER splicing — inserting a column shifts everything after
  // it, and reusing a stale index silently reads the wrong cell.
  let idxEmail = header.indexOf('Email');
  if (idxEmail === -1) {
    const idxPhone = header.indexOf('Телефон');
    idxEmail = (idxPhone === -1 ? idxCompany : idxPhone) + 1;
    header.splice(idxEmail, 0, 'Email');
    for (let i = 1; i < rows.length; i++) rows[i].splice(idxEmail, 0, '—');
    idxWebsite = header.indexOf('Сайт');
    console.log('Добавил колонку "Email" в CSV (её раньше не было).');
  }

  let updated = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const current = (r[idxEmail] || '').trim();
    const website = (r[idxWebsite] || '').trim();
    if (current && current !== '—') continue;
    if (!website || website === '(нет сайта)') { r[idxEmail] = '—'; continue; }
    if (SOCIAL_HOSTS.test((() => { try { return new URL(website).hostname; } catch { return ''; } })())) {
      r[idxEmail] = '—';
      continue;
    }

    console.log(`Смотрю email: ${r[idxCompany] || website}`);
    let email = null;
    try {
      email = await findEmailOnSite(website);
    } catch (e) {
      console.error(`  Ошибка: ${e.message}`);
    }
    r[idxEmail] = email || '—';
    if (email) updated++;
  }

  const lines = rows.map((r) => r.map(csvField).join(','));
  fs.writeFileSync(CSV_PATH, lines.join('\n') + '\n');

  console.log(`Done. Backfilled ${updated} email(s).`);

  git('config', 'user.name', 'leads-agent');
  git('config', 'user.email', 'actions@users.noreply.github.com');
  git('add', '-A');
  try {
    git('commit', '-m', `Backfill emails for ${updated} existing lead(s)`);
    git('push', 'origin', `HEAD:${REF}`);
  } catch {
    console.log('Nothing to commit.');
  }
}

main().catch((e) => {
  console.error('backfill-emails failed:', e);
  process.exitCode = 1;
});
