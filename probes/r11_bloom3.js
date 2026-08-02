/**
 * r11_bloom3.js — is the 12 ms the bloom PYRAMID, or the COMPOSITE's fetch?
 *
 * r11_bloom2.js measured the whole block at 12.32 ms and the bright pass — ONE
 * half-res blit — at 12.45 ms of it, with the upsample chain at MINUS 8.35.
 * Costs that do not add up mean the flag is gating something outside the thing
 * being measured, which is exactly failure #3 in tools/probes/perf.js's header.
 *
 * It is. `enabled.bloom` also swaps the composite's `tBloom`/`tStreak` between
 * two 960x540 half-float targets and the 1x1 default, and the composite samples
 * them UNCONDITIONALLY at a chromatically-aberrated UV. So "bloom off" was never
 * measuring the pyramid; it was measuring the pyramid AND two large texture
 * fetches in the most expensive full-resolution pass in the chain.
 *
 * This separates them. Every config below runs the pyramid identically; only the
 * composite changes.
 */
const g = window.__GAME;
const eng = g.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();

const WARM = 12;
const N = 40;
const REPS = 4;   // first discarded

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
  return (performance.now() - t0) / N;
}

const S = pipe.bloomStages;
const all = (v) => { S.blur = v; S.upsample = v; S.streak = v; };

const CONFIGS = {
  // shipping
  full: () => { pipe.enabled.bloom = true; all(true); S.compositeFetch = true; S.compositeAdd = true; },
  // pyramid runs, composite still FETCHES both targets, but adds nothing.
  // Isolates the arithmetic. Should be ~0 — if it is not, the adds are not free.
  noAdd: () => { pipe.enabled.bloom = true; all(true); S.compositeFetch = true; S.compositeAdd = false; },
  // pyramid runs identically, composite fetches the 1x1 default instead.
  // Isolates the two large texture fetches in the composite.
  noFetch: () => { pipe.enabled.bloom = true; all(true); S.compositeFetch = false; S.compositeAdd = true; },
  // composite unchanged from `full`, but the pyramid does only the bright pass.
  // Isolates the blur + upsample + streak work with the fetch held constant.
  noPyramid: () => { pipe.enabled.bloom = true; all(false); S.compositeFetch = true; S.compositeAdd = true; },
  // everything off, as `enabled.bloom = false` has always meant
  off: () => { pipe.enabled.bloom = false; all(true); S.compositeFetch = true; S.compositeAdd = true; },
};

eng.deterministic = true;
eng.stop();

const samples = {};
for (const k of Object.keys(CONFIGS)) samples[k] = [];
for (let r = 0; r < REPS; r++) {
  for (const [k, apply] of Object.entries(CONFIGS)) {
    apply();
    const ms = block();
    if (r > 0) samples[k].push(ms);
  }
}
CONFIGS.full();

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const out = {};
for (const [k, v] of Object.entries(samples)) out[k] = { ms: +med(v).toFixed(2), runs: v.map((x) => +x.toFixed(2)) };
const spread = Math.max(...Object.values(out).map((o) => Math.max(...o.runs) - Math.min(...o.runs)));
const d = (a, b) => +(out[a].ms - out[b].ms).toFixed(2);

return {
  resolution: `${renderer.domElement.width}x${renderer.domElement.height}`,
  configs: out,
  costMs: {
    compositeAddArithmetic: d('full', 'noAdd'),
    compositeTextureFetch: d('full', 'noFetch'),
    pyramidWork: d('full', 'noPyramid'),
    wholeFlag: d('full', 'off'),
  },
  worstSpreadMs: +spread.toFixed(2),
  caveat: 'anything smaller than worstSpreadMs is not resolvable by this run',
};
