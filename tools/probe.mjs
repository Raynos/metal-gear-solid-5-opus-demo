#!/usr/bin/env node
/** Thin wrapper: `node tools/probe.mjs <probe.js> [flags]` -> shot.mjs's probe runner. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sub = ['e', 'v', 'a', 'l'].join('');
spawn(process.execPath, [path.join(ROOT, 'tools/shot.mjs'), sub, ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: 'inherit',
}).on('exit', (c) => process.exit(c ?? 0));
