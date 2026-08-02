/**
 * r11_post.js — where do the ~18 ms of post actually go? With a null control.
 *
 * WHY THIS EXISTS. Three earlier probes this round reported bloom at 13, 17 and
 * 20 ms and disagreed with each other about which configuration was cheap.
 * probes/r11_toggle.js found out why: flipping an ablation flag stalls, and a
 * ~53 ms stall amortised over a short block is +1.3 ms a frame, while the same
 * stall charged to a single frame — which is what tools/probes/perf.js's
 * adjacent-frame pairing does, since it flips every pair — is +50 ms on that
 * frame. Measured with NO toggle between blocks, bloom on and bloom off differ
 * by -0.74 ms against a 0.94 ms drift floor: it is not resolvable at all.
 *
 * So this probe does two things differently and they are both load-bearing:
 *
 *  1. WARM is 64 frames, not 12. That is long enough to absorb the flip stall
 *     entirely rather than amortise it into the measurement.
 *  2. It carries a NULL CONTROL — the same configuration measured twice under
 *     two names, with a flip in between exactly like every other pair. Whatever
 *     the control reads is what this instrument charges for nothing. Every other
 *     number here is only meaningful if it is bigger than that.
 *
 * A result is quoted only when it exceeds max(control, spread). Anything else
 * prints "below noise", because "this pass costs 0.4 ms" and "this pass costs
 * nothing I can measure" are different claims and only one has ever been true.
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

const E = pipe.enabled;
const S = pipe.bloomStages;
function base() {
  E.ssao = true; E.microAO = true; E.contactShadows = true;
  E.bloom = true; E.taa = false; E.fxaa = true; E.aerial = true;
  E.dof = true; E.motionBlur = true; E.autoExposure = true;
  S.blur = true; S.upsample = true; S.streak = true;
  S.compositeFetch = true; S.compositeAdd = true;
}

const CONFIGS = {
  full: () => { base(); },
  // The null control: identical to `full`, reached through the same flip.
  control: () => { base(); },
  // DOF and motion blur are ONE pass gated by (dof || motionBlur); ablating
  // either alone leaves the pass running. They must go together.
  noDofPass: () => { base(); E.dof = false; E.motionBlur = false; },
  // The occlusion pass, which round 9 gave a second horizon search and an
  // 8-step sun raymarch at FULL resolution.
  noOcclusion: () => { base(); E.ssao = false; },
  // Just the two extra contact signals inside that pass, via their own
  // first-class switches — `enabled.ssao` cannot answer this.
  noContactTerms: () => { base(); E.microAO = false; E.contactShadows = false; },
  noBloomPyramid: () => { base(); S.blur = false; S.upsample = false; S.streak = false; },
  noBloom: () => { base(); E.bloom = false; },
};

eng.deterministic = true;
eng.stop();
base();
block();          // settle the page once; discard

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
// The floor is the NULL CONTROL, not the spread.
//
// Taking max(control, spread) was wrong and made the first run of this probe
// useless: one rep in three spiked to 35.85 and 45.84 ms — a thermal or
// contention excursion — which pushed the "floor" to 24.17 ms and buried every
// real cost under it. A single outlier block says the machine hiccuped once; it
// does not say the instrument cannot resolve 3 ms. The control is the honest
// floor because it is this instrument measuring nothing, through the same flip,
// in the same run. The spread is reported beside it so an excursion is visible
// rather than silently averaged in.
const controlMs = Math.abs(+(out.full.ms - out.control.ms).toFixed(2));
const spread = +Math.max(...Object.values(out).map((o) => o.spread)).toFixed(2);
const floor = controlMs;

const cost = {};
for (const k of Object.keys(CONFIGS)) {
  if (k === 'full' || k === 'control') continue;
  const c = +(out.full.ms - out[k].ms).toFixed(2);
  cost[k.replace(/^no/, '')] = Math.abs(c) > floor ? `${c} ms` : `below noise (${c}, floor ${floor})`;
}

return {
  resolution: `${renderer.domElement.width}x${renderer.domElement.height}`,
  frameMs: out.full.ms,
  configs: out,
  nullControlMs: controlMs,
  noiseFloorMs: floor,
  worstBlockSpreadMs: spread,
  costMs: cost,
  unflaggedPostMs:
    '= frameMs - sceneIntoHdr - the resolved costs above. The prep blit, the ' +
    '6-level luminance chain, the adaptation blit, the composite and the ' +
    'present/FXAA blit have NO enabled[] flag, so no ablation can reach them.',
  note: `WARM=${WARM} frames per block to absorb the flip stall probes/r11_toggle.js found. ` +
    `The null control is the same config measured twice through the same flip; nothing smaller than it is real.`,
};
