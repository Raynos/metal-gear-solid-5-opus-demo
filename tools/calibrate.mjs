#!/usr/bin/env node
/**
 * calibrate.mjs — sweep lighting/exposure parameters inside ONE browser session
 * and report the luminance response of each combination.
 *
 *   node tools/calibrate.mjs
 *
 * Why this exists: eyeballing PNGs to answer "is this exposed correctly" costs a
 * full 60s harness round-trip per guess. This runs ~50 combinations in seconds
 * and prints mean luminance + % of clipped pixels, so exposure is set from data.
 *
 * Target for a sunlit desert daylight shot (matching how MGSV actually sits on
 * a scope): mean luminance 0.42-0.55, clipped < 0.6%, with a broad midtone
 * histogram rather than a spike at either end.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

async function startVite(port) {
  const proc = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: 'ignore', detached: true },
  );
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return proc;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('vite did not start');
}

const port = await freePort();
const vite = await startVite(port);
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.error('PAGE ERROR', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__GAME?.ready === true, { timeout: 120000 });

const SHOT = process.argv[2] || 'vista';

const results = await page.evaluate(
  async ({ shot }) => {
    const g = window.__GAME;
    const { lighting, engine } = g.world;
    const out = [];
    const skySet = [0.002, 0.004, 0.0075];
    const sunSet = [2.0, 3.5, 5.0];
    const envSet = [0.4, 0.8, 1.2];
    const hemiSet = [0.0, 0.35];
    const expSet = [0.7, 1.0];
    for (const skyE of skySet) {
      for (const sun of sunSet) {
        for (const env of envSet) {
          for (const hemi of hemiSet) {
            for (const exp of expSet) {
              g.applyShot(shot);
              g.world.sky.material.uniforms.uSkyExposure.value = skyE;
              lighting._envDirty = true;
              lighting.sun.intensity = sun;
              lighting.hemi.intensity = hemi;
              engine.pipeline.exposure = exp;
              g.settle(2);
              engine.scene.environmentIntensity = env;
              g.settle(1);
              const p = g.probeLuminance();
              out.push({ skyE, sun, env, hemi, exp, mean: p.mean, clipped: p.clippedPct });
            }
          }
        }
      }
    }
    return out;
  },
  { shot: SHOT },
);

results.sort((a, b) => Math.abs(a.mean - 0.48) - Math.abs(b.mean - 0.48));
console.log(`shot=${SHOT}  (sorted by closeness to target mean 0.48)\n`);
console.log('  skyE     sun   env   hemi  exp   mean    clipped%');
for (const r of results.slice(0, 20)) {
  console.log(
    `  ${String(r.skyE).padStart(6)}  ${String(r.sun).padStart(4)}  ${String(r.env).padStart(4)}  ${String(r.hemi).padStart(4)}  ` +
      `${String(r.exp).padStart(4)}  ${String(r.mean).padStart(6)}  ${String(r.clipped).padStart(7)}`,
  );
}

await browser.close();
try { process.kill(-vite.pid, 'SIGKILL'); } catch {}
