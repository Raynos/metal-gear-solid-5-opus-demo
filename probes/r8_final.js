/**
 * r8_final.js — what each part of the frame costs.  ARGS: <shot> <mode> [reps]
 *
 * THREE MEASUREMENT TRAPS THIS AVOIDS, all of which produced published numbers
 * in this project that were wrong:
 *
 *  1. Timing enqueued frames. Every block is bracketed by gl.finish().
 *  2. Drift over a long sequential walk. Configurations are interleaved.
 *  3. GPU CLOCK RAMP. This is the one that bit round 8. A cheap configuration
 *     lets the GPU drop its clocks, and whichever configuration is measured
 *     next pays the ramp — enough that an earlier sweep reported a 5-level
 *     bloom pyramid as 15 ms SLOWER than the 6-level one that strictly contains
 *     it, and a single 30x16 mip as costing 11 ms. Every switch is followed by
 *     three untimed warm blocks, and the order alternates every rep so neither
 *     side is always the one coming off the cheap block.
 *
 * The estimator is the MINIMUM over reps: contention only ever adds time, so
 * the fastest block is the one that had the machine to itself.
 */
const g = window.__GAME;
const THREE = g.THREE;
const eng = g.world.engine;
const cam = eng.camera;
const gl = eng.renderer.getContext();
const pipe = eng.pipeline;
const lighting = g.world.lighting;

const A = (typeof ARGS !== 'undefined' && ARGS) || [];
const shot = A[0] || 'gameplay';
const mode = A[1] || 'pan';
const REPS = +(A[2] || 6);
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

const N = 20;
let k = 0;
function block() { for (let i = 0; i < N; i++) { MUT(k++); eng.step(1 / 60); eng.render(); } }
function timed() { gl.finish(); const t = performance.now(); block(); gl.finish(); return (performance.now() - t) / N; }
const min = (a) => +Math.min(...a).toFixed(2);

for (let i = 0; i < 6; i++) block();

/** Cost of whatever `off` removes, with the ramp and the order controlled. */
function ab(on, off) {
  const A2 = [], B2 = [];
  const run = (set, into) => { set(); block(); block(); block(); into.push(timed()); };
  for (let r = 0; r < REPS; r++) {
    if (r % 2 === 0) { run(on, A2); run(off, B2); } else { run(off, B2); run(on, A2); }
  }
  on();
  block();
  return { on: min(A2), off: min(B2), costMs: +(min(A2) - min(B2)).toFixed(2) };
}
function flagAB(flags) {
  const prev = flags.map((f) => pipe.enabled[f]);
  return ab(() => flags.forEach((f, i) => { pipe.enabled[f] = prev[i]; }),
            () => flags.forEach((f) => { pipe.enabled[f] = false; }));
}

const out = { shot, mode, reps: REPS, resolution: `${pipe.width}x${pipe.height}` };
out.baseline = min([timed(), timed(), timed()]);
out.postChain = flagAB(Object.keys(pipe.enabled));
out.bloom = flagAB(['bloom']);
out.ssao = flagAB(['ssao']);
out.taa = flagAB(['taa']);
out.dofPass = flagAB(['dof', 'motionBlur']);

// Shadow-map rasterisation: freeze the cascades but keep their maps, so nothing
// recompiles and the image is unchanged.
const cs = lighting.cascades;
const autos = cs.map((l) => l.shadow.autoUpdate);
const pin = (l) => Object.defineProperty(l.shadow, 'needsUpdate', { configurable: true, get: () => false, set: () => {} });
const unpin = (l) => { delete l.shadow.needsUpdate; l.shadow.needsUpdate = true; };
out.shadowRaster = ab(() => cs.forEach((l, i) => { unpin(l); l.shadow.autoUpdate = autos[i]; }),
                      () => cs.forEach((l) => { l.shadow.autoUpdate = false; pin(l); }));

// Internal render scale, against the shipping 1.0. Guarded so this probe also
// runs against a checkout that predates it, for before/after.
out.renderScale = {};
for (const s of pipe.setRenderScale ? [0.85, 0.7] : []) {
  const r = ab(() => pipe.setRenderScale(1), () => pipe.setRenderScale(s));
  out.renderScale[s] = { ms: r.off, savedMs: r.costMs };
}
if (pipe.setRenderScale) pipe.setRenderScale(1);
block();

out.cascades = cs.map((l) => ({ map: l.shadow.mapSize.x, every: lighting.refreshInterval[cs.indexOf(l)] }));
out.stats = { draws: pipe.sceneStats?.calls, triangles: pipe.sceneStats?.triangles };
return out;
