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
 * `status`, `stop` and `reload` are accepted and ignored: there is nothing to
 * manage now.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

if (['status', 'stop', 'reload'].includes(argv[0])) {
  console.log(`render daemon: retired — each invocation now owns its own browser (see tools/render.mjs)`);
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
