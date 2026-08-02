/**
 * r11_volsteps.js — what the round-11 savings are worth, and what the deck costs.
 *
 * ## The instrument this probe used to be, and why it was thrown away
 *
 * The pass's three private blits run in `update()`, not in `render()`, so they
 * can be called on their own and timed on their own with a gl.finish() either
 * side — 22 ms of frame simply not in the measurement. That is a lovely idea and
 * it does not work on this machine. Timing 200 bare `pass.update()` calls that
 * way returned blocks of 0.012-0.016 ms per update — a 200-update block costing
 * 3 ms in total — sitting beside blocks of 2.9 ms per update in the SAME
 * configuration. A driver does not run the same shader 200x faster on some
 * reps. What it does do is defer: with no `render()` between them there is
 * nothing forcing a command-buffer commit, and glFinish on an encoder that was
 * never committed returns immediately, so the work lands in the NEXT block. The
 * near-zero blocks and the inflated ones are the same work, counted twice in
 * the wrong places.
 *
 * That is this project's oldest bug wearing a new hat: "a budget that timed
 * enqueued frames and reported 2.7 ms for a 40 ms frame". Taking the MINIMUM
 * over reps — which looks like the right defence on a shared machine, since
 * contention can only add time — selects for exactly the degenerate blocks and
 * made ten of eleven configurations read 0.013 ms. Both are recorded here so
 * nobody rebuilds it.
 *
 * ## What this measures instead
 *
 * Whole frames, through `eng.render()`, which does force a commit — the method
 * of probes/r11_post.js and probes/r11_volcost.js, with the rep count raised
 * because the effects here are sub-millisecond. WARM = 64 to absorb the flip
 * stall, a NULL CONTROL (the same configuration under two names, reached
 * through the same flip), and a moving camera.
 *
 * ARGS[0] = shot (default 'vista').
 */
const g = window.__GAME;
const eng = g.engine;
const renderer = eng.renderer;
const gl = renderer.getContext();
const vol = g.world.registry.volumetrics;
if (!vol || !vol.pass) return { error: 'volumetrics did not install' };
const pass = vol.pass;
const AB = pass.ablate;

const SHOT = ARGS[0] || 'vista';
const WARM = 64;
const N = 40;
const REPS = 7;

const cam = eng.camera;
eng.deterministic = true;
eng.stop();
g.applyShot(SHOT);
const p0 = cam.position.clone();
const q0 = cam.quaternion.clone();
let t = 0;

function step() {
  t += 1 / 60;
  cam.position.set(p0.x + Math.sin(t * 0.6) * 6, p0.y, p0.z + Math.cos(t * 0.6) * 6);
  cam.quaternion.copy(q0);
  cam.rotateY(Math.sin(t * 0.35) * 0.05);
  eng.step(1 / 60);
  eng.render();
}
function block() {
  for (let i = 0; i < WARM; i++) step();
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) step();
  gl.finish();
  return +((performance.now() - t0) / N).toFixed(3);
}

function base() {
  pass.setEnabled(true);
  AB.haze = false; AB.clouds = false; AB.deck = false;
  AB.cirrus = false; AB.shafts = false; AB.vsquash = false; AB.apGain = null;
  pass.steps.cloud = 96; pass.steps.light = 6; pass.steps.shaft = 24;
  pass.params.cloudStreak = 0.0;
  pass.compositeMesh.visible = true;
  pass.compositeMat.uniforms.uFastUpsample.value = 1;
}

const CONFIGS = {
  full: () => base(),
  control: () => base(),
  // --- what round 11 changed, priced by putting it BACK -------------------
  // The upsample fast path off: nine full-res fetches per pixel on every pixel
  // instead of five on the ~all of them with no silhouette in the footprint.
  slowUpsample: () => { base(); pass.compositeMat.uniforms.uFastUpsample.value = 0; },
  // weatherAt's discarded second tWeather fetch back. 0.002 takes the other
  // side of the uniform branch at a streak strength too small to move a pixel.
  streakFetchBack: () => { base(); pass.params.cloudStreak = 0.002; },
  // --- where the pass's own time goes ------------------------------------
  noDeckMarch: () => { base(); AB.deck = true; },
  noLightMarch: () => { base(); pass.steps.light = 0; },
  noHaze: () => { base(); AB.haze = true; },
  noComposite: () => { base(); pass.compositeMesh.visible = false; },
  noPass: () => { base(); pass.setEnabled(false); },
};

base();
block(); // settle the page once; discard

const samples = {};
for (const k of Object.keys(CONFIGS)) samples[k] = [];
for (let r = 0; r < REPS; r++) {
  for (const [k, apply] of Object.entries(CONFIGS)) { apply(); samples[k].push(block()); }
}
base();

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const out = {};
for (const [k, v] of Object.entries(samples)) {
  out[k] = { ms: med(v), runs: v, spread: +(Math.max(...v) - Math.min(...v)).toFixed(3) };
}
const floor = Math.abs(+(out.full.ms - out.control.ms).toFixed(3));
const cost = {};
for (const k of Object.keys(CONFIGS)) {
  if (k === 'full' || k === 'control') continue;
  const c = +(out.full.ms - out[k].ms).toFixed(3);
  cost[k] = Math.abs(c) > floor ? `${c} ms` : `below noise (${c}, floor ${floor})`;
}

return {
  shot: SHOT,
  resolution: `${renderer.domElement.width}x${renderer.domElement.height}`,
  frameMs: out.full.ms,
  configs: out,
  nullControlMs: floor,
  worstBlockSpreadMs: +Math.max(...Object.values(out).map((o) => o.spread)).toFixed(3),
  // Sign convention: positive means `full` is SLOWER than the configuration, so
  // for the two "put it back" rows a NEGATIVE number is the round-11 saving.
  deltaMs: cost,
  note: `WARM=${WARM} N=${N} REPS=${REPS}. slowUpsample and streakFetchBack are the ` +
    'round-11 changes put BACK, so their delta is negative by exactly what was saved.',
};
