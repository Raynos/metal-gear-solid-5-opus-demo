#!/usr/bin/env node
/**
 * shotd-client — talk to the ONE render daemon. Never start one.
 *
 * THE RULE THAT MATTERS: a client does not spawn a daemon. It connects, or it
 * tells you how to start one, and stops.
 *
 * Silent spawning is what destroyed the previous daemon. Whichever checkout ran
 * a client first became the daemon's CODE, and six of seven worktrees carried
 * stale copies — so a concurrency fix, a resident-world cap fix and an entire
 * metrics layer were silently not running for hours while the logs looked fine.
 * It was only found by printing the daemon's own argv.
 *
 * The daemon lives in the MAIN tree, in a herdr pane, where it is visible and
 * ownable. If it is not running, that is a thing a human should see and decide
 * about, not something a background agent papers over by starting its own.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const RUN = process.env.SHOTD_RUN
  ? path.resolve(process.env.SHOTD_RUN)
  : path.join(os.homedir(), '.cache', 'shotd');

function daemonPort() {
  try {
    return +readFileSync(path.join(RUN, 'port'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Hash of the shotd.mjs THIS tree would run, to compare against the live one. */
function localHash(root) {
  try {
    const src = readFileSync(path.join(root, 'tools/shotd.mjs'));
    return createHash('sha1').update(src).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

export async function connect({ root, quiet = false } = {}) {
  const port = daemonPort();
  if (!port) {
    if (!quiet) {
      console.error(
        'No render daemon.\n' +
        '  Start it in its own herdr pane, from the MAIN tree, and leave it there:\n' +
        '    node tools/shotd.mjs --idle 600\n' +
        '  It exits on its own after 10 minutes idle, so it costs nothing when unused.',
      );
    }
    return null;
  }

  let status;
  try {
    status = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
  } catch {
    if (!quiet) console.error(`Daemon port ${port} is stale — nothing is listening. Restart it in its pane.`);
    return null;
  }

  // Version handshake. A mismatch means the running daemon is not the code this
  // tree expects, which is exactly the failure that went unnoticed for hours.
  const mine = localHash(root);
  if (mine && status.sourceHash && mine !== status.sourceHash) {
    console.error(
      `Render daemon is running DIFFERENT code than this tree expects.\n` +
      `  daemon: ${status.sourceHash}  (from ${status.homeTree})\n` +
      `  here:   ${mine}\n` +
      `  Restart the daemon in its pane so it picks up the current main.`,
    );
    return null;
  }
  return { port, status };
}

export { daemonPort, localHash };
