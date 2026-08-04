// Shared helper: best-effort extraction of a contact email from a page's
// raw HTML. Used by find-leads.js (on the homepage it already fetches for
// the viewport/HTTPS check) and by backfill-phones.js's sibling,
// backfill-emails.js (which fetches a couple of extra pages per site).
//
// Google Places API has no email field at all, so this is the only way to
// get one — scraping the business's own site. Best-effort by nature: some
// sites hide contact info behind a form, some behind JS that never runs in
// a plain fetch, some have none at all.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Extensions that show up in filenames matching the email regex by accident
// (e.g. "logo@2x.png" reads like an email). Anything with one of these as
// its final "TLD" is not a real address.
const FILE_EXT_BLOCKLIST = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'css', 'js', 'mjs',
  'woff', 'woff2', 'ttf', 'eot', 'json', 'xml', 'pdf', 'map',
]);

// Placeholder / infra addresses that show up on nearly every site built with
// a page builder or that uses common third-party scripts — never a real
// business contact.
const DOMAIN_BLOCKLIST = new Set([
  'example.com', 'example.org', 'sentry.io', 'wixpress.com', 'schema.org',
  'w3.org', 'godaddy.com', 'google.com', 'gstatic.com', 'googleapis.com',
  'fontawesome.com', 'jsdelivr.net', 'cloudflare.com', 'yourdomain.com',
  'domain.com', 'email.com', 'sentry-next.wixpress.com',
]);

// Cloudflare's "email protection" replaces a real mailto with a span whose
// data-cfemail attribute holds the address XOR-obfuscated against its own
// first byte, e.g. data-cfemail="4a2b...". Decode it back to plain text so
// it's findable like any other address.
function decodeCloudflareEmails(html) {
  return html.replace(/data-cfemail="([a-f0-9]+)"/gi, (_, hex) => {
    try {
      const bytes = hex.match(/../g).map((b) => parseInt(b, 16));
      const key = bytes[0];
      const decoded = bytes.slice(1).map((b) => String.fromCharCode(b ^ key)).join('');
      return decoded;
    } catch {
      return '';
    }
  });
}

function isUsableEmail(email) {
  const lower = email.toLowerCase();
  const domain = lower.split('@')[1] || '';
  const tld = domain.split('.').pop();
  if (FILE_EXT_BLOCKLIST.has(tld)) return false;
  if (DOMAIN_BLOCKLIST.has(domain)) return false;
  if (lower.startsWith('you@') || lower.startsWith('user@') || lower.startsWith('name@')) return false;
  return true;
}

// Prefer generic-business-inbox-looking addresses over e.g. a random
// developer's email that happens to appear in a footer credit line.
const PREFERRED_PREFIXES = ['geral', 'info', 'contacto', 'contato', 'contact', 'reservas', 'hello', 'ola'];

function extractEmail(html) {
  if (!html) return null;
  const decoded = decodeCloudflareEmails(html);
  const matches = decoded.match(EMAIL_RE) || [];
  const candidates = [...new Set(matches)].filter(isUsableEmail);
  if (!candidates.length) return null;

  const preferred = candidates.find((e) =>
    PREFERRED_PREFIXES.some((p) => e.toLowerCase().startsWith(p + '@')));
  return preferred || candidates[0];
}

module.exports = { extractEmail, decodeCloudflareEmails, isUsableEmail };
