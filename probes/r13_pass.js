/**
 * r13_pass.js — what one pass costs, without ever flipping a flag mid-measure.
 *
 *   node tools/shot.mjs eval probes/r13_pass.js <flag>
 *
 * The project's own rule is that flipping an ablation flag stalls ~50 ms and
 * that perf.js's adjacent-pair flipping is therefore worthless. That rule bans
 * flipping DURING a measurement; it does not ban measuring a build that had a
 * flag turned off before it ever warmed up. This sets the flag ONCE, before the
 * first of 48 warm frames, and then runs r13_frame's protocol untouched — so
 * the stall is absorbed by the warm-up and every measured block is one steady
 * configuration.
 *
 * Run it once per flag; each invocation is a fresh page. Compare against the
 * `none` run from the same sitting, and only believe a difference larger than
 * the two IQRs.
 */
const g = window.__GAME;
const eng = g.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();

const FLAG = (typeof ARGS !== 'undefined' && ARGS && ARGS[0]) || 'none';

const WARM = 48;
const N = 40;
const REPS = 9;
const K = 24;

g.applyShot('gameplay');
eng.deterministic = true;
eng.stop();
pipe.enabled.dof = true;

// --- the one and only state change, before anything is warmed -------------
let applied = FLAG;
if (FLAG === 'none') {
  applied = 'none';
} else if (FLAG === 'volumetrics') {
  const vol = g.world.registry.volumetrics;
  if (vol?.pass) vol.pass.enabled = false;
  for (const sys of eng.systems ?? []) {
    if (/volumetric/i.test(sys.name ?? '')) sys.enabled = false;
  }
  g.world.scene.traverse((o) => { if (/volumetric/i.test(o.name || '')) o.visible = false; });
} else if (FLAG in pipe.enabled) {
  pipe.enabled[FLAG] = false;
} else {
  applied = `UNKNOWN:${FLAG}`;
}

const cam = eng.camera;
const start = cam.position.clone();
let t = 0;
function ballast(k) {
  for (let i = 0; i < k; i++) {
    renderer.setRenderTarget(i & 1 ? pipe.taaA : pipe.taaB);
    renderer.clear(true, false, false);
  }
  renderer.setRenderTarget(null);
}
function step() {
  t += 1 / 60;
  cam.position.set(start.x + Math.sin(t * 0.6) * 6, start.y, start.z + Math.cos(t * 0.6) * 6);
  cam.lookAt(0, 2, 0);
  eng.step(1 / 60);
  eng.render();
  ballast(K);
}
function block() {
  for (let i = 0; i < WARM; i++) step();
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) step();
  gl.finish();
  return +((performance.now() - t0) / N).toFixed(2);
}

block();
const runs = [];
for (let i = 0; i < REPS; i++) runs.push(block());
const s = [...runs].sort((a, b) => a - b);
const q = (f) => s[Math.min(s.length - 1, Math.round(f * (s.length - 1)))];

return {
  flag: applied,
  medianMs: q(0.5),
  iqrMs: +(q(0.75) - q(0.25)).toFixed(2),
  runs,
};
