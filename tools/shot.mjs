#!/usr/bin/env node
/**
 * shot.mjs — deterministic screenshot harness.
 *
 *   node tools/shot.mjs                       # all shots -> shots/
 *   node tools/shot.mjs vista ground          # only those shots
 *   node tools/shot.mjs --out shots/round3    # custom output dir
 *   node tools/shot.mjs --width 1920 --height 1080
 *
 * Boots a vite dev server on an ephemeral port, drives a headless Chromium with
 * real GPU-backed WebGL (SwiftShader fallback), poses the canonical camera
 * shots, settles N deterministic frames, and writes PNGs.
 *
 * Exits non-zero if the page threw — a broken build must never be silently
 * screenshotted as "art direction".
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { shots: [], dir: 'shots', width: 1920, height: 1080, frames: 6, keepOpen: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.dir = argv[++i];
    else if (a === '--width') out.width = +argv[++i];
    else if (a === '--height') out.height = +argv[++i];
    else if (a === '--frames') out.frames = +argv[++i];
    else if (a === '--keep-open') out.keepOpen = true;
    else if (!a.startsWith('--')) out.shots.push(a);
  }
  return out;
}

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

async function startVite(port) {
  const proc = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1', '--clearScreen', 'false'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok) return proc;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill('SIGKILL');
  throw new Error(`vite failed to start on ${port}:\n${log}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(ROOT, opts.dir);
  await mkdir(outDir, { recursive: true });

  const port = await freePort();
  const vite = await startVite(port);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=metal',
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--enable-webgl',
      '--disable-frame-rate-limit',
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
      '--mute-audio',
    ],
  });

  const page = await browser.newPage({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: 1,
  });

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 });

  try {
    await page.waitForFunction(() => window.__GAME && window.__GAME.ready === true, { timeout: 90000 });
  } catch (err) {
    console.error('GAME never became ready.');
    console.error(consoleErrors.join('\n'));
    await browser.close();
    try { process.kill(-vite.pid, 'SIGKILL'); } catch {}
    process.exit(2);
  }

  const renderer = await page.evaluate(() => {
    const gl = window.__GAME.engine.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  console.log(`renderer: ${renderer}`);

  const allShots = await page.evaluate(() => Object.keys(window.__GAME.shots));
  const shots = opts.shots.length ? opts.shots.filter((s) => allShots.includes(s)) : allShots;
  if (opts.shots.length && shots.length !== opts.shots.length) {
    const missing = opts.shots.filter((s) => !allShots.includes(s));
    console.error(`unknown shots: ${missing.join(', ')} (have: ${allShots.join(', ')})`);
  }

  const report = { renderer, shots: {}, errors: consoleErrors };

  for (const name of shots) {
    const meta = await page.evaluate(
      ({ name, frames }) => {
        const g = window.__GAME;
        const s = g.applyShot(name);
        const ms = g.settle(frames);
        return { note: s.note, tod: s.tod, ms: Math.round(ms * 100) / 100, stats: g.stats(), errors: g.errors.slice() };
      },
      { name, frames: opts.frames },
    );
    const file = path.join(outDir, `${name}.png`);
    const buf = await page.screenshot({ type: 'png' });
    await writeFile(file, buf);
    report.shots[name] = { file: path.relative(ROOT, file), ...meta };
    console.log(
      `  ${name.padEnd(10)} ${meta.tod.padEnd(10)} ${String(meta.ms).padStart(7)}ms ` +
        `calls=${String(meta.stats.calls).padStart(4)} tris=${String(meta.stats.triangles).padStart(8)} -> ${path.relative(ROOT, file)}`,
    );
  }

  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  if (!opts.keepOpen) {
    await browser.close();
    try { process.kill(-vite.pid, 'SIGKILL'); } catch {}
  }

  if (consoleErrors.length) {
    console.error(`\n${consoleErrors.length} page error(s):`);
    for (const e of consoleErrors.slice(0, 20)) console.error('  ' + e);
    process.exit(1);
  }
  console.log(`\nwrote ${shots.length} shot(s) to ${path.relative(ROOT, outDir)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
