#!/usr/bin/env node
/**
 * eval.mjs — boot the game headless and run an arbitrary probe script in the page.
 *
 *   node tools/eval.mjs probe.js [--width 1920 --height 1080] [--shot vista]
 *
 * The probe file's contents become the body of an async function with `g`
 * (= window.__GAME), `THREE`, and `screenshot(name)` in scope. Whatever it
 * returns is printed as JSON. Screenshots land next to the probe under
 * `--out` (default shots/diag).
 *
 * This exists so integration questions ("which module draws that quad?", "what
 * does the grade do to a known radiance?") are answered by measurement rather
 * than by reading shaders and guessing.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const probeFile = argv.find((a) => !a.startsWith('--'));
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const W = +opt('width', 1920), H = +opt('height', 1080);
const outDir = path.resolve(ROOT, opt('out', 'shots/diag'));
await mkdir(outDir, { recursive: true });

const port = await new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore', detached: true });
for (let i = 0; i < 300; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--force-device-scale-factor=1', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); else if (m.type() === 'log' && process.env.VERBOSE) console.log('[page]', m.text()); });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__GAME?.ready === true, { timeout: 180000 });

const src = await readFile(path.resolve(ROOT, probeFile), 'utf8');
const shots = [];
await page.exposeFunction('__shotRequest', (name) => { shots.push(name); });

const result = await page.evaluate(async (src) => {
  const g = window.__GAME;
  const THREE = g.THREE;
  const fn = new Function('g', 'THREE', `return (async () => {\n${src}\n})();`);
  return await fn(g, THREE);
}, src);

console.log(JSON.stringify(result, null, 2));

// Any `__snap` entries the probe left behind get written as PNGs.
const snaps = await page.evaluate(() => Object.keys(window.__snaps || {}));
for (const name of snaps) {
  const b64 = await page.evaluate((n) => window.__snaps[n], name);
  await writeFile(path.join(outDir, name + '.png'), Buffer.from(b64.split(',')[1], 'base64'));
  console.error('snap ->', path.join(path.relative(ROOT, outDir), name + '.png'));
}

if (errs.length) console.error('PAGE ERRORS:\n' + errs.slice(0, 10).join('\n'));
await browser.close();
try { process.kill(-vite.pid, 'SIGKILL'); } catch {}
process.exit(errs.length ? 1 : 0);
