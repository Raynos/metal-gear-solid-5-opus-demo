#!/usr/bin/env node
/**
 * gp_playshot.mjs — full-page screenshots of PLAY MODE.
 *
 * `tools/render.mjs` only knows how to pose the canonical shots, which all live
 * in godmode; there is no way to photograph the game as it is actually played,
 * and a DOM overlay (the HUD, and now the reticle) does not appear in a canvas
 * capture at all. This boots the same page the same way and drives real input
 * before each capture, so what lands on disk is the frame a player sees.
 *
 *   node probes/gp_playshot.mjs [--out shots/play] [--width 1920] [--height 1080]
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = { dir: 'shots/play', width: 1920, height: 1080 };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') opt.dir = argv[++i];
  else if (argv[i] === '--width') opt.width = +argv[++i];
  else if (argv[i] === '--height') opt.height = +argv[++i];
}

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

/**
 * The poses, each driven with TRUSTED input — Playwright's own keyboard and
 * mouse, not synthetic KeyboardEvents. That distinction is not pedantry: an
 * untrusted mousedown cannot take pointer lock, and src/core/Input.js ignores
 * mouse LOOK until it has the lock, so a synthetic right-click aims the weapon
 * without ever moving the camera and the frame is a lie.
 *
 * `place` runs in the page (teleport only); `drive` is real input over real
 * time, because the engine's own rAF loop is what is running.
 */
const POSES = [
  { name: 'spawn', place: 'S.play()', drive: async (p) => p.waitForTimeout(700) },
  { name: 'approach', place: 'S.play(); S.at(0.40)', drive: async (p) => { await p.keyboard.down('w'); await p.waitForTimeout(1400); await p.keyboard.up('w'); await p.waitForTimeout(120); } },
  { name: 'sprint', place: 'S.play(); S.at(0.55)', drive: async (p) => { await p.keyboard.down('Shift'); await p.keyboard.down('w'); await p.waitForTimeout(1700); await p.keyboard.up('w'); await p.keyboard.up('Shift'); await p.waitForTimeout(80); } },
  { name: 'aim', place: 'S.play(); S.at(0.74)', drive: async (p) => { await p.mouse.click(960, 540); await p.waitForTimeout(150); await p.mouse.down({ button: 'right' }); await p.waitForTimeout(900); } },
  { name: 'crouch-aim', place: 'S.play(); S.at(0.88)', drive: async (p) => { await p.mouse.click(960, 540); await p.keyboard.press('c'); await p.waitForTimeout(600); await p.mouse.down({ button: 'right' }); await p.waitForTimeout(900); } },
  { name: 'wall', place: 'S.play(); S.atWall()', drive: async (p) => { await p.keyboard.down('w'); await p.waitForTimeout(2200); await p.keyboard.up('w'); await p.waitForTimeout(120); } },
  { name: 'hurt', place: 'S.play(); S.at(0.88)', drive: async (p) => { await p.waitForTimeout(300); await p.evaluate(() => window.S.hurt(0.62)); await p.waitForTimeout(220); } },
  { name: 'failed', place: 'S.play(); S.at(0.82)', drive: async (p) => { await p.evaluate(() => window.S.hurt(1.2)); await p.waitForTimeout(1400); } },
  { name: 'accomplished', place: 'S.play(); S.at(0.55)', drive: async (p) => { await p.evaluate(() => window.S.win()); await p.waitForTimeout(1400); } },
];

async function main() {
  bundle();
  const server = await serve();
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--force-device-scale-factor=1', '--mute-audio', '--hide-scrollbars'],
  });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: opt.width, height: opt.height }, deviceScaleFactor: 1 });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  const cleanup = async (code) => {
    const pid = browser.process?.()?.pid;
    await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
    for (const p of [pid, server.proc.pid]) {
      if (!p) continue;
      try { process.kill(-p, 'SIGKILL'); } catch {}
      try { process.kill(p, 'SIGKILL'); } catch {}
    }
    process.exit(code);
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => cleanup(130));

  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__GAME?.ready === true, { timeout: 180000 });

  // The page-side driver.
  await page.evaluate(() => {
    const g = window.__GAME;
    const W = g.world;
    const eng = W.engine;
    const gp = W.registry.gameplay ?? W.registry.player;
    const site = W.registry.outpost.bounds.getCenter(new g.THREE.Vector3());
    const key = (c, d) => window.dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { code: c, bubbles: true }));
    window.S = {
      play() {
        W.gameState.setMode('godmode');
        W.gameState.setMode('play');
        gp.vitals.reset();
        eng.step(1 / 60);
      },
      settle(n) { for (let i = 0; i < n; i++) { eng.step(1 / 60); eng.render(); } },
      /** Put the player t of the way from the spawn to the compound. */
      at(t) {
        const s = gp.spawnPoint;
        const hAt = (a, b) => W.registry.characters.ground.heightAt(a, b);
        let x = s.x + (site.x - s.x) * t;
        let z = s.z + (site.z - s.z) * t;
        // Teleporting is not walking: the straight line to the compound goes
        // through buildings, and a camera correctly rendering the inside of a
        // hangar the player was dropped into is not a camera bug. Nudge to
        // somewhere he could actually be standing.
        for (let r = 0; r <= 14 && gp.obstacles.maxIn(x, z, 0.9) > hAt(x, z) + 0.45; r += 1.5) {
          for (let k = 0; k < 12; k++) {
            const a = (k / 12) * Math.PI * 2;
            const px = x + Math.cos(a) * r;
            const pz = z + Math.sin(a) * r;
            if (gp.obstacles.maxIn(px, pz, 0.9) <= hAt(px, pz) + 0.45) { x = px; z = pz; r = 99; break; }
          }
        }
        const c = gp.controller;
        const y = hAt(x, z);
        c.position.set(x, y, z);
        c.footY = y;
        c.velocity.set(0, 0, 0);
        c.yaw = Math.atan2(-(site.x - x), -(site.z - z));
        gp.camera.reset(c.position, c.yaw);
        this.settle(4);
      },
      /** Stand him against the nearest wall, facing it. */
      atWall() {
        const obs = gp.obstacles;
        const hAt = (x, z) => W.registry.characters.ground.heightAt(x, z);
        for (let a = 0; a < 96; a++) {
          const th = (a / 96) * Math.PI * 2;
          for (let r = 18; r < 62; r += 0.4) {
            const x = site.x + Math.sin(th) * r;
            const z = site.z + Math.cos(th) * r;
            if (obs.maxIn(x, z, 0.4) > hAt(x, z) + 1.4) {
              const sx = site.x + Math.sin(th) * (r + 2.4);
              const sz = site.z + Math.cos(th) * (r + 2.4);
              const c = gp.controller;
              c.position.set(sx, hAt(sx, sz), sz);
              c.footY = c.position.y;
              c.velocity.set(0, 0, 0);
              c.yaw = Math.atan2(-(x - sx), -(z - sz)) + 0.4;
              gp.camera.reset(c.position, c.yaw);
              this.settle(4);
              return;
            }
          }
        }
      },
      hurt(a) { gp.vitals.damage(a, gp.controller.position.clone().add(new g.THREE.Vector3(6, 0, 6))); },
      win() { gp.endMission('accomplished', 'commander'); },
      locked() { return !!gp.input.pointerLocked; },
    };
  });

  const outDir = path.resolve(ROOT, opt.dir);
  await mkdir(outDir, { recursive: true });
  for (const { name, place, drive } of POSES) {
    // Let go of anything the last pose was holding, then park and drive.
    await page.mouse.up({ button: 'right' }).catch(() => {});
    await page.evaluate(`(function(){ const S = window.S; ${place}; })()`);
    // Entering play triggers the UI's mission card, which is an opaque plate
    // for 0.2 + 2.4 + 0.85 s. Wait it out or every frame here is black type on
    // black — which is exactly what the first run of this script produced.
    await page.waitForTimeout(3700);
    await drive(page);
    const info = await page.evaluate(() => {
      const gp = window.__GAME.world.registry.gameplay ?? window.__GAME.world.registry.player;
      const r = document.querySelector('.gp-ret');
      const st = r ? getComputedStyle(r) : null;
      return {
        pos: [+gp.position.x.toFixed(1), +gp.position.z.toFixed(1)],
        stance: gp.stance,
        health: +gp.health.toFixed(2),
        ammo: `${gp.weapon.ammo}/${gp.weapon.reserve}`,
        alert: window.__GAME.world.registry.ai?.alertLevel,
        aiming: gp.isAiming,
        locked: window.S.locked(),
        speed: +gp.speed.toFixed(2),
        reticle: r ? { opacity: st.opacity, transform: st.transform, range: r.querySelector('u').textContent } : null,
      };
    });
    await writeFile(path.join(outDir, `${name}.png`), await page.screenshot({ type: 'png' }));
    console.log(`${name.padEnd(12)} ${JSON.stringify(info)}`);
  }
  if (errors.length) {
    console.error(`\n${errors.length} page error(s):`);
    for (const e of errors.slice(0, 10)) console.error('  ' + e);
  }
  await cleanup(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
