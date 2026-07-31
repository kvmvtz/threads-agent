// Minimal Threads API client (Node 20+, uses global fetch).
// Docs referenced: developers.facebook.com/docs/threads

const BASE = 'https://graph.threads.net/v1.0';

async function callApi(url, params, method = 'GET') {
  const usp = new URLSearchParams(params);
  const isGet = method === 'GET';
  const fullUrl = isGet ? `${url}?${usp.toString()}` : url;
  const res = await fetch(fullUrl, {
    method,
    headers: isGet ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: isGet ? undefined : usp.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(`Threads API error (${res.status}) on ${url}: ${JSON.stringify(json)}`);
  }
  return json;
}

/** Create a video container. Returns the creation_id. */
async function createVideoContainer({ userId, accessToken, videoUrl, text }) {
  const json = await callApi(`${BASE}/${userId}/threads`, {
    media_type: 'VIDEO',
    video_url: videoUrl,
    text: text || '',
    access_token: accessToken,
  }, 'POST');
  if (!json.id) throw new Error('createVideoContainer: no id in response: ' + JSON.stringify(json));
  return json.id;
}

/** Poll a container's processing status until FINISHED or ERROR (or timeout). */
async function waitForContainerReady({ creationId, accessToken, timeoutMs = 5 * 60 * 1000, intervalMs = 15000 }) {
  const deadline = Date.now() + timeoutMs;
  // Meta explicitly recommends waiting at least ~30s before the first status check for video.
  await sleep(30000);
  while (Date.now() < deadline) {
    const json = await callApi(`${BASE}/${creationId}`, {
      fields: 'status,error_message',
      access_token: accessToken,
    });
    if (json.status === 'FINISHED') return;
    if (json.status === 'ERROR') throw new Error('Container processing failed: ' + JSON.stringify(json));
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for container to finish processing');
}

/** Publish a ready container. Returns the published post id. */
async function publishContainer({ userId, accessToken, creationId }) {
  const json = await callApi(`${BASE}/${userId}/threads_publish`, {
    creation_id: creationId,
    access_token: accessToken,
  }, 'POST');
  if (!json.id) throw new Error('publishContainer: no id in response: ' + JSON.stringify(json));
  return json.id;
}

/** Full publish flow for a video post. Returns the published post id. */
async function postVideo({ userId, accessToken, videoUrl, text }) {
  const creationId = await createVideoContainer({ userId, accessToken, videoUrl, text });
  await waitForContainerReady({ creationId, accessToken });
  return publishContainer({ userId, accessToken, creationId });
}

/** Refresh a long-lived token. Returns { accessToken, expiresIn }. */
async function refreshLongLivedToken(currentToken) {
  const json = await callApi('https://graph.threads.net/refresh_access_token', {
    grant_type: 'th_refresh_token',
    access_token: currentToken,
  });
  if (!json.access_token) throw new Error('refresh failed: ' + JSON.stringify(json));
  return { accessToken: json.access_token, expiresIn: json.expires_in };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { postVideo, createVideoContainer, waitForContainerReady, publishContainer, refreshLongLivedToken };
