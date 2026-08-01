#!/usr/bin/env node
/**
 * bench.mjs — measure every dimension of the inner loop, in one command.
 *
 *   node tools/bench.mjs                 # full suite
 *   node tools/bench.mjs --quick         # skip the parallel-drain case
 *   node tools/bench.mjs --trees 7       # simulate N agents
 *
 * Runs against its own isolated daemon (SHOTD_RUN), so it never contends with
 * or evicts the one real agents are using, and appends a row to
 * `bench-history.jsonl` so a change can be judged against the last run instead
 * of a memory of the last run.
 *
 * WHY IT EXISTS. Every performance number in this project was wrong at least
 * once, and each was found by accident: a frame-time budget that timed enqueued
 * frames and reported 2.7 ms for a 40 ms frame; a screenshot path that rendered
 * 54 frames per photo; a generation cache silently gated off; a daemon whose
 * behaviour depended on which checkout happened to start it; 19 orphaned vite
 * servers. None of that survives a suite that is actually run.
 *
 * DIMENSIONS
 *   cold        world built from nothing (bundle + sim + load)
 *   warm        source edited, world rebuilt (the case agents actually hit)
 *   resident    world already loaded, nothing changed
 *   photo1      one screenshot against a resident world
 *   photo20     twenty screenshots in one invocation (marginal cost per photo)
 *   drain       N trees each asking for a batch at once — total wall clock
 *   idle        daemon at rest: process count and RSS with an empty queue
 */
import { spawn, execSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);

const RUN = path.join(tmpdir(), 'shotd-bench');
const env = { ...process.env, SHOTD_RUN: RUN };
const TREES = +val('--trees', 7);

const sh = (cmd, opts = {}) =>
  execSync(cmd, { cwd: ROOT, env, stdio: 'pipe', encoding: 'utf8', ...opts });

function timeIt(fn) {
  const t0 = Date.now();
  try {
    fn();
  } catch {
    /* a failed case still costs wall clock; report it */
  }
  return Date.now() - t0;
}

const shot = (args, cwd = ROOT) =>
  timeIt(() => sh(`node ${path.join(ROOT, 'tools/shot.mjs')} ${args}`, { cwd, timeout: 900000 }));

/** Touch a file the world does not depend on, to force a rebuild without a re-sim. */
function touch(cwd = ROOT) {
  const f = path.join(cwd, 'src/ui/index.js');
  appendFileSync(f, `\n// bench ${Date.now()}\n`);
}

/**
 * Census of OUR OWN processes only.
 *
 * The first version counted every matching process on the machine, so a run
 * alongside the real agents' daemon reported 15 "zombies" that were somebody
 * else's healthy workers. A benchmark that cannot tell its own processes from
 * the neighbours' is worse than no benchmark: it manufactures bugs.
 * Scoped by the bench daemon's pid tree.
 */
function processCensus() {
  let ours = new Set();
  try {
    const dpid = sh(`pgrep -f "shotd.mjs" | while read p; do ` +
      `if ps -o args= -p $p | grep -q "${RUN}"; then echo $p; fi; done`).trim().split(/\s+/).filter(Boolean);
    for (const p of dpid) {
      ours.add(+p);
      const kids = sh(`pgrep -P ${p} || true`).trim().split(/\s+/).filter(Boolean);
      for (const k of kids) ours.add(+k);
    }
  } catch { /* best effort */ }
  const count = (pat) => {
    try {
      const pids = sh(`pgrep -f ${JSON.stringify(pat)} || true`).trim().split(/\s+/).filter(Boolean).map(Number);
      return String(pids.filter((p) => ours.has(p)).length);
    } catch {
      return '0';
    }
  };
  let rssMB = 0;
  try {
    const list = [...ours].join(',');
    if (list) rssMB = Math.round(+sh(`ps -o rss= -p ${list} | awk '{s+=$1} END {print s+0}'`).trim() / 1024);
  } catch {
    /* best effort */
  }
  return {
    vite: +count('vite/bin/vite.js'),
    shotd: +count('shotd.mjs'),
    headless: +count('chrome-headless-shell'),
    rssMB,
  };
}

const out = { t: new Date().toISOString(), trees: TREES };

console.log('benchmarking — isolated daemon at', RUN);
sh(`node ${path.join(ROOT, 'tools/shot.mjs')} stop || true`);

// --- cold: nothing resident, no gencache ---------------------------------
sh('rm -rf node_modules/.gencache || true');
out.coldMs = shot('vista --out /tmp/bench-cold');
console.log(`  cold        ${out.coldMs} ms   (bundle + simulate + load)`);

// --- warm: source moved, sim comes from cache ----------------------------
touch();
out.warmMs = shot('vista --out /tmp/bench-warm');
console.log(`  warm        ${out.warmMs} ms   (bundle + load, sim cached)`);

// --- resident: nothing changed -------------------------------------------
out.residentMs = shot('vista --out /tmp/bench-res');
console.log(`  resident    ${out.residentMs} ms   (no rebuild at all)`);

// --- photo throughput against a resident world ---------------------------
out.photo1Ms = shot('vista --out /tmp/bench-p1');
const many = Array.from({ length: 20 }, (_, i) => ['vista', 'ridge', 'ground', 'night', 'gameplay', 'outpost', 'dawn'][i % 7]);
out.photo20Ms = shot(`${[...new Set(many)].join(' ')} --out /tmp/bench-p20`);
out.perPhotoMs = Math.round(out.photo20Ms / new Set(many).size);
console.log(`  photo1      ${out.photo1Ms} ms`);
console.log(`  photoN      ${out.photo20Ms} ms for ${new Set(many).size} shots  (${out.perPhotoMs} ms/photo)`);

// --- idle: what does the daemon cost doing nothing ------------------------
out.idle = processCensus();
console.log(`  idle        vite=${out.idle.vite} shotd=${out.idle.shotd} headless=${out.idle.headless} rss=${out.idle.rssMB}MB`);

// --- drain: N trees all asking at once ------------------------------------
if (!has('--quick')) {
  const trees = [];
  const base = mkdtempSync(path.join(tmpdir(), 'benchtree-'));
  for (let i = 0; i < TREES; i++) {
    const dir = path.join(base, `t${i}`);
    sh(`git worktree add -f --detach ${dir} HEAD`, { cwd: ROOT });
    sh(`ln -sfn ${path.join(ROOT, 'node_modules')} ${path.join(dir, 'node_modules')}`);
    trees.push(dir);
  }
  // Every tree cold at once: the exact shape of a workflow round starting.
  const t0 = Date.now();
  const kids = trees.map((d) =>
    spawn('node', [path.join(ROOT, 'tools/shot.mjs'), 'vista', 'ground', 'gameplay', '--out', '/tmp/bench-drain'], {
      cwd: d, env, stdio: 'ignore',
    }),
  );
  await Promise.all(kids.map((k) => new Promise((r) => k.on('close', r))));
  out.drainMs = Date.now() - t0;
  out.drainPerTreeMs = Math.round(out.drainMs / TREES);
  console.log(`  drain       ${out.drainMs} ms for ${TREES} trees x 3 shots  (${out.drainPerTreeMs} ms/tree)`);
  out.peak = processCensus();
  console.log(`  peak        vite=${out.peak.vite} shotd=${out.peak.shotd} headless=${out.peak.headless} rss=${out.peak.rssMB}MB`);
  for (const d of trees) sh(`git worktree remove --force ${d} || true`, { cwd: ROOT });
}

sh(`node ${path.join(ROOT, 'tools/shot.mjs')} stop || true`);
out.after = processCensus();
if (out.after.vite || out.after.headless) {
  console.log(`  ZOMBIES     vite=${out.after.vite} headless=${out.after.headless} left after stop`);
}

appendFileSync(path.join(ROOT, 'bench-history.jsonl'), JSON.stringify(out) + '\n');
console.log('\nappended to bench-history.jsonl');
