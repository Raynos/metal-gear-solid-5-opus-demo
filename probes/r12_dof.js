/**
 * r12_dof.js — did half-resolution DOF actually save anything?
 *
 * The audit ranked "DOF+MB gather to half res" as the single biggest available
 * cut at ~2-2.5 ms, having measured the pass at 2.5-3.3 ms full res (three
 * ways). This measures the change that was made against the configuration it
 * replaced, in the mode where DOF actually runs.
 *
 * Method is a12_ballast.js's, because on this machine it is the only one that
 * works: the M3 Pro downclocks under light GPU load, so an identical config
 * reads 4.7 ms after a heavy block and 16.1 ms after a light one. Every config
 * below therefore carries the same BALLAST — fullscreen ALU blits bounced
 * between the unused TAA targets — so clock state cancels in the differences.
 * Plus WARM=64 to absorb the ~50 ms flag-flip stall, and a null control.
 *
 * DOF is off in godmode (main.js turns the cinematic passes off for the
 * inspection camera), so this forces the play-mode flags on rather than
 * measuring a pass that is not running.
 */
const g = window.__GAME;
const eng = g.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();

const WARM = 64;
const N = 40;
const REPS = 3;
const K = 24;

g.applyShot('gameplay');
eng.deterministic = true;
eng.stop();

// Play mode is where DOF and motion blur are on. applyShot parks us in godmode,
// which explicitly disables both, so set them directly afterwards.
pipe.enabled.dof = true;
pipe.enabled.motionBlur = true;

const cam = eng.camera;
const start = cam.position.clone();
let t = 0;
function step() {
  t += 1 / 60;
  cam.position.set(start.x + Math.sin(t * 0.6) * 6, start.y, start.z + Math.cos(t * 0.6) * 6);
  cam.lookAt(0, 2, 0);
  eng.step(1 / 60);
  eng.render();
  ballast(K);
}

// Constant GPU load so the governor sees the same total work in every config.
const bmat = pipe.fxaaMat ?? pipe.compositeMat;
function ballast(k) {
  for (let i = 0; i < k; i++) {
    renderer.setRenderTarget(i & 1 ? pipe.taaA : pipe.taaB);
    renderer.clear(true, false, false);
  }
  renderer.setRenderTarget(null);
}

function block() {
  for (let i = 0; i < WARM; i++) step();
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) step();
  gl.finish();
  return +((performance.now() - t0) / N).toFixed(2);
}

// Force the DOF target to full or half resolution at run time. setSize on a
// WebGLRenderTarget reallocates, and a12_scene.js's NaN trap says an
// uninitialised half-float target sampled with blending poisons the raster --
// so every size change is followed by a clear and a full warm block.
const W = pipe._outW ?? renderer.domElement.width;
const H = pipe._outH ?? renderer.domElement.height;
function setDof(half) {
  pipe.dofRT.setSize(half ? Math.max(2, W >> 1) : W, half ? Math.max(2, H >> 1) : H);
  renderer.setRenderTarget(pipe.dofRT);
  renderer.clear(true, false, false);
  renderer.setRenderTarget(null);
}

const CONFIGS = {
  half: () => setDof(true),
  control: () => setDof(true),   // same config, same flip: the noise floor
  full: () => setDof(false),
  dofOff: () => { setDof(true); pipe.enabled.dof = false; pipe.enabled.motionBlur = false; },
};

setDof(true);
block();

const samples = {};
for (const k of Object.keys(CONFIGS)) samples[k] = [];
for (let r = 0; r < REPS; r++) {
  for (const [k, apply] of Object.entries(CONFIGS)) {
    pipe.enabled.dof = true;
    pipe.enabled.motionBlur = true;
    apply();
    samples[k].push(block());
  }
}
pipe.enabled.dof = true;
pipe.enabled.motionBlur = true;
setDof(true);

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const out = {};
for (const [k, v] of Object.entries(samples)) {
  out[k] = { ms: med(v), runs: v, spread: +(Math.max(...v) - Math.min(...v)).toFixed(2) };
}
const floor = Math.abs(+(out.half.ms - out.control.ms).toFixed(2));
const saved = +(out.full.ms - out.half.ms).toFixed(2);
const passCost = +(out.full.ms - out.dofOff.ms).toFixed(2);

return {
  note: 'play-mode flags forced on; ballast K=24 in every config so GPU clocks cancel',
  resolution: `${W}x${H}`,
  configs: out,
  nullControlMs: floor,
  savedByHalfResMs: Math.abs(saved) > floor ? saved : `below noise (${saved}, floor ${floor})`,
  fullResPassCostMs: Math.abs(passCost) > floor ? passCost : `below noise (${passCost}, floor ${floor})`,
};
