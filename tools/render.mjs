#!/usr/bin/env node
/**
 * render.mjs — take screenshots. No daemon, no queue, no shared state.
 *
 *   node tools/render.mjs                          # every canonical shot
 *   node tools/render.mjs vista ground --out shots/mine
 *   node tools/render.mjs --width 1920 --height 1080
 *   node tools/render.mjs eval probe.js [args...]  # run a probe in the page
 *
 * WHY THIS REPLACED THE DAEMON.
 *
 * The daemon existed to keep worlds warm, because generating one cost 17 s and
 * paying that per screenshot was intolerable. That premise died twice over:
 *
 *   1. The terrain simulation — 11.6 s of the 17 s — is now baked through
 *      GenCache, so a cold world is ~4.6 s.
 *   2. Agents edit source constantly, so nearly every request invalidated the
 *      warm world anyway. The hit rate the design assumed never existed:
 *      measured 40% of requests paid a full rebuild.
 *
 * What the shared daemon did buy was a single point of failure and a queue.
 * Measured with seven agents against it: queue depth 20, p50 wait 302 s,
 * p50 total 360 s, and 29 errors against 9 completions — including a race I
 * introduced where two callers built the same world and one nulled the other's
 * server handle. Worlds also evicted each other continuously, because a cap
 * chosen for RAM (5) was below the number of concurrent authors (7).
 *
 * A private, short-lived chromium per invocation removes all of it: no lock, no
 * eviction, no cross-tree contamination, no daemon whose behaviour depends on
 * which checkout started it. Seven agents rarely render at the same instant, and
 * when they do the OS schedules them better than a hand-rolled queue did.
 *
 * The cost is the ~4.6 s world build per invocation, which is why this batches:
 * ask for every shot you want in ONE command and they all share one page.
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const o = { shots: [], dir: 'shots', width: 1920, height: 1080, frames: 8, mode: 'shot', probe: null, probeArgs: [] };
  if (argv[0] === 'eval') {
    o.mode = 'eval';
    o.probe = argv[1];
    o.probeArgs = argv.slice(2);
    return o;
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.dir = argv[++i];
    else if (a === '--width') o.width = +argv[++i];
    else if (a === '--height') o.height = +argv[++i];
    else if (a === '--frames') o.frames = +argv[++i];
    else if (!a.startsWith('--')) o.shots.push(a);
  }
  return o;
}

const freePort = () =>
  new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

/** Bundle once. Fails fast with the file and line, in ~3 s, not a 25 s page load. */
function bundle() {
  const t0 = Date.now();
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'warn'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000,
    });
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    console.error(`build failed:\n${out.slice(0, 3000)}`);
    process.exit(3);
  }
  return Date.now() - t0;
}

async function serve() {
  const port = await freePort();
  const proc = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return { proc, port };
    } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 80));
  }
  try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
  throw new Error(`preview server failed to start:\n${log}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const bundleMs = bundle();

  const server = await serve();
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--force-device-scale-factor=1', '--mute-audio', '--hide-scrollbars'],
  });

  const errors = [];
  const page = await browser.newPage({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1 });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', async (r) => {
    if (r.status() >= 400) errors.unshift(`${r.status()} ${r.url()}`);
  });

  // Hard cleanup. A headless chromium is a process TREE (zygote, gpu, renderers);
  // browser.close() alone left 18 of them behind across seven runs, which is how
  // the machine ended up at load 20. Close politely, then make sure.
  const cleanup = async (code) => {
    const pid = browser.process?.()?.pid;
    await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
    for (const p of [pid, server.proc.pid]) {
      if (!p) continue;
      try { process.kill(-p, 'SIGKILL'); } catch {}
      try { process.kill(p, 'SIGKILL'); } catch {}
    }
    process.exit(code);
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => cleanup(130));

  const tLoad = Date.now();
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'load', timeout: 120000 });
  try {
    await page.waitForFunction(() => window.__GAME?.ready === true, { timeout: 180000 });
  } catch {
    console.error('build is broken — the page never became ready:');
    for (const e of errors.slice(0, 10)) console.error('  ' + e);
    await cleanup(2);
  }
  const loadMs = Date.now() - tLoad;

  if (opts.mode === 'eval') {
    const src = await readFile(path.resolve(opts.probe), 'utf8');
    const result = await page.evaluate(
      new Function('ARGS', `return (async () => { ${src} })()`),
      opts.probeArgs,
    );
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    if (errors.length) {
      console.error('\npage errors:');
      for (const e of errors.slice(0, 10)) console.error('  ' + e);
    }
    await cleanup(0);
  }

  const outDir = path.resolve(ROOT, opts.dir);
  await mkdir(outDir, { recursive: true });
  const all = await page.evaluate(() => Object.keys(window.__GAME.shots));
  const wanted = opts.shots.length ? opts.shots.filter((s) => all.includes(s)) : all;
  const report = { renderer: '', shots: {}, errors: [] };
  report.renderer = await page.evaluate(() => {
    const gl = window.__GAME.engine.renderer.getContext();
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  console.log(`renderer: ${report.renderer}`);

  for (const name of wanted) {
    const t = Date.now();
    const meta = await page.evaluate(
      ({ name, frames }) => {
        const g = window.__GAME;
        const s = g.applyShot(name);
        g.settle(frames);
        return { note: s.note, tod: s.tod, stats: g.stats() };
      },
      { name, frames: opts.frames },
    );
    const file = path.join(outDir, `${name}.png`);
    await writeFile(file, await page.screenshot({ type: 'png' }));
    const ms = Date.now() - t;
    report.shots[name] = { file: path.relative(ROOT, file), ms, ...meta };
    console.log(
      `  ${name.padEnd(10)} ${meta.tod.padEnd(10)} ${String(ms).padStart(5)}ms ` +
        `calls=${String(meta.stats.calls).padStart(4)} tris=${String(meta.stats.triangles).padStart(8)} -> ${path.relative(ROOT, file)}`,
    );
  }

  report.errors = errors;
  report.timing = { bundleMs, loadMs, totalMs: Date.now() - t0 };
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${wanted.length} shot(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s  (bundle ${(bundleMs / 1000).toFixed(1)}s, world ${(loadMs / 1000).toFixed(1)}s)`);

  if (errors.length) {
    console.error(`\n${errors.length} page error(s):`);
    for (const e of errors.slice(0, 20)) console.error('  ' + e);
    await cleanup(1);
  }
  await cleanup(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
