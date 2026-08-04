// One-off maintenance script: leads_found.csv rows created before the
// "Телефон" column existed have no phone number saved, even though Google
// Places had it all along (find-leads.js just wasn't storing it yet — fixed
// now, see CSV_HEADERS in find-leads.js). This script backfills those old
// rows by looking up each row's Place ID via the Places API "Place Details"
// endpoint (one call per place, keyed by exact ID — no re-searching, so it
// can't accidentally match the wrong business).
//
// Safe to run more than once: rows that already have a phone (not "—" and
// not empty) are left untouched. Not on any schedule — trigger manually via
// workflow_dispatch on find-leads-backfill-phones.yml, or delete that
// workflow once you don't need it anymore (this script can stay in the repo
// as a reference either way).
//
// Required env var: GOOGLE_PLACES_API_KEY

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CSV_PATH = path.join(ROOT, 'leads_found.csv');
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;
const REF = process.env.GITHUB_REF_NAME || 'main';

if (!PLACES_KEY) {
  console.error('Missing GOOGLE_PLACES_API_KEY');
  process.exitCode = 1;
  return;
}

// Minimal CSV parse/write that matches find-leads.js's own escaping
// (quotes fields containing comma/quote/newline, doubles internal quotes).
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

async function placeDetailsPhone(placeId) {
  const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': PLACES_KEY,
      'X-Goog-FieldMask': 'nationalPhoneNumber',
    },
  });
  if (!res.ok) {
    console.error(`  Place Details error for ${placeId}: ${res.status}`);
    return null;
  }
  const json = await res.json();
  return json.nationalPhoneNumber || null;
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
  const idxPhone = header.indexOf('Телефон');
  const idxPlaceId = header.indexOf('Место (Place ID)');
  const idxCompany = header.indexOf('Компания');
  if (idxPhone === -1 || idxPlaceId === -1) {
    console.error('leads_found.csv is missing expected columns — nothing to do.');
    return;
  }

  let updated = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const current = (r[idxPhone] || '').trim();
    const placeId = (r[idxPlaceId] || '').trim();
    if (current && current !== '—' || !placeId || !placeId.startsWith('ChIJ')) continue;

    console.log(`Смотрю телефон: ${r[idxCompany] || placeId}`);
    let phone = null;
    try {
      phone = await placeDetailsPhone(placeId);
    } catch (e) {
      console.error(`  Ошибка: ${e.message}`);
    }
    r[idxPhone] = phone || '—';
    if (phone) updated++;
    await new Promise((res) => setTimeout(res, 300)); // light pacing, no need to hammer the API
  }

  const lines = rows.map((r) => r.map(csvField).join(','));
  fs.writeFileSync(CSV_PATH, lines.join('\n') + '\n');

  console.log(`Done. Backfilled ${updated} phone number(s).`);

  git('config', 'user.name', 'leads-agent');
  git('config', 'user.email', 'actions@users.noreply.github.com');
  git('add', '-A');
  try {
    git('commit', '-m', `Backfill phone numbers for ${updated} existing lead(s)`);
    git('push', 'origin', `HEAD:${REF}`);
  } catch {
    console.log('Nothing to commit.');
  }
}

main().catch((e) => {
  console.error('backfill-phones failed:', e);
  process.exitCode = 1;
});
