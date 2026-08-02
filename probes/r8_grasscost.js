/**
 * r8_grasscost.js — what the round-8 grass density gain costs, measured as an
 * A/B inside ONE session.
 *
 * Comparing a perf.js run before an edit against a perf.js run after it is
 * worthless on this machine: eight worktrees share one GPU and one daemon, and
 * the same build measured 31 ms and 57 ms twenty minutes apart. The only honest
 * number is an ablation — toggle the layer, keep everything else identical, and
 * interleave the blocks so a drifting machine drifts through both arms equally.
 *
 * Rules from tools/probes/perf.js are kept: warm until the queue is saturated,
 * discard the first block, measure throughput over many frames, MOVE the camera.
 */
const g = window.__GAME;
const W = g.world;
const eng = W.engine;
const cam = eng.camera;
const gl = eng.renderer.getContext();

const WARM = 24;
const N = 25;
// Seven alternating blocks per arm, first discarded. Eight worktrees share this
// GPU and the load moves under you: single-block samples on this machine have
// ranged 32-75 ms for the SAME build. Interleaving many short blocks and taking
// the difference of medians is the only estimator that survives that.
const REPS = 7;

const clast = [];
const grass = [];
eng.scene.traverse((o) => {
  if (!o.isInstancedMesh) return;
  if (o.name.startsWith('clast-')) clast.push(o);
  else if (o.name.startsWith('grass-')) grass.push(o);
});

const home = cam.position.clone();
const yaw0 = cam.rotation.y;
function pan(i) {
  // A moving camera: pan + a real translation, so clipmaps, cascade refits and
  // the lattice snap all churn the way they do for a player.
  cam.rotation.y = yaw0 + Math.sin(i * 0.035) * 0.45;
  cam.position.x = home.x + Math.sin(i * 0.05) * 3.0;
  cam.position.z = home.z + Math.cos(i * 0.05) * 3.0;
  cam.updateMatrixWorld();
}

function throughput() {
  for (let i = 0; i < WARM; i++) { pan(i); eng.step(1 / 60); eng.render(); }
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) { pan(i + WARM); eng.step(1 / 60); eng.render(); }
  gl.finish();
  return (performance.now() - t0) / N;
}

function counts() {
  pan(0);
  eng.step(1 / 60);
  eng.render();
  const info = eng.renderer.info.render;
  return { calls: info.calls, triangles: info.triangles };
}

const arms = {
  on: { set: () => { for (const m of grass) m.visible = true; }, ms: [] },
  off: { set: () => { for (const m of grass) m.visible = false; }, ms: [] },
};

const stats = {};
for (const k of Object.keys(arms)) {
  arms[k].set();
  stats[k] = counts();
}

for (let r = 0; r < REPS; r++) {
  for (const k of Object.keys(arms)) {
    arms[k].set();
    arms[k].ms.push(throughput());
  }
}
arms.on.set();
cam.position.copy(home);
cam.rotation.y = yaw0;
cam.updateMatrixWorld();

// Drop the first block of each arm: it is the one that pays for shader
// compilation and for the LOD rings still filling.
const med = (a) => {
  const s = a.slice(1).sort((x, y) => x - y);
  return s[s.length >> 1];
};

return {
  shot: g.shotName ?? null,
  clastMeshes: clast.length,
  clastInstances: clast.reduce((a, m) => a + m.count, 0),
  grassMeshes: grass.length,
  msWithGrass: +med(arms.on.ms).toFixed(2),
  msWithoutGrass: +med(arms.off.ms).toFixed(2),
  grassCostMs: +(med(arms.on.ms) - med(arms.off.ms)).toFixed(2),
  samplesOn: arms.on.ms.map((v) => +v.toFixed(1)),
  samplesOff: arms.off.ms.map((v) => +v.toFixed(1)),
  drawsWithGrass: stats.on.calls,
  drawsWithoutGrass: stats.off.calls,
  trisWithGrass: stats.on.triangles,
  trisWithoutGrass: stats.off.triangles,
  vegetationStats: W.registry?.vegetation?.stats ?? null,
};
