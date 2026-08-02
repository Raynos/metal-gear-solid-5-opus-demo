/**
 * r11_composite.js — price the composite's own features.
 *
 * probes/results/r11-fill.json puts 18.67 ms of a 26.44 ms frame in per-pixel
 * work, and probes/results/r11-post.json can only reach ~3.4 ms of it with the
 * flags that exist. The composite is the prime suspect for the rest: it is one
 * full-resolution pass with SEVEN samplers that also does chromatic aberration
 * as three separate fetches of the scene, a manual 32^3 LUT as two dependent
 * fetches with a lerp across blue slices, a depth fetch for distance-faded
 * grain, and the whole ACES + grade + split-tone + bleach + vignette chain.
 *
 * Method is r11_post.js's: WARM 64 frames so the flip stall is absorbed rather
 * than amortised, and a null control that is the same configuration measured
 * twice through the same flip. Nothing smaller than the control is real.
 *
 * These are PRICES, not proposals. Chromatic aberration and the LUT are both
 * part of the look; knowing what they cost is what makes dropping or keeping
 * them a decision instead of a guess.
 */
const g = window.__GAME;
const eng = g.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();

const WARM = 64;
const N = 40;
const REPS = 3;

const cam = eng.camera;
const start = cam.position.clone();
let t = 0;
function step() {
  t += 1 / 60;
  cam.position.set(start.x + Math.sin(t * 0.6) * 6, start.y, start.z + Math.cos(t * 0.6) * 6);
  cam.lookAt(0, 2, 0);
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

const cu = pipe.compositeMat.uniforms;
const gr = pipe.grade;

// `uCA` and `uGrain` ARE rewritten every frame from `this.grade` (render() line
// ~3246/3250), so a probe must write the grade or be silently reverted -- the
// trap the `ablate` object exists to avoid. `uLutStrength` is NOT rewritten; it
// is set once at construction, so it can be written directly.
const GREF = { ca: gr.chromaticAberration, grain: gr.grainAmount };
const LREF = cu.uLutStrength.value;

const set = ({ ca, grain, lut }) => {
  gr.chromaticAberration = ca !== undefined ? ca : GREF.ca;
  gr.grainAmount = grain !== undefined ? grain : GREF.grain;
  cu.uLutStrength.value = lut !== undefined ? lut : LREF;
};

// NOTE: the shipping value of chromaticAberration is 0.0 (ArtDirection.js:248).
// Before the uniform branch added in this round, uCA = 0 still did all THREE
// scene fetches at a zero offset -- an effect that is switched off, paid for in
// full, every frame. So `caOn` here is not "what CA costs to add", it is what
// the build was already paying for nothing.
const CONFIGS = {
  full: () => set({}),                    // shipping: CA off => one fetch now
  control: () => set({}),                 // null control
  caOn: () => set({ ca: 0.0015 }),        // three fetches, as before the branch
  noLUT: () => set({ lut: 0 }),           // two dependent fetches + slice lerp
  noGrain: () => set({ grain: 0 }),       // depth fetch + noise
};

eng.deterministic = true;
eng.stop();
CONFIGS.full();
block();

const samples = {};
for (const k of Object.keys(CONFIGS)) samples[k] = [];
for (let r = 0; r < REPS; r++) {
  for (const [k, apply] of Object.entries(CONFIGS)) {
    CONFIGS.full();          // always return to the reference first, so each
    apply();                 // config differs from `full` by exactly one thing
    samples[k].push(block());
  }
}
CONFIGS.full();

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
  frameMs: out.full.ms,
  gradeReference: GREF,
  lutReference: LREF,

  configs: out,
  nullControlMs: floor,
  worstBlockSpreadMs: +Math.max(...Object.values(out).map((o) => o.spread)).toFixed(2),
  costMs: cost,
};
