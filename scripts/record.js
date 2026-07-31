// Records a smooth scroll-through video of a website and converts it to a
// Threads-compatible MP4 (H264, faststart).
//
// Usage: node scripts/record.js <url> <outMp4Path> [durationSec]
//
// Requires: playwright (with chromium installed) + ffmpeg on PATH.
// Runs fine on GitHub Actions ubuntu-latest after `npx playwright install --with-deps chromium`.

const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const url = process.argv[2];
const outMp4 = process.argv[3];
const durationSec = Number(process.argv[4] || 22);

if (!url || !outMp4) {
  console.error('Usage: node scripts/record.js <url> <outMp4Path> [durationSec]');
  process.exit(1);
}

// Portrait-ish frame that reads well as a Threads video.
const WIDTH = 1080, HEIGHT = 1350;

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollrec-'));

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--hide-scrollbars'],
  });
  const ctx = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    recordVideo: { dir: tmpDir, size: { width: WIDTH, height: HEIGHT } },
  });
  const page = await ctx.newPage();

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  } catch (e) {
    console.error('goto warning:', e.message);
  }

  // let hero animations / webfonts / lazy images settle
  await page.waitForTimeout(4000);

  // best-effort cookie banner dismissal
  for (const sel of ['button:has-text("Accept")', 'button:has-text("Accept all")', 'button:has-text("I agree")', 'button:has-text("OK")', 'button:has-text("Got it")']) {
    try { await page.locator(sel).first().click({ timeout: 700 }); break; } catch {}
  }

  const total = await page.evaluate(() => Math.min(document.body.scrollHeight, 16000));
  const scrollable = Math.max(total - HEIGHT, 0);
  const tickMs = 40;
  const steps = Math.floor((durationSec * 1000) / tickMs);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease-in-out
    const y = Math.round(scrollable * eased);
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(tickMs);
  }
  await page.waitForTimeout(1200);

  await ctx.close(); // flushes the recorded video to disk
  const webmPath = await page.video().path();
  await browser.close();

  fs.mkdirSync(path.dirname(outMp4), { recursive: true });

  // Convert to Threads-friendly MP4: H264, yuv420p, faststart for progressive fetch.
  execFileSync('ffmpeg', [
    '-y', '-i', webmPath,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-profile:v', 'high', '-level', '4.0',
    '-movflags', '+faststart',
    '-vf', 'scale=1080:-2',
    '-r', '30',
    '-an', // no audio track recorded anyway
    outMp4,
  ], { stdio: 'inherit' });

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('WROTE:' + outMp4);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
