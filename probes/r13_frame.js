/**
 * r13_frame.js — r12_frame with enough repetitions to resolve a 1 ms cut.
 *
 * r12_frame reports a 5-run median with a 6.6-7.5 ms spread, which cannot
 * settle whether a change worth 0.6 ms happened. The spread is the GPU
 * governor, not the renderer: one run in five comes back ~6 ms under the rest.
 *
 * So: 11 blocks instead of 5, report the MEDIAN and the interquartile range,
 * and take the low quartile as well. Comparing two builds means comparing
 * medians AND checking the IQRs overlap — a median that moves by less than the
 * IQR has not moved.
 *
 * Everything else is r12_frame's, deliberately: one configuration, no flags
 * flipped, no targets resized, constant ballast.
 */
const g = window.__GAME;
const eng = g.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();

const WARM = 48;
const N = 40;
const REPS = 11;
const K = 24;

g.applyShot('gameplay');
eng.deterministic = true;
eng.stop();
// applyShot parks in godmode, which turns the cinematic passes off. DOF is a
// per-pixel pass under test, so put the play-mode flag back.
pipe.enabled.dof = true;

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
  framePx: `${renderer.domElement.width}x${renderer.domElement.height}`,
  renderScale: pipe.renderScale,
  dofTargetPx: `${pipe.dofRT.width}x${pipe.dofRT.height}`,
  stats: g.stats(),
  runs,
  medianMs: q(0.5),
  q25: q(0.25),
  q75: q(0.75),
  iqrMs: +(q(0.75) - q(0.25)).toFixed(2),
  fpsAtMedian: +(1000 / q(0.5)).toFixed(1),
};
