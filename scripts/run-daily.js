// Orchestrates one day's post:
//   1. Pop the next site from sites_queue.txt
//   2. Record a scroll-through video of it
//   3. Commit + push the video so it's reachable at a public raw.githubusercontent.com URL
//   4. Publish it to Threads (create container -> wait -> publish)
//   5. On success: remove the used line from the queue, bump the day counter, log to history.md, commit + push
//
// On any failure BEFORE a successful publish, nothing is marked as used, so the
// same queue item is retried on the next scheduled run. The workflow step is
// configured to fail loudly (GitHub emails the repo owner automatically on a
// failed scheduled run) rather than fail silently.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildCaption } = require('./caption');
const { postVideo } = require('./threads-api');

const ROOT = path.join(__dirname, '..');
const QUEUE_PATH = path.join(ROOT, 'sites_queue.txt');
const STATE_PATH = path.join(ROOT, 'state.json');
const HISTORY_PATH = path.join(ROOT, 'history.md');
const VIDEOS_DIR = path.join(ROOT, 'videos');

const REPO = process.env.GITHUB_REPOSITORY; // e.g. "nikita/threads-daily-design-agent"
const REF = process.env.GITHUB_REF_NAME || 'main';
const THREADS_USER_ID = requireEnv('THREADS_USER_ID');
const THREADS_ACCESS_TOKEN = requireEnv('THREADS_ACCESS_TOKEN');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function readState() {
  if (!fs.existsSync(STATE_PATH)) return { day: 1 };
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

// Queue line format: URL | Site Name | optional one-line hook
// Blank lines and lines starting with # are ignored.
function readQueueLines() {
  if (!fs.existsSync(QUEUE_PATH)) return [];
  return fs.readFileSync(QUEUE_PATH, 'utf8').split('\n');
}

function parseQueueEntry(line) {
  const parts = line.split('|').map((s) => s.trim());
  const url = parts[0];
  let name = parts[1];
  const hook = parts[2] || '';
  if (!name) {
    try { name = new URL(url).hostname.replace(/^www\./, ''); } catch { name = url; }
  }
  return { url, name, hook };
}

function nextQueueEntry(lines) {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    return { index: i, entry: parseQueueEntry(trimmed) };
  }
  return null;
}

function removeLine(lines, index) {
  const copy = lines.slice();
  copy.splice(index, 1);
  return copy;
}

function git(...args) {
  execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });
}

function commitAndPush(message) {
  git('config', 'user.name', 'threads-daily-agent');
  git('config', 'user.email', 'actions@users.noreply.github.com');
  git('add', '-A');
  // Nothing to commit is not an error we want to crash on.
  try {
    git('commit', '-m', message);
  } catch (e) {
    console.log('Nothing to commit (' + message + ')');
    return;
  }
  git('push', 'origin', `HEAD:${REF}`);
}

// Keep the repo lean: drop videos older than 2 days old (already posted, no
// longer need to stay reachable for Threads to re-fetch them).
function pruneOldVideos(currentDay) {
  if (!fs.existsSync(VIDEOS_DIR)) return;
  for (const file of fs.readdirSync(VIDEOS_DIR)) {
    const m = file.match(/^day-(\d+)\.mp4$/);
    if (!m) continue;
    const day = Number(m[1]);
    if (day <= currentDay - 2) {
      fs.rmSync(path.join(VIDEOS_DIR, file));
    }
  }
}

async function main() {
  const state = readState();
  const day = state.day || 1;

  const lines = readQueueLines();
  const next = nextQueueEntry(lines);

  if (!next) {
    console.error(`Queue is empty — nothing to post for Day ${day}. Add more lines to sites_queue.txt.`);
    process.exitCode = 1; // fail the run -> GitHub emails the owner
    return;
  }

  const { url, name, hook } = next.entry;
  console.log(`Day ${day}: recording ${url} (${name})`);

  const videoRelPath = `videos/day-${day}.mp4`;
  const videoAbsPath = path.join(ROOT, videoRelPath);
  execFileSync('node', [path.join(__dirname, 'record.js'), url, videoAbsPath, '22'], { stdio: 'inherit' });

  pruneOldVideos(day);
  commitAndPush(`Day ${day}: add scroll video for ${name}`);

  const videoUrl = `https://raw.githubusercontent.com/${REPO}/${REF}/${videoRelPath}`;
  console.log('Public video URL:', videoUrl);

  const caption = buildCaption({ day, siteName: name, hook });
  console.log('Caption:\n' + caption);

  const postId = await postVideo({
    userId: THREADS_USER_ID,
    accessToken: THREADS_ACCESS_TOKEN,
    videoUrl,
    text: caption,
  });
  console.log('Published Threads post id:', postId);

  // Only now mark the queue entry as used and bump the day counter.
  const remaining = removeLine(lines, next.index);
  fs.writeFileSync(QUEUE_PATH, remaining.join('\n'));
  writeState({ day: day + 1 });
  fs.appendFileSync(HISTORY_PATH, `- Day ${day} — ${name} (${url}) — post id \`${postId}\` — ${new Date().toISOString()}\n`);

  commitAndPush(`Day ${day}: published (post ${postId})`);
  console.log(`Day ${day} done.`);
}

main().catch((e) => {
  console.error('run-daily failed:', e);
  process.exitCode = 1;
});
