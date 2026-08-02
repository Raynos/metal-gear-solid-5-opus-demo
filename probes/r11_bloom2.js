/**
 * r11_bloom2.js — WHICH part of the bloom block costs 13-20 ms?
 *
 * Increments between neighbouring configs, which is the only method this
 * project's perf probe trusts. Each config adds one stage to the previous one,
 * so the cost of a stage is the difference to its neighbour, and every config is
 * measured the same number of times round-robin so drift lands on all of them.
 *
 * The obvious model is already known to be wrong: bloomMips 2 costs 19.2 ms,
 * 3 costs 27.4 and 6 costs 25.7 (probes/r11_bloom.js). That is not a fragment
 * count, so the answer is a stage, a format, or a bandwidth wall — not "too many
 * levels".
 */
const g = window.__GAME;
const eng = g.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();

const WARM = 12;   // the FIRST block of any config reads ~9 ms against a settled
const N = 40;      // 26 — enqueued frames, failure #5 in perf.js's header
const REPS = 4;    // 4 reps, first discarded

const cam = eng.camera;
const start = cam.position.clone();
let t = 0;

function block() {
  for (let i = 0; i < WARM; i++) step();
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) step();
  gl.finish();
  return (performance.now() - t0) / N;
}
function step() {
  t += 1 / 60;
  cam.position.set(start.x + Math.sin(t * 0.6) * 6, start.y, start.z + Math.cos(t * 0.6) * 6);
  cam.lookAt(0, 2, 0);
  eng.step(1 / 60);
  eng.render();
}

const S = pipe.bloomStages;
const CONFIGS = {
  // 1. no bloom block at all
  off: () => { pipe.enabled.bloom = false; },
  // 2. + the bright pass (one half-res blit) and nothing else
  bright: () => { pipe.enabled.bloom = true; S.blur = false; S.upsample = false; S.streak = false; },
  // 3. + the 6-level separable blur pyramid
  blur: () => { pipe.enabled.bloom = true; S.blur = true; S.upsample = false; S.streak = false; },
  // 4. + the upsample chain
  upsample: () => { pipe.enabled.bloom = true; S.blur = true; S.upsample = true; S.streak = false; },
  // 5. + the 3 x 17-tap anamorphic streak = shipping config
  full: () => { pipe.enabled.bloom = true; S.blur = true; S.upsample = true; S.streak = true; },
};

eng.deterministic = true;
eng.stop();

const samples = {};
for (const k of Object.keys(CONFIGS)) samples[k] = [];
for (let r = 0; r < REPS; r++) {
  for (const [k, apply] of Object.entries(CONFIGS)) {
    apply();
    const ms = block();
    if (r > 0) samples[k].push(ms);   // discard rep 0: the queue is not saturated
  }
}
CONFIGS.full();

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const out = {};
for (const [k, v] of Object.entries(samples)) {
  out[k] = { ms: +med(v).toFixed(2), runs: v.map((x) => +x.toFixed(2)) };
}
const spread = Math.max(...Object.values(out).map((o) => Math.max(...o.runs) - Math.min(...o.runs)));
const d = (a, b) => +(out[a].ms - out[b].ms).toFixed(2);

return {
  note: 'increments between neighbouring configs; median of 3 blocks of 40 frames, camera moving, round-robin, first rep discarded',
  resolution: `${renderer.domElement.width}x${renderer.domElement.height}`,
  configs: out,
  stageCostMs: {
    brightPass: d('bright', 'off'),
    blurPyramid: d('blur', 'bright'),
    upsampleChain: d('upsample', 'blur'),
    anamorphicStreak: d('full', 'upsample'),
    wholeBlock: d('full', 'off'),
  },
  worstSpreadMs: +spread.toFixed(2),
  caveat: 'any stage cost smaller than worstSpreadMs is not resolvable by this run',
};
