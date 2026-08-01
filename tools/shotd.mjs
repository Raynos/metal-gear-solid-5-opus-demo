#!/usr/bin/env node
/**
 * shotd.mjs — THE render daemon. Exactly one per machine, for every tree.
 *
 * WHY THIS EXISTS
 *
 * The original harness booted a vite server, a chromium and a complete
 * procedural world for every single screenshot. Measured on an M3 Pro:
 *
 *     2.1s  vite boot
 *     1.2s  chromium launch
 *    17.1s  page init   <- a CPU profile blames 11.8s (69%) on the Terrain.js
 *                          erosion sim, recomputed identically every time
 *     0.6s  the actual screenshot
 *
 * Across three build rounds that was 551 process launches and ~193 minutes.
 * Eight agents running it concurrently turned an 18s run into 55s of pure
 * core contention.
 *
 * The first fix was a daemon per working tree. That was still wrong: authors
 * run a worktree each, so daemons tracked worktrees — six of them, 47 chromium
 * processes, 7.8 GB, load average 122, machine unusable.
 *
 * So: ONE daemon, ONE vite server, ONE chromium, ONE warm world, machine-wide.
 * Every tree talks to it. Requests queue. Because different trees hold different
 * source, the daemon owns which tree is currently loaded and switches on demand
 * — and it batches queued work by tree so a switch is amortised over every
 * request waiting for that tree rather than paid per request.
 *
 * Nothing starts this by hand: tools/shot.mjs spawns it on demand and it shuts
 * itself down when idle.
 *
 *   node tools/shotd.mjs [--idle 600]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { openSync, writeSync, closeSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Machine-wide state. Deliberately NOT inside any tree: the whole point is that
// one daemon serves every tree, so its lock cannot live in one of them.
const RUN = path.join(os.homedir(), '.cache', 'shotd');
const LOCK = path.join(RUN, 'lock');
const PORTFILE = path.join(RUN, 'port');
const VITEPID = path.join(RUN, 'vite.pid');
const BROWSERPID = path.join(RUN, 'browser.pid');

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i < 0 ? d : argv[i + 1];
};
const IDLE_MS = Math.max(60, +opt('idle', 600)) * 1000;
// How long a request may wait behind another tree's batch before it jumps the
// queue. Without this, a busy tree starves every other tree indefinitely.
const STARVATION_MS = 45000;

const log = (...a) => process.stdout.write(`[${new Date().toISOString()}] ${a.join(' ')}\n`);

// --- single instance ------------------------------------------------------
// An exclusive create is the whole interlock: nine clients racing to start the
// daemon means eight lose here and go connect to the winner instead, before
// opening so much as a vite server.
function claimLock() {
  try {
    const fd = openSync(LOCK, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    try {
      process.kill(+readFileSync(LOCK, 'utf8').trim(), 0); // throws if gone
      return false; // a live daemon owns it
    } catch {
      try { unlinkSync(LOCK); } catch {}
      return claimLock();
    }
  }
}

function releaseLock() {
  for (const f of [LOCK, PORTFILE, VITEPID, BROWSERPID]) {
    try { unlinkSync(f); } catch {}
  }
}

// --- source staleness -----------------------------------------------------
// A loaded world only has to be thrown away when the code that generated it
// changed, so a rebuild is paid once per edit for the whole machine.
const WATCH_FILES = ['index.html', 'vite.config.js'];
const mtimeCache = new Map(); // root -> { at, value }

async function newestSourceMtime(root) {
  const hit = mtimeCache.get(root);
  if (hit && Date.now() - hit.at < 250) return hit.value; // bursts shouldn't re-walk
  let newest = 0;
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const s = await stat(p).catch(() => null);
        if (s && s.mtimeMs > newest) newest = s.mtimeMs;
      }
    }
  };
  await walk(path.join(root, 'src'));
  for (const f of WATCH_FILES) {
    const s = await stat(path.join(root, f)).catch(() => null);
    if (s && s.mtimeMs > newest) newest = s.mtimeMs;
  }
  mtimeCache.set(root, { at: Date.now(), value: newest });
  return newest;
}

// --- the one browser, the one vite ---------------------------------------
const BROWSER_ARGS = [
  '--use-gl=angle',
  '--use-angle=metal',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--enable-webgl',
  '--disable-frame-rate-limit',
  '--force-device-scale-factor=1',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

let browser = null;
let page = null;
let pageErrors = [];
let vite = null; // { proc, port, root }
let loaded = { root: null, mtime: 0 }; // which tree's world is in the page
let viewport = { width: 1280, height: 720 };
let lastActivity = Date.now();
let stopping = false;

function freePort() {
  return new Promise((res, rej) => {
    const srv = createNetServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

function killVite() {
  if (!vite) return;
  try { process.kill(-vite.proc.pid, 'SIGKILL'); } catch {}
  try { unlinkSync(VITEPID); } catch {}
  vite = null;
}

/**
 * Kill a child orphaned by a previously hard-killed daemon. SIGKILL on the
 * daemon leaves its chromium and vite running; without this they accumulate
 * across a session, each holding a port and hundreds of MB.
 */
function reapStale(file, what, group = true) {
  let pid;
  try { pid = +readFileSync(file, 'utf8').trim(); } catch { return; }
  if (pid > 0) {
    try {
      process.kill(group ? -pid : pid, 'SIGKILL');
      log(`reaped orphaned ${what} from a previous daemon (pid ${pid})`);
    } catch { /* already gone */ }
  }
  try { unlinkSync(file); } catch {}
}

const reapStaleVite = () => reapStale(VITEPID, 'vite');

async function startVite(root) {
  reapStaleVite();
  const port = await freePort();
  const proc = spawn(
    process.execPath,
    [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1', '--clearScreen', 'false'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  writeFileSync(VITEPID, String(proc.pid));
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return { proc, port, root };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
  throw new Error(`vite failed to start for ${root}:\n${out}`);
}

function isPageGone(err) {
  const m = String(err?.message ?? err);
  return /Not attached to an active page|Target closed|Target crashed|has been closed|Page closed|crashed/.test(m);
}

async function attachPage() {
  page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  loaded = { root: null, mtime: 0 };
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  // A module that fails to transform comes back as a 500 whose body names the
  // file and line. Without this the only symptom is a bare 500.
  page.on('response', async (res) => {
    if (res.status() < 400) return;
    const body = await res.text().catch(() => '');
    const detail = body.trim().split('\n').slice(0, 6).join('\n  ');
    pageErrors.unshift(`${res.status()} ${res.url()}${detail ? `\n  ${detail}` : ''}`);
  });
  page.on('crash', () => {
    loaded = { root: null, mtime: 0 };
    log('page crashed; will be rebuilt on next request');
  });
}

/**
 * Wait for the world to finish generating.
 *
 * Two traps. Playwright's second positional argument is the page-function
 * ARGUMENT, not the options bag — passing `{ timeout }` there silently leaves
 * the 30s default in place, which is shorter than a cold world build under load
 * and is why the old harness spuriously timed out and everyone wrapped it in
 * retry loops. And on a cold `node_modules/.vite`, vite's dependency optimizer
 * force-reloads the page mid-boot and destroys the execution context.
 */
async function waitReady(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let state;
    try {
      state = await page.evaluate(() => ({
        ready: !!(window.__GAME && window.__GAME.ready === true),
        present: !!window.__GAME,
        doc: document.readyState,
      }));
    } catch (err) {
      if (isPageGone(err)) throw err;
      const m = String(err?.message ?? err);
      if (!m.includes('Execution context was destroyed') && !m.includes('navigating')) throw err;
      await page.waitForLoadState('load').catch(() => {});
      state = null;
    }
    if (state?.ready) return;

    // A finished document that never created the harness, plus a thrown error,
    // means the module graph did not evaluate — a syntax error, not a slow
    // build. Say so now: during a real build the main thread is blocked and
    // this poll cannot even run, so reaching here means nothing is building.
    if (state && !state.present && state.doc === 'complete' && pageErrors.length) {
      throw new Error(`build is broken — the page threw before the harness loaded:\n  ${pageErrors[0]}`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `world never became ready within ${Math.round(timeoutMs / 1000)}s` +
          (pageErrors.length ? `; first page error:\n  ${pageErrors[0]}` : ''),
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Make the single page hold `root`'s current world, switching trees and/or
 * rebuilding only when it actually has to. This is the chokepoint everything
 * else funnels through.
 */
async function ensureWorld(root, { force = false } = {}) {
  const newest = await newestSourceMtime(root);
  if (!force && loaded.root === root && loaded.mtime >= newest && page && !page.isClosed()) return;

  const t0 = Date.now();
  const reason = force ? 'forced reload' : loaded.root !== root ? `switch to ${path.basename(root)}` : 'sources changed';

  if (!vite || vite.root !== root) {
    killVite();
    vite = await startVite(root);
  }
  if (!page || page.isClosed()) await attachPage();
  pageErrors = [];

  try {
    await page.goto(`http://127.0.0.1:${vite.port}/`, { waitUntil: 'load', timeout: 120000 });
    await waitReady();
  } catch (err) {
    if (!isPageGone(err)) {
      loaded = { root: null, mtime: 0 };
      throw err;
    }
    // Renderer died holding a 3.6M-triangle scene; start a fresh one once.
    try { await page.close(); } catch {}
    await attachPage();
    pageErrors = [];
    await page.goto(`http://127.0.0.1:${vite.port}/`, { waitUntil: 'load', timeout: 120000 });
    await waitReady();
  }
  loaded = { root, mtime: newest };
  log(`world ready for ${root} (${reason}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// --- the queue ------------------------------------------------------------
// One page means one job at a time. The ordering rule is what makes a shared
// daemon cheap: prefer work for the tree already loaded, so a switch is paid
// once for a whole batch instead of once per request. A waiter that has been
// passed over for too long jumps the queue, so a busy tree cannot starve the
// others.
const queue = [];
let running = false;

function enqueue(root, job) {
  return new Promise((resolve, reject) => {
    queue.push({ root, job, resolve, reject, at: Date.now() });
    pump();
  });
}

function nextIndex() {
  const now = Date.now();
  const starving = queue.findIndex((q) => now - q.at > STARVATION_MS);
  if (starving >= 0) return starving;
  const sameTree = queue.findIndex((q) => q.root === loaded.root);
  return sameTree >= 0 ? sameTree : 0;
}

async function pump() {
  if (running || !queue.length || stopping) return;
  running = true;
  lastActivity = Date.now();
  const item = queue.splice(nextIndex(), 1)[0];
  try {
    await ensureWorld(item.root);
    item.resolve(await item.job());
  } catch (err) {
    item.reject(err);
  } finally {
    running = false;
    lastActivity = Date.now();
    pump();
  }
}

async function setViewport(width, height) {
  if (viewport.width === width && viewport.height === height) return;
  viewport = { width, height };
  await page.setViewportSize(viewport);
}

// --- request handlers -----------------------------------------------------
let renderer = null;

async function readRenderer() {
  if (renderer) return renderer;
  renderer = await page
    .evaluate(() => {
      const gl = window.__GAME.engine.renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    })
    .catch(() => 'unknown');
  return renderer;
}

function handleShot({ root, shots, out = 'shots', width = 1280, height = 720, frames = 6 }) {
  return enqueue(root, async () => {
    await setViewport(width, height);
    pageErrors = [];

    const outDir = path.resolve(root, out);
    await mkdir(outDir, { recursive: true });

    const all = await page.evaluate(() => Object.keys(window.__GAME.shots));
    const wanted = shots && shots.length ? shots.filter((s) => all.includes(s)) : all;
    const report = { renderer: await readRenderer(), shots: {}, errors: [] };

    for (const name of wanted) {
      const meta = await page.evaluate(
        ({ name, frames }) => {
          const g = window.__GAME;
          const s = g.applyShot(name);
          const ms = g.settle(frames);
          return { note: s.note, tod: s.tod, ms: Math.round(ms * 100) / 100, stats: g.stats(), errors: g.errors.slice() };
        },
        { name, frames },
      );
      const file = path.join(outDir, `${name}.png`);
      await writeFile(file, await page.screenshot({ type: 'png' }));
      report.shots[name] = { file: path.relative(root, file), ...meta };
    }
    report.errors = pageErrors.slice();
    report.missing = (shots || []).filter((s) => !all.includes(s));
    report.dir = path.relative(root, outDir);
    await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    return report;
  });
}

function handleEval({ root, code, shot, width = 1920, height = 1080, out = 'shots/diag' }) {
  return enqueue(root, async () => {
    await setViewport(width, height);
    pageErrors = [];
    if (shot) await page.evaluate((n) => window.__GAME.applyShot(n), shot);

    const result = await page.evaluate(async (src) => {
      window.__snaps = {};
      const g = window.__GAME;
      const fn = new Function('g', 'THREE', `return (async () => {\n${src}\n})();`);
      return await fn(g, g.THREE);
    }, code);

    const outDir = path.resolve(root, out);
    const snaps = await page.evaluate(() => Object.keys(window.__snaps || {}));
    if (snaps.length) await mkdir(outDir, { recursive: true });
    const written = [];
    for (const name of snaps) {
      const b64 = await page.evaluate((n) => window.__snaps[n], name);
      const file = path.join(outDir, name + '.png');
      await writeFile(file, Buffer.from(b64.split(',')[1], 'base64'));
      written.push(path.relative(root, file));
    }
    return { result, snaps: written, errors: pageErrors.slice() };
  });
}

/** Explicit "throw the world away and rebuild it" control. */
function handleReload({ root }) {
  return enqueue(root, async () => {
    await ensureWorld(root, { force: true });
    return { ok: true, root, reloaded: true };
  });
}

// PNG inspection needs no GPU and must never block the render queue, so it runs
// on its own plain 2D page in the same browser.
let pixPage = null;
async function getPixPage() {
  if (pixPage && !pixPage.isClosed()) return pixPage;
  pixPage = await browser.newPage();
  await pixPage.setContent('<canvas id=c></canvas>');
  return pixPage;
}

async function loadPng(p, root, file) {
  const b64 = (await readFile(path.resolve(root, file))).toString('base64');
  return p.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.getElementById('c');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
    return { w: img.width, h: img.height };
  }, b64);
}

async function handlePix({ root, op, files = [], args = [] }) {
  const p = await getPixPage();
  if (op === 'stats') {
    const rows = [];
    for (const f of files) {
      await loadPng(p, root, f);
      const s = await p.evaluate(() => {
        const c = document.getElementById('c');
        const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
        let r = 0, g = 0, b = 0, n = 0, clip = 0;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
          if (d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250) clip++;
        }
        return { r: r / n, g: g / n, b: b / n, clip: clip / n };
      });
      rows.push({
        shot: path.basename(f, '.png'),
        R: +s.r.toFixed(1), G: +s.g.toFixed(1), B: +s.b.toFixed(1),
        'R-B': +(s.r - s.b).toFixed(1),
        clipPct: +(s.clip * 100).toFixed(2),
      });
    }
    return { rows };
  }
  if (op === 'probe') {
    await loadPng(p, root, files[0]);
    const pts = args.map((a) => a.split(',').map(Number));
    return {
      points: await p.evaluate((pts) => {
        const g = document.getElementById('c').getContext('2d', { willReadFrequently: true });
        return pts.map(([x, y]) => {
          const d = g.getImageData(x, y, 1, 1).data;
          return { x, y, r: d[0], g: d[1], b: d[2] };
        });
      }, pts),
    };
  }
  if (op === 'crop') {
    const [x, y, w, h, scale, outFile] = args;
    await loadPng(p, root, files[0]);
    const b64 = await p.evaluate(({ x, y, w, h, s }) => {
      const src = document.getElementById('c');
      const o = document.createElement('canvas');
      o.width = w * s; o.height = h * s;
      const g = o.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(src, x, y, w, h, 0, 0, w * s, h * s);
      return o.toDataURL('image/png').split(',')[1];
    }, { x: +x, y: +y, w: +w, h: +h, s: +scale });
    const dest = path.resolve(root, outFile);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(b64, 'base64'));
    return { wrote: path.relative(root, dest) };
  }
  if (op === 'column') {
    await loadPng(p, root, files[0]);
    const [x, fracs] = args;
    return {
      rows: await p.evaluate(({ x, fracs }) => {
        const c = document.getElementById('c');
        const g = c.getContext('2d', { willReadFrequently: true });
        return fracs.map((f) => {
          const y = Math.min(c.height - 1, Math.round(f * c.height));
          const d = g.getImageData(x, y, 1, 1).data;
          return { frac: f, y, r: d[0], g: d[1], b: d[2] };
        });
      }, { x: +x, fracs: String(fracs).split(',').map(Number) }),
    };
  }
  throw new Error(`unknown pix op: ${op}`);
}

// --- server ---------------------------------------------------------------
function readBody(req) {
  return new Promise((res, rej) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); }
    });
    req.on('error', rej);
  });
}

async function main() {
  mkdirSync(RUN, { recursive: true });
  if (!claimLock()) {
    log('another daemon holds the lock; exiting');
    process.exit(0);
  }
  process.on('exit', releaseLock);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(`signal ${sig}`));

  log(`booting (idle=${IDLE_MS / 1000}s) — one vite, one chromium, one world`);
  reapStale(BROWSERPID, 'chromium', false);
  browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
  const bpid = browser.process()?.pid;
  if (bpid) writeFileSync(BROWSERPID, String(bpid));
  await attachPage();

  const server = createServer(async (req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/status') {
        return send(200, {
          ok: true, pid: process.pid, renderer,
          loadedRoot: loaded.root, queued: queue.length, busy: running,
          trees: [...new Set(queue.map((q) => q.root))].length,
          uptimeSec: Math.round(process.uptime()),
        });
      }
      if (url.pathname === '/stop') {
        send(200, { ok: true, stopping: true });
        return setTimeout(() => shutdown('client asked'), 50);
      }
      const body = await readBody(req);
      if (!body.root) return send(400, { error: 'request is missing its root' });
      if (url.pathname === '/shot') return send(200, await handleShot(body));
      if (url.pathname === '/eval') return send(200, await handleEval(body));
      if (url.pathname === '/reload') return send(200, await handleReload(body));
      if (url.pathname === '/pix') return send(200, await handlePix(body));
      return send(404, { error: 'no such endpoint' });
    } catch (err) {
      log(`ERROR ${err?.stack || err}`);
      return send(500, { error: String(err?.message ?? err) });
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 65000;

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(PORTFILE, String(server.address().port));
  log(`listening on ${server.address().port}`);

  setInterval(() => {
    if (!running && !queue.length && Date.now() - lastActivity > IDLE_MS) shutdown('idle');
  }, 30000).unref();
}

async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log(`shutting down (${reason})`);
  // Release the lock LAST. Releasing it first opens a window where a successor
  // daemon starts while this one is still holding a browser and a vite server —
  // which is exactly how two daemons ended up alive at once. And never linger:
  // if browser.close() hangs we still die, and the 'exit' handler clears the
  // lock on the way out.
  const bail = setTimeout(() => process.exit(0), 5000);
  try { await browser?.close(); } catch {}
  killVite();
  clearTimeout(bail);
  releaseLock();
  process.exit(0);
}

main().catch(async (err) => {
  log(`fatal: ${err?.stack || err}`);
  releaseLock();
  try { await browser?.close(); } catch {}
  killVite();
  process.exit(1);
});
