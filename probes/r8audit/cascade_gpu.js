/**
 * GPU cost of each half of the round-8 shadow cut, from timer queries.
 *
 * Wall clock could not answer this: probes/r8audit/cascade_cost.js measured the
 * four configurations at 34.35 / 33.32 / 32.90 / 33.37 ms with a 20 ms spread
 * inside a single configuration, and put BOTH changes together as slower than
 * the refresh change alone — which is impossible, so the whole ordering was
 * noise. EXT_disjoint_timer_query_webgl2 bills the GPU for the commands between
 * two marks and is indifferent to the seven other trees sharing this machine.
 *
 * The `scene` span contains the shadow-map rasterisation (three.js renders the
 * cascades inside renderer.render), which is the only span either change can
 * move, so that is the one reported. Median over frames, per configuration,
 * interleaved and order-alternated per rep.
 *
 * ARGS: <shot> <static|pan> [framesPerArm] [reps]
 */
const g = window.__GAME;
const THREE = g.THREE;
const eng = g.engine, cam = eng.camera, pipe = eng.pipeline;
const lighting = g.world.lighting;
const gl = eng.renderer.getContext();
const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
if (!ext) return { error: 'no EXT_disjoint_timer_query_webgl2' };
g.setFreeFly(false);

const A = (typeof ARGS !== 'undefined' && ARGS) || [];
const shot = A[0] || 'vista';
const mode = A[1] || 'pan';
const FRAMES = +(A[2] || 40);
const REPS = +(A[3] || 4);
g.applyShot(shot);
g.settle(8);

const q0 = cam.quaternion.clone();
const MUT = { static: () => {}, pan: (i) => { cam.quaternion.copy(q0); cam.rotateY((i * 1.0 * Math.PI) / 180); } }[mode];
let k = 0;
const step = () => { MUT(k++); eng.step(1 / 60); eng.render(); };

function setC(sizes, interval, phase) {
  lighting.cascades.forEach((l, i) => {
    const s = sizes[Math.min(i, sizes.length - 1)];
    if (l.shadow.mapSize.x !== s) { l.shadow.mapSize.set(s, s); if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; } }
    l.shadow.needsUpdate = true;
  });
  lighting.refreshInterval = interval.slice();
  lighting._refreshPhase = phase.slice();
}
const CFG = {
  r7_full:     { sizes: [2048, 2048, 2048, 1024], int: [1, 2, 4, 8],  ph: [0, 0, 1, 3] },
  sizeOnly:    { sizes: [2048, 1536, 1024, 1024], int: [1, 2, 4, 8],  ph: [0, 0, 1, 3] },
  refreshOnly: { sizes: [2048, 2048, 2048, 1024], int: [1, 3, 6, 12], ph: [0, 0, 2, 5] },
  shipped_r8:  { sizes: [2048, 1536, 1024, 1024], int: [1, 3, 6, 12], ph: [0, 0, 2, 5] },
};
const names = Object.keys(CFG);
const got = Object.fromEntries(names.map((n) => [n, []]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measure() {
  const pending = [];
  let active = null, activeName = null;
  pipe.profiler = {
    mark(name) {
      if (active) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ name: activeName, q: active }); active = null; }
      if (name === 'end') return;
      const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); active = q; activeName = name;
    },
  };
  for (let i = 0; i < FRAMES; i++) step();
  pipe.profiler = null;
  if (active) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ name: activeName, q: active }); }
  for (let t = 0; t < 200; t++) {
    const last = pending[pending.length - 1];
    if (gl.getQueryParameter(last.q, gl.QUERY_RESULT_AVAILABLE)) break;
    await sleep(10);
  }
  const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
  const scene = [];
  for (const { name, q } of pending) {
    if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
    if (name === 'scene') scene.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
    gl.deleteQuery(q);
  }
  return { scene, disjoint };
}
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

for (let i = 0; i < 30; i++) step();     // saturate the queue
for (let r = 0; r < REPS; r++) {
  const order = r % 2 === 0 ? names : names.slice().reverse();
  for (const n of order) {
    const c = CFG[n];
    setC(c.sizes, c.int, c.ph);
    for (let i = 0; i < 30; i++) step();  // warm: clock ramp + refill every cascade
    const m = await measure();
    if (!m.disjoint) got[n].push(+median(m.scene).toFixed(3));
  }
}
setC(CFG.shipped_r8.sizes, CFG.shipped_r8.int, CFG.shipped_r8.ph);

const ms = Object.fromEntries(names.map((n) => [n, got[n].length ? +median(got[n]).toFixed(3) : null]));
return {
  shot, mode, framesPerArm: FRAMES, reps: REPS, resolution: `${pipe.width}x${pipe.height}`,
  sceneSpanMs: ms,
  savedVsR7_ms: {
    sizeOnly: ms.r7_full != null && ms.sizeOnly != null ? +(ms.r7_full - ms.sizeOnly).toFixed(3) : null,
    refreshOnly: ms.r7_full != null && ms.refreshOnly != null ? +(ms.r7_full - ms.refreshOnly).toFixed(3) : null,
    shipped_r8: ms.r7_full != null && ms.shipped_r8 != null ? +(ms.r7_full - ms.shipped_r8).toFixed(3) : null,
  },
  raw: got,
};
