// One-time helper to get your FIRST Threads long-lived access token.
// Run this on your own computer (not in CI) — it never sends your
// client secret or tokens anywhere except Meta's own API.
//
// Usage:
//   node scripts/get-first-token.js authorize-url <APP_ID> <REDIRECT_URI>
//     -> prints the URL to open in your browser
//
//   node scripts/get-first-token.js exchange <APP_ID> <APP_SECRET> <REDIRECT_URI> <CODE>
//     -> exchanges the ?code=... you got back for a short-lived token,
//        then immediately upgrades it to a 60-day long-lived token and
//        prints both the token and your numeric Threads user id.

const [, , cmd, ...rest] = process.argv;

async function main() {
  if (cmd === 'authorize-url') {
    const [appId, redirectUri] = rest;
    if (!appId || !redirectUri) return usage();
    const url = new URL('https://threads.net/oauth/authorize');
    url.searchParams.set('client_id', appId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'threads_basic,threads_content_publish');
    url.searchParams.set('response_type', 'code');
    console.log('Open this URL in your browser, log in, and approve access:\n');
    console.log(url.toString());
    console.log('\nAfter approving, you\'ll be redirected to your redirect_uri with a ?code=... in the address bar.');
    console.log('Copy everything after "code=" and before any trailing "#_" — that\'s your CODE.');
    return;
  }

  if (cmd === 'exchange') {
    const [appId, appSecret, redirectUri, code] = rest;
    if (!appId || !appSecret || !redirectUri || !code) return usage();

    // Step 1: code -> short-lived token
    const shortRes = await fetch('https://graph.threads.net/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      }),
    });
    const shortJson = await shortRes.json();
    if (!shortRes.ok || !shortJson.access_token) {
      throw new Error('Short-lived token exchange failed: ' + JSON.stringify(shortJson));
    }
    console.log('Got short-lived token. Threads user id:', shortJson.user_id);

    // Step 2: short-lived -> long-lived (60 days)
    const longUrl = new URL('https://graph.threads.net/access_token');
    longUrl.searchParams.set('grant_type', 'th_exchange_token');
    longUrl.searchParams.set('client_secret', appSecret);
    longUrl.searchParams.set('access_token', shortJson.access_token);
    const longRes = await fetch(longUrl.toString());
    const longJson = await longRes.json();
    if (!longRes.ok || !longJson.access_token) {
      throw new Error('Long-lived token exchange failed: ' + JSON.stringify(longJson));
    }

    console.log('\n=== Save these as GitHub repo secrets ===');
    console.log('THREADS_USER_ID      =', shortJson.user_id);
    console.log('THREADS_ACCESS_TOKEN =', longJson.access_token);
    console.log(`(long-lived token, valid ~${Math.round((longJson.expires_in || 5184000) / 86400)} days — the daily workflow will keep it refreshed automatically after that, see README)`);
    return;
  }

  usage();
}

function usage() {
  console.log(`Usage:
  node scripts/get-first-token.js authorize-url <APP_ID> <REDIRECT_URI>
  node scripts/get-first-token.js exchange <APP_ID> <APP_SECRET> <REDIRECT_URI> <CODE>`);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
