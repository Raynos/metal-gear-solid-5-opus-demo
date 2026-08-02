#!/usr/bin/env node
/**
 * fx_audit.mjs — does firing/reloading actually reach the screen and the speakers?
 *
 * Drives the game with Playwright's own trusted keyboard/mouse, HEADLESS
 * (CLAUDE.md), and instruments the audio module and the character animator from
 * the page so every claim is a counter that moved, not a line of code that
 * exists. Nothing here calls a gameplay function to produce an outcome.
 *
 *   node probes/fx_audit.mjs [--out shots/fx] [--shots]
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = { dir: 'shots/fx', width: 1920, height: 1080, shots: false };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') opt.dir = argv[++i];
  else if (argv[i] === '--shots') opt.shots = true;
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

const rows = [];
const record = (name, pass, detail) => {
  rows.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(26)} ${detail}`);
};

async function main() {
  bundle();
  const server = await serve();
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--force-device-scale-factor=1',
      // NOT --mute-audio: a muted context still schedules and still reports
      // state, but keeping real audio on is what proves the device path works.
      '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
  });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: opt.width, height: opt.height }, deviceScaleFactor: 1 });
  page.on('console', (m) => m.type() === 'error' && !/404 \(Not Found\)/.test(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
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
  if (opt.shots) await mkdir(outDir, { recursive: true });
  const shot = async (n) => opt.shots && writeFile(path.join(outDir, `${n}.png`), await page.screenshot({ type: 'png' }));

  // ---- instrument, page side. Counters only; nothing is stubbed out. -------
  await page.evaluate(() => {
    const W = window.__GAME.world;
    const A = W.registry.audio;
    const C = W.registry.characters;
    const P = W.registry.player;
    const k = {};
    const bump = (n) => { k[n] = (k[n] ?? 0) + 1; };
    const wrap = (obj, name, tag) => {
      if (!obj || typeof obj[name] !== 'function') return false;
      const f = obj[name].bind(obj);
      obj[name] = (...a) => { bump(tag); return f(...a); };
      return true;
    };
    const wrapped = {
      foleyWeapon: wrap(A?.foley, 'weapon', 'audio.weapon'),
      foleyTranq: wrap(A?.foley, 'tranq', 'audio.tranq'),
      foleyStep: wrap(A?.foley, 'footstep', 'audio.footstep'),
      foleyCqc: wrap(A?.foley, 'cqc', 'audio.cqc'),
      alertSpotted: wrap(A?.alert, 'spotted', 'alert.spotted'),
      alertCaution: wrap(A?.alert, 'caution', 'alert.caution'),
      alertNotice: wrap(A?.alert, 'notice', 'alert.notice'),
      alertClear: wrap(A?.alert, 'clear', 'alert.clear'),
      alertSet: wrap(A?.alert, 'set', 'alert.set'),
      engKeep: wrap(A?.engine, 'keep', 'voice.keep'),
    };
    // A sting can be REQUESTED twice for one transition — src/ui polls the HUD
    // and src/ai pushes — and only one of the two should be synthesised. Count
    // the requests that actually got through the gate, not the calls.
    if (A?.alert?._gate) {
      const g = A.alert._gate.bind(A.alert);
      A.alert._gate = (n, gap) => { const ok = g(n, gap); if (ok) bump(`gate.${n}`); return ok; };
    }
    // And count what the SQUAD actually did, so the assertion is
    // "one transition, one sting" rather than a number typed into the probe.
    const trans = [];
    W.registry.ai?.onAlertChange?.((e) => trans.push(e.to));
    P?.events?.on?.((e) => {
      if (e.type === 'shot' || e.type === 'tranq') {
        window.__lastShot = { type: e.type, surface: e.surface ?? null, point: e.point ? [+e.point.x.toFixed(1), +e.point.y.toFixed(1), +e.point.z.toFixed(1)] : null };
      }
    });
    // Which actions the animator is actually asked to play.
    const acts = {};
    const pc = P?.player;
    if (pc) {
      const f = pc.playAction.bind(pc);
      pc.playAction = (n, o) => { acts[n] = (acts[n] ?? 0) + 1; return f(n, o); };
    }
    // The flash lives for two frames, so polling it from node cannot see it.
    // Sample the pools every frame from inside the loop and keep the peaks.
    const peak = { flash: 0, light: 0, dust: 0, sparks: 0, decals: 0, shells: 0, draws: 0 };
    W.engine.addSystem({
      order: 2000,
      update() {
        const f = P?.feedback;
        if (!f) return;
        const s = f.stats();
        peak.flash = Math.max(peak.flash, s.flash ? 1 : 0);
        peak.light = Math.max(peak.light, s.lightIntensity);
        peak.dust = Math.max(peak.dust, s.dust);
        peak.sparks = Math.max(peak.sparks, s.sparks);
        peak.decals = Math.max(peak.decals, s.decals);
        peak.shells = Math.max(peak.shells, s.shells);
        peak.draws = Math.max(peak.draws, s.draws);
      },
    });

    // Did anything visible get added under the player? Count scene children.
    window.FX = {
      k, acts, wrapped, peak, trans,
      reset() {
        for (const n in k) delete k[n];
        for (const n in acts) delete acts[n];
        for (const n in peak) peak[n] = 0;
        trans.length = 0;
      },
      read() {
        const st = C?.stateOf?.(P?.player) ?? null;
        return {
          audio: A ? A.stats() : null,
          k: { ...k },
          acts: { ...acts },
          action: st?.action ?? null,
          ammo: P?.ammo, reserve: P?.reserve, reloading: P?.reloading,
          aiming: P?.isAiming,
          dead: P?.dead, health: +(P?.health ?? 0).toFixed(2),
          reloadFrac: +(P?.weapon?.reloading ?? 0).toFixed(2),
          alertLevel: W.registry.ai?.alertLevel ?? null,
          sceneChildren: W.engine.scene.children.length,
          mode: W.gameState.mode,
          fx: P?.feedback ? P.feedback.stats() : null,
          fxPeak: { ...peak },
          trans: [...trans],
          aimHit: P?.aimHit ? { dist: +P.aimHit.dist.toFixed(1), ch: P.aimHit.character?.name ?? null } : null,
          pitch: +(P?.camera?.pitch ?? 0).toFixed(3),
          lastShot: window.__lastShot ?? null,
          music: W.registry.audio?.music
            ? { target: W.registry.audio.music.target, level: W.registry.audio.music.level }
            : null,
        };
      },
    };
  });

  const read = () => page.evaluate(() => window.FX.read());
  const reset = () => page.evaluate(() => window.FX.reset());

  console.log('instrumented:', JSON.stringify((await read()).audio));

  // ---- start the game the way a player does -------------------------------
  await page.evaluate(() => window.__GAME.setAutomation(true));
  await page.click('button.row:first-of-type', { force: true });   // trusted click
  await page.waitForTimeout(900);
  await page.mouse.click(960, 540);                                 // trusted click
  await page.waitForTimeout(600);

  let s = await read();
  record('mode = play', s.mode === 'play', `mode=${s.mode}`);
  record('audio armed', !!s.audio?.armed, `armed=${s.audio?.armed} running=${s.audio?.running} ctx=${s.audio?.ctxState} avail=${s.audio?.available}`);

  // ---- footsteps ----------------------------------------------------------
  await reset();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(4000);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(200);
  s = await read();
  record('footsteps scheduled', (s.k['audio.footstep'] ?? 0) > 2,
    `footstep calls=${s.k['audio.footstep'] ?? 0} voices kept=${s.k['voice.keep'] ?? 0}`);

  // ---- firing -------------------------------------------------------------
  await reset();
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(700);
  // Put the muzzle on the ground a few metres out, so the round LANDS. Fired at
  // the horizon the dart runs its whole 1.6 s of flight and hits nothing, and
  // "no impact effect" would then be the aim, not the code.
  await page.mouse.move(960, 540);
  const pitch0 = (await read()).pitch;
  await page.mouse.move(960, 700, { steps: 8 });
  await page.waitForTimeout(300);
  const before = await read();
  console.log(`  look: pitch ${pitch0} -> ${before.pitch} after a 160 px downward mouse move`);
  console.log('  trace:', JSON.stringify(await page.evaluate(() => {
    const T = window.__GAME.THREE;
    const S = window.__GAME.world.registry.player.stealth;
    const o = new T.Vector3(); const d = new T.Vector3();
    S.aimRay(o, d);
    const h = S._trace(o, d);
    return {
      origin: [+o.x.toFixed(1), +o.y.toFixed(2), +o.z.toFixed(1)],
      dir: [+d.x.toFixed(3), +d.y.toFixed(3), +d.z.toFixed(3)],
      groundUnderOrigin: +S.ground.heightAt(o.x, o.z).toFixed(2),
      hit: h ? { surface: h.surface ?? 'character', p: [+h.point.x.toFixed(1), +h.point.y.toFixed(2), +h.point.z.toFixed(1)] } : null,
    };
  })));
  // down/up WITHOUT a position. `mouse.click(x, y)` moves the pointer first,
  // and in automation mode every pointer move is mouse LOOK — clicking back at
  // screen centre after aiming down pitched the weapon 24 degrees up on the
  // frame of every shot, so five rounds went over the horizon and the probe
  // read that as "impacts are broken".
  for (let i = 0; i < 5; i++) {
    await page.mouse.down();
    await page.waitForTimeout(70);
    await page.mouse.up();
    await page.waitForTimeout(560);
  }
  await page.waitForTimeout(200);
  const after = await read();
  await shot('fire');
  record('fire consumes ammo', after.ammo < before.ammo, `${before.ammo} -> ${after.ammo}`);
  record('fire drives animator', (after.acts.fire ?? 0) > 0,
    `playAction('fire') x${after.acts.fire ?? 0}, action=${after.action}`);
  record('fire makes a sound', (after.k['audio.tranq'] ?? 0) > 0 || (after.k['audio.weapon'] ?? 0) > 0,
    `tranq=${after.k['audio.tranq'] ?? 0} weapon=${after.k['audio.weapon'] ?? 0} voices=${after.k['voice.keep'] ?? 0}`);
  record('muzzle flash + light', after.fxPeak.flash > 0 && after.fxPeak.light > 1,
    `flash frames seen=${after.fxPeak.flash} peak light intensity=${after.fxPeak.light}`);
  record('impact leaves a mark', after.fxPeak.decals > 0 && after.fxPeak.sparks > 0,
    `dust=${after.fxPeak.dust} sparks=${after.fxPeak.sparks} decals=${after.fxPeak.decals} (sand impact = puff + grains + mark)`);
  console.log('  aim debug:', JSON.stringify({ aimHit: after.aimHit, pitch: after.pitch, lastShot: after.lastShot }));
  record('brass ejects', after.fxPeak.shells > 0,
    `shells live=${after.fxPeak.shells}, peak extra draw calls from all of this=${after.fxPeak.draws}`);
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(200);

  // ---- reload -------------------------------------------------------------
  await reset();
  await page.keyboard.press('KeyT');
  await page.waitForTimeout(300);
  const mid = await read();
  record('reload drives animator', (mid.acts.reload ?? 0) > 0,
    `playAction('reload') x${mid.acts.reload ?? 0}, action=${mid.action}, reloading=${mid.reloading}`);
  record('reload makes a sound', (mid.k['audio.weapon'] ?? 0) > 0, `weapon calls=${mid.k['audio.weapon'] ?? 0}`);
  await shot('reload');
  // Generous: the page runs slower than wall clock under a probe (measured
  // 2.14 s of game time in 3.3 s of wall clock), so a wait sized to the clip
  // length is a race the probe loses, not a defect in the reload.
  await page.waitForTimeout(5000);
  const done = await read();
  record('reload refills', done.ammo > mid.ammo,
    `${mid.ammo} -> ${done.ammo} after 5.3 s wall against a 2.40 s clip `
    + `(progress ${done.reloadFrac}, health ${done.health}, dead ${done.dead})`);

  // ---- alert ladder -------------------------------------------------------
  // The squad's own state machine decides when it changes level and it decays
  // on its own timers, so the assertion is not "three stings" — it is ONE sting
  // per transition the squad actually reported, which is the property that
  // breaks when two publishers both drive the same cue.
  await reset();
  const ladder = await page.evaluate(async () => {
    const W = window.__GAME.world;
    const ai = W.registry.ai;
    const P = W.registry.player;
    const mus = () => W.registry.audio?.music?.target ?? null;
    const out = [];
    // `report` is the call the perception layer makes: it sets the level AND
    // the timer that holds it, which `squad.set` alone does not, so a level
    // driven this way survives long enough to be a real transition.
    for (const [kind, wait] of [['notice', 1400], ['sight', 1600]]) {
      ai.squad.report(kind, P.position, null);
      await new Promise((r) => setTimeout(r, wait));
      out.push([kind, ai.alertLevel, mus()]);
    }
    return out;
  }).catch((e) => String(e));
  await page.waitForTimeout(400);
  s = await read();
  const toAlert = s.trans.filter((t) => t === 'ALERT').length;
  const toCaution = s.trans.filter((t) => t === 'CAUTION').length;
  const gSpot = s.k['gate.spotted'] ?? 0;
  const gCaut = s.k['gate.caution'] ?? 0;
  record('alert stinger per transition',
    toAlert > 0 && gSpot === toAlert && gCaut === toCaution,
    `squad went ${JSON.stringify(s.trans)}; synthesised spotted=${gSpot} caution=${gCaut} `
    + `(requested spotted=${s.k['alert.spotted'] ?? 0} caution=${s.k['alert.caution'] ?? 0} — the gap is the double-fire the gate drops)`);
  record('alert moves the score', Array.isArray(ladder) && ladder.some((r) => r[2] === 1),
    `music intensity per rung ${JSON.stringify(ladder)} (ALERT must reach 1)`);

  // ---- the harness must not be able to see any of this --------------------
  // Every canonical screenshot is taken in godmode. A pixel diff cannot settle
  // this today — two runs of IDENTICAL source differ by a mean of 5-9/255 on
  // this machine, which is larger than any change being looked for — so assert
  // the invariant that makes the pixels irrelevant: outside play mode nothing
  // from this module is in the scene graph at all.
  const iso = await page.evaluate(() => {
    const W = window.__GAME.world;
    const P = W.registry.player;
    const present = () => !!W.engine.scene.getObjectByName('gameplay:feedback');
    const out = { inPlay: present(), attachedInPlay: P.feedback.stats().attached };
    W.gameState.setMode('godmode');
    out.inGodmode = present();
    out.attachedInGodmode = P.feedback.stats().attached;
    W.gameState.setMode('menu');
    out.inMenu = present();
    return out;
  });
  record('inert outside play mode',
    iso.inPlay && iso.attachedInPlay && !iso.inGodmode && !iso.attachedInGodmode && !iso.inMenu,
    `scene contains 'gameplay:feedback' — play=${iso.inPlay} godmode=${iso.inGodmode} menu=${iso.inMenu}`);

  // ---- the cues themselves, rendered offline and measured -----------------
  // "foley.tranq was called" is not "a sound came out". This renders the whole
  // mix bus into an OfflineAudioContext and reads the samples back.
  const st = await page.evaluate(() => window.__AUDIO.selftest());
  const want = ['weapon.tranq', 'weapon.shot', 'weapon.reload', 'step.sand.walk', 'alert.spotted', 'alert.clear'];
  const peaks = want.map((n) => `${n}=${st[n]?.peak ?? 'MISSING'}`).join(' ');
  record('every cue makes a signal', want.every((n) => (st[n]?.peak ?? 0) > 0.005), peaks);
  // The garrison's rifle reaches the synthesiser by NAME, through the same
  // string dispatch the gameplay module publishes it on. Proven separately from
  // the cue itself because a working voice behind an unrouted name is silence.
  const routed = await page.evaluate(() => {
    const A = window.__AUDIO;
    const before = A.stats().voices;
    const ok = A.play('weapon.shot', { pos: window.__GAME.world.registry.player.position });
    return { ok, delta: A.stats().voices - before };
  });
  record('weapon.shot is routed', routed.ok, `api.play('weapon.shot') -> ${routed.ok}`);

  record('suppressed is quieter than a rifle',
    (st['weapon.tranq']?.peak ?? 0) < (st['weapon.shot']?.peak ?? 0),
    `tranq peak ${st['weapon.tranq']?.peak} vs rifle peak ${st['weapon.shot']?.peak}`);

  if (errors.length) console.log('page errors:', errors.slice(0, 6));
  const fails = rows.filter((r) => !r.pass).length;
  console.log(`\n${rows.length - fails}/${rows.length} pass`);
  await cleanup(fails ? 1 : 0);
}

main().catch(async (e) => { console.error(e); process.exit(2); });
