/**
 * r11_volcost.js — what src/render/volumetrics actually costs, and where.
 *
 * WHY THIS REPLACES probes/r11_vol.js. That probe had to ablate the pass by
 * pulling its systems out of `engine.systems` and hiding its meshes by
 * identity, because the pass had no switch. It measured 7.58 ms in one run and
 * 2.76 in another against null controls of 2.68 and 2.09, with the machine at
 * load 13.8 both times — a range, not a number. The pass now has
 * `registry.volumetrics.setEnabled()`, which removes the depth linearise, the
 * raymarch, the temporal resolve and the in-scene composite quad in one call
 * and DOES NOT touch `pipeline.enabled.aerial` — so the off configuration has
 * no haze at all rather than RenderPipeline's second one.
 *
 * Method is probes/r11_post.js's, and every part of it is load-bearing:
 *
 *  1. WARM = 64 frames per block. Flipping an ablation stalls for ~50 ms; a
 *     short warm-up amortises that stall into the measurement and reports it as
 *     a per-frame cost. That is how bloom got reported at 13, 17 and 20 ms in
 *     one round while actually costing nothing (commit 5e5fbac).
 *  2. A NULL CONTROL: `full` measured twice under two names, through the same
 *     flip. Whatever it reads is what this instrument charges for nothing.
 *     Nothing smaller than it is quoted as a number.
 *  3. The camera MOVES. A static pose skips clipmap updates, cascade refits and
 *     history invalidation, all of which a player pays for every frame.
 *
 * ARGS[0] = shot name (default 'vista' — the haze- and sky-dominated frame,
 * which is where this pass is most expensive and where the budget is decided).
 */
const g = window.__GAME;
const eng = g.engine;
const renderer = eng.renderer;
const gl = renderer.getContext();
const vol = g.world.registry.volumetrics;

if (!vol || !vol.setEnabled) return { error: 'volumetrics did not install, or is pre-round-11' };

const SHOT = ARGS[0] || 'vista';
const WARM = 64;
const N = 40;
const REPS = 5;

const pass = vol.pass;
const cam = eng.camera;
g.applyShot(SHOT);
const p0 = cam.position.clone();
const q0 = cam.quaternion.clone();
let t = 0;

function step() {
  t += 1 / 60;
  // A slow orbit plus a slow pan, around the shot's own pose rather than around
  // the world origin: this has to be the frame the budget is quoted for.
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
  return +((performance.now() - t0) / N).toFixed(2);
}

const AB = pass.ablate;
function base() {
  vol.setEnabled(true);
  AB.haze = false; AB.clouds = false; AB.deck = false;
  AB.cirrus = false; AB.shafts = false; AB.vsquash = false; AB.apGain = null;
  pass.steps.cloud = 96; pass.steps.light = 6; pass.steps.shaft = 24;
}

const CONFIGS = {
  full: () => base(),
  // The null control: identical to `full`, reached through the same flip.
  control: () => base(),
  // The whole module: raymarch, resolve, composite quad, dust and sand.
  noVolumetrics: () => { base(); vol.setEnabled(false); },
  // The pass alone; the particle layers stay.
  noPass: () => { base(); pass.setEnabled(false); },
  noParticles: () => { base(); vol.particles.setEnabled(false); },
  // Inside the pass, by loop. `deck` skips the cumulus march outright;
  // `clouds` leaves it walking an empty weather field, so the pair separates
  // the march's traversal cost from its shading cost.
  noDeckMarch: () => { base(); AB.deck = true; },
  noCloudCover: () => { base(); AB.clouds = true; },
  noLightMarch: () => { base(); pass.steps.light = 0; },
  noShafts: () => { base(); AB.shafts = true; },
  noCirrus: () => { base(); AB.cirrus = true; },
  noHaze: () => { base(); AB.haze = true; },
};

eng.deterministic = true;
eng.stop();
base();
block(); // settle the page once; discard

const samples = {};
for (const k of Object.keys(CONFIGS)) samples[k] = [];
for (let r = 0; r < REPS; r++) {
  for (const [k, apply] of Object.entries(CONFIGS)) {
    apply();
    samples[k].push(block());
  }
}
base();

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const out = {};
for (const [k, v] of Object.entries(samples)) {
  out[k] = { ms: med(v), runs: v, spread: +(Math.max(...v) - Math.min(...v)).toFixed(2) };
}
const floor = Math.abs(+(out.full.ms - out.control.ms).toFixed(2));
const cost = {};
for (const k of Object.keys(CONFIGS)) {
  if (k === 'full' || k === 'control') continue;
  const c = +(out.full.ms - out[k].ms).toFixed(2);
  cost[k.replace(/^no/, '')] = Math.abs(c) > floor ? `${c} ms` : `below noise (${c}, floor ${floor})`;
}

return {
  shot: SHOT,
  resolution: `${renderer.domElement.width}x${renderer.domElement.height}`,
  frameMs: out.full.ms,
  configs: out,
  nullControlMs: floor,
  worstBlockSpreadMs: +Math.max(...Object.values(out).map((o) => o.spread)).toFixed(2),
  costMs: cost,
  note: `WARM=${WARM} N=${N} REPS=${REPS}. The floor is the null control — the same ` +
    'configuration measured twice through the same flip. Sub-costs do not sum to the ' +
    'whole: turning one loop off lets the others reach further before their own break tests.',
};
