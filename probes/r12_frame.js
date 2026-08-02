/**
 * r12_frame.js — one number: the play-mode frame, with nothing switched.
 *
 * No flags flipped, no targets resized, no configs rotated. Every one of those
 * has produced a false number in this project: flipping a flag stalls ~50 ms,
 * and resizing a half-float render target mid-run stalls far worse — an attempt
 * to A/B the DOF resolution by calling setSize between configs gave a null
 * control of 3.37 ms and block spreads of 33 ms, which is no measurement at all.
 *
 * So this measures ONE configuration and nothing else. To compare two builds,
 * run it on both back to back in one sitting — the same source measures 30 ms
 * and 39 ms on this machine hours apart, so that is the only valid comparison.
 *
 * Ballast is carried (a12_ballast.js's trick) so the GPU governor sees a
 * constant load and cannot downclock one build relative to the other.
 */
const g = window.__GAME;
const eng = g.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();

const WARM = 64;
const N = 40;
const REPS = 5;
const K = 24;

g.applyShot('gameplay');
eng.deterministic = true;
eng.stop();
// applyShot parks in godmode, which turns the cinematic passes off. DOF is the
// thing under test, so put the play-mode flags back.
pipe.enabled.dof = true;
pipe.enabled.motionBlur = true;

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

block();                                  // settle; discard
const runs = [];
for (let i = 0; i < REPS; i++) runs.push(block());
const sorted = [...runs].sort((a, b) => a - b);

return {
  dofTargetPx: `${pipe.dofRT.width}x${pipe.dofRT.height}`,
  framePx: `${renderer.domElement.width}x${renderer.domElement.height}`,
  runs,
  medianMs: sorted[Math.floor(sorted.length / 2)],
  minMs: sorted[0],
  spreadMs: +(sorted[sorted.length - 1] - sorted[0]).toFixed(2),
};
