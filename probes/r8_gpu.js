/**
 * r8_gpu.js — per-pass GPU time from EXT_disjoint_timer_query_webgl2.
 * ARGS: <shot> <static|pan|walk> [frames]
 *
 * Wall-clock A/B is unusable on this machine: the render daemon is shared by
 * eight working trees, and one interleaved run priced bloom at 18 ms and the
 * whole post chain at 4 ms. A timer query bills the GPU for the commands
 * between two marks and is indifferent to what else is queued, so this reports
 * where the frame actually goes.
 *
 * `scene` includes the shadow-map rasterisation (it happens inside three's
 * renderer.render) and the volumetric pass's three blits, which run as an
 * engine system before the pipeline is entered.
 */
const g = window.__GAME;
const THREE = g.THREE;
const eng = g.world.engine;
const cam = eng.camera;
const gl = eng.renderer.getContext();
const pipe = eng.pipeline;
const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
if (!ext) return { error: 'no EXT_disjoint_timer_query_webgl2' };

const A = (typeof ARGS !== 'undefined' && ARGS) || [];
const shot = A[0] || 'gameplay';
const mode = A[1] || 'pan';
const FRAMES = +(A[2] || 40);
g.applyShot(shot);
g.settle(4);

const base = cam.position.clone();
const q0 = cam.quaternion.clone();
const fwd = new THREE.Vector3();
cam.getWorldDirection(fwd);
const MUT = {
  static: () => {},
  pan: (i) => { cam.quaternion.copy(q0); cam.rotateY((i * 1.0 * Math.PI) / 180); },
  walk: (i) => { cam.position.copy(base).addScaledVector(fwd, (i * 4) / 60); },
}[mode];

// One TIME_ELAPSED query may be active at a time, so a mark closes the previous
// span and opens the next. Results land a few frames later; they are drained at
// the end rather than polled, so the measurement never stalls the pipe.
const pending = [];
let active = null;
let activeName = null;
const profiler = {
  mark(name) {
    if (active) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ name: activeName, q: active }); active = null; }
    if (name === 'end') return;
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    active = q;
    activeName = name;
  },
};

let k = 0;
const step = () => { MUT(k++); eng.step(1 / 60); eng.render(); };
for (let i = 0; i < 30; i++) step();      // saturate the queue before timing

pipe.profiler = profiler;
for (let i = 0; i < FRAMES; i++) step();
pipe.profiler = null;
if (active) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ name: activeName, q: active }); active = null; }

// Drain. A disjoint anywhere in the window invalidates every result in it.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let tries = 0; tries < 200; tries++) {
  const last = pending[pending.length - 1];
  if (gl.getQueryParameter(last.q, gl.QUERY_RESULT_AVAILABLE)) break;
  await sleep(10);
}
const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);

const acc = {};
let n = 0;
for (const { name, q } of pending) {
  if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
  const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
  (acc[name] || (acc[name] = [])).push(ns / 1e6);
  gl.deleteQuery(q);
  n++;
}
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const passMs = {};
let total = 0;
for (const [name, a] of Object.entries(acc)) { passMs[name] = +median(a).toFixed(2); total += passMs[name]; }

return {
  shot, mode, frames: FRAMES, samples: n, disjoint,
  resolution: `${pipe.width}x${pipe.height}`,
  renderScale: pipe.renderScale,
  gpuTotalMs: +total.toFixed(2),
  passMs: Object.fromEntries(Object.entries(passMs).sort((a, b) => b[1] - a[1])),
};
