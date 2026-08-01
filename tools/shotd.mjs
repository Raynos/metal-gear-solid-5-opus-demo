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
 * A daemon per working tree was the first fix and was still wrong: authors run
 * a worktree each, so daemons tracked worktrees — six of them, 47 chromium
 * processes, 7.8 GB, load average 122, machine unusable.
 *
 * So: ONE daemon, ONE chromium, machine-wide, shared by every tree.
 *
 * WHY MORE THAN ONE RESIDENT WORLD
 *
 * Collapsing to a single resident world made same-tree work superb (32 shots in
 * 9.2s, ~0.29s each) and cross-tree work worse than what it replaced: every
 * switch rebuilt from scratch at 13.5s, strictly serialised, with no reuse. Four
 * agents on four trees took 59.6s — and 57.2s again on a second pass, because
 * each switch evicted the previous world.
 *
 * So the daemon keeps a small LRU of resident worlds (default 3, hard cap 6).
 * One chromium still; one page and one vite server per resident world. That is a
 * bounded ~2 GB, nothing like the 7.8 GB that came from unbounded per-tree
 * daemons — and revisiting a hot tree costs ~0.3s instead of 13.5s.
 *
 * Nothing starts this by hand: tools/shot.mjs spawns it on demand and it shuts
 * itself down when idle.
 *
 *   node tools/shotd.mjs [--idle 600] [--worlds 3]
 */
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { openSync, writeSync, closeSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Machine-wide state. Deliberately NOT inside any tree: one daemon serves every
// tree, so its lock cannot live in one of them.
const RUN = path.join(os.homedir(), '.cache', 'shotd');
const LOCK = path.join(RUN, 'lock');
const PORTFILE = path.join(RUN, 'port');
const CHILDREN = path.join(RUN, 'children.json'); // pids to reap after a hard kill

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i < 0 ? d : argv[i + 1];
};
const IDLE_MS = Math.max(60, +opt('idle', 600)) * 1000;
// Each resident world is a page holding ~160 MB of terrain typed arrays plus GPU
// textures, and a vite server at ~75 MB. Capped hard: unbounded residency is the
// mistake that took the machine down.
// One daemon serves every worktree, so the cap must cover the number of authors
// working at once, not the number of trees one author uses. At 3, nine parallel
// agents evicted each other continuously: 138 rebuilds in one session, 98 of them
// on a single tree, 44.7 min (17% of wall clock) spent regenerating worlds that
// were about to be needed again. Resident worlds are ~0.15 GB each.
const MAX_WORLDS = Math.max(1, Math.min(+opt('worlds', 10), 16));
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
  for (const f of [LOCK, PORTFILE, CHILDREN]) {
    try { unlinkSync(f); } catch {}
  }
}

// --- child bookkeeping ----------------------------------------------------
// SIGKILL on the daemon orphans its chromium and every vite server it started,
// and those accumulate at ~0.8 GB and ~75 MB apiece. Record them so the next
// daemon cleans up. NOTE: playwright launches `chrome-headless-shell`, NOT
// `Chromium.app` — grepping for the latter silently matches nothing.
const children = { browser: null, vites: [] };

function persistChildren() {
  try { writeFileSync(CHILDREN, JSON.stringify(children)); } catch {}
}

function reapOrphans() {
  let prev;
  try { prev = JSON.parse(readFileSync(CHILDREN, 'utf8')); } catch { return; }
  const kill = (pid, group, what) => {
    if (!pid) return;
    try {
      process.kill(group ? -pid : pid, 'SIGKILL');
      log(`reaped orphaned ${what} from a previous daemon (pid ${pid})`);
    } catch { /* already gone */ }
  };
  kill(prev.browser, false, 'chromium');
  for (const p of prev.vites ?? []) kill(p, true, 'vite');
  try { unlinkSync(CHILDREN); } catch {}
}

// --- source staleness -----------------------------------------------------
// A resident world only has to be thrown away when the code that generated it
// changed, so a rebuild is paid once per edit rather than once per screenshot.
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

// --- the one browser ------------------------------------------------------
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
  // Only one page can be foreground; without these the rest get throttled and
  // screenshots come back stale or blank.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

let browser = null;
let renderer = null;
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

function isPageGone(err) {
  const m = String(err?.message ?? err);
  return /Not attached to an active page|Target closed|Target crashed|has been closed|Page closed|crashed/.test(m);
}

/**
 * PID of the chromium we launched. `browser.process()` is missing on some
 * Playwright builds, so fall back to our own child list — at launch chromium is
 * the only child, because vite servers start lazily per world.
 */
function browserPid() {
  try {
    if (typeof browser.process === 'function') {
      const pid = browser.process()?.pid;
      if (pid) return pid;
    }
  } catch { /* not supported on this build */ }
  try {
    const kids = execSync(`pgrep -P ${process.pid}`, { encoding: 'utf8' })
      .trim().split('\n').map(Number).filter(Boolean);
    return kids[0] ?? null;
  } catch {
    return null;
  }
}

// --- worlds ---------------------------------------------------------------
/** One tree's generated world: its own vite server and its own warm page. */
class World {
  constructor(root) {
    this.root = root;
    this.page = null;
    this.vite = null;
    this.mtime = 0;
    this.lastUsed = Date.now();
    this.errors = [];
    this.width = 1280;
    this.height = 720;
  }

  async startVite() {
    const port = await freePort();
    const proc = spawn(
      process.execPath,
      [path.join(this.root, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1', '--clearScreen', 'false'],
      { cwd: this.root, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (out += d));
    children.vites.push(proc.pid);
    persistChildren();

    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/`)).ok) {
          this.vite = { proc, port };
          return;
        }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    throw new Error(`vite failed to start for ${this.root}:\n${out}`);
  }

  async attachPage() {
    this.page = await browser.newPage({
      viewport: { width: this.width, height: this.height },
      deviceScaleFactor: 1,
    });
    this.mtime = 0;
    this.page.on('console', (m) => {
      if (m.type() === 'error') this.errors.push(m.text());
    });
    this.page.on('pageerror', (e) => this.errors.push(String(e)));
    // A module that fails to transform comes back as a 500 whose body names the
    // file and line. Without this the only symptom is a bare 500.
    this.page.on('response', async (res) => {
      if (res.status() < 400) return;
      const body = await res.text().catch(() => '');
      const detail = body.trim().split('\n').slice(0, 6).join('\n  ');
      this.errors.unshift(`${res.status()} ${res.url()}${detail ? `\n  ${detail}` : ''}`);
    });
    this.page.on('crash', () => {
      this.mtime = 0;
      log(`page for ${path.basename(this.root)} crashed; will rebuild on next use`);
    });
  }

  /**
   * Wait for the world to finish generating.
   *
   * Two traps. Playwright's second positional argument is the page-function
   * ARGUMENT, not the options bag — passing `{ timeout }` there silently leaves
   * the 30s default in place, which is shorter than a cold build under load and
   * is why the old harness spuriously timed out and everyone wrapped it in retry
   * loops. And on a cold `node_modules/.vite`, vite's dependency optimizer
   * force-reloads the page mid-boot and destroys the execution context.
   */
  async waitReady(timeoutMs = 180000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let state;
      try {
        state = await this.page.evaluate(() => ({
          ready: !!(window.__GAME && window.__GAME.ready === true),
          present: !!window.__GAME,
          doc: document.readyState,
        }));
      } catch (err) {
        if (isPageGone(err)) throw err;
        const m = String(err?.message ?? err);
        if (!m.includes('Execution context was destroyed') && !m.includes('navigating')) throw err;
        await this.page.waitForLoadState('load').catch(() => {});
        state = null;
      }
      if (state?.ready) return;

      // A finished document that never created the harness, plus a thrown
      // error, means the module graph did not evaluate — a syntax error, not a
      // slow build. Say so now: during a real build the main thread is blocked
      // and this poll could not even run.
      if (state && !state.present && state.doc === 'complete' && this.errors.length) {
        throw new Error(`build is broken — the page threw before the harness loaded:\n  ${this.errors[0]}`);
      }
      if (Date.now() > deadline) {
        throw new Error(
          `world never became ready within ${Math.round(timeoutMs / 1000)}s` +
            (this.errors.length ? `; first page error:\n  ${this.errors[0]}` : ''),
        );
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async build(reason) {
    const t0 = Date.now();
    // Stamp before building: an edit landing mid-build must leave this world
    // stale rather than being masked by a fresher mtime.
    const stamp = await newestSourceMtime(this.root);
    this.errors = [];
    if (!this.vite) await this.startVite();
    if (!this.page || this.page.isClosed()) await this.attachPage();

    try {
      await this.page.goto(`http://127.0.0.1:${this.vite.port}/`, { waitUntil: 'load', timeout: 120000 });
      await this.waitReady();
    } catch (err) {
      if (!isPageGone(err)) {
        this.mtime = 0;
        throw err;
      }
      // Renderer died holding a 3.6M-triangle scene; start a fresh one once.
      try { await this.page.close(); } catch {}
      await this.attachPage();
      this.errors = [];
      await this.page.goto(`http://127.0.0.1:${this.vite.port}/`, { waitUntil: 'load', timeout: 120000 });
      await this.waitReady();
    }
    this.mtime = stamp;
    log(`world ready for ${this.root} (${reason}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  async setViewport(width, height) {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    await this.page.setViewportSize({ width, height });
  }

  async dispose() {
    try { await this.page?.close(); } catch {}
    if (this.vite) {
      try { process.kill(-this.vite.proc.pid, 'SIGKILL'); } catch {}
      children.vites = children.vites.filter((p) => p !== this.vite.proc.pid);
      persistChildren();
    }
    this.page = null;
    this.vite = null;
  }
}

const worlds = new Map(); // root -> World; LRU by lastUsed

async function evictIfNeeded(keepRoot) {
  while (worlds.size >= MAX_WORLDS) {
    let oldest = null;
    for (const w of worlds.values()) {
      if (w.root === keepRoot) continue;
      if (!oldest || w.lastUsed < oldest.lastUsed) oldest = w;
    }
    if (!oldest) return; // nothing evictable
    worlds.delete(oldest.root);
    await oldest.dispose();
    log(`evicted world ${oldest.root} (LRU, cap ${MAX_WORLDS})`);
  }
}

/**
 * Get a ready world for `root`. This is the chokepoint everything funnels
 * through: it rebuilds only when the tree's sources actually moved, and keeps
 * recently used trees resident so revisiting one is nearly free.
 */
async function getWorld(root, { force = false } = {}) {
  let w = worlds.get(root);
  const newest = await newestSourceMtime(root);

  if (w && !force && w.mtime >= newest && w.page && !w.page.isClosed()) {
    w.lastUsed = Date.now();
    return w;
  }

  if (!w) {
    await evictIfNeeded(root);
    w = new World(root);
    worlds.set(root, w);
    await w.build('first use');
  } else {
    await w.build(force ? 'forced reload' : 'sources changed');
  }
  w.lastUsed = Date.now();
  return w;
}

// --- the queue ------------------------------------------------------------
// Rendering is GPU-serialised and world builds are single-threaded CPU work, so
// one job at a time is the honest model — overlapping them only adds contention.
// The ordering rule is what makes it cheap: prefer work for a tree that is
// already resident, so a build is amortised over a whole batch. A waiter passed
// over for too long jumps the queue.
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
  const resident = queue.findIndex((q) => {
    const w = worlds.get(q.root);
    return w && w.page && !w.page.isClosed();
  });
  return resident >= 0 ? resident : 0;
}

async function pump() {
  if (running || !queue.length || stopping) return;
  running = true;
  lastActivity = Date.now();
  const item = queue.splice(nextIndex(), 1)[0];
  try {
    const world = await getWorld(item.root);
    item.resolve(await item.job(world));
  } catch (err) {
    item.reject(err);
  } finally {
    running = false;
    lastActivity = Date.now();
    pump();
  }
}

// --- request handlers -----------------------------------------------------
async function readRenderer(w) {
  if (renderer) return renderer;
  renderer = await w.page
    .evaluate(() => {
      const gl = window.__GAME.engine.renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    })
    .catch(() => 'unknown');
  return renderer;
}

function handleShot({ root, shots, out = 'shots', width = 1280, height = 720, frames = 6 }) {
  return enqueue(root, async (w) => {
    await w.setViewport(width, height);
    w.errors = [];

    const outDir = path.resolve(root, out);
    await mkdir(outDir, { recursive: true });

    const all = await w.page.evaluate(() => Object.keys(window.__GAME.shots));
    const wanted = shots && shots.length ? shots.filter((s) => all.includes(s)) : all;
    const report = { renderer: await readRenderer(w), shots: {}, errors: [] };

    for (const name of wanted) {
      const meta = await w.page.evaluate(
        ({ name, frames }) => {
          const g = window.__GAME;
          const s = g.applyShot(name);
          const ms = g.settle(frames);
          return { note: s.note, tod: s.tod, ms: Math.round(ms * 100) / 100, stats: g.stats(), errors: g.errors.slice() };
        },
        { name, frames },
      );
      const file = path.join(outDir, `${name}.png`);
      await writeFile(file, await w.page.screenshot({ type: 'png' }));
      report.shots[name] = { file: path.relative(root, file), ...meta };
    }
    report.errors = w.errors.slice();
    report.missing = (shots || []).filter((s) => !all.includes(s));
    report.dir = path.relative(root, outDir);
    await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    return report;
  });
}

function handleEval({ root, code, shot, width = 1920, height = 1080, out = 'shots/diag' }) {
  return enqueue(root, async (w) => {
    await w.setViewport(width, height);
    w.errors = [];
    if (shot) await w.page.evaluate((n) => window.__GAME.applyShot(n), shot);

    const result = await w.page.evaluate(async (src) => {
      window.__snaps = {};
      const g = window.__GAME;
      const fn = new Function('g', 'THREE', `return (async () => {\n${src}\n})();`);
      return await fn(g, g.THREE);
    }, code);

    const outDir = path.resolve(root, out);
    const snaps = await w.page.evaluate(() => Object.keys(window.__snaps || {}));
    if (snaps.length) await mkdir(outDir, { recursive: true });
    const written = [];
    for (const name of snaps) {
      const b64 = await w.page.evaluate((n) => window.__snaps[n], name);
      const file = path.join(outDir, name + '.png');
      await writeFile(file, Buffer.from(b64.split(',')[1], 'base64'));
      written.push(path.relative(root, file));
    }
    return { result, snaps: written, errors: w.errors.slice() };
  });
}

/** Explicit "throw the world away and rebuild it" control. */
function handleReload({ root }) {
  return enqueue(root, async () => {
    await getWorld(root, { force: true });
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

  log(`booting (idle=${IDLE_MS / 1000}s, worlds=${MAX_WORLDS}) — one chromium, ${MAX_WORLDS} resident world(s) max`);
  reapOrphans();
  browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
  children.browser = browserPid();
  persistChildren();

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
          maxWorlds: MAX_WORLDS,
          resident: [...worlds.values()].map((w) => ({ root: w.root, idleSec: Math.round((Date.now() - w.lastUsed) / 1000) })),
          queued: queue.length, busy: running,
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
  // daemon starts while this one still holds a browser and vite servers — which
  // is how two daemons ended up alive at once. And never linger: if close()
  // hangs we still die, and the 'exit' handler clears the lock on the way out.
  const bail = setTimeout(() => process.exit(0), 5000);
  for (const w of worlds.values()) await w.dispose().catch(() => {});
  try { await browser?.close(); } catch {}
  clearTimeout(bail);
  releaseLock();
  process.exit(0);
}

main().catch(async (err) => {
  log(`fatal: ${err?.stack || err}`);
  try { await browser?.close(); } catch {}
  for (const w of worlds.values()) await w.dispose().catch(() => {});
  releaseLock();
  process.exit(1);
});
