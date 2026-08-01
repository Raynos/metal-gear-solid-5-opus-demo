#!/usr/bin/env node
/**
 * Character preview harness (dev tool, characters module only).
 *
 * `tools/shot.mjs` renders the canonical camera poses, which are anchored to
 * world coordinates. This one anchors the camera to a *character* instead, so
 * the mesh, the materials and every animation state can be inspected at the
 * distance a player actually sees them from, independently of where the terrain
 * happens to put the ground.
 *
 *   node src/characters/_preview.mjs [--out shots/chars] [--width 1280]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const args = process.argv.slice(2);
const consumed = new Set();
const opt = (n, d) => {
  const i = args.indexOf(n);
  if (i < 0) return d;
  consumed.add(i).add(i + 1);
  return args[i + 1];
};
const OUT = path.resolve(ROOT, opt('--out', 'shots/chars'));
const W = +opt('--width', 1280);
const H = +opt('--height', 720);
const RAW = args.includes('--raw');
const ONLY = args.filter((a, i) => !consumed.has(i) && !a.startsWith('--'));

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

const VIEWS = [
  // name, target character, distance, height, azimuth (rad, 0 = behind), pitch, fov, state
  { name: 'ots', who: 'player', dist: 2.7, h: 1.62, az: 0.34, look: 1.32, fov: 48, state: { speed: 0, stance: 'stand' } },
  // The gameplay rig, reproduced against a character-anchored camera: same
  // distance, same eye height, same fov, and the same 63-degree turn off the
  // view axis that `index.js` gives the player. This is the frame the game is
  // judged on, so it is the frame the character work is iterated against.
  { name: 'ots-r4', who: 'player', dist: 2.4, h: 1.6, az: 1.10, look: 1.16, fov: 45, state: { speed: 0, aim: 0.12 } },
  { name: 'front-r4', who: 'player', dist: 2.6, h: 1.45, az: Math.PI - 0.6, look: 1.2, fov: 45, state: { speed: 0, aim: 0.12 } },
  { name: 'side-r4', who: 'player', dist: 2.8, h: 1.35, az: Math.PI / 2, look: 1.1, fov: 45, state: { speed: 0, aim: 0.12 } },
  { name: 'ots-walk', who: 'player', dist: 3.0, h: 1.6, az: 0.4, look: 1.25, fov: 48, state: { speed: 1.5 }, warm: 3.1 },
  { name: 'ots-aim', who: 'player', dist: 2.5, h: 1.62, az: 0.3, look: 1.4, fov: 46, state: { speed: 0, aim: 1 }, warm: 1.5 },
  { name: 'front', who: 'player', dist: 3.6, h: 1.05, az: Math.PI - 0.5, look: 0.95, fov: 42, state: { speed: 0 } },
  { name: 'face', who: 'player', dist: 0.85, h: 1.7, az: Math.PI - 0.55, look: 1.68, fov: 34, state: { speed: 0 } },
  { name: 'face-front', who: 'player', dist: 0.72, h: 1.68, az: Math.PI, look: 1.665, fov: 30, state: { speed: 0 }, sunLit: true, sunOff: 0.6, faceOff: 0.35 },
  { name: 'face-soldier', who: 'soldier', dist: 0.8, h: 1.66, az: Math.PI - 0.4, look: 1.64, fov: 32, state: { speed: 0 }, sunLit: true, sunOff: 0.7, faceOff: 0.3 },
  { name: 'lit', who: 'player', dist: 3.4, h: 1.15, az: 0, look: 1.0, fov: 42, state: { speed: 0 }, sunLit: true, sunOff: 0.75, faceOff: 0.4 },
  { name: 'lit-soldier', who: 'soldier', dist: 3.4, h: 1.15, az: 0, look: 1.0, fov: 42, state: { speed: 0 }, sunLit: true, sunOff: 0.8, faceOff: 0.5 },
  { name: 'run', who: 'player', dist: 4.2, h: 1.5, az: 1.25, look: 1.1, fov: 46, state: { speed: 4.6 }, warm: 2.35 },
  { name: 'crouch', who: 'player', dist: 3.0, h: 1.2, az: 0.9, look: 0.8, fov: 46, state: { speed: 1.1, stance: 'crouch' }, warm: 3.0 },
  { name: 'prone', who: 'player', dist: 2.8, h: 0.85, az: 1.1, look: 0.4, fov: 48, state: { speed: 0.5, stance: 'prone' }, warm: 3.5 },
  { name: 'hit', who: 'player', dist: 3.2, h: 1.5, az: 0.7, look: 1.15, fov: 46, state: { speed: 0, hit: true }, warm: 0.18 },
  { name: 'soldier', who: 'soldier', dist: 3.4, h: 1.15, az: Math.PI - 0.7, look: 1.0, fov: 44, state: { speed: 0 } },
  { name: 'soldier-back', who: 'soldier', dist: 3.2, h: 1.35, az: 0.25, look: 1.1, fov: 44, state: { speed: 1.4 }, warm: 2.6 },
  { name: 'squad', who: 'player', dist: 9.0, h: 3.0, az: 0.8, look: 1.0, fov: 40, state: { speed: 0 } },
];

/**
 * Build to a private directory and serve that, rather than running the dev
 * server. Several people are editing this repo at once; with HMR live, someone
 * else saving a file mid-capture reloads the page and the screenshot comes back
 * black. A static build is a snapshot and cannot be pulled out from under us.
 */
async function main() {
  await mkdir(OUT, { recursive: true });
  // Inside dist/, which is already git-ignored — no new ignore entries needed.
  const dist = path.join(ROOT, 'dist', '_charpreview');
  await new Promise((res, rej) => {
    const b = spawn(
      process.execPath,
      [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'warn'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    b.stdout.on('data', (d) => (out += d));
    b.stderr.on('data', (d) => (out += d));
    b.on('exit', (c) => (c === 0 ? res() : rej(new Error('vite build failed:\n' + out))));
  });

  const port = await freePort();
  const vite = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--outDir', dist, '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let log = '';
  vite.stdout.on('data', (d) => (log += d));
  vite.stderr.on('data', (d) => (log += d));
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok) break;
    } catch {
      /* not up */
    }
    if (Date.now() > deadline) throw new Error('vite preview failed: ' + log);
    await new Promise((r) => setTimeout(r, 250));
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--force-device-scale-factor=1', '--hide-scrollbars'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__GAME && window.__GAME.ready === true, { timeout: 120000 });

  for (const v of VIEWS) {
    if (ONLY.length && !ONLY.includes(v.name)) continue;
    const meta = await page.evaluate(({ v, raw }) => {
      const G = window.__GAME;
      const T = G.THREE;
      const mod = window.__WORLD.registry.characters;
      const ch = v.who === 'player' ? mod.player : mod.characters.find((c) => !c.isPlayer);
      G.applyShot('gameplay');
      G.setFreeFly(false);
      if (raw) {
        // Diagnostic mode: strip the atmospheric and lens passes so the
        // character's own shading is what is being judged, not the scene's
        // current haze/exposure tuning (which other modules own and are still
        // moving). applyShot resets exposure, so this has to come after it.
        Object.assign(G.engine.pipeline.enabled, {
          aerial: false, dof: false, autoExposure: false, motionBlur: false, taa: false, bloom: false,
        });
        for (const c of G.engine.scene.children) {
          if (/^volumetric/.test(c.name)) c.visible = false;
        }
      }

      for (const c of mod.characters) c.controlled = true;
      ch.controlled = true;

      // The canonical shot cameras assume a ground plane near y = 0. If the
      // terrain's playable basin currently sits far below that, previews taken
      // at the spawn would be judged through a wall of height fog that the real
      // gameplay camera never sees. Relocate the subject to ground level so the
      // character is evaluated in the lighting the game is actually tuned for.
      const T2 = window.__WORLD.terrain;
      if (T2 && Math.abs(T2.heightAt(ch.position.x, ch.position.z)) > 2.0) {
        let best = null;
        for (let r = 40; r < 1400 && !best; r += 24) {
          for (let a = 0; a < 24; a++) {
            const x = Math.cos((a / 24) * Math.PI * 2) * r;
            const z = Math.sin((a / 24) * Math.PI * 2) * r;
            const h = T2.heightAt(x, z);
            const slope = Math.abs(T2.heightAt(x + 2, z) - h) + Math.abs(T2.heightAt(x, z + 2) - h);
            if (Math.abs(h) < 0.8 && slope < 0.5) {
              best = { x, z };
              break;
            }
          }
        }
        if (best) {
          const dx = best.x - ch.position.x;
          const dz = best.z - ch.position.z;
          for (const c of mod.characters) {
            c.position.x += dx;
            c.position.z += dz;
          }
        }
      }
      ch.anim.speed = v.state.speed ?? 0;
      ch.anim.smoothSpeed = v.state.speed ?? 0;
      ch.setStance(v.state.stance ?? 'stand');
      ch.anim.stanceBlend = v.state.stance === 'crouch' ? 1 : 0;
      ch.anim.proneBlend = v.state.stance === 'prone' ? 1 : 0;
      ch.anim.aim = v.state.aim ?? 0;
      if (v.state.aim) ch.anim.aimTarget.set(ch.position.x, ch.groundY + 1.4, ch.position.z - 30);
      // Neutral head: the idle scan is great in motion, useless for judging a
      // static portrait.
      ch.anim.lookTarget = new T.Vector3(
        ch.position.x - Math.sin(ch.yaw) * 24,
        ch.groundY + 1.66,
        ch.position.z - Math.cos(ch.yaw) * 24,
      );
      ch.anim.t = 12.3;
      ch.anim.breath = 3.1;
      ch.anim.phase = 0.18;

      // Warm-up so gait phase, blends and springs settle into the target state.
      const warm = v.warm ?? 0.6;
      const steps = Math.max(1, Math.round(warm / (1 / 60)));
      for (let i = 0; i < steps; i++) {
        if (v.state.speed) ch.drive(1 / 60, v.state.speed, ch.yaw);
        ch.update(1 / 60);
      }
      if (v.state.hit) {
        ch.takeHit(new T.Vector3(Math.sin(ch.yaw + 0.6), 0, Math.cos(ch.yaw + 0.6)));
        for (let i = 0; i < 11; i++) ch.update(1 / 60);
      }

      // `sunLit` re-poses the subject relative to the sun rather than to its
      // own facing. Judging a sculpt lit only by sky bounce is pointless — every
      // form goes flat — so portrait views put the key light over the camera's
      // shoulder the way a character render would be set up.
      let camAz;
      if (v.sunLit) {
        const sd = window.__WORLD.lighting.sunDirection;
        camAz = Math.atan2(sd.x, sd.z) + (v.sunOff ?? 0.55);
        ch.yaw = camAz + Math.PI + (v.faceOff ?? 0);
        ch.update(1 / 60);
      } else {
        camAz = ch.yaw + v.az;
      }
      const yaw = camAz;
      const eye = new T.Vector3(
        ch.position.x + Math.sin(yaw) * v.dist,
        ch.groundY + v.h,
        ch.position.z + Math.cos(yaw) * v.dist,
      );
      G.engine.camera.position.copy(eye);
      G.engine.camera.fov = v.fov;
      G.engine.camera.updateProjectionMatrix();
      G.engine.camera.lookAt(new T.Vector3(ch.position.x, ch.groundY + v.look, ch.position.z));

      // Freeze the sim: settle() would step characters and drift the framing.
      const cam = G.engine.camera.position.clone();
      const quat = G.engine.camera.quaternion.clone();
      G.engine.deterministic = true;
      G.engine.stop();
      for (let i = 0; i < 3; i++) {
        G.engine.camera.position.copy(cam);
        G.engine.camera.quaternion.copy(quat);
        G.engine.render();
      }
      if (raw) {
        // Drive exposure to a fixed mid-grey so successive iterations of the
        // character art are comparable frame to frame.
        for (let i = 0; i < 5; i++) {
          G.engine.render();
          const m = G.probeLuminance().mean;
          G.engine.pipeline.exposure *= Math.pow(0.44 / Math.max(0.02, m), 0.9);
          G.engine.camera.position.copy(cam);
          G.engine.camera.quaternion.copy(quat);
        }
      }
      const t0 = performance.now();
      for (let i = 0; i < 4; i++) G.engine.render();
      G.engine.renderer.getContext().finish();
      return { ms: +((performance.now() - t0) / 4).toFixed(2), stats: G.stats(), lum: G.probeLuminance().mean };
    }, { v, raw: RAW });
    const buf = await page.screenshot({ type: 'png' });
    await writeFile(path.join(OUT, `${v.name}.png`), buf);
    console.log(`  ${v.name.padEnd(13)} ${String(meta.ms).padStart(6)}ms calls=${meta.stats.calls} tris=${meta.stats.triangles} lum=${meta.lum}`);
  }

  await browser.close();
  try {
    process.kill(-vite.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  if (errors.length) {
    console.error(`\n${errors.length} page error(s):`);
    for (const e of errors.slice(0, 12)) console.error('  ' + e);
    process.exit(1);
  }
  console.log(`\nwrote previews to ${path.relative(ROOT, OUT)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
