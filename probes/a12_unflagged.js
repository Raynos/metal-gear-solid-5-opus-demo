/**
 * a12_unflagged.js — price the passes that have NO enabled[] flag, by
 * monkey-patching the two _blit routers from inside the page.
 *
 * WHY. r11_post priced everything flaggable and left ~12 ms unattributed, with
 * a BELIEF that it lives in prep / luminance / adaptation / composite / present.
 * a12_gpu.js tried EXT_disjoint_timer_query first and the instrument is
 * unusable on ANGLE Metal: gpuSum 317 ms against a 24 ms wall frame, with a
 * 64x64 luminance blit billed 15 ms — each query eats a command-buffer
 * boundary, so the result is proportional to blit count, not GPU work. (That
 * is almost certainly the "timer query 6x off" in CLAUDE.md's history.)
 *
 * So: the r11_post instrument — WARM=64 blocks, gl.finish paced, null control,
 * medians over 3 reps — with the missing switches supplied by wrapping
 * pipe._blit and vol._blit to SKIP blits whose material is in a skip-set, or
 * SWAP a material for a trivial copy of the same source into the same target.
 *
 * skip  = remove the whole pass (raster + fetches + arithmetic + RT traffic).
 *         Downstream passes read the target's STALE contents — still a valid
 *         texture, so downstream cost is unchanged to first order.
 * cheap = same blit, 1-fetch copy shader: what remains is the pass's raster +
 *         bandwidth floor, so (skip - cheap) isolates the shader arithmetic.
 *
 * The present pass is never SKIPPED, only cheapened: a frame that draws
 * nothing to the canvas hits the "gl.finish after unpresented work returns at
 * submission speed" trap and the whole block method underneath it dies.
 *
 * PATCH COST: the wrapper itself is priced by the null control, which flips
 * through the same patch path as every other config.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();
const vol = g.world?.registry?.volumetrics?.pass ?? null;

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

// --- the missing switches ---------------------------------------------------
const skip = new Set();      // materials whose blit is dropped outright
const cheap = new Map();     // material -> { mat: copyMat, src: () => texture }

// One trivial copy shader, reused; its uniform is set per swapped blit.
const mkCopy = () => new (Object.getPrototypeOf(pipe.prepMat).constructor)({
  vertexShader: 'varying vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv;\nvoid main(){ gl_FragColor = texture2D(tDiffuse, vUv); }',
  uniforms: { tDiffuse: { value: null } },
  depthTest: false,
  depthWrite: false,
});
const copyMat = mkCopy();

const origPipeBlit = pipe._blit;
pipe._blit = function (material, target) {
  if (skip.has(material)) return;
  const sub = cheap.get(material);
  if (sub) {
    copyMat.uniforms.tDiffuse.value = sub();
    return origPipeBlit.call(this, copyMat, target);
  }
  return origPipeBlit.call(this, material, target);
};
let origVolBlit = null;
if (vol) {
  origVolBlit = vol._blit;
  vol._blit = function (material, target) {
    if (skip.has(material)) return;
    return origVolBlit.call(this, material, target);
  };
}

const E = pipe.enabled;
const S = pipe.bloomStages;
function base() {
  skip.clear();
  cheap.clear();
  E.ssao = true; E.microAO = true; E.contactShadows = true;
  E.bloom = true; E.taa = false; E.fxaa = true; E.aerial = true;
  E.dof = true; E.motionBlur = true; E.autoExposure = true;
  S.blur = true; S.upsample = true; S.streak = true;
  S.compositeFetch = true; S.compositeAdd = true;
}

const CONFIGS = {
  full: () => { base(); },
  control: () => { base(); },                                    // null control
  skipPrep: () => { base(); skip.add(pipe.prepMat); },
  cheapPrep: () => { base(); cheap.set(pipe.prepMat, () => pipe.hdr.texture); },
  skipLumChain: () => { base(); skip.add(pipe.lumMat); skip.add(pipe.downMat); skip.add(pipe.adaptMat); },
  skipComposite: () => { base(); skip.add(pipe.compositeMat); },
  cheapComposite: () => { base(); cheap.set(pipe.compositeMat, () => (pipe.dofRT.texture)); },
  cheapPresent: () => { base(); cheap.set(pipe.fxaaMat, () => pipe.compositeRT.texture); },
  skipAOBlur: () => { base(); skip.add(pipe.aoBlurMat); },
  skipVolDepthLin: () => { base(); if (vol) skip.add(vol.depthMat); },
  skipVolMarchResolve: () => { base(); if (vol) { skip.add(vol.volMat); skip.add(vol.resolveMat); } },
};

eng.deterministic = true;
eng.stop();
base();
block(); // settle; also compiles nothing yet — copyMat compiles on first cheap block, absorbed by that block's WARM

let result;
try {
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
    cost[k] = Math.abs(c) > floor ? `${c} ms` : `below noise (${c}, floor ${floor})`;
  }
  result = {
    resolution: `${pipe.width}x${pipe.height}`,
    frameMs: out.full.ms,
    nullControlMs: floor,
    configs: out,
    costMs: cost,
    note: 'skip = whole pass removed; cheap = same blit through a 1-fetch copy, so skip-cheap isolates shader arithmetic. Downstream reads stale-but-valid textures. Present is only ever cheapened, never skipped.',
  };
} finally {
  pipe._blit = origPipeBlit;
  if (vol && origVolBlit) vol._blit = origVolBlit;
  base();
}
return result;
