#!/usr/bin/env node
/**
 * render.mjs — take screenshots. No daemon, no queue, no shared state.
 *
 *   node tools/render.mjs                          # every canonical shot
 *   node tools/render.mjs vista ground --out shots/mine
 *   node tools/render.mjs --width 1920 --height 1080
 *   node tools/render.mjs eval probe.js [args...]  # run a probe in the page
 *
 * WHY THIS REPLACED THE DAEMON.
 *
 * The daemon existed to keep worlds warm, because generating one cost 17 s and
 * paying that per screenshot was intolerable. That premise died twice over:
 *
 *   1. The terrain simulation — 11.6 s of the 17 s — is now baked through
 *      GenCache, so a cold world is ~4.6 s.
 *   2. Agents edit source constantly, so nearly every request invalidated the
 *      warm world anyway. The hit rate the design assumed never existed:
 *      measured 40% of requests paid a full rebuild.
 *
 * What the shared daemon did buy was a single point of failure and a queue.
 * Measured with seven agents against it: queue depth 20, p50 wait 302 s,
 * p50 total 360 s, and 29 errors against 9 completions — including a race I
 * introduced where two callers built the same world and one nulled the other's
 * server handle. Worlds also evicted each other continuously, because a cap
 * chosen for RAM (5) was below the number of concurrent authors (7).
 *
 * A private, short-lived chromium per invocation removes all of it: no lock, no
 * eviction, no cross-tree contamination, no daemon whose behaviour depends on
 * which checkout started it. Seven agents rarely render at the same instant, and
 * when they do the OS schedules them better than a hand-rolled queue did.
 *
 * The cost is the ~4.6 s world build per invocation, which is why this batches:
 * ask for every shot you want in ONE command and they all share one page.
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

/**
 * Installed into the page as `window.__pinDeterminism()` and run immediately
 * before every `settle()`.
 *
 * `settle()` in main.js already rewinds the pipeline frame counter (TAA jitter
 * phase, AO rotation, grain seed) and `engine.elapsed`. That is not sufficient:
 * several things integrate their own clock and survive a settle, so a shot
 * depended on how many frames the page happened to have drawn before it.
 *
 * Measured (tools/probes/determinism.js, gameplay, 640x360 centre window), two
 * captures of the same shot with a camera excursion between them:
 *
 *   nothing pinned                        rms 5.20   max 134 codes   85% of pixels
 *   what settle() pins today              rms 2.53   max 108         33%
 *   + character animation clocks          rms 1.10   max  42         28%
 *   + shadow cascade refresh phase        rms 0.77   max  33         25%
 *   + TAA and exposure history, 32 frames rms 0.23   max   9          4%
 *
 * The dominant term is `src/characters/anim.js`: every `Animator` seeds `t`,
 * `phase` and `breath` from `Math.random()` and integrates them forever, so the
 * garrison and its cast shadows were in a different pose in every run. An 11x
 * drop in the noise floor is the difference between "this A/B shows no visual
 * change" being a finding and being unfalsifiable.
 *
 * Defensive throughout — a tree where a module failed to install still shoots.
 */
const PIN_SRC = `
window.__pinDeterminism = function () {
  const g = window.__GAME;
  if (!g) return { pinned: false };
  const eng = g.engine;
  const pipe = eng.pipeline;
  const out = { animators: 0, taa: false, exposure: false, shadows: false };

  const list = g.world && g.world.registry && g.world.registry.characters
    ? g.world.registry.characters.characters : null;
  if (Array.isArray(list)) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i] && list[i].anim;
      if (!a) continue;
      // Fixed but per-index, so the crowd does not idle in lockstep.
      a.t = 7.31 * i + 3.5;
      a.phase = (0.6180339887 * (i + 1)) % 1;
      a.breath = 2.17 * i + 1.1;
      a.hitTime = 1e3;
      if (a.loco) {
        a.loco.smoothSpeed = a.loco.speed || 0;
        a.loco.stanceBlend = a.loco.stance === 'crouch' ? 1 : 0;
        a.loco.proneBlend = a.loco.stance === 'prone' ? 1 : 0;
      }
      a.bobY = 0;
      if (a.weaponSway && a.weaponSway.set) a.weaponSway.set(0, 0, 0);
      if (a.weaponSwayVel && a.weaponSwayVel.set) a.weaponSwayVel.set(0, 0, 0);
      if (a.lookBlend && a.lookBlend.set) a.lookBlend.set(0, 0);
      out.animators++;
    }
  }

  if (pipe) {
    const r = eng.renderer;
    // The history flag alone is not enough: it stops the NEXT frame reading
    // history, but the buffers still hold the previous shot's image and are
    // read again from frame 2 on.
    if ('_historyValid' in pipe) { pipe._historyValid = false; out.taa = true; }
    for (const name of ['taaA', 'taaB', 'adaptA', 'adaptB']) {
      const rt = pipe[name];
      if (!rt) continue;
      r.setRenderTarget(rt);
      r.clear(true, false, false);
      if (name === 'adaptA') out.exposure = true;
    }
    r.setRenderTarget(null);
  }

  // Cascades 1+ refresh on a schedule keyed to a free-running counter, so which
  // ones are fresh depended on the page's frame count.
  const lighting = g.world && g.world.lighting;
  if (lighting && typeof lighting.invalidateShadows === 'function') {
    lighting.invalidateShadows();
    out.shadows = true;
  }

  // The volumetric pass keeps its OWN temporal history — a half-resolution
  // reprojected cloud/haze buffer with a reset flag — and nothing above
  // touches it, because it is an engine SYSTEM rather than a pipeline pass.
  //
  // Measured: the same source, same shot, run three times, gave vista mean
  // R = 145.3, 151.6 and 153.9. Two single-shot runs agreed exactly (153.9),
  // so the build is deterministic given the same history state; what varied
  // was how far the haze had converged, which depends on how many frames the
  // page happened to draw before the shot. That is a 6% swing in the frame's
  // own mean — larger than most of the effects nine rounds have been trying to
  // A/B on this exact shot. The ground shot, which is near-field, was stable
  // to 0.1 over the same runs, which is why this went unnoticed: it only bites
  // the shots dominated by distance haze, i.e. the establishing frames.
  //
  // Forcing the reset makes the shot a function of the source again. The
  // history then reconverges over settle()'s frames from a known state.
  // (No backticks anywhere in here: PIN_SRC is a JS template literal.)
  const volPass = g.world && g.world.registry && g.world.registry.volumetrics
    ? g.world.registry.volumetrics.pass : null;
  if (volPass && '_reset' in volPass) {
    volPass._reset = 1;
    volPass._lastCamPos = undefined;
    out.volumetrics = true;
  }
  return out;
};
`;

import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const o = {
    shots: [], dir: 'shots', width: 1920, height: 1080, frames: 8,
    mode: 'shot', probe: null, probeArgs: [],
    filmFrames: 48, filmEvery: 2, filmSpeed: 1,
  };
  if (argv[0] === 'film') {
    o.mode = 'film';
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--out') o.dir = argv[++i];
      else if (a === '--width') o.width = +argv[++i];
      else if (a === '--height') o.height = +argv[++i];
      else if (a === '--frames') o.filmFrames = +argv[++i];
      else if (a === '--every') o.filmEvery = +argv[++i];
      else if (a === '--speed') o.filmSpeed = +argv[++i];
      else if (!a.startsWith('--')) o.shots.push(a);
    }
    return o;
  }
  if (argv[0] === 'eval') {
    o.mode = 'eval';
    o.probe = argv[1];
    // Keep parsing: --width/--height matter for a probe too, and returning
    // early here meant every eval silently ran at the default 1920x1080 no
    // matter what was asked for — which is exactly how a viewport-dependent
    // layout bug stays invisible.
    o.probeArgs = [];
    for (let i = 2; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--width') o.width = +argv[++i];
      else if (a === '--height') o.height = +argv[++i];
      else o.probeArgs.push(a);
    }
    return o;
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.dir = argv[++i];
    else if (a === '--width') o.width = +argv[++i];
    else if (a === '--height') o.height = +argv[++i];
    else if (a === '--frames') o.frames = +argv[++i];
    else if (a === '--hide') o.hide = (o.hide ?? []).concat(argv[++i].split(','));
    else if (!a.startsWith('--')) o.shots.push(a);
  }
  return o;
}

const freePort = () =>
  new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

/** Bundle once. Fails fast with the file and line, in ~3 s, not a 25 s page load. */
function bundle() {
  const t0 = Date.now();
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'warn'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000,
    });
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    console.error(`build failed:\n${out.slice(0, 3000)}`);
    process.exit(3);
  }
  return Date.now() - t0;
}

async function serve() {
  const port = await freePort();
  const proc = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  // Detached so we can kill the whole group, which means it can also outlive us.
  // Watchdog: if our pid disappears, the server exits on its own within 10 s.
  const parent = process.pid;
  const watchdog = setInterval(() => {
    try { process.kill(parent, 0); } catch {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
      clearInterval(watchdog);
    }
  }, 10000);
  watchdog.unref();
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return { proc, port };
    } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 80));
  }
  try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
  throw new Error(`preview server failed to start:\n${log}`);
}

/**
 * Reap orphans before starting.
 *
 * render.mjs kills its own process tree on exit, but it cannot do that if IT is
 * SIGKILLed — and then its vite server and chromium survive with ppid 1, holding
 * memory forever. Sixteen chromium processes and eight vite servers accumulated
 * that way in one session, 4.1 GB of a shared machine.
 *
 * So every run sweeps first. An orphan is a vite or chromium that (a) belongs to
 * this project, and (b) has been reparented to init, which means the thing that
 * started it is gone and nobody is ever coming back for it. That test is safe on
 * a shared machine: another author's LIVE process still has a live parent.
 */
function reapOrphans() {
  try {
    const ps = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' });
    let reaped = 0;
    for (const line of ps.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const [, pid, ppid, args] = m;
      if (ppid !== '1') continue;                       // has a live parent: not ours to judge
      if (!/vite\/bin\/vite\.js|chrome-headless-shell/.test(args)) continue;
      if (!args.includes('metal-gear-solid-5-opus-demo') &&
          !/chrome-headless-shell/.test(args)) continue;
      try { process.kill(+pid, 'SIGKILL'); reaped++; } catch { /* already gone */ }
    }
    if (reaped) console.error(`reaped ${reaped} orphaned process(es) from a previous run`);
  } catch { /* ps unavailable: not worth failing a render over */ }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  reapOrphans();
  const t0 = Date.now();
  const bundleMs = bundle();

  const server = await serve();
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--force-device-scale-factor=1', '--mute-audio', '--hide-scrollbars'],
  });

  const errors = [];
  const page = await browser.newPage({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1 });

  /**
   * Cap console arguments INSIDE the page, before they reach CDP.
   *
   * One undeclared uniform used to take the whole harness down with
   * `ERR_STRING_TOO_LONG` out of playwright's pipe transport, and the stack
   * pointed at node's Buffer.toString rather than at anything in this project —
   * so the failure mode of a one-word GLSL typo was a render tool that looked
   * broken. three.js logs the ENTIRE annotated shader source on a compile
   * failure, our terrain shader is ~3000 lines, and it re-logs on every frame
   * for every material that failed: past 512 MB in a single CDP message the
   * transport cannot even turn it into a string.
   *
   * Truncating here rather than in the `console` handler is deliberate — by the
   * time a handler runs, the oversized message has already been through the
   * pipe. 2 KB is enough to carry three.js's header and its first `ERROR: 0:NNN`
   * line, which is the part that names the bug.
   */
  await page.addInitScript(() => {
    const CAP = 2048;
    const cap = (a) => {
      try {
        const s = typeof a === 'string' ? a : String(a);
        return s.length > CAP ? `${s.slice(0, CAP)}…[+${s.length - CAP} chars truncated]` : s;
      } catch { return '<unstringifiable>'; }
    };
    for (const k of ['log', 'warn', 'error', 'info', 'debug']) {
      const orig = console[k].bind(console);
      console[k] = (...args) => orig(...args.map(cap));
    }
  });

  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', async (r) => {
    if (r.status() >= 400) errors.unshift(`${r.status()} ${r.url()}`);
  });

  // Hard cleanup. A headless chromium is a process TREE (zygote, gpu, renderers);
  // browser.close() alone left 18 of them behind across seven runs, which is how
  // the machine ended up at load 20. Close politely, then make sure.
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

  const tLoad = Date.now();
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'load', timeout: 120000 });
  try {
    await page.waitForFunction(() => window.__GAME?.ready === true, { timeout: 180000 });
  } catch {
    console.error('build is broken — the page never became ready:');
    for (const e of errors.slice(0, 10)) console.error('  ' + e);
    await cleanup(2);
  }
  const loadMs = Date.now() - tLoad;
  await page.evaluate(PIN_SRC);

  // Take the discoverability card out of the photograph.
  //
  // index.html's CONTROLS card demotes itself to a title bar after 12 s, and a
  // shot lands long before that — so it was burned into all seven canonical
  // frames, covering ~8% of the image including the top-left of the vista.
  // Every blind A/B against real MGSV frames so far was run with a debug
  // overlay in shot, which is a handicap the renderer never earned. It is a
  // harness concern, not a game one: a player still gets the card.
  await page.evaluate(() => {
    document.getElementById('controls-card')?.remove();
    // And the boot overlay, which is the real reason the vista shot has never
    // been reproducible.
    //
    // #boot is a full-screen #0a0b0c panel that fades out over a 420 ms CSS
    // opacity transition and is NEVER removed from the DOM. `ready` and the
    // fade start together, so the first screenshot of a run lands inside it.
    // readPixels reads the CANVAS; page.screenshot() composites the PAGE. That
    // is the whole discrepancy: in-page readPixels of the identical sequence
    // gave 154.16 twelve times out of twelve, while six screenshot runs gave
    // 154.1, 154.1, 133.1, 154.1, 146.7, 154.2 -- always dimmer, never
    // brighter, a continuum rather than two states. canvas*(1-a) + 10*a
    // predicts 146.9 / 139.7 / 133.2 at a = 0.05 / 0.10 / 0.145 against 146.7 /
    // 139.3 / 133.1 measured.
    //
    // I diagnosed this wrong first and it is worth recording why: I blamed the
    // volumetric pass's temporal history, "fixed" it by resetting that history,
    // and made the 8-frame case WORSE (spread 30 against 8.6) because the reset
    // starts the haze cold. Every symptom fitted -- it only bit the shots
    // dominated by distance haze, because those are the ones whose FIRST shot
    // is the establishing frame. The shot that is dimmed is simply the first
    // one taken, and vista is first in every batch.
    document.getElementById('boot')?.remove();
  });

  if (opts.mode === 'eval') {
    const src = await readFile(path.resolve(opts.probe), 'utf8');
    const result = await page.evaluate(
      new Function('ARGS', `return (async () => { ${src} })()`),
      opts.probeArgs,
    );
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    if (errors.length) {
      console.error('\npage errors:');
      for (const e of errors.slice(0, 10)) console.error('  ' + e);
    }
    await cleanup(0);
  }

  if (opts.mode === 'film') {
    /**
     * Film a shot with the camera MOVING, one PNG per sampled frame.
     *
     * This exists because of the single most expensive lesson in this project:
     * every defect a human actually complained about — the swirling moire, the
     * smearing, the cloud loop, the stippled shadow edges — was invisible in the
     * seven static camera poses nine rounds were optimised against. A still
     * frame cannot show a temporal artefact, and three of the open defects are
     * suspected temporal (the shadow cascades refresh on a [1,3,6,12] schedule,
     * so under a moving camera two thirds of them are stale on any given frame).
     *
     * Deliberately NOT pinned per frame. `__pinDeterminism` is run once at the
     * start so the garrison is in a known pose, and then the sim is left to run:
     * pinning every frame would reset exactly the temporal state — TAA history,
     * AO rotation, cascade refresh phase — that this is here to photograph.
     */
    const outDir = path.resolve(ROOT, opts.dir);
    await mkdir(outDir, { recursive: true });
    const name = opts.shots[0] ?? 'ground';
    await page.evaluate((n) => {
      const g = window.__GAME;
      g.applyShot(n);
      if (window.__pinDeterminism) window.__pinDeterminism();
      const eng = g.engine;
      eng.deterministic = true;
      eng.stop();
      // Remember the pose so each step is measured from it rather than
      // integrating float error over a hundred frames.
      window.__FILM = { p: eng.camera.position.clone(), q: eng.camera.quaternion.clone(), t: 0 };
    }, name);
    const digits = String(opts.filmFrames).length;
    for (let i = 0; i < opts.filmFrames; i++) {
      await page.evaluate(
        ({ every, speed }) => {
          const g = window.__GAME;
          const eng = g.engine;
          const THREE = g.THREE;
          const f = window.__FILM;
          // A slow truck plus a slow pan: translation exercises the clipmap
          // rings and the LOD boundary, rotation exercises TAA reprojection and
          // the cascade refits. Doing only one of them hides half the defects.
          for (let k = 0; k < every; k++) {
            f.t += (1 / 60) * speed;
            const yaw = Math.sin(f.t * 0.22) * 0.16;
            const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
            eng.camera.quaternion.copy(q).multiply(f.q);
            eng.camera.position.copy(f.p);
            eng.camera.position.x += Math.sin(f.t * 0.35) * 3.2;
            eng.camera.position.z += (Math.cos(f.t * 0.35) - 1) * 3.2;
            eng.step(1 / 60);
            eng.render();
          }
        },
        { every: opts.filmEvery, speed: opts.filmSpeed },
      );
      const file = path.join(outDir, `f${String(i).padStart(digits, '0')}.png`);
      await writeFile(file, await page.screenshot({ type: 'png' }));
    }
    console.log(
      `filmed ${opts.filmFrames} frames of "${name}" ` +
        `(${opts.filmEvery} sim frames apart) -> ${path.relative(ROOT, outDir)}`,
    );
    if (errors.length) {
      console.error('\npage errors:');
      for (const e of errors.slice(0, 10)) console.error('  ' + e);
    }
    await cleanup(errors.length ? 1 : 0);
  }

  // --hide <substr>[,<substr>] — shoot the scene with matching meshes hidden.
  //
  // "Which system draws that?" is asked constantly here and has been answered
  // by reading source and guessing. Answering it by DIFFERENCE needs an A/B of
  // the same frame, and a probe cannot take a screenshot. Doing it statistically
  // from inside the page was tried first and does not work: hiding meshes
  // perturbs the AO and the volumetric history, so a baseline-against-baseline
  // control still came back 12% of the ground band changed — larger than most
  // of the groups being separated. Two PNGs and a pair of eyes settles in
  // seconds what the statistic could not settle at all, which is what this
  // project's own rule about judging by eye rather than by histogram says.
  if (opts.hide?.length) {
    const hidden = await page.evaluate((subs) => {
      const names = [];
      window.__GAME.world.scene.traverse((o) => {
        if (!(o.isMesh || o.isInstancedMesh || o.isPoints)) return;
        const tag = ((o.name || '') + ' ' + (o.material?.name || '')).toLowerCase();
        if (subs.some((s) => tag.includes(s.toLowerCase()))) {
          o.visible = false;
          names.push(o.name || '(unnamed)');
        }
      });
      return names;
    }, opts.hide);
    console.log(`hidden: ${hidden.length} mesh(es) matching ${opts.hide.join(',')}`);
    if (!hidden.length) console.error(`  WARNING: nothing matched — the shot below is unmodified`);
  }

  const outDir = path.resolve(ROOT, opts.dir);
  await mkdir(outDir, { recursive: true });
  const all = await page.evaluate(() => Object.keys(window.__GAME.shots));
  const wanted = opts.shots.length ? opts.shots.filter((s) => all.includes(s)) : all;
  const report = { renderer: '', shots: {}, errors: [] };
  report.renderer = await page.evaluate(() => {
    const gl = window.__GAME.engine.renderer.getContext();
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  console.log(`renderer: ${report.renderer}`);

  for (const name of wanted) {
    const t = Date.now();
    const meta = await page.evaluate(
      ({ name, frames }) => {
        const g = window.__GAME;
        const s = g.applyShot(name);
        // Pin AFTER the pose is set (invalidateShadows wants the final camera)
        // and before settle, so the frame is a function of the source alone.
        const pinned = window.__pinDeterminism ? window.__pinDeterminism() : null;
        // Resetting the volumetric history is only half the job: it starts the
        // haze COLD, and 8 frames catch it mid-convergence, which measured
        // worse than not resetting at all (vista mean R spread 30 against 8.6).
        // Reset plus enough frames to reconverge from that known state is what
        // actually helps -- spread 2.9 at 32 frames. Still not zero: the cloud
        // deck also evolves on its own clock, which settle() does not rewind,
        // and that clock belongs to src/render/volumetrics. Documented rather
        // than hidden, because a 2% floor on this shot is still smaller than
        // most of what gets A/B'd on it, and 6% was not.
        g.settle(pinned && pinned.volumetrics ? Math.max(frames, 32) : frames);
        return { note: s.note, tod: s.tod, pinned, stats: g.stats() };
      },
      { name, frames: opts.frames },
    );
    const file = path.join(outDir, `${name}.png`);
    await writeFile(file, await page.screenshot({ type: 'png' }));
    const ms = Date.now() - t;
    report.shots[name] = { file: path.relative(ROOT, file), ms, ...meta };
    console.log(
      `  ${name.padEnd(10)} ${meta.tod.padEnd(10)} ${String(ms).padStart(5)}ms ` +
        `calls=${String(meta.stats.calls).padStart(4)} tris=${String(meta.stats.triangles).padStart(8)} -> ${path.relative(ROOT, file)}`,
    );
  }

  report.errors = errors;
  report.timing = { bundleMs, loadMs, totalMs: Date.now() - t0 };
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${wanted.length} shot(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s  (bundle ${(bundleMs / 1000).toFixed(1)}s, world ${(loadMs / 1000).toFixed(1)}s)`);

  if (errors.length) {
    console.error(`\n${errors.length} page error(s):`);
    for (const e of errors.slice(0, 20)) console.error('  ' + e);
    await cleanup(1);
  }
  await cleanup(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
