#!/usr/bin/env node
/**
 * fx_cost.mjs — what the firing feedback costs, with the camera MOVING.
 *
 * Rules taken from tools/probes/perf.js, because every one of them was learned
 * the hard way here: warm until the GPU queue is saturated before timing, time
 * a long block rather than a few frames, and DISCARD THE FIRST BLOCK — after a
 * settle the queue is empty and submission returns at command-buffer write
 * speed, which measures the driver and not the frame.
 *
 * Three conditions, same world, same camera path:
 *   off      the module detached — exactly what the build did before this round
 *   idle     attached, nothing alive: the "do I pay for this while sneaking" case
 *   firing   a round every 10 frames, so the flash light is lit on ~20% of
 *            frames and every pool is full. This is the worst case that can
 *            occur, and it occurs while the weapon is being emptied.
 *
 *   node probes/fx_cost.mjs
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

function bundle() {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'warn'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
  } catch (err) {
    console.error(`build failed:\n${`${err.stdout ?? ''}${err.stderr ?? ''}`.trim().slice(0, 3000)}`);
    process.exit(3);
  }
}

async function serve() {
  const port = await freePort();
  const proc = spawn(process.execPath,
    [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return { proc, port }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('preview server failed to start');
}

async function main() {
  bundle();
  const server = await serve();
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--force-device-scale-factor=1', '--hide-scrollbars'],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const cleanup = async (code) => {
    const pid = browser.process?.()?.pid;
    await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
    for (const p of [pid, server.proc.pid]) {
      if (!p) continue;
      try { process.kill(-p, 'SIGKILL'); } catch { /* gone */ }
      try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
    }
    process.exit(code);
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => cleanup(130));

  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__GAME?.ready === true, { timeout: 180000 });

  // Real input, so the AudioContext arms: the audio bus is part of what this
  // round added and measuring the frame with it silent would flatter it.
  await page.evaluate(() => window.__GAME.setAutomation(true));
  await page.click('button.row:first-of-type', { force: true });
  await page.waitForTimeout(1000);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(500);
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(900);

  const out = await page.evaluate(async () => {
    const g = window.__GAME;
    const E = g.engine;
    const gl = E.renderer.getContext();
    const P = E && window.__GAME.world.registry.player;
    E.stop();

    const BLOCK = 60;
    /** Time `BLOCK` frames of a moving camera. Returns ms/frame. */
    function block(mutate) {
      for (let i = 0; i < BLOCK; i++) { mutate(i); E.step(1 / 60); E.render(); }
      gl.finish();
      const t0 = performance.now();
      for (let i = 0; i < BLOCK; i++) { mutate(i); E.step(1 / 60); E.render(); }
      gl.finish();
      return (performance.now() - t0) / BLOCK;
    }

    // The camera path: turning while walking, which is what invalidates the TAA
    // history and refits the shadow cascades. A parked camera measures nothing.
    const move = () => { P.camera.addLook(0.010, 0); };

    // INTERLEAVED, not one condition after another. Measured the naive way —
    // three blocks of `off`, then three of `idle`, then three of `firing` — the
    // numbers came out 95.3 / 62.2 / 53.1 ms, i.e. the module APPEARED to make
    // the frame 42 ms faster. That is the world still warming across the first
    // condition, and it is larger than anything being measured. Round-robin, so
    // any drift lands on all three equally, and drop the first round.
    const conditions = {
      off: (i) => { move(i); },
      idle: (i) => { move(i); },
      firing: (i) => {
        move(i);
        if (i % 10 === 0) { P.stealth.ammo = 20; P.stealth._fireCooldown = 0; P.stealth.fire(); }
      },
    };
    const set = (name) => {
      if (name === 'off') P.feedback.detach();
      else P.feedback.attach();
    };

    const samples = { off: [], idle: [], firing: [] };
    const draws = { off: 0, idle: 0, firing: 0 };
    const tris = { off: 0, idle: 0, firing: 0 };
    const ROUNDS = 9;
    let peak = null;
    for (let r = 0; r < ROUNDS; r++) {
      for (const name of ['off', 'idle', 'firing']) {
        set(name);
        const ms = block(conditions[name]);
        if (r > 0) samples[name].push(+ms.toFixed(2));   // round 0 discarded
        // Draw calls and triangles are DETERMINISTIC — they do not care what
        // else the machine is doing, which on a box at load 43 makes them the
        // only numbers here that mean anything on their own.
        draws[name] = Math.max(draws[name], E.pipeline?.sceneStats?.calls ?? E.renderer.info.render.calls);
        tris[name] = Math.max(tris[name], E.pipeline?.sceneStats?.triangles ?? E.renderer.info.render.triangles);
        if (name === 'firing') peak = P.feedback.stats();
      }
    }
    const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const res = {};
    for (const name of ['off', 'idle', 'firing']) {
      res[name] = {
        median: +med(samples[name]).toFixed(2),
        mean: +(samples[name].reduce((x, y) => x + y) / samples[name].length).toFixed(2),
        min: +Math.min(...samples[name]).toFixed(2),
        blocks: samples[name],
      };
    }

    P.feedback.detach();
    return { res, peakPools: peak, draws, tris, audio: window.__AUDIO?.stats?.() ?? null };
  });

  const r = out.res;
  console.log(JSON.stringify(out, null, 2));
  console.log('\n--- cost of the firing feedback, camera moving, round-robin, first round discarded ---');
  for (const k of ['off', 'idle', 'firing']) {
    const b = r[k].blocks;
    console.log(`${k.padEnd(8)} min ${r[k].min.toFixed(2)} ms  median ${r[k].median.toFixed(2)}  spread ${(Math.max(...b) - Math.min(...b)).toFixed(2)}  draws ${out.draws[k]}  tris ${out.tris[k]}`);
  }
  console.log(`\nmin(idle)   - min(off) = ${(r.idle.min - r.off.min).toFixed(2)} ms`);
  console.log(`min(firing) - min(off) = ${(r.firing.min - r.off.min).toFixed(2)} ms   (a round every 10 frames)`);
  console.log(`extra draw calls: idle +${out.draws.idle - out.draws.off}, firing +${out.draws.firing - out.draws.off}`);
  console.log('NOTE: min-of-8-blocks is the statistic to read on a shared machine. If the');
  console.log('per-condition spread above is larger than the delta, the delta is below noise.');
  await cleanup(0);
}

main().catch((e) => { console.error(e); process.exit(2); });
