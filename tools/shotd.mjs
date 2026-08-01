#!/usr/bin/env node
/**
 * shotd.mjs — the render daemon. ONE of these serves the whole machine.
 *
 * The old harness booted a vite server, a chromium and a full procedural world
 * for every single screenshot. Measured on an M3 Pro: 2.1s vite + 1.2s chromium
 * + 17.1s page init (of which 11.8s is the Terrain.js erosion sim) + 0.6s per
 * shot. Eight build agents doing that concurrently pushed one run from 18s to
 * 55s through sheer contention. Across the first three rounds that was 551
 * process launches and ~193 minutes of wall clock, nearly all of it spent
 * recomputing an identical world.
 *
 * So: boot once, stay warm, serve everyone. A shot against an unchanged tree
 * costs ~0.6s. The world is rebuilt only when a source file actually changes,
 * and then once for the whole machine rather than once per agent.
 *
 * Nothing starts this by hand — tools/shot.mjs spawns it on demand and it shuts
 * itself down when idle.
 *
 *   node tools/shotd.mjs [--pages 3] [--idle 1800] [--foreground]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { openSync, writeSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = path.join(ROOT, '.shotd');
const LOCK = path.join(RUN, 'lock');
const PORTFILE = path.join(RUN, 'port');
const LOG = path.join(RUN, 'log');
const VITEPID = path.join(RUN, 'vite.pid');

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i < 0 ? d : argv[i + 1];
};
const POOL_SIZE = Math.max(1, +opt('pages', 3));
const IDLE_MS = Math.max(60, +opt('idle', 1800)) * 1000;

const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  process.stdout.write(line);
};

// --- single instance ------------------------------------------------------
// An exclusive create is the whole interlock: eight clients racing to start the
// daemon means seven of them lose here and go connect to the winner instead.
function claimLock() {
  try {
    const fd = openSync(LOCK, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Stale lock from a daemon that died without cleaning up?
    try {
      const pid = +readFileSync(LOCK, 'utf8').trim();
      process.kill(pid, 0); // throws if the process is gone
      return false; // a live daemon owns it
    } catch {
      try { unlinkSync(LOCK); } catch {}
      return claimLock();
    }
  }
}

function releaseLock() {
  for (const f of [LOCK, PORTFILE, VITEPID]) {
    try { unlinkSync(f); } catch {}
  }
}

// --- source staleness -----------------------------------------------------
// A page holds a fully generated world. It only has to be thrown away when the
// code that generated it changed, so the reload cost is paid once per edit for
// the whole machine instead of once per screenshot per agent.
const WATCH_DIRS = ['src'];
const WATCH_FILES = ['index.html', 'vite.config.js'];

let mtimeCache = { at: 0, value: 0 };

async function newestSourceMtime() {
  // Bursts of concurrent requests shouldn't each re-walk the tree.
  if (Date.now() - mtimeCache.at < 250) return mtimeCache.value;
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
  await Promise.all(WATCH_DIRS.map((d) => walk(path.join(ROOT, d))));
  for (const f of WATCH_FILES) {
    const s = await stat(path.join(ROOT, f)).catch(() => null);
    if (s && s.mtimeMs > newest) newest = s.mtimeMs;
  }
  mtimeCache = { at: Date.now(), value: newest };
  return newest;
}

// --- boot -----------------------------------------------------------------
async function freePort() {
  return new Promise((res, rej) => {
    const srv = createNetServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

/**
 * Kill the vite server left behind by a previous daemon that was SIGKILLed.
 * The normal exit paths clean up after themselves, but a hard kill orphans the
 * child, and orphans accumulate across a long session holding ports and memory.
 */
function reapStaleVite() {
  let pid;
  try {
    pid = +readFileSync(VITEPID, 'utf8').trim();
  } catch {
    return;
  }
  if (pid > 0) {
    try {
      process.kill(-pid, 'SIGKILL');
      log(`reaped orphaned vite from a previous daemon (pid ${pid})`);
    } catch {
      /* already gone */
    }
  }
  try { unlinkSync(VITEPID); } catch {}
}

async function startVite() {
  reapStaleVite();
  const port = await freePort();
  const proc = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1', '--clearScreen', 'false'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  writeFileSync(VITEPID, String(proc.pid));
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return { proc, port };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill('SIGKILL');
  throw new Error(`vite failed to start on ${port}:\n${out}`);
}

const BROWSER_ARGS = [
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
  // Pages past the first are never the focused tab. Without these, chromium
  // throttles them and screenshots come back stale or blank.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

const DEFAULT_W = 1280;
const DEFAULT_H = 720;

/**
 * Wait for the world to finish generating.
 *
 * Two traps here. Playwright's second positional argument is the page-function
 * ARGUMENT, not the options bag — passing `{ timeout }` there silently leaves
 * the 30s default in place, which is shorter than a cold world build under load
 * and is why the old harness would spuriously time out when several agents ran
 * at once. And on a cold `node_modules/.vite`, vite's dependency optimizer
 * force-reloads the page mid-boot, destroying the execution context; that is
 * expected, so ride it out rather than failing the build.
 */
async function waitReady(page, errors = [], timeoutMs = 180000) {
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
      const msg = String(err?.message ?? err);
      // On a cold `node_modules/.vite`, vite's dependency optimizer force-
      // reloads the page mid-boot and destroys the execution context. Expected;
      // ride it out rather than failing the build.
      if (isPageGone(err)) throw err;
      if (!msg.includes('Execution context was destroyed') && !msg.includes('navigating')) throw err;
      await page.waitForLoadState('load').catch(() => {});
      state = null;
    }

    if (state?.ready) return;

    // A finished document that never created the harness, plus a thrown error,
    // means the module graph did not evaluate — a syntax error somewhere, not a
    // slow world build. Say so now instead of burning the full timeout: during a
    // real build the main thread is blocked and this poll cannot even run.
    if (state && !state.present && state.doc === 'complete' && errors.length) {
      throw new Error(`build is broken — the page threw before the harness loaded:\n  ${errors[0]}`);
    }

    if (Date.now() > deadline) {
      throw new Error(
        `world never became ready within ${Math.round(timeoutMs / 1000)}s` +
          (errors.length ? `; first page error:\n  ${errors[0]}` : ''),
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

let vite;
let browser;
const pool = [];
const waiters = [];
let lastActivity = Date.now();

// World builds run one at a time, machine-wide. Concurrency here is pure loss:
// the work is single-threaded JS, so overlapping builds only fight for cores.
let bootChain = Promise.resolve();
function serializeBoot(fn) {
  const run = bootChain.then(fn, fn);
  bootChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** Detached target, crashed renderer, closed context — all mean "page is gone". */
function isPageGone(err) {
  const m = String(err?.message ?? err);
  return (
    m.includes('Not attached to an active page') ||
    m.includes('Target closed') ||
    m.includes('Target crashed') ||
    m.includes('has been closed') ||
    m.includes('Page closed') ||
    m.includes('crashed')
  );
}

/** One warm page: a booted game plus the source state it was booted from. */
class Slot {
  constructor(id) {
    this.id = id;
    this.page = null;
    this.builtFrom = 0;
    this.width = DEFAULT_W;
    this.height = DEFAULT_H;
    this.errors = [];
    this.dead = false;
  }

  async attach() {
    this.page = await browser.newPage({
      viewport: { width: this.width, height: this.height },
      deviceScaleFactor: 1,
    });
    this.builtFrom = 0;
    this.dead = false;
    this.page.on('console', (m) => {
      if (m.type() === 'error') this.errors.push(m.text());
    });
    this.page.on('pageerror', (e) => this.errors.push(String(e)));
    // A module that fails to transform comes back as a 500 whose body carries
    // the file and line. Without this the only symptom is a bare
    // "500 Internal Server Error", which tells an author nothing.
    this.page.on('response', async (res) => {
      if (res.status() < 400) return;
      const body = await res.text().catch(() => '');
      const detail = body.trim().split('\n').slice(0, 6).join('\n  ');
      this.errors.unshift(`${res.status()} ${res.url()}${detail ? `\n  ${detail}` : ''}`);
    });
    // A renderer holding a 3.6M-triangle scene can be reaped under memory
    // pressure. Note it and rebuild on next use rather than failing a request.
    this.page.on('crash', () => {
      this.dead = true;
      log(`page ${this.id} crashed; will be recreated`);
    });
  }

  async boot(reason) {
    // Serialized: a world build is ~12s of single-threaded erosion, so two
    // pages building at once take three times as long as two in sequence.
    // This is the same contention that made the old per-agent harness slow.
    return serializeBoot(async () => {
      const t0 = Date.now();
      this.errors.length = 0;
      // Stamp before building, not after: an edit that lands mid-build must
      // leave this page stale rather than being masked by a fresher mtime.
      const stamp = await newestSourceMtime();
      if (this.builtFrom === 0) {
        await this.page.goto(`http://127.0.0.1:${vite.port}/`, { waitUntil: 'load', timeout: 120000 });
      } else {
        await this.page.reload({ waitUntil: 'load', timeout: 120000 });
      }
      await waitReady(this.page, this.errors);
      this.builtFrom = stamp;
      log(`page ${this.id} built (${reason}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    });
  }

  /** Throw the page away and start a fresh one. */
  async recreate(reason) {
    try { await this.page?.close(); } catch {}
    await this.attach();
    await this.boot(reason);
  }

  /**
   * Rebuild only if the tree moved under us — this is the whole optimisation —
   * and transparently replace the page if it died while parked in the pool.
   */
  async sync() {
    if (this.dead || !this.page || this.page.isClosed()) {
      await this.recreate('page was gone');
      return;
    }
    const newest = await newestSourceMtime();
    if (newest <= this.builtFrom) return;
    try {
      await this.boot('sources changed');
    } catch (err) {
      if (!isPageGone(err)) throw err;
      await this.recreate('page died during rebuild');
    }
  }

  async resize(width, height) {
    if (this.width === width && this.height === height) return;
    await this.page.setViewportSize({ width, height });
    this.width = width;
    this.height = height;
  }
}

/**
 * Hand out a page for the tree as it stands right now, preferring one that is
 * already current. A stale page only gets picked when no current page is free,
 * so a burst of requests after one edit rides the first rebuilt page instead of
 * each paying for a rebuild — and when demand really does exceed one page, the
 * spare pages refresh themselves (serialised by serializeBoot) to restore
 * capacity rather than leaving everyone queued behind a single world.
 */
async function acquire() {
  lastActivity = Date.now();
  for (;;) {
    // Recompute after every await — concurrent callers mutate the pool, so
    // nothing observed before an await can be trusted after it.
    const newest = await newestSourceMtime();
    const i = pool.findIndex((s) => s && !s.dead && s.builtFrom >= newest);
    if (i >= 0) return pool.splice(i, 1)[0];

    const stale = pool.pop();
    if (stale) return stale;

    // Pool empty: wait for a page to come back and re-evaluate it.
    const returned = await new Promise((res) => waiters.push(res));
    if (returned) pool.push(returned);
  }
}

function release(slot) {
  lastActivity = Date.now();
  if (!slot) return;
  const w = waiters.shift();
  if (w) w(slot);
  else pool.push(slot);
}

// --- request handlers -----------------------------------------------------
/**
 * Run `fn` against a synced warm page. If the renderer dies mid-request the
 * page is rebuilt and the work retried once, so a crash costs a rebuild rather
 * than a failed shot that an agent would have to notice and retry by hand.
 */
async function withSlot(fn) {
  const slot = await acquire();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await slot.sync();
        return await fn(slot);
      } catch (err) {
        if (attempt >= 1 || !isPageGone(err)) throw err;
        log(`retrying after page loss: ${String(err?.message ?? err).split('\n')[0]}`);
        await slot.recreate('page died mid-request');
      }
    }
  } finally {
    release(slot);
  }
}

async function handleShot({ shots, out = 'shots', width = DEFAULT_W, height = DEFAULT_H, frames = 6 }) {
  return withSlot(async (slot) => {
    await slot.resize(width, height);
    slot.errors.length = 0;

    const outDir = path.resolve(ROOT, out);
    await mkdir(outDir, { recursive: true });

    const all = await slot.page.evaluate(() => Object.keys(window.__GAME.shots));
    const wanted = shots && shots.length ? shots.filter((s) => all.includes(s)) : all;
    const missing = (shots || []).filter((s) => !all.includes(s));

    // Cold start may have failed against a broken tree; this is the first
    // moment a working page exists to ask.
    if (!vite.renderer) vite.renderer = await readRenderer(slot).catch(() => 'unknown');
    const report = { renderer: vite.renderer, shots: {}, errors: [] };
    for (const name of wanted) {
      const meta = await slot.page.evaluate(
        ({ name, frames }) => {
          const g = window.__GAME;
          const s = g.applyShot(name);
          const ms = g.settle(frames);
          return { note: s.note, tod: s.tod, ms: Math.round(ms * 100) / 100, stats: g.stats(), errors: g.errors.slice() };
        },
        { name, frames },
      );
      const file = path.join(outDir, `${name}.png`);
      await writeFile(file, await slot.page.screenshot({ type: 'png' }));
      report.shots[name] = { file: path.relative(ROOT, file), ...meta };
    }
    report.errors = slot.errors.slice();
    report.missing = missing;
    report.dir = path.relative(ROOT, outDir);
    await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    return report;
  });
}

async function handleEval({ code, shot, width = 1920, height = 1080, out = 'shots/diag' }) {
  return withSlot(async (slot) => {
    await slot.resize(width, height);
    slot.errors.length = 0;
    if (shot) await slot.page.evaluate((n) => window.__GAME.applyShot(n), shot);

    const result = await slot.page.evaluate(async (src) => {
      window.__snaps = {};
      const g = window.__GAME;
      const fn = new Function('g', 'THREE', `return (async () => {\n${src}\n})();`);
      return await fn(g, g.THREE);
    }, code);

    const outDir = path.resolve(ROOT, out);
    const snaps = await slot.page.evaluate(() => Object.keys(window.__snaps || {}));
    if (snaps.length) await mkdir(outDir, { recursive: true });
    const written = [];
    for (const name of snaps) {
      const b64 = await slot.page.evaluate((n) => window.__snaps[n], name);
      const file = path.join(outDir, name + '.png');
      await writeFile(file, Buffer.from(b64.split(',')[1], 'base64'));
      written.push(path.relative(ROOT, file));
    }
    return { result, snaps: written, errors: slot.errors.slice() };
  });
}

// PNG inspection runs on its own 2D page — it needs no GPU and must never
// occupy a slot that a screenshot is waiting for.
let pixPage = null;
async function getPixPage() {
  if (pixPage) return pixPage;
  pixPage = await browser.newPage();
  await pixPage.setContent('<canvas id=c></canvas>');
  return pixPage;
}

async function loadPng(page, file) {
  const b64 = (await readFile(path.resolve(ROOT, file))).toString('base64');
  return page.evaluate(async (b64) => {
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

async function handlePix({ op, files = [], args = [] }) {
  const page = await getPixPage();
  if (op === 'stats') {
    const rows = [];
    for (const f of files) {
      await loadPng(page, f);
      const s = await page.evaluate(() => {
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
    await loadPng(page, files[0]);
    const pts = args.map((a) => a.split(',').map(Number));
    const vals = await page.evaluate((pts) => {
      const c = document.getElementById('c');
      const g = c.getContext('2d', { willReadFrequently: true });
      return pts.map(([x, y]) => {
        const d = g.getImageData(x, y, 1, 1).data;
        return { x, y, r: d[0], g: d[1], b: d[2] };
      });
    }, pts);
    return { points: vals };
  }
  if (op === 'crop') {
    const [x, y, w, h, scale, outFile] = args;
    await loadPng(page, files[0]);
    const b64 = await page.evaluate(({ x, y, w, h, s }) => {
      const src = document.getElementById('c');
      const o = document.createElement('canvas');
      o.width = w * s; o.height = h * s;
      const g = o.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(src, x, y, w, h, 0, 0, w * s, h * s);
      return o.toDataURL('image/png').split(',')[1];
    }, { x: +x, y: +y, w: +w, h: +h, s: +scale });
    const dest = path.resolve(ROOT, outFile);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(b64, 'base64'));
    return { wrote: path.relative(ROOT, dest) };
  }
  if (op === 'column') {
    await loadPng(page, files[0]);
    const [x, fracs] = args;
    const rows = await page.evaluate(({ x, fracs }) => {
      const c = document.getElementById('c');
      const g = c.getContext('2d', { willReadFrequently: true });
      return fracs.map((f) => {
        const y = Math.min(c.height - 1, Math.round(f * c.height));
        const d = g.getImageData(x, y, 1, 1).data;
        return { frac: f, y, r: d[0], g: d[1], b: d[2] };
      });
    }, { x: +x, fracs: String(fracs).split(',').map(Number) });
    return { rows };
  }
  throw new Error(`unknown pix op: ${op}`);
}

async function readRenderer(slot) {
  const ask = () =>
    slot.page.evaluate(() => {
      const gl = window.__GAME.engine.renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
  try {
    return await ask();
  } catch {
    // Lost the context to a late optimizer reload — settle and ask again.
    await waitReady(slot.page, slot.errors);
    return ask();
  }
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
  await mkdir(RUN, { recursive: true });
  if (!claimLock()) {
    log('another daemon holds the lock; exiting');
    process.exit(0);
  }

  process.on('exit', releaseLock);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { shutdown(`signal ${sig}`); });
  }

  log(`booting (pages=${POOL_SIZE}, idle=${IDLE_MS / 1000}s)`);
  vite = await startVite();
  log(`vite on ${vite.port}`);
  browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });

  // First page synchronously, so a client that connects immediately gets a
  // usable answer; the rest warm up behind it.
  // The tree may well be broken right now — somebody is always mid-edit. That
  // must not stop the daemon coming up: a daemon that refuses to start when the
  // build is red is a daemon that cannot tell anyone *why* the build is red.
  // Boot what we can, listen regardless, and let each request retry and report.
  const first = new Slot(0);
  await first.attach();
  try {
    await first.boot('cold start');
    vite.renderer = await readRenderer(first);
    log(`renderer: ${vite.renderer}`);
  } catch (err) {
    log(`cold start failed (serving anyway, will retry per request): ${String(err?.message ?? err).split('\n')[0]}`);
  }
  release(first);

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
          ok: true, pid: process.pid, pages: POOL_SIZE, idlePages: pool.length,
          queued: waiters.length, renderer: vite.renderer, uptimeSec: Math.round(process.uptime()),
        });
      }
      if (url.pathname === '/stop') {
        send(200, { ok: true, stopping: true });
        setTimeout(() => shutdown('client asked'), 50);
        return;
      }
      const body = await readBody(req);
      if (url.pathname === '/shot') return send(200, await handleShot(body));
      if (url.pathname === '/eval') return send(200, await handleEval(body));
      if (url.pathname === '/pix') return send(200, await handlePix(body));
      return send(404, { error: 'no such endpoint' });
    } catch (err) {
      log(`ERROR ${err?.stack || err}`);
      return send(500, { error: String(err?.message ?? err) });
    }
  });
  // Long world rebuilds must not trip a socket timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 65000;

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await writeFile(PORTFILE, String(port));
  log(`listening on ${port}`);

  // Remaining pages warm up in the background — the daemon is already usable.
  (async () => {
    for (let i = 1; i < POOL_SIZE; i++) {
      const s = new Slot(i);
      try {
        await s.attach();
        await s.boot('warm-up');
      } catch (err) {
        // Broken tree, most likely. Still hand the page to the pool: it boots
        // with builtFrom = 0, so the next request retries and reports properly.
        log(`page ${i} warm-up failed: ${String(err?.message ?? err).split('\n')[0]}`);
      }
      release(s);
    }
    log('pool warm');
  })().catch((e) => log(`warm-up failed: ${e}`));

  setInterval(() => {
    if (Date.now() - lastActivity > IDLE_MS) shutdown('idle');
  }, 30000).unref();
}

let stopping = false;
async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log(`shutting down (${reason})`);
  releaseLock();
  try { await browser?.close(); } catch {}
  try { process.kill(-vite.proc.pid, 'SIGKILL'); } catch {}
  process.exit(0);
}

main().catch(async (err) => {
  log(`fatal: ${err?.stack || err}`);
  releaseLock();
  // Without this the detached vite server outlives the daemon and leaks a port.
  try { await browser?.close(); } catch {}
  try { process.kill(-vite.proc.pid, 'SIGKILL'); } catch {}
  process.exit(1);
});
