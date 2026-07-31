// Refreshes the long-lived Threads access token and writes the new value
// back into the repo's Actions secret, so the daily workflow always has a
// fresh token without any manual step.
//
// Requires:
//   THREADS_ACCESS_TOKEN  - current long-lived token (secret)
//   ADMIN_PAT             - a GitHub fine-grained PAT scoped to this repo only,
//                            with "Secrets: Read and write" permission.
//   GITHUB_REPOSITORY     - provided automatically by Actions ("owner/repo")

const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');
const { refreshLongLivedToken } = require('./threads-api');

const REPO = process.env.GITHUB_REPOSITORY;
const ADMIN_PAT = requireEnv('ADMIN_PAT');
const CURRENT_TOKEN = requireEnv('THREADS_ACCESS_TOKEN');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function ghApi(pathname, opts = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${ADMIN_PAT}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${pathname} failed: ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

// Encrypts a secret value for the GitHub Actions "create or update repo secret" API.
// See: https://docs.github.com/en/rest/actions/secrets
function encryptSecret(publicKeyBase64, value) {
  const messageBytes = naclUtil.decodeUTF8(value);
  const keyBytes = naclUtil.decodeBase64(publicKeyBase64);
  const encryptedBytes = nacl.sealedbox
    ? nacl.sealedbox.seal(messageBytes, keyBytes) // if a sealedbox polyfill is present
    : sealedboxSeal(messageBytes, keyBytes);
  return naclUtil.encodeBase64(encryptedBytes);
}

// tweetnacl doesn't ship libsodium's crypto_box_seal, so implement it directly
// (ephemeral keypair + nacl.box, per libsodium's sealed box construction).
function sealedboxSeal(message, recipientPublicKey) {
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.hash(Buffer.concat([Buffer.from(ephemeral.publicKey), Buffer.from(recipientPublicKey)])).slice(0, 24);
  const boxed = nacl.box(message, nonce, recipientPublicKey, ephemeral.secretKey);
  return Buffer.concat([Buffer.from(ephemeral.publicKey), Buffer.from(boxed)]);
}

async function main() {
  const { accessToken, expiresIn } = await refreshLongLivedToken(CURRENT_TOKEN);
  console.log(`Got new token, valid for ${Math.round(expiresIn / 86400)} days.`);

  const { key, key_id } = await ghApi(`/repos/${REPO}/actions/secrets/public-key`);
  const encryptedValue = encryptSecret(key, accessToken);

  await ghApi(`/repos/${REPO}/actions/secrets/THREADS_ACCESS_TOKEN`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted_value: encryptedValue, key_id }),
  });

  console.log('THREADS_ACCESS_TOKEN secret updated.');
}

main().catch((e) => {
  console.error('refresh-token failed:', e);
  process.exitCode = 1;
});
