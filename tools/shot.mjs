#!/usr/bin/env node
/**
 * shot.mjs — client for the render daemon (tools/shotd.mjs).
 *
 * This process does no rendering. It hands a request to the one warm daemon on
 * this machine and prints the answer, so ten agents screenshotting at once cost
 * one browser and one world, not ten of each.
 *
 *   node tools/shot.mjs                          # all canonical shots -> shots/
 *   node tools/shot.mjs vista ground             # only those shots
 *   node tools/shot.mjs vista --out shots/mine   # custom output dir
 *   node tools/shot.mjs vista --width 1920 --height 1080
 *
 *   node tools/shot.mjs eval probe.js [--shot vista] [--out shots/diag]
 *   node tools/shot.mjs pix stats shots/r4/*.png
 *   node tools/shot.mjs pix probe shots/r4/vista.png 100,200 300,400
 *   node tools/shot.mjs pix crop shots/r4/ground.png 1030 810 220 160 3 out.png
 *   node tools/shot.mjs pix column shots/r4/vista.png 1690 0.02,0.12,0.25,0.40
 *
 *   node tools/shot.mjs reload            # force a world rebuild from source
 *   node tools/shot.mjs status | stop
 *
 * There is exactly ONE daemon per machine, shared by every working tree: one
 * chromium, and a small LRU of resident worlds (default 3) each with its own
 * page and vite server. Requests queue, ordered to prefer a tree that is already
 * resident. A shot against a resident tree costs ~0.3s; a tree that has to be
 * built costs ~13.5s, so keep your hot trees under the cap (SHOTD_WORLDS).
 *
 * The daemon starts on demand and shuts itself down when idle. Exits non-zero
 * if the page threw — a broken build must never be silently screenshotted as
 * "art direction".
 */
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { openSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The daemon is machine-wide, not per-tree, so its state lives outside every
// tree. Each request carries ROOT so the daemon knows which tree to load.
// Instance isolation. One daemon per machine is right for the shared tree, but
// optimisation work needs a daemon that cannot contend with, evict, or be
// queued behind the one real agents are using. SHOTD_RUN gives it a private
// lock, port file and world set.
const RUN = process.env.SHOTD_RUN
  ? path.resolve(process.env.SHOTD_RUN)
  : path.join(os.homedir(), '.cache', 'shotd');
const PORTFILE = path.join(RUN, 'port');
const LOCKFILE = path.join(RUN, 'lock');
const LOGFILE = path.join(RUN, 'log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How long a client waits before deciding a spawned daemon is never coming and
// electing a replacement. Must comfortably exceed daemon startup-to-lock time.
const RESPAWN_BACKOFF_MS = 15000;

async function ping() {
  let port;
  try {
    port = (await readFile(PORTFILE, 'utf8')).trim();
  } catch {
    return null;
  }
  if (!port) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) return port;
  } catch {
    /* stale port file */
  }
  return null;
}

function spawnDaemon() {
  const out = openSync(LOGFILE, 'a');
  spawn(process.execPath, [path.join(ROOT, 'tools/shotd.mjs'), ...daemonFlags()], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
  }).unref();
}

/** Is some daemon process alive and holding the lock (possibly still booting)? */
function daemonStarting() {
  try {
    const pid = +readFileSync(LOCKFILE, 'utf8').trim();
    process.kill(pid, 0); // throws if that process is gone
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a live daemon, starting one if needed.
 *
 * Nine agents can hit this at the same instant. They all try to spawn, and the
 * daemon takes an O_EXCL lock the moment it starts: exactly one wins, the other
 * eight log "another daemon holds the lock" and exit before opening so much as a
 * vite server. Everyone then waits here for the winner's port file, which is
 * only written once it is booted and listening — so nobody ever talks to a
 * half-built daemon. If the winner dies mid-boot the lock goes with it, and the
 * loop below notices and elects a new one.
 */
async function daemonPort({ quiet = false } = {}) {
  const existing = await ping();
  if (existing) return existing;

  await mkdir(RUN, { recursive: true });
  if (!quiet) process.stderr.write('starting render daemon (first run builds the world once)...\n');
  spawnDaemon();
  let lastSpawn = Date.now();

  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await sleep(300);
    const port = await ping();
    if (port) return port;
    // No port and nobody holds the lock: the daemon we were waiting on died,
    // so elect another. The backoff matters — for the first second or so after
    // a spawn there is legitimately no lock file yet, and re-electing on that
    // gap makes every client spawn a daemon every poll.
    if (!daemonStarting() && Date.now() - lastSpawn > RESPAWN_BACKOFF_MS) {
      spawnDaemon();
      lastSpawn = Date.now();
    }
  }
  throw new Error(`render daemon never came up — see ${LOGFILE}`);
}

function daemonFlags() {
  const f = [];
  if (process.env.SHOTD_IDLE) f.push('--idle', process.env.SHOTD_IDLE);
  if (process.env.SHOTD_WORLDS) f.push('--worlds', process.env.SHOTD_WORLDS);
  return f;
}

/** Did this fail because the daemon went away rather than because we were wrong? */
function isDaemonGone(err) {
  const m = String(err?.message ?? err);
  return /ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|other side closed|browser has been closed|Target page, context or browser has been closed/.test(
    m,
  );
}

async function call(endpoint, body, { quiet = false } = {}) {
  // The daemon is shared and long-lived, so it can legitimately restart under a
  // request — an idle shutdown racing us, another author's `stop`, a crash. That
  // is the daemon's business, not the caller's: re-acquire one and try again
  // rather than surfacing a connection error as a failed build.
  for (let attempt = 0; ; attempt++) {
    try {
      const port = await daemonPort({ quiet: quiet || attempt > 0 });
      const r = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(body ?? {}), root: ROOT }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `daemon returned ${r.status}`);
      return json;
    } catch (err) {
      if (attempt >= 2 || !isDaemonGone(err)) throw err;
      await sleep(500);
    }
  }
}

// --- argument parsing -----------------------------------------------------
const argv = process.argv.slice(2);
const flags = { out: 'shots', width: 1280, height: 720, frames: 6, shot: null };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') flags.out = argv[++i];
  else if (a === '--width') flags.width = +argv[++i];
  else if (a === '--height') flags.height = +argv[++i];
  else if (a === '--frames') flags.frames = +argv[++i];
  else if (a === '--shot') flags.shot = argv[++i];
  else if (!a.startsWith('--')) positional.push(a);
}

const SUBCOMMANDS = new Set(['eval', 'pix', 'status', 'stop', 'reload']);
const cmd = SUBCOMMANDS.has(positional[0]) ? positional.shift() : 'shot';

// --- subcommands ----------------------------------------------------------
async function runShot() {
  const report = await call('/shot', {
    shots: positional,
    out: flags.out,
    width: flags.width,
    height: flags.height,
    frames: flags.frames,
  });

  console.log(`renderer: ${report.renderer}`);
  if (report.missing?.length) {
    console.error(`unknown shots: ${report.missing.join(', ')}`);
  }
  const names = Object.keys(report.shots);
  for (const name of names) {
    const s = report.shots[name];
    console.log(
      `  ${name.padEnd(10)} ${s.tod.padEnd(10)} ${String(s.ms).padStart(7)}ms ` +
        `calls=${String(s.stats.calls).padStart(4)} tris=${String(s.stats.triangles).padStart(8)} -> ${s.file}`,
    );
  }

  if (report.errors?.length) {
    console.error(`\n${report.errors.length} page error(s):`);
    for (const e of report.errors.slice(0, 20)) console.error('  ' + e);
    process.exit(1);
  }
  console.log(`\nwrote ${names.length} shot(s) to ${report.dir}`);
}

async function runEval() {
  const file = positional[0];
  if (!file) throw new Error('usage: shot.mjs eval <probe.js> [--shot vista] [--out shots/diag]');
  const code = await readFile(path.resolve(ROOT, file), 'utf8');
  const res = await call('/eval', {
    code,
    shot: flags.shot,
    width: flags.width === 1280 ? 1920 : flags.width,
    height: flags.height === 720 ? 1080 : flags.height,
    out: flags.out === 'shots' ? 'shots/diag' : flags.out,
  });
  console.log(JSON.stringify(res.result, null, 2));
  for (const s of res.snaps) console.error('snap ->', s);
  if (res.errors?.length) {
    console.error('PAGE ERRORS:\n' + res.errors.slice(0, 10).join('\n'));
    process.exit(1);
  }
}

async function runPix() {
  const op = positional.shift();
  if (!op) throw new Error('usage: shot.mjs pix <stats|probe|crop|column> ...');
  let files = positional;
  let args = [];
  if (op === 'probe') {
    files = [positional[0]];
    args = positional.slice(1);
  } else if (op === 'crop' || op === 'column') {
    files = [positional[0]];
    args = positional.slice(1);
  }
  const res = await call('/pix', { op, files, args });
  if (res.rows) console.table(res.rows);
  else if (res.points) console.table(res.points);
  else if (res.wrote) console.log(res.wrote);
  else console.log(JSON.stringify(res, null, 2));
}

async function runReload() {
  await call('/reload', {});
  console.log('world rebuilt from source');
}

async function runStatus() {
  const port = await ping();
  if (!port) {
    console.log('render daemon: not running');
    return;
  }
  const r = await fetch(`http://127.0.0.1:${port}/status`);
  const s = await r.json();
  console.log(
    `render daemon: up  pid=${s.pid} port=${port} queued=${s.queued} busy=${s.busy} ` +
      `uptime=${s.uptimeSec}s\nrenderer: ${s.renderer ?? 'not yet probed'}\n` +
      `resident worlds: ${s.resident?.length ?? 0}/${s.maxWorlds}`,
  );
  for (const w of s.resident ?? []) console.log(`  ${w.root}  (idle ${w.idleSec}s)`);
}

async function runStop() {
  const port = await ping();
  if (!port) {
    console.log('render daemon: not running');
    return;
  }
  await fetch(`http://127.0.0.1:${port}/stop`).catch(() => {});
  console.log('render daemon: stopped');
}

const RUNNERS = { shot: runShot, eval: runEval, pix: runPix, reload: runReload, status: runStatus, stop: runStop };

RUNNERS[cmd]().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
