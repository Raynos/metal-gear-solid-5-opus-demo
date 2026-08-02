/**
 * WHAT EACH HALF OF THE ROUND-8 SHADOW CUT ACTUALLY BOUGHT.
 *
 * `cascade_sweep.js` showed the change splits cleanly: the refresh-interval half
 * (1/2/4 -> 1/3/6) is pixel-free in a static frame, and the map-size half
 * (2048/2048/2048 -> 2048/1536/1024) carries 100% of the visible cost. So the
 * question the trade turns on is what each half saves, separately.
 *
 * Timing discipline is lifted from probes/r8_final.js, because this machine is
 * shared and a naive A/B on it reported a pass that strictly contains another as
 * being faster than it:
 *   - every block bracketed by gl.finish(), so enqueued work is not free;
 *   - three untimed warm blocks after every switch, for the GPU clock ramp;
 *   - configurations interleaved and the order alternated per rep;
 *   - MINIMUM over reps, since contention only ever adds.
 *
 * ARGS: <shot> <mode:static|pan> [reps]
 */
const g = window.__GAME;
const THREE = g.THREE;
const eng = g.engine, gl = eng.renderer.getContext(), pipe = eng.pipeline;
const lighting = g.world.lighting, cam = eng.camera;
g.setFreeFly(false);

const A = (typeof ARGS !== 'undefined' && ARGS) || [];
const shot = A[0] || 'vista';
const mode = A[1] || 'pan';
const REPS = +(A[2] || 6);
g.applyShot(shot);
g.settle(8);

const base = cam.position.clone(), q0 = cam.quaternion.clone();
const MUT = { static: () => {}, pan: (i) => { cam.quaternion.copy(q0); cam.rotateY((i * 1.0 * Math.PI) / 180); } }[mode];
const N = 20;
let k = 0;
function block() { for (let i = 0; i < N; i++) { MUT(k++); eng.step(1 / 60); eng.render(); } }
function timed() { gl.finish(); const t = performance.now(); block(); gl.finish(); return (performance.now() - t) / N; }
const min = (a) => +Math.min(...a).toFixed(3);
for (let i = 0; i < 6; i++) block();

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
  r7_full:      { sizes: [2048, 2048, 2048, 1024], int: [1, 2, 4, 8],  ph: [0, 0, 1, 3] },
  sizeOnly:     { sizes: [2048, 1536, 1024, 1024], int: [1, 2, 4, 8],  ph: [0, 0, 1, 3] },
  refreshOnly:  { sizes: [2048, 2048, 2048, 1024], int: [1, 3, 6, 12], ph: [0, 0, 2, 5] },
  shipped_r8:   { sizes: [2048, 1536, 1024, 1024], int: [1, 3, 6, 12], ph: [0, 0, 2, 5] },
};
const names = Object.keys(CFG);
const samples = Object.fromEntries(names.map((n) => [n, []]));

// Interleave: one timed sample of every configuration per rep, order reversed on
// odd reps so no configuration is always the one coming off the previous switch.
for (let r = 0; r < REPS; r++) {
  const order = r % 2 === 0 ? names : names.slice().reverse();
  for (const n of order) {
    const c = CFG[n];
    setC(c.sizes, c.int, c.ph);
    block(); block(); block();          // warm: clock ramp + fill every cascade
    samples[n].push(timed());
  }
}
setC(CFG.shipped_r8.sizes, CFG.shipped_r8.int, CFG.shipped_r8.ph);
block();

const ms = Object.fromEntries(names.map((n) => [n, min(samples[n])]));
return {
  shot, mode, reps: REPS, resolution: `${pipe.width}x${pipe.height}`,
  frameMs: ms,
  savedVsR7: {
    sizeOnly: +(ms.r7_full - ms.sizeOnly).toFixed(3),
    refreshOnly: +(ms.r7_full - ms.refreshOnly).toFixed(3),
    shipped_r8: +(ms.r7_full - ms.shipped_r8).toFixed(3),
  },
  rawSamples: samples,
  stats: { draws: pipe.sceneStats?.calls, triangles: pipe.sceneStats?.triangles },
};
