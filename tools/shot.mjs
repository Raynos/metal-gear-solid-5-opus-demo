#!/usr/bin/env node
/**
 * shot.mjs — compatibility shim. The real implementation is render.mjs.
 *
 * Every agent, script and doc in this repo says `node tools/shot.mjs ...`, so
 * that CLI stays. What changed is what is behind it: the shared render daemon
 * is gone. It existed to keep worlds warm, and both halves of that premise
 * failed — the expensive part (an 11.6 s terrain sim) is now baked, and agents
 * edit constantly so 40% of requests rebuilt anyway.
 *
 * Measured, seven trees rendering three shots each:
 *   daemon        p50 wait 302 s, 29 errors against 9 completions, queue 20 deep
 *   private       21.4 s total for all 21 screenshots, zero errors, no leftovers
 *
 * `stop` and `reload` are accepted and ignored: there is nothing to manage now.
 *
 * `status` still answers a live question, and it is load-bearing.
 * tools/probes/README.md tells you to check it before trusting a frame time —
 * "if the queue is more than one or two, your frame times are somebody else's
 * load". There is no queue any more, but the contention it was guarding against
 * is real and got WORSE, because every invocation now owns a browser instead of
 * sharing one. So `status` reports the contention directly: how many headless
 * chromiums are on this machine right now, and what the load average is. That
 * is the number the perf probe's validity gate actually needs.
 */
import { spawn, execFileSync } from 'node:child_process';
import { loadavg, cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

if (['stop', 'reload'].includes(argv[0])) {
  console.log(`render daemon: retired — each invocation now owns its own browser (see tools/render.mjs)`);
  process.exit(0);
}

if (argv[0] === 'status') {
  const sh = (cmd) => {
    try {
      return execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };
  // Count the process TREES, not the processes: one headless chromium is a
  // zygote plus a GPU process plus renderers, so a raw pgrep count reads ~4x
  // the number of browsers and makes an idle machine look contended.
  const heads = sh(`pgrep -f chrome-headless-shell | wc -l`) || '0';
  const browsers = sh(`pgrep -f 'chrome-headless-shell --type=$' | wc -l`);
  const vite = sh(`pgrep -f 'vite' | wc -l`) || '0';
  const [m1] = loadavg();
  const n = cpus().length;
  // Whose are they? A process under another author's worktree is not a leak,
  // and CLAUDE.md is explicit that killing it is the worst thing you can do.
  // The bracket around the first letter is the classic ps|grep trick: this
  // command's OWN argv contains the pattern, and without it the grep matches
  // itself and reports a worktree called "[^".
  const trees = sh(
    `ps -A -o args= | grep -E '[c]hrome-headless-shell|[v]ite' ` +
      `| grep -o '\\.claude/worktrees/[^/]*' | sort -u | head -10`,
  );
  const busy = Number(heads) > 4 || m1 > n * 0.7;
  console.log(`render daemon: retired — each invocation owns its own browser (tools/render.mjs)`);
  console.log(`headless chromium procs : ${heads.trim()}${browsers ? ` (~${browsers.trim()} browsers)` : ''}`);
  console.log(`vite procs              : ${vite.trim()}`);
  console.log(`load average (1m)       : ${m1.toFixed(2)} over ${n} cores`);
  if (trees) console.log(`other worktrees running : ${trees.split('\n').join(', ')}`);
  console.log(
    busy
      ? `VERDICT: CONTENDED — a frame time measured now is somebody else's load. Wait.`
      : `VERDICT: quiet — safe to measure.`,
  );
  process.exit(0);
}

// `pix` used to be a daemon subcommand; it is a pure image tool.
const target = argv[0] === 'pix'
  ? path.join(HERE, 'reference/imagestats.py')
  : path.join(HERE, 'render.mjs');

if (argv[0] === 'pix') {
  const p = spawn('python3', [target, ...argv.slice(1)], { stdio: 'inherit' });
  p.on('close', (c) => process.exit(c ?? 0));
} else {
  const p = spawn(process.execPath, [target, ...argv], { stdio: 'inherit' });
  p.on('close', (c) => process.exit(c ?? 0));
}
