#!/usr/bin/env node
/**
 * Driver for the character studio (dev tool, characters module only).
 *
 *   node src/characters/_studio.mjs [--out shots/studio] [view ...]
 *
 * Runs the vite DEV server rather than a production build on purpose: the dev
 * server compiles modules on demand, so a half-saved file in someone else's
 * directory cannot block a character iteration the way a full bundle does.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const args = process.argv.slice(2);
const consumed = new Set();
const opt = (n, d) => {
  const i = args.indexOf(n);
  if (i < 0) return d;
  consumed.add(i).add(i + 1);
  return args[i + 1];
};
const OUT = path.resolve(ROOT, opt('--out', 'shots/studio'));
const W = +opt('--width', 1280);
const H = +opt('--height', 720);
const ONLY = args.filter((a, i) => !consumed.has(i) && !a.startsWith('--'));

const VIEWS = [
  // The money shot: over-the-shoulder, three-quarter key. `sunOff` is the
  // camera's azimuth relative to the sun — 0 is fully front-lit, PI is fully
  // backlit — so the set below walks the whole lighting range the game has to
  // survive, not just the flattering end of it.
  { name: 'ots', who: 'player', dist: 2.9, h: 1.66, look: 1.25, fov: 48, sunOff: 1.15, faceOff: 0.0 },
  // Every visible surface in shadow — the "flat black cutout" test. This frame
  // has to hold form with no key light on it at all.
  { name: 'shade', who: 'player', dist: 2.9, h: 1.66, look: 1.25, fov: 48, sunOff: 0.3, shadeSide: true },
  // Full backlight: the silhouette-separation test.
  { name: 'backlit', who: 'player', dist: 3.0, h: 1.6, look: 1.2, fov: 46, sunOff: 2.85, faceOff: 0.0 },
  { name: 'ots-aim', who: 'player', dist: 2.5, h: 1.62, look: 1.4, fov: 46, aim: 1, sunOff: 1.3, warm: 1.5 },
  { name: 'lit', who: 'player', dist: 3.4, h: 1.15, look: 1.0, fov: 42, sunOff: 0.75, faceOff: 0.4 },
  { name: 'back', who: 'player', dist: 3.2, h: 1.35, look: 1.05, fov: 44, sunOff: 1.5, faceOff: 0.0, speed: 1.4, warm: 2.6 },
  { name: 'face', who: 'player', dist: 0.72, h: 1.68, look: 1.665, fov: 30, sunOff: 0.6, faceOff: 0.35 },
  { name: 'face-key', who: 'player', dist: 0.75, h: 1.70, look: 1.665, fov: 30, sunOff: 0.0, faceOff: 0.0 },
  { name: 'face-side', who: 'player', dist: 0.75, h: 1.70, look: 1.665, fov: 30, sunOff: 1.5, faceOff: 0.0 },
  { name: 'face-noshadow', who: 'player', dist: 0.75, h: 1.70, look: 1.665, fov: 30, sunOff: 0.0, faceOff: 0.0, noShadow: true },
  { name: 'boots', who: 'player', dist: 1.05, h: 0.42, look: 0.16, fov: 40, sunOff: 0.8, faceOff: 0.3 },
  { name: 'hands', who: 'player', dist: 0.85, h: 1.3, look: 1.2, fov: 34, sunOff: 1.9, faceOff: 0.3 },
  { name: 'kit', who: 'player', dist: 1.35, h: 1.35, look: 1.2, fov: 40, sunOff: 2.9, faceOff: 0.0 },
  { name: 'soldier', who: 'soldier', dist: 3.4, h: 1.15, look: 1.0, fov: 42, sunOff: 0.8, faceOff: 0.5 },
  { name: 'soldier-face', who: 'soldier', dist: 0.8, h: 1.66, look: 1.64, fov: 32, sunOff: 0.7, faceOff: 0.3 },
  { name: 'night', who: 'player', dist: 3.0, h: 1.5, look: 1.15, fov: 46, sunOff: 1.2, faceOff: 0.3, tod: 'night' },
];

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const port = await freePort();
  const vite = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let log = '';
  vite.stdout.on('data', (d) => (log += d));
  vite.stderr.on('data', (d) => (log += d));
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/src/characters/_studio.html`);
      if (r.ok) break;
    } catch {
      /* not up */
    }
    if (Date.now() > deadline) throw new Error('vite dev failed: ' + log);
    await new Promise((r) => setTimeout(r, 250));
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--force-device-scale-factor=1', '--hide-scrollbars'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  // Stub out vite's HMR client. Other authors are saving files in this repo
  // while a capture runs, and a full-reload halfway through destroys the
  // execution context and fails the run for reasons that have nothing to do
  // with the characters.
  await page.route('**/@vite/client', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `export const createHotContext = () => ({ on(){}, off(){}, accept(){}, acceptExports(){}, prune(){}, dispose(){}, decline(){}, invalidate(){}, send(){}, data:{} });
             export const updateStyle = () => {};
             export const removeStyle = () => {};
             export const injectQuery = (u) => u;
             export default {};`,
    }),
  );
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${port}/src/characters/_studio.html`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__STUDIO && window.__STUDIO.ready === true, { timeout: 120000 });

  for (const v of VIEWS) {
    if (ONLY.length && !ONLY.includes(v.name)) continue;
    const meta = await page.evaluate((view) => window.__STUDIO.pose(view), v);
    const buf = await page.screenshot({ type: 'png' });
    await writeFile(path.join(OUT, `${v.name}.png`), buf);
    const f = meta.frame.join('/');
    const s = meta.subject.join('/');
    const warm = meta.subject[0] - meta.subject[2] >= 0 ? 'warm' : 'COLD';
    console.log(
      `  ${v.name.padEnd(13)} ${String(meta.ms).padStart(6)}ms  frame ${f.padEnd(12)} char ${s.padEnd(12)} ` +
        `cov ${String(meta.coverage).padStart(4)}%  ${warm}`,
    );
  }

  await browser.close();
  try {
    process.kill(-vite.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  if (errors.length) {
    console.error(`\n${errors.length} page error(s):`);
    for (const e of errors.slice(0, 12)) console.error('  ' + e);
    process.exit(1);
  }
  console.log(`\nwrote studio frames to ${path.relative(ROOT, OUT)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
