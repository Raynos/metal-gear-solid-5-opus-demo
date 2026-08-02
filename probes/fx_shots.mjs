#!/usr/bin/env node
/**
 * fx_shots.mjs — photograph the two frames a muzzle flash exists for.
 *
 * A flash lives for two frames, so no wall-clock screenshot can be relied on to
 * catch it. This stops the rAF loop, fires, steps ONE frame and captures — so
 * the picture is of a known frame index rather than of luck. Everything is an
 * A/B against the same world in the same pose: `off` is the module detached,
 * which is exactly what the build did before this round.
 *
 *   node probes/fx_shots.mjs [--out shots/fx]
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = { dir: 'shots/fx', width: 1920, height: 1080 };
for (let i = 0; i < argv.length; i++) if (argv[i] === '--out') opt.dir = argv[++i];

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
  const page = await browser.newPage({ viewport: { width: opt.width, height: opt.height }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(String(e)); console.log('pageerror:', String(e).slice(0, 300)); });
  page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text().slice(0, 300)));
  page.on('crash', () => console.log('PAGE CRASHED'));
  page.on('close', () => console.log('page closed'));
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
  const outDir = path.resolve(ROOT, opt.dir);
  await mkdir(outDir, { recursive: true });
  const shot = async (n) => {
    await writeFile(path.join(outDir, `${n}.png`), await page.screenshot({ type: 'png' }));
    console.log(`  -> ${opt.dir}/${n}.png`);
  };

  // Get into play with real input, then aim down so the round lands close.
  await page.evaluate(() => window.__GAME.setAutomation(true));
  await page.click('button.row:first-of-type', { force: true });
  await page.waitForTimeout(900);
  await page.mouse.move(960, 540);
  await page.mouse.move(960, 540);
  await page.waitForTimeout(300);
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(700);
  await page.mouse.move(960, 690, { steps: 10 });
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    const g = window.__GAME;
    const E = g.engine;
    const P = g.world.registry.player;
    window.FXS = {
      /** Freeze the loop. Everything below steps the world by hand. */
      freeze() { E.stop(); },
      step(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) { E.step(dt); E.render(); } },
      fire(withFx) {
        P.stealth.rearm();
        if (withFx) P.feedback.attach(); else P.feedback.detach();
        // Clear anything the animator is mid-way through so the two frames
        // differ ONLY by this module.
        P.player.anim.actions.cancel();
        P.stealth.fire();
      },
      reload(withAnim) {
        P.stealth.ammo = 4;
        P.stealth.reloading = 0;
        P.player.anim.actions.cancel();
        P.stealth.reload();
        if (!withAnim) P.player.anim.actions.cancel();
      },
      /** Hold the action layer down, i.e. reproduce "reload plays nothing". */
      suppressActions(on) {
        if (on) {
          if (!this._u) {
            const a = P.player.anim.actions;
            this._u = a.update.bind(a);
            a.update = (dt) => { a.cancel(); return this._u(dt); };
          }
        } else if (this._u) {
          P.player.anim.actions.update = this._u;
          this._u = null;
        }
      },
      fx() { return P.feedback.stats(); },
      /** Where on screen the muzzle and the impact ended up, so a crop is aimed. */
      where() {
        const T = g.THREE;
        const to2 = (v) => {
          const p = v.clone().project(E.camera);
          return [Math.round((p.x * 0.5 + 0.5) * innerWidth), Math.round((-p.y * 0.5 + 0.5) * innerHeight)];
        };
        const o = new T.Vector3(); const d = new T.Vector3();
        P.stealth.aimRay(o, d);
        const m = P.stealth.muzzlePoint(new T.Vector3(), d);
        const h = P.stealth._trace(o, d);
        const hand = P.player.rig.byName.get('handR').getWorldPosition(new T.Vector3());
        const f3 = (v) => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
        return {
          muzzle: to2(m), impact: h ? to2(h.point) : null, aim: +P.stealth.aimAmount.toFixed(2),
          handRel: f3(hand.clone().sub(P.position)),
          muzzleRel: f3(m.clone().sub(P.position)),
          camToMuzzle: +E.camera.position.distanceTo(m).toFixed(2),
          camToPlayer: +E.camera.position.distanceTo(P.position).toFixed(2),
        };
      },
    };
  });

  await page.evaluate(() => window.FXS.freeze());

  // --- the flash frame -----------------------------------------------------
  for (const [name, withFx] of [['off-fire', false], ['on-fire', true]]) {
    await page.evaluate((w) => { window.FXS.fire(w); window.FXS.step(1); }, withFx);
    console.log(name, JSON.stringify(await page.evaluate(() => window.FXS.fx())),
      JSON.stringify(await page.evaluate(() => window.FXS.where())));
    await shot(name);
  }


  // --- a beat later: dust, the mark and the case ---------------------------
  await page.evaluate(() => { window.FXS.fire(false); window.FXS.step(10); });
  console.log('off-impact', JSON.stringify(await page.evaluate(() => window.FXS.where())));
  await shot('off-impact');
  await page.evaluate(() => { window.FXS.fire(true); window.FXS.step(10); });
  console.log('on-impact', JSON.stringify(await page.evaluate(() => window.FXS.fx())),
    JSON.stringify(await page.evaluate(() => window.FXS.where())));
  await shot('on-impact');

  // --- reload, 0.75 s in ---------------------------------------------------
  await page.evaluate(() => { window.FXS.suppressActions(true); window.FXS.reload(false); window.FXS.step(45); });
  await shot('off-reload');
  await page.evaluate(() => { window.FXS.suppressActions(false); window.FXS.reload(true); window.FXS.step(45); });
  await shot('on-reload');

  if (errors.length) console.log('page errors:', errors.slice(0, 5));
  await cleanup(0);
}

main().catch((e) => { console.error(e); process.exit(2); });
