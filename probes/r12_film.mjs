#!/usr/bin/env node
/**
 * r12_film.mjs — film the aim raise, the shot and the recoil settle.
 *
 * AIM FEEL IS TEMPORAL. Every number in probes/r12_aim.js is a still: it can
 * say the reticle is 79 px off centre but not that it SLIDES there as the range
 * under it changes, and it can say the kick peaks at 0.9 degrees but not
 * whether that reads as a weapon or as a camera being nudged. `tools/render.mjs
 * film` cannot help — it films the canonical godmode shots, where there is no
 * player, no weapon and no reticle (the reticle is DOM, and it is suppressed
 * whenever `engine.deterministic` is set, which the harness always sets).
 *
 * So: same page, same headless launch, same process-tree cleanup as
 * gp_playshot.mjs, but the engine's own loop is stopped and each PNG is a known
 * number of simulation frames after the last one. `deterministic` is left FALSE
 * on purpose — it is what hides the reticle, and the reticle is the subject.
 *
 *   node probes/r12_film.mjs [--out shots/r12] [--legacy]
 *
 * `--legacy` monkey-patches Stealth.aimRay back to the shipped formula (eye
 * origin, camera forward, world-space sway, no convergence) so the same pose
 * can be filmed twice and the two strips laid side by side. Nothing else
 * changes, which is the only way to be sure the difference is the aim solve.
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = { dir: 'shots/r12', width: 1920, height: 1080, legacy: false };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') opt.dir = argv[++i];
  else if (argv[i] === '--width') opt.width = +argv[++i];
  else if (argv[i] === '--height') opt.height = +argv[++i];
  else if (argv[i] === '--legacy') opt.legacy = true;
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
  await page.evaluate(() => {
    document.getElementById('controls-card')?.remove();
    document.getElementById('boot')?.remove();
  });

  await page.evaluate((legacy) => {
    const g = window.__GAME;
    const THREE = g.THREE;
    const W = g.world;
    const eng = W.engine;
    const gp = W.registry.gameplay ?? W.registry.player;
    const st = gp.stealth;

    // STOP THE CLOCK FIRST. The engine's own rAF loop runs from page load, so
    // how many frames the garrison has walked by the time setup() is called is
    // a function of wall time — and the first before/after pair filmed two
    // DIFFERENT guards at two different bearings, which is not an A/B. From
    // here on every frame in this script is stepped by hand.
    eng.stop();

    // Applied AFTER setup, deliberately: the pose search accepts a candidate
    // only when the dart actually reaches the target, and running that search
    // under the broken solve would pick a different pose — which is the one
    // thing a before/after strip must not do.
    window.__GO_LEGACY = () => {
      if (!st._lookDir) return false;
      // The shipped formula, verbatim from the commit before this branch.
      st.aimRay = function aimRay(outOrigin, outDir) {
        const p = this.ctl.position;
        const eye = p.y + (this.ctl.stance === 'prone' ? 0.32 : this.ctl.stance === 'crouch' ? 1.10 : 1.42);
        this.cam.forward(outDir);
        const steady = this.holdingBreath ? 0.22 : 1;
        const amp = (this.ctl.stance === 'prone' ? 0.0035 : this.ctl.stance === 'crouch' ? 0.006 : 0.0105)
          * steady * (0.6 + 0.4 * (1 - this.breath));
        const sx = (Math.sin(this._swayT * 1.7) + 0.6 * Math.sin(this._swayT * 0.61 + 1.3)) * amp;
        const sy = (Math.sin(this._swayT * 1.31 + 2.1) + 0.5 * Math.sin(this._swayT * 0.83)) * amp;
        this.aimSway.set(sx, sy);
        outDir.x += sx;
        outDir.y += sy;
        outDir.normalize();
        outOrigin.set(p.x, eye, p.z).addScaledVector(outDir, 0.35);
        return outDir;
      };
      st._solveConverge = () => {};
      // The reticle followed the traced IMPACT before this branch; dropping
      // `sightPoint` makes Reticle.js fall back to exactly that path, so the
      // control is the whole old sight and not half of it.
      st.sightPoint = undefined;
      st._predict = function _predict(dt) {
        if (this.aimAmount < 0.05) { this.aimHit = null; return; }
        this._predictT -= dt;
        if (this._predictT > 0) return;
        this._predictT = 0.05;          // the shipped 20 Hz throttle
        const org = this._ao;
        const dir = this._ad;
        this.aimRay(org, dir);
        const hit = this._trace(org, dir);
        this.aimHit = hit ? {
          character: hit.character ?? null,
          point: hit.point,
          dist: Math.hypot(hit.point.x - org.x, hit.point.y - org.y, hit.point.z - org.z),
        } : null;
      };
      return true;
    };
    void legacy;

    const key = (c, d) => window.dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { code: c, bubbles: true }));
    window.F = {
      key,
      /** Advance n simulation frames and present one. */
      tick(n) { for (let i = 0; i < n; i++) { eng.step(1 / 60); eng.render(); } },
      /**
       * Stand him a fixed distance behind a guard, weapon down, camera on the
       * guard's chest. `controlled` freezes the guard: a sentry who walks out
       * of frame between the aim raise and the shot makes the strip unreadable.
       */
      /**
       * A CLEAR FIRING LINE, chosen by trying candidates rather than assumed.
       *
       * The first version stood the player a fixed distance behind the first
       * live guard, and the compound put a wall between them: the round hit
       * that wall at 9.3 m, and the whole strip photographed a man shooting
       * masonry. `probes/r12_jump.js` established that both the look march and
       * the ballistic trace were right and the POSE was wrong, which is the
       * kind of mistake that gets written up as an engine defect. Accept a
       * candidate only when the dart's own trace comes back with the target.
       */
      setup(range) {
        W.gameState.setMode('godmode');
        W.gameState.setMode('play');
        gp.vitals.reset();
        const gnd = W.registry.characters.ground;
        const c = gp.controller;
        const aim = (target) => {
          for (let i = 0; i < 24; i++) {
            const w = target.clone().sub(eng.camera.position).normalize();
            const have = gp.camera.forward(new THREE.Vector3());
            gp.camera.pitch += Math.asin(THREE.MathUtils.clamp(w.y, -1, 1))
              - Math.asin(THREE.MathUtils.clamp(have.y, -1, 1));
            const wy = Math.atan2(-w.x, -w.z);
            gp.camera.yaw += Math.atan2(Math.sin(wy - gp.camera.yaw), Math.cos(wy - gp.camera.yaw));
            this.tick(1);
          }
        };
        for (const q of W.registry.ai.guards) {
          if (q.down) continue;
          const v = q.ch;
          v.controlled = true;
          v.anim.speed = 0;
          for (const bearing of [0, 0.9, -0.9, 2.0, -2.0, Math.PI]) {
            const yaw = v.yaw + bearing;
            const x = v.position.x + Math.sin(yaw) * range;
            const z = v.position.z + Math.cos(yaw) * range;
            c.position.set(x, gnd.heightAt(x, z), z);
            c.footY = c.position.y;
            c.velocity.set(0, 0, 0);
            c.yaw = yaw + Math.PI;
            gp.camera.reset(c.position, c.yaw);
            this.tick(20);
            const target = new THREE.Vector3(v.position.x, (v.groundY ?? 0) + 1.25, v.position.z);
            aim(target);
            const o = new THREE.Vector3();
            const d = new THREE.Vector3();
            st.aimRay(o, d);
            const h = st._trace(o, d);
            if (h?.character === v) {
              window.__VICTIM = v;
              window.__TARGET = target;
              return { name: v.name, range: +eng.camera.position.distanceTo(target).toFixed(2), bearing: +bearing.toFixed(2) };
            }
          }
        }
        return { name: 'NONE — no clear firing line found', range: 0 };
      },
      /** Where the reticle is, in px from the centre of the frame. */
      ret() {
        const el = document.querySelector('.gp-ret');
        const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(el?.style.transform || '');
        if (!m || el.style.opacity === '0') return null;
        return [Math.round(+m[1] - window.innerWidth / 2), Math.round(+m[2] - window.innerHeight / 2)];
      },
      state() {
        return {
          ret: this.ret(),
          kick: +(gp.camera._kick * 180 / Math.PI).toFixed(2),
          kickYaw: +((gp.camera._kickYaw ?? 0) * 180 / Math.PI).toFixed(2),
          fov: +eng.camera.fov.toFixed(1),
          aim: +st.aimAmount.toFixed(2),
          ammo: st.ammo,
          down: !!window.__VICTIM?.downed,
        };
      },
    };
  }, opt.legacy);

  const info = await page.evaluate((r) => window.F.setup(r), 16);
  // WAIT OUT THE BRIEFING CARD. Entering play mode raises the UI's mission
  // plate, which is opaque for 0.2 + 2.4 + 0.85 s of WALL time — and stopping
  // the engine loop does not stop a CSS transition. The first strip filmed
  // through it: 29 PNGs of black with the word OUTPOST on them, while every
  // number printed beside them was correct, which is exactly the sort of pair
  // that gets a working build called broken.
  await page.waitForTimeout(4200);
  await page.evaluate(() => window.F.tick(1));
  if (opt.legacy) {
    const ok = await page.evaluate(() => window.__GO_LEGACY());
    if (!ok) { console.error('--legacy: this build has no convergence to remove'); await cleanup(2); }
    await page.evaluate(() => window.F.tick(4));
  }
  const outDir = path.resolve(ROOT, opt.dir);
  await mkdir(outDir, { recursive: true });

  // The strip. Each entry is (label, sim frames to advance before the shot).
  const strip = [];
  const shoot = async (tag, advance, before) => {
    if (before) await page.evaluate(before);
    if (advance) await page.evaluate((n) => window.F.tick(n), advance);
    const s = await page.evaluate(() => window.F.state());
    const file = path.join(outDir, `${String(strip.length).padStart(2, '0')}-${tag}.png`);
    await writeFile(file, await page.screenshot({ type: 'png' }));
    strip.push({ tag, ...s });
  };

  await shoot('hip', 0);
  await shoot('hip2', 6);
  // The aim raise, one simulation frame per photograph.
  await page.evaluate(() => window.F.key('KeyE', true));
  for (let i = 1; i <= 8; i++) await shoot(`ads-f${String(i * 2).padStart(2, '0')}`, 2);
  await shoot('ads-settled', 24);
  // One round, then the settle at one frame per photograph.
  await page.evaluate(() => { window.F.key('Space', true); });
  await shoot('fire-f01', 1);
  await page.evaluate(() => { window.F.key('Space', false); });
  for (let i = 2; i <= 10; i++) await shoot(`kick-f${String(i).padStart(2, '0')}`, 1);
  await shoot('kick-settled', 20);
  // A burst on AUTO: the only place the bloom and the climbing kick show.
  await page.evaluate(() => {
    const gp = window.__GAME.world.registry.gameplay ?? window.__GAME.world.registry.player;
    gp.stealth.rearm();
    gp.stealth.fireMode = 'AUTO';
    window.F.key('Space', true);
  });
  for (let i = 1; i <= 6; i++) await shoot(`auto-f${String(i * 4).padStart(2, '0')}`, 4);
  await page.evaluate(() => window.F.key('Space', false));
  await shoot('auto-recover', 30);

  console.log(`${opt.legacy ? 'LEGACY (pre-fix aim solve)' : 'current build'} — target ${info.name} at ${info.range} m`);
  console.log('frame                 reticle px from centre   kick deg   fov   aim  ammo  target down');
  for (const s of strip) {
    console.log(
      `${s.tag.padEnd(16)} ${String(s.ret ? `(${s.ret[0]}, ${s.ret[1]})` : 'hidden').padStart(16)}   `
      + `${String(s.kick).padStart(5)}/${String(s.kickYaw).padStart(5)}  ${String(s.fov).padStart(4)}  `
      + `${String(s.aim).padStart(4)}  ${String(s.ammo).padStart(4)}   ${s.down}`,
    );
  }
  console.log(`\n${strip.length} frames -> ${path.relative(ROOT, outDir)}`);
  if (errors.length) {
    console.error('\npage errors:');
    for (const e of errors.slice(0, 10)) console.error('  ' + e);
  }
  await cleanup(errors.length ? 1 : 0);
}

main();
