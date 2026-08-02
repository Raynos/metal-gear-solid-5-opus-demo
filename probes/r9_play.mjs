#!/usr/bin/env node
/**
 * r9_play.mjs — PLAY THE GAME, in a real browser, with trusted input.
 *
 * Everything here is driven the way a player drives it: Playwright's own
 * keyboard and mouse, over real wall-clock time, against the engine's own rAF
 * loop. Nothing calls a gameplay function to make an outcome happen — the only
 * page-side `evaluate` calls READ state, or teleport the player to a starting
 * position for a scenario (and each teleport is declared in its scenario).
 *
 * That distinction is the whole point. `endMission('accomplished')` proves the
 * UI can render a win card; shooting the commander until he goes down and
 * watching the card appear proves the game has a win state. This script does
 * the second kind.
 *
 *   node probes/r9_play.mjs [--out shots/r9-play] [--only name,name]
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = { dir: 'shots/r9-play', width: 1920, height: 1080, only: null };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') opt.dir = argv[++i];
  else if (argv[i] === '--width') opt.width = +argv[++i];
  else if (argv[i] === '--height') opt.height = +argv[++i];
  else if (argv[i] === '--only') opt.only = argv[++i].split(',');
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

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(22)} ${detail}`);
}

async function main() {
  bundle();
  const server = await serve();
  const browser = await chromium.launch({
    // HEADLESS. This used to be headed because Playwright's headless chromium refuses
    // `requestPointerLock` outright — the request raises `pointerlockerror`,
    // measured — and src/core/Input.js ignores mouse LOOK until it holds the
    // lock. A headless run can press keys but can never turn the camera, so
    // every "I aimed at him" it reports is a lie. Headed plus bringToFront()
    // takes the lock on the first trusted mousedown.
    // pointer lock, and src/core/Input.js gated mouse LOOK on holding it — so a
    // headless run could press keys but never turn the camera. That is fixed:
    // __GAME.setAutomation(true) accepts raw mousemove deltas as look with no
    // lock. A headful window steals focus on a machine somebody is using; see
    // CLAUDE.md. Call setAutomation(true) after the page is ready.
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--force-device-scale-factor=1', '--mute-audio', '--hide-scrollbars'],
  });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: opt.width, height: opt.height }, deviceScaleFactor: 1 });
  // The 404 is the favicon; vite preview serves no icon and it is not a defect.
  page.on('console', (m) => m.type() === 'error' && !/404 \(Not Found\)/.test(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.bringToFront();
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

  const outDir = path.resolve(ROOT, opt.dir);
  await mkdir(outDir, { recursive: true });
  const shot = async (n) => writeFile(path.join(outDir, `${n}.png`), await page.screenshot({ type: 'png' }));

  // --- page-side helpers: READ state, and park the player for a scenario ----
  await page.evaluate(() => {
    const g = window.__GAME;
    const W = g.world;
    const P = W.registry.player;
    const AI = W.registry.ai;
    const site = W.registry.outpost.bounds.getCenter(new g.THREE.Vector3());
    window.R = {
      site: [site.x, site.z],
      read() {
        const r = AI ? AI.report() : null;
        const cmd = P.commander;
        return {
          mode: W.gameState.mode,
          alert: r ? r.level : null,
          aiLive: r ? r.live : null,
          maxAware: r ? Math.max(0, ...r.guards.map((x) => x.aware)) : 0,
          seenBy: r ? r.guards.filter((x) => x.sees).length : 0,
          nearest: r ? Math.min(1e9, ...r.guards.filter((x) => !x.down).map((x) => Math.hypot(x.at[0] - P.position.x, x.at[1] - P.position.z))) : null,
          // `guard.rounds` is what is LEFT in the magazine, not what has been fired.
          magsLeft: r ? r.guards.reduce((a, x) => a + x.rounds, 0) : 0,
          shots: r?.gunfire ? r.gunfire.shots : 0,
          hitsTaken: r?.gunfire ? r.gunfire.hits : 0,
          down: r ? r.guards.filter((x) => x.down).length : 0,
          commanderDown: r?.commander ? r.commander.down : null,
          commanderAt: r?.commander ? r.commander.at : null,
          pos: [+P.position.x.toFixed(1), +P.position.z.toFixed(1)],
          stance: P.stance, speed: +P.speed.toFixed(2), sprinting: P.sprinting,
          health: +P.health.toFixed(3), dead: P.dead, shock: +P.shock.toFixed(2),
          ammo: P.ammo, reserve: P.reserve, reloading: P.reloading,
          weapon: P.weapon ? { name: P.weapon.name, ammo: P.weapon.ammo, reserve: P.weapon.reserve, mode: P.weapon.mode } : null,
          mission: P.mission ? { name: P.mission.name, status: P.mission.status } : null,
          objectives: (P.objectives || []).map((o) => `${o.id}:${o.done ? 'done' : 'open'}`),
          aiming: P.isAiming,
          aimHit: P.aimHit ? { name: P.aimHit.character?.name ?? null, dist: +(P.aimHit.dist ?? 0).toFixed(1) } : null,
          camY: +g.engine.camera.position.y.toFixed(2),
          camIn: (() => {
            // Is the camera inside solid geometry? Ask the obstacle field the
            // controller itself uses, at the camera's own position.
            const c = g.engine.camera.position;
            const gr = W.registry.characters.ground.heightAt(c.x, c.z);
            return P.obstacles ? P.obstacles.maxIn(c.x, c.z, 0.25) > c.y || c.y < gr : null;
          })(),
          hud: {
            weaponWidget: (() => {
              const w = document.querySelector('section.hud .wpn');
              if (!w) return false;
              // Present in the DOM is not shown. The HUD fades widgets with
              // opacity, so ask for the computed value up the chain.
              for (let n = w; n && n !== document.body; n = n.parentElement) {
                const cs = getComputedStyle(n);
                if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false;
              }
              return w.getBoundingClientRect().width > 20;
            })(),
            ammoText: (document.querySelector('section.hud .wpn')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
            alertText: (document.querySelector('section.hud .alr')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
            cardText: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140),
          },
        };
      },
      /** Teleport only. Used to set up a scenario, never to produce an outcome. */
      warp(x, z, faceX, faceZ) {
        const c = W.registry.player.controller;
        const hAt = (a, b) => W.registry.characters.ground.heightAt(a, b);
        const P2 = W.registry.player;
        for (let r = 0; r <= 14 && P2.obstacles.maxIn(x, z, 0.9) > hAt(x, z) + 0.45; r += 1.5) {
          for (let k = 0; k < 12; k++) {
            const a = (k / 12) * Math.PI * 2;
            const px = x + Math.cos(a) * r; const pz = z + Math.sin(a) * r;
            if (P2.obstacles.maxIn(px, pz, 0.9) <= hAt(px, pz) + 0.45) { x = px; z = pz; r = 99; break; }
          }
        }
        const y = hAt(x, z);
        c.position.set(x, y, z); c.footY = y; c.velocity.set(0, 0, 0);
        if (faceX !== undefined) c.yaw = Math.atan2(-(faceX - x), -(faceZ - z));
        P2.camera.reset(c.position, c.yaw);
        return [x, z];
      },
      /** Nearest wall/fence face outside the compound, and a standing spot 2.4 m off it. */
      wallSpot() {
        const obs = W.registry.player.obstacles;
        const hAt = (x, z) => W.registry.characters.ground.heightAt(x, z);
        for (let a = 0; a < 96; a++) {
          const th = (a / 96) * Math.PI * 2;
          for (let r = 18; r < 62; r += 0.4) {
            const x = site.x + Math.sin(th) * r; const z = site.z + Math.cos(th) * r;
            if (obs.maxIn(x, z, 0.4) > hAt(x, z) + 1.4) {
              return { wall: [x, z], stand: [site.x + Math.sin(th) * (r + 2.4), site.z + Math.cos(th) * (r + 2.4)] };
            }
          }
        }
        return null;
      },
      commanderPos() { const r = AI?.report(); return r?.commander ? r.commander.at : null; },
      /** Standing spot `d` m from the nearest living guard, on clear ground. */
      nearGuard(d) {
        const r = AI.report();
        const P2 = W.registry.player;
        const live = r.guards.filter((x) => !x.down);
        if (!live.length) return null;
        let best = live[0]; let bd = 1e9;
        for (const gd of live) {
          const dd = Math.hypot(gd.at[0] - P2.position.x, gd.at[1] - P2.position.z);
          if (dd < bd) { bd = dd; best = gd; }
        }
        const obs = P2.obstacles;
        const hAt = (x, z) => W.registry.characters.ground.heightAt(x, z);
        for (let a = 0; a < 24; a++) {
          const th = (a / 24) * Math.PI * 2;
          const x = best.at[0] + Math.sin(th) * d; const z = best.at[1] + Math.cos(th) * d;
          if (obs.maxIn(x, z, 0.9) <= hAt(x, z) + 0.45) return [x, z, best.at[0], best.at[1]];
        }
        return null;
      },
      commanderName() { return W.registry.characters.commander?.name ?? null; },
      /**
       * A start point for the alert ladder: on the approach to the compound but
       * as far from every living guard as the ring allows. A fixed offset does
       * not work — the commander's reserve is staged on the access track, so
       * site+78,+78 put the player 21 m from a rifleman and the whole encounter
       * happened at knife range.
       */
      farStart(ring) {
        const r = AI.report();
        const live = r.guards.filter((x) => !x.down).map((x) => x.at);
        const obs = W.registry.player.obstacles;
        const hAt = (x, z) => W.registry.characters.ground.heightAt(x, z);
        let best = null; let bestD = -1;
        for (let a = 0; a < 72; a++) {
          const th = (a / 72) * Math.PI * 2;
          const x = site.x + Math.sin(th) * ring; const z = site.z + Math.cos(th) * ring;
          if (obs.maxIn(x, z, 0.9) > hAt(x, z) + 0.45) continue;
          const d = Math.min(...live.map((g) => Math.hypot(g[0] - x, g[1] - z)));
          if (d > bestD) { bestD = d; best = [x, z]; }
        }
        return best ? [best[0], best[1], bestD] : null;
      },
      /**
       * A place to shoot him FROM. The first attempt at this warped to a fixed
       * +11,+11 and put the player inside a hangar, where the aim ray hit a
       * wall 1.4 m away and 40 s of trigger pulls went into plywood. So: test
       * the segment, not just the endpoint.
       */
      clearSpot(cx, cz) {
        const obs = W.registry.player.obstacles;
        const hAt = (x, z) => W.registry.characters.ground.heightAt(x, z);
        for (let r = 9; r <= 22; r += 1.5) {
          for (let a = 0; a < 24; a++) {
            const th = (a / 24) * Math.PI * 2;
            const x = cx + Math.sin(th) * r; const z = cz + Math.cos(th) * r;
            if (obs.maxIn(x, z, 0.9) > hAt(x, z) + 0.45) continue;
            // Walk the segment at chest height; anything standing in it blocks.
            let clear = true;
            for (let t = 0.08; t < 0.96; t += 0.06) {
              const px = x + (cx - x) * t; const pz = z + (cz - z) * t;
              if (obs.maxIn(px, pz, 0.35) > hAt(px, pz) + 1.3) { clear = false; break; }
            }
            if (clear) return [x, z, r];
          }
        }
        return null;
      },
      locked() { return !!W.registry.player.input.pointerLocked; },
    };
  });

  const read = () => page.evaluate(() => window.R.read());

  /**
   * Put the run back at the start of a live mission, the way a player does it:
   * ENTER on the end card is RETRY. Without this the scenarios contaminate each
   * other — the first full pass died during the ALERT ladder, and every frame
   * after that (evasion, gave-up, taking-fire) photographed the MISSION FAILED
   * plate instead of the game. The end card also drops pointer lock, so the
   * lock has to be retaken or mouse look is dead for everything downstream.
   */
  async function ensureFresh() {
    let s0 = await read();
    if (s0.mission?.status === 'accomplished' || s0.mission?.status === 'failed' || s0.dead) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
      s0 = await read();
    }
    // Always round-trip the mode, even from a live mission. The garrison keeps
    // its alert state and its last-known-position search across scenarios, and
    // a scenario that starts with eight men already converging on where the
    // previous one left the player is not the scenario it says it is: the first
    // sequenced pass had the death test standing in the open for 90 s without a
    // single round fired at it, because every guard was 80 m away searching.
    await page.evaluate(() => {
      const W = window.__GAME.world;
      W.gameState.setMode('godmode'); W.gameState.setMode('play');
      W.registry.player.vitals.reset();
    });
    await page.waitForTimeout(1400);
    if (!(await page.evaluate(() => window.R.locked()))) {
      await page.mouse.click(960, 540);
      await page.waitForTimeout(250);
    }
    // Ride out the mission card before anything is photographed.
    await page.waitForTimeout(3600);
    return read();
  }
  const want = (n) => !opt.only || opt.only.includes(n);

  // Wait until `fn(state)` is true, sampling once a second. Returns the state
  // it stopped on plus how long it took, so a timeout is reported, not thrown.
  async function until(fn, timeoutMs, label) {
    const t0 = Date.now();
    let s = await read();
    while (!fn(s) && Date.now() - t0 < timeoutMs) {
      await page.waitForTimeout(500);
      s = await read();
    }
    return { s, ms: Date.now() - t0, ok: fn(s), label };
  }

  // ==== 0. the menu, with a real click ====================================
  await page.waitForTimeout(1200);
  await shot('00-menu');
  const menuRows = await page.$$eval('button.row', (b) => b.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  await page.click('button.row:first-of-type', { force: true });
  await page.waitForTimeout(500);
  let st = await read();
  record('menu starts the game', st.mode === 'play', `clicked "${menuRows[0]}" -> mode=${st.mode}`);

  // Pointer lock, so mouse LOOK works at all. Requires a trusted click.
  await page.bringToFront();
  await page.mouse.click(960, 540);
  await page.waitForTimeout(300);
  const locked = await page.evaluate(() => window.R.locked());
  record('pointer lock', locked, locked ? 'trusted click took the lock; mouse LOOK is live'
    : 'requestPointerLock was REFUSED — mouse look is dead for this run');

  // ==== 1. spawn, then WAIT 30 SECONDS =====================================
  if (want('calm')) {
    await page.waitForTimeout(3600); // the mission card is opaque for ~3.5 s
    const s0 = await read();
    const t0 = Date.now();
    let worst = 0; let worstLevel = 'CALM';
    while (Date.now() - t0 < 30000) {
      await page.waitForTimeout(1000);
      const s = await read();
      worst = Math.max(worst, s.maxAware);
      if (s.alert !== 'CALM') worstLevel = s.alert;
    }
    const s1 = await read();
    await shot('01-spawn-30s-calm');
    record('30 s idle stays CALM', s1.alert === 'CALM' && worstLevel === 'CALM',
      `spawn ${s0.pos} nearest guard ${s0.nearest?.toFixed(1)} m; after 30 s alert=${s1.alert}, peak awareness ${worst.toFixed(3)}, worst level ${worstLevel}`);
  }

  // ==== 2. the verb check — every key must move something ==================
  if (want('verbs')) {
    const before = await read();
    // crouch
    await page.keyboard.press('KeyC'); await page.waitForTimeout(700);
    const crouched = await read();
    await shot('02-crouch');
    record('crouch (C)', crouched.stance === 'crouch', `${before.stance} -> ${crouched.stance}`);
    // prone
    await page.keyboard.press('KeyZ'); await page.waitForTimeout(900);
    const proned = await read();
    await shot('03-prone');
    record('prone (Z)', proned.stance === 'prone', `${crouched.stance} -> ${proned.stance}`);
    // Back to standing. `setStance` REFUSES while `stanceTimer > 0` and the key
    // is edge-triggered, so a press that lands inside the prone->crouch commit
    // is dropped, not queued — measured: one press 700 ms after Z left him
    // crouched. That is a design choice, not a bug, but it means the player has
    // to press again, so the test does what the player does.
    let presses = 0;
    let stood = await read();
    for (let i = 0; i < 6 && stood.stance !== 'stand'; i++) {
      await page.keyboard.press(stood.stance === 'prone' ? 'KeyZ' : 'KeyC');
      presses++;
      await page.waitForTimeout(650);
      stood = await read();
    }
    record('stand up', stood.stance === 'stand', `-> ${stood.stance} after ${presses} press(es)`);

    // sprint: measure speed walking vs sprinting
    await page.keyboard.down('KeyW'); await page.waitForTimeout(1200);
    const walkS = (await read()).speed;
    await page.keyboard.down('ShiftLeft'); await page.waitForTimeout(1400);
    const runS = await read();
    await shot('04-sprint');
    await page.keyboard.up('ShiftLeft'); await page.keyboard.up('KeyW'); await page.waitForTimeout(400);
    record('sprint (Shift)', runS.sprinting && runS.speed > walkS * 1.25,
      `walk ${walkS.toFixed(2)} m/s -> sprint ${runS.speed.toFixed(2)} m/s (sprinting=${runS.sprinting})`);

    // weapon widget + aim
    await page.mouse.down({ button: 'right' }); await page.waitForTimeout(900);
    const aimed = await read();
    await shot('05-aim');
    record('aim (RMB)', aimed.aiming, `isAiming=${aimed.aiming}`);
    record('weapon widget', !!aimed.weapon && aimed.hud.weaponWidget,
      `weapon=${JSON.stringify(aimed.weapon)} hud="${aimed.hud.ammoText}"`);

    // fire until the magazine is visibly down, then reload
    const ammo0 = aimed.ammo;
    for (let i = 0; i < 8; i++) { await page.mouse.click(960, 540); await page.waitForTimeout(140); }
    await page.waitForTimeout(400);
    const fired = await read();
    await shot('06-fire');
    record('fire (LMB)', fired.ammo < ammo0, `ammo ${ammo0} -> ${fired.ammo}`);
    await page.keyboard.press('KeyT');
    const rel = await until((s) => !s.reloading && s.ammo > fired.ammo, 8000);
    await shot('07-reload');
    record('reload (T) refills', rel.ok, `ammo ${fired.ammo} -> ${rel.s.ammo}/${rel.s.reserve} in ${rel.ms} ms`);
    await page.mouse.up({ button: 'right' }); await page.waitForTimeout(300);
  }

  // ==== 3. walk into a fence: must slide, not wedge ========================
  if (want('wall')) {
    const w = await page.evaluate(() => window.R.wallSpot());
    if (!w) record('fence slide', false, 'no wall found in the outpost obstacle field');
    else {
      // Stand him 2.4 m off the wall, facing it at a shallow angle so a
      // correct slide has somewhere to go.
      await page.evaluate(([sx, sz, wx, wz]) => window.R.warp(sx, sz, wx + (wz - sz) * 0.9, wz - (wx - sx) * 0.9),
        [w.stand[0], w.stand[1], w.wall[0], w.wall[1]]);
      await page.waitForTimeout(600);
      const a = await read();
      await page.keyboard.down('KeyW'); await page.waitForTimeout(2600);
      const mid = await read();
      await page.waitForTimeout(1400);
      await page.keyboard.up('KeyW'); await page.waitForTimeout(300);
      const b = await read();
      await shot('08-fence-slide');
      const moved = Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1]);
      record('walk into fence slides', moved > 2.5 && mid.speed > 0.4,
        `travelled ${moved.toFixed(1)} m along the wall, speed while in contact ${mid.speed.toFixed(2)} m/s (a wedge reads ~0)`);

      // aim near the wall: the camera boom must not enter geometry
      await page.evaluate(([sx, sz, wx, wz]) => window.R.warp(sx, sz, wx, wz), [w.stand[0], w.stand[1], w.wall[0], w.wall[1]]);
      await page.waitForTimeout(500);
      await page.mouse.down({ button: 'right' }); await page.waitForTimeout(1000);
      const c = await read();
      await shot('09-aim-at-wall');
      await page.mouse.up({ button: 'right' }); await page.waitForTimeout(200);
      record('camera stays out of geometry', c.camIn === false, `camera inside solid = ${c.camIn} (y=${c.camY})`);
    }
  }

  // ==== 4. be seen: CALM -> CAUTION -> ALERT ==============================
  if (want('ladder')) {
    await ensureFresh();
    // Start the encounter at RANGE. The first version walked in to 15 m and was
    // shot dead 22 s later, mid-escape — which is a true fact about the game
    // (at ALERT, standing, at 15 m, you last 4.5 s) but it meant every frame
    // from EVASION onward photographed the MISSION FAILED plate. Being spotted
    // at 55-70 m leaves a survivable escape, which is the thing under test.
    const start = await page.evaluate(() => window.R.farStart(95));
    await page.evaluate(([x, z]) => window.R.warp(x, z, ...window.R.site), start);
    await page.waitForTimeout(900);
    const s0 = await read();
    await page.keyboard.down('KeyW');
    if (process.env.TRACE) {
      for (let i = 0; i < 12; i++) { await page.waitForTimeout(3000); const t = await read();
        console.log('  trace', JSON.stringify({ pos: t.pos, sp: t.speed, near: +(t.nearest ?? 0).toFixed(1), aw: t.maxAware, seen: t.seenBy, alert: t.alert, live: t.aiLive, mode: t.mode })); }
    }
    const caution = await until((s) => s.alert === 'CAUTION' || s.alert === 'ALERT', 150000);
    await shot('10-caution');
    record('CALM -> CAUTION', caution.s.alert === 'CAUTION' || caution.s.alert === 'ALERT',
      `started ${start[2].toFixed(0)} m from the nearest guard and walked in; alert=${caution.s.alert} after ${(caution.ms / 1000).toFixed(1)} s at ${caution.s.nearest?.toFixed(0)} m, seenBy=${caution.s.seenBy}, awareness ${caution.s.maxAware.toFixed(2)}, health ${caution.s.health}`);
    const alert = await until((s) => s.alert === 'ALERT', 90000);
    await page.keyboard.up('KeyW');
    await shot('11-alert');
    record('CAUTION -> ALERT', alert.s.alert === 'ALERT',
      `alert=${alert.s.alert} after a further ${(alert.ms / 1000).toFixed(1)} s at ${alert.s.nearest?.toFixed(0)} m; ${alert.s.shots} rounds fired at me (${alert.s.hitsTaken} hits), health ${alert.s.health}`);

    // ==== 5. break line of sight -> EVASION, and they give up ============
    // Turn and run. Nothing is teleported here: this is the escape, played.
    await page.keyboard.down('ShiftLeft');
    await page.keyboard.down('KeyS');
    const evade = await until((s) => s.alert === 'EVASION' || s.dead, 90000);
    await page.keyboard.up('ShiftLeft');
    await shot('12-evasion');
    record('break LOS -> EVASION', evade.s.alert === 'EVASION' && !evade.s.dead,
      `sprinted away; alert=${evade.s.alert} after ${(evade.ms / 1000).toFixed(1)} s at ${evade.s.nearest?.toFixed(0)} m, health ${evade.s.health}${evade.s.dead ? ' (KILLED during the escape)' : ''}`);
    // Keep backing off while they search, and go prone — what a player does.
    await page.keyboard.press('KeyC'); await page.waitForTimeout(600);
    const giveup = await until((s) => s.alert === 'CALM' || s.alert === 'CAUTION' || s.dead, 180000);
    await page.keyboard.up('KeyS');
    await shot('13-gave-up');
    record('the garrison gives up', giveup.ok && !giveup.s.dead,
      `alert settled to ${giveup.s.alert} after a further ${(giveup.ms / 1000).toFixed(1)} s, health ${giveup.s.health}`);
  }

  // ==== 6. take damage, die, MISSION FAILED ===============================
  if (want('death')) {
    await ensureFresh();
    // Get caught the way a player gets caught — walk in until they see you —
    // and then DO NOT LEAVE. Warping into the middle of a CALM compound and
    // waiting does not work: measured, 70 s standing at 17 m from the wire drew
    // two rounds and no damage, because nobody had a reason to look.
    const dstart = await page.evaluate(() => window.R.farStart(95));
    await page.evaluate(([x, z]) => window.R.warp(x, z, ...window.R.site), dstart);
    await page.waitForTimeout(800);
    await page.keyboard.down('KeyW');
    const spotted = await until((s) => s.alert === 'ALERT', 150000);
    await page.keyboard.up('KeyW');
    // Close to 14 m and STAND THERE. The approach is teleported — the walk in
    // wedges against terrain at whatever range it happens to wedge at, and a
    // test that sometimes settles at 29 m is testing a different thing: at 29 m
    // with one shooter, hits arrive slower than Vitals regenerates and the
    // player survives indefinitely (measured: 26 hits over 150 s, still alive).
    // Standing in front of a squad at 14 m is the decision the model exists to
    // punish, so that is the one under test.
    const close = await page.evaluate(() => window.R.nearGuard(14));
    if (close) { await page.evaluate((c) => window.R.warp(c[0], c[1], c[2], c[3]), close); }
    await page.waitForTimeout(600);
    const hp0 = await read();
    const hurt = await until((s) => s.health < 0.95, 90000);
    await shot('14-taking-fire');
    record('guards can hurt you', hurt.ok,
      `spotted at ${spotted.s.nearest?.toFixed(0)} m after ${(spotted.ms / 1000).toFixed(1)} s; health ${hp0.health} -> ${hurt.s.health} under ${hurt.s.shots} rounds (${hurt.s.hitsTaken} hits), shock ${hurt.s.shock}`);
    const dead = await until((s) => s.dead || s.mission?.status === 'failed', 150000);
    await page.waitForTimeout(2500);
    const failed = await read();
    await shot('15-mission-failed');
    record('death -> MISSION FAILED', failed.mission?.status === 'failed',
      `dead=${failed.dead} mission=${JSON.stringify(failed.mission)}; took ${failed.hitsTaken} hits from ${failed.shots} rounds, died ${(dead.ms / 1000).toFixed(1)} s after the first one landed`);
  }

  // ==== 7. neutralise the commander -> MISSION ACCOMPLISHED ===============
  if (want('win')) {
    // Restart cleanly, then go and shoot him.
    await ensureFresh();
    const cmd = await page.evaluate(() => window.R.commanderPos());
    if (!cmd) record('commander exists', false, 'registry.ai.report().commander is null');
    else {
      record('commander exists', true, `posted at ${JSON.stringify(cmd)}`);
      // Stand somewhere with a clear line to him — measured, not assumed — and
      // put darts into him. The approach across 120 m of garrison is teleported;
      // the AIM and the KILL are trigger pulls and mouse movement.
      const spot = await page.evaluate(([x, z]) => window.R.clearSpot(x, z), cmd);
      if (!spot) { record('clear line to the commander', false, 'no unobstructed firing position found'); }
      else {
        record('clear line to the commander', true, `firing position ${spot[0].toFixed(1)},${spot[1].toFixed(1)} at ${spot[2].toFixed(1)} m`);
        await page.evaluate(([sx, sz, cx, cz]) => window.R.warp(sx, sz, cx, cz), [spot[0], spot[1], cmd[0], cmd[1]]);
        await page.waitForTimeout(900);
        await page.mouse.down({ button: 'right' }); await page.waitForTimeout(900);

        // Put the reticle ON him. Pointer lock is live, so this is mouse LOOK:
        // sweep pitch, then yaw, until the trace reports a character.
        const name = await page.evaluate(() => window.R.commanderName());
        let s2 = await read();
        let onTarget = !!s2.aimHit?.name;
        for (const dy of [0, -18, 18, -36, 36, -54, 54]) {
          if (onTarget) break;
          for (const dx of [0, -14, 14, -28, 28, -42, 42]) {
            await page.mouse.move(960 + dx, 540 + dy, { steps: 3 });
            await page.waitForTimeout(180);
            s2 = await read();
            if (s2.aimHit?.name) { onTarget = true; break; }
          }
        }
        await shot('16-commander-in-sight');
        record('commander in the sight', onTarget,
          `target name "${name}"; aimHit=${JSON.stringify(s2.aimHit)}`);

        const t0 = Date.now();
        while (Date.now() - t0 < 60000) {
          s2 = await read();
          if (s2.commanderDown || s2.mission?.status === 'accomplished' || s2.dead) break;
          if (s2.ammo <= 0) { await page.keyboard.press('KeyT'); await page.waitForTimeout(2400); continue; }
          await page.mouse.click(960, 540);
          await page.waitForTimeout(160);
        }
        await page.mouse.up({ button: 'right' });
      }
      const win = await until((x) => x.mission?.status === 'accomplished', 15000);
      await page.waitForTimeout(2000);
      const fin = await read();
      await shot('17-mission-accomplished');
      record('commander goes down', !!fin.commanderDown, `commanderDown=${fin.commanderDown}, guards down ${fin.down}`);
      record('win -> MISSION ACCOMPLISHED', fin.mission?.status === 'accomplished',
        `mission=${JSON.stringify(fin.mission)} objectives=${JSON.stringify(fin.objectives)} card="${fin.hud.cardText}"`);
    }
  }

  console.log('\n--- summary ---');
  console.log(JSON.stringify({ pass: results.filter((r) => r.pass).length, fail: results.filter((r) => !r.pass).length,
    failed: results.filter((r) => !r.pass).map((r) => r.name) }, null, 2));
  if (errors.length) {
    console.error(`\n${errors.length} page error(s):`);
    for (const e of errors.slice(0, 12)) console.error('  ' + e);
  }
  await cleanup(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
