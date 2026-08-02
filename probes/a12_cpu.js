/**
 * a12_cpu.js — CPU side of the frame: simulation step vs render submission.
 *
 * a12_scene2 leaves ~8.2 ms of scene-attributed "fixed" cost. Some of that is
 * CPU (eng.step: AI, animation, volumetric uniform prep; eng.render: three.js
 * draw submission) which overlaps GPU work in the shipping loop and therefore
 * does NOT stack against the GPU budget at 60 FPS. Split it:
 *
 *  - stepMs:   wall time of eng.step alone, no render call at all.
 *  - submitMs: wall time of the eng.render() CALL — CPU-side encode/submit —
 *              while the GPU runs asynchronously behind it. Long tail =
 *              back-pressure, so the median and p90 are both reported.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const renderer = eng.renderer;
const gl = renderer.getContext();

const cam = eng.camera;
const start = cam.position.clone();
let t = 0;
function move() {
  t += 1 / 60;
  cam.position.set(start.x + Math.sin(t * 0.6) * 6, start.y, start.z + Math.cos(t * 0.6) * 6);
  cam.lookAt(0, 2, 0);
}

eng.deterministic = true;
eng.stop();
for (let i = 0; i < 64; i++) { move(); eng.step(1 / 60); eng.render(); }
gl.finish();

// 1. step alone (includes the volumetric system's three blits' CPU submission,
// since it runs as an engine system inside step — noted, not removable here).
const stepT = [];
for (let i = 0; i < 200; i++) {
  move();
  const t0 = performance.now();
  eng.step(1 / 60);
  stepT.push(performance.now() - t0);
}
gl.finish();

// 2. full frame, timing the two calls separately.
const stepT2 = [];
const submitT = [];
for (let i = 0; i < 200; i++) {
  move();
  const a = performance.now();
  eng.step(1 / 60);
  const b = performance.now();
  eng.render();
  const c = performance.now();
  stepT2.push(b - a);
  submitT.push(c - b);
}
gl.finish();

const q = (a, f) => +[...a].sort((x, y) => x - y)[Math.floor(a.length * f)].toFixed(2);
return {
  stepAloneMs: { p50: q(stepT, 0.5), p90: q(stepT, 0.9) },
  stepInLoopMs: { p50: q(stepT2, 0.5), p90: q(stepT2, 0.9) },
  renderSubmitMs: { p50: q(submitT, 0.5), p90: q(submitT, 0.9) },
  note: 'renderSubmit p50 >> p90 gap or p50 near the frame time means GPU back-pressure is folded in; the honest CPU submit cost is the p50 when the queue is not full.',
};
