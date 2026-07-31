#!/usr/bin/env node
/**
 * probe-sky.mjs — isolate what is painting the sky.
 *
 * Samples sky pixels with the cloud/volumetric layers toggled, so a "the sky is
 * a grey card" complaint can be attributed to Sky.js, to the volumetrics module,
 * or to the composite grade, instead of guessed at.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = await new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore', detached: true });
for (let i = 0; i < 300; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.error('ERR', String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__GAME?.ready === true, { timeout: 150000 });

const out = await page.evaluate(() => {
  const g = window.__GAME;
  const gl = g.engine.renderer.getContext();
  const W = 960, H = 540;

  // Sample a vertical column of sky: zenith -> horizon.
  function column() {
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const x = Math.floor(W * 0.88);
    const rows = [];
    // readPixels is bottom-up: y=H-1 is the top of the image.
    for (const frac of [0.02, 0.12, 0.25, 0.4]) {
      const yImg = Math.floor(H * frac);
      const y = H - 1 - yImg;
      const i = (y * W + x) * 4;
      rows.push([+(px[i] / 255).toFixed(3), +(px[i + 1] / 255).toFixed(3), +(px[i + 2] / 255).toFixed(3)]);
    }
    return rows;
  }

  const res = {};
  const scene = g.engine.scene;
  const hidden = [];

  g.applyShot('vista');
  g.settle(4);
  res.asShipped = column();

  // Hide everything that is not the sky dome or terrain.
  scene.traverse((o) => {
    if (!o.isMesh && !o.isPoints && !o.isInstancedMesh) return;
    const isSky = o === g.world.sky.mesh;
    if (!isSky && o.visible && o.name !== 'terrain') { hidden.push(o); }
  });
  for (const o of hidden) o.visible = false;
  g.settle(4);
  res.skyDomeOnly = column();

  for (const o of hidden) o.visible = true;

  // Sky dome raw radiance, bypassing the grade: read the HDR buffer instead.
  g.applyShot('vista');
  g.settle(4);
  res.hiddenCount = hidden.length;
  res.skyUniforms = Object.fromEntries(
    Object.entries(g.world.sky.material.uniforms).map(([k, v]) => [k, v.value?.toArray ? v.value.toArray().map(n => +n.toFixed(4)) : v.value]),
  );
  return res;
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
try { process.kill(-vite.pid, 'SIGKILL'); } catch {}
