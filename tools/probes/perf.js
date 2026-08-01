/**
 * perf.js — the honest frame-time ruler.  node tools/shot.mjs eval tools/probes/perf.js
 *
 * WHY THIS EXISTS. For six rounds every report said "2.7 ms, within budget" while
 * the game actually ran at 14-24 FPS. The old measurement (`__GAME.settle()`)
 * timed five frames immediately after a settle and divided. Those five frames are
 * only ENQUEUED, not executed — the GPU queue is empty, submission returns
 * instantly, and you measure the driver's command-buffer write speed rather than
 * the frame. Measured on the same build, same size, same frames:
 *
 *     5 frames + one finish()      3.44 ms   <- what every report quoted
 *     finish() every frame x30    33.46 ms
 *     no finish, 30 frames        55.74 ms
 *     throughput, 60 frames       74.04 ms   <- the truth (14 FPS)
 *
 * and the cost ramp across consecutive 20-frame blocks is
 *     [2.8, 47.4, 40.7, 40.8, 40.4, 41.5]
 * i.e. only the first block is cheap, which is exactly the window settle() used.
 *
 * RULES FOR ANY FRAME-TIME CLAIM:
 *   1. Discard the first block. Warm up until the queue is saturated.
 *   2. Measure THROUGHPUT over many frames, not latency of a few.
 *   3. Move the camera. A static pose skips clipmap updates, shadow-cascade
 *      refits, TAA history invalidation and LOD churn — all of which a player pays.
 */

const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const eng = W.engine;
const cam = eng.camera;
const gl = eng.renderer.getContext();

const WARM = 24;   // frames discarded so the GPU queue is saturated before timing
const N = 60;      // timed frames per scenario

function throughput(mutate) {
  for (let i = 0; i < WARM; i++) { mutate(i); eng.step(1 / 60); eng.render(); }
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) { mutate(i); eng.step(1 / 60); eng.render(); }
  gl.finish();
  return (performance.now() - t0) / N;
}

/** Per-frame samples, for percentiles. finish() per frame over-counts a pipelined
 *  frame, so it is reported only as a spike detector, never as the headline. */
function percentiles(mutate) {
  const t = [];
  for (let i = 0; i < WARM; i++) { mutate(i); eng.step(1 / 60); eng.render(); }
  gl.finish();
  for (let i = 0; i < N; i++) {
    const a = performance.now();
    mutate(i); eng.step(1 / 60); eng.render(); gl.finish();
    t.push(performance.now() - a);
  }
  t.sort((x, y) => x - y);
  return { p50: t[N >> 1], p95: t[Math.floor(N * 0.95)], worst: t[N - 1] };
}

const shot = (typeof ARGS !== 'undefined' && ARGS && ARGS[0]) || 'gameplay';
g.applyShot(shot);
g.settle(4);

const base = cam.position.clone();
const q0 = cam.quaternion.clone();
const fwd = new THREE.Vector3();
cam.getWorldDirection(fwd);
const reset = () => { cam.position.copy(base); cam.quaternion.copy(q0); };

const scenarios = {
  static: () => {},
  pan60: (i) => { cam.quaternion.copy(q0); cam.rotateY((i * 1.0 * Math.PI) / 180); },
  walk: (i) => { cam.position.copy(base).addScaledVector(fwd, (i * 4) / 60); },
  sprint: (i) => { cam.position.copy(base).addScaledVector(fwd, (i * 40) / 60); },
};

const frames = {};
for (const [name, fn] of Object.entries(scenarios)) {
  reset();
  const ms = throughput(fn);
  reset();
  const p = percentiles(fn);
  frames[name] = {
    ms: +ms.toFixed(1),
    fps: +(1000 / ms).toFixed(0),
    p95ms: +p.p95.toFixed(1),
    worstms: +p.worst.toFixed(1),
  };
}
reset();

// ---- where does the time go? ablate each post pass and diff throughput ----
const pipe = eng.pipeline;
const flags = Object.keys(pipe.enabled || {});
const full = throughput(() => {});
const passCost = {};
for (const f of flags) {
  const prev = pipe.enabled[f];
  if (!prev) continue;
  pipe.enabled[f] = false;
  const without = throughput(() => {});
  pipe.enabled[f] = prev;
  passCost[f] = +(full - without).toFixed(1);
}

// Scene-vs-post split: render the scene with the whole post chain bypassed.
const saved = {};
for (const f of flags) { saved[f] = pipe.enabled[f]; pipe.enabled[f] = false; }
const noPost = throughput(() => {});
for (const f of flags) pipe.enabled[f] = saved[f];

const size = eng.renderer.getSize(new THREE.Vector2());
const info = eng.renderer.info;

return {
  shot,
  resolution: `${size.x}x${size.y} @dpr${eng.renderer.getPixelRatio()}`,
  frames,
  budget60fps: 16.7,
  budget30fps: 33.3,
  splitMs: {
    total: +full.toFixed(1),
    postChain: +(full - noPost).toFixed(1),
    sceneAndShadows: +noPost.toFixed(1),
  },
  perPassMs: Object.fromEntries(Object.entries(passCost).sort((a, b) => b[1] - a[1])),
  draws: eng.pipeline?.sceneStats?.calls ?? info.render.calls,
  triangles: eng.pipeline?.sceneStats?.triangles ?? info.render.triangles,
  programs: info.programs?.length ?? 0,
};
