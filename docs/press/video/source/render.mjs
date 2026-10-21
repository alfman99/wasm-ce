// Renders docs/press/video/wasmcheat-launch{,-vertical}.{mp4,jpg} from the session that
// tests/e2e/promo.spec.ts records. Run that first (WASMCHEAT_SHOTS=1), then: node docs/press/video/source/render.mjs
// Needs ffmpeg, and python3 with numpy for the soundtrack.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const WORK = here('../../../../test-results/promo-video/');
const OUT = here('../');
const FPS = 30, DURATION = 21, POSTER = 16.3;
mkdirSync(WORK, { recursive: true });
// The whole transcript: the last line of every step.
const lines = JSON.parse(readFileSync(here('../../../../test-results/promo-session/session.json'))).slice(1).map((step) => step.lines.at(-1));
execFileSync('python3', [here('sound.py'), `${WORK}soundtrack.wav`], { stdio: 'inherit' });

const browser = await chromium.launch();
for (const [format, name] of [['landscape', 'wasmcheat-launch'], ['vertical', 'wasmcheat-launch-vertical']]) {
  const page = await browser.newPage({ viewport: format === 'vertical' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 } });
  await page.goto(new URL(`video.html?format=${format}`, import.meta.url).href);
  await page.evaluate(async (lines) => {
    window.setup(lines);
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.decode()));
  }, lines);
  await page.evaluate((t) => window.render(t), POSTER);
  await page.screenshot({ path: `${WORK}${name}.png` });
  execFileSync('magick', [`${WORK}${name}.png`, '-quality', '92', `${OUT}${name}.jpg`]);
  // Frame 0 is the poster, so every platform's thumbnail is a settled frame.
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    '-i', `${WORK}soundtrack.wav`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', `${OUT}${name}.mp4`], { stdio: ['pipe', 'inherit', 'inherit'] });
  for (let f = 0; f < FPS * DURATION; f += 1) {
    await page.evaluate((t) => window.render(t), f === 0 ? POSTER : f / FPS);
    const png = await page.screenshot();
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  await page.close();
}
await browser.close();
