/**
 * r13_wallshot.js — "enemies keep shooting me through the walls".
 *
 * Firing is gated on `guard.vis.visible`, which comes from NavGrid.losClear —
 * a 2.5D march over a 1 m grid. The suspicion is the SAMPLING RATE: losClear
 * takes `ceil(len / cell)` samples, i.e. one per cell LENGTH, while a diagonal
 * ray crosses ~1.4 cells per metre. A one-cell-thick wall — which is most of
 * the wall on this site — can fall between two samples and be missed.
 *
 * Ground truth is a real Raycaster against the scene. It is far too slow for
 * the sim (which is why the grid exists) and perfectly fine for one probe.
 *
 * Reports the disagreement rate over sight lines from every guard's eye to a
 * ring of points around the compound, split by direction:
 *
 *   falseClear  grid says visible, raycast says blocked  <- shooting through a wall
 *   falseBlock  grid says blocked, raycast says visible  <- guards going blind
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const reg = W.registry;
const ai = reg.ai;
const eng = W.engine;

W.gameState.setMode('play');
for (let i = 0; i < 20; i++) eng.step(1 / 60);

const grid = ai.navGrid;
if (!grid) return { error: 'no grid on the ai registry', keys: Object.keys(ai) };

// Everything that should stop a bullet. Characters are excluded — a guard
// seeing through his mate is a different question.
const solids = [];
W.scene.traverse((o) => {
  if (!(o.isMesh || o.isInstancedMesh) || !o.visible) return;
  if (/^char-|grass|clast|bush|scrub|brush|tree|volumetric|tumbleweed|razor|link/i.test(o.name || '')) return;
  solids.push(o);
});

const rc = new THREE.Raycaster();
rc.far = 120;
const dir = new THREE.Vector3();
let lastBlocker = null;
function raycastClear(a, b) {
  dir.subVectors(b, a);
  const len = dir.length();
  if (len < 0.05) return true;
  dir.divideScalar(len);
  rc.set(a, dir);
  rc.far = len - 0.25;
  const hits = rc.intersectObjects(solids, false);
  lastBlocker = hits.length ? `${hits[0].object.name || '(unnamed)'}|${hits[0].object.material?.name || ''}` : null;
  return hits.length === 0;
}
const blockers = {};

const centre = reg.outpost.bounds.getCenter(new THREE.Vector3());
const eye = new THREE.Vector3();
const tgt = new THREE.Vector3();

let n = 0, falseClear = 0, falseBlock = 0, agree = 0;
const samples = [];
for (const q of ai.guards) {
  if (!q.ch) continue;
  eye.copy(q.ch.position);
  eye.y += 1.6;
  // A ring of chest-height standing points across the compound: some in the
  // open, some behind buildings and walls, which is the whole point.
  for (let k = 0; k < 64; k++) {
    const th = (k / 64) * Math.PI * 2;
    const r = 8 + (k % 7) * 5.5;
    const x = centre.x + Math.cos(th) * r;
    const z = centre.z + Math.sin(th) * r;
    const y = grid.heightAt(x, z) + 1.35;
    tgt.set(x, y, z);
    if (eye.distanceTo(tgt) < 3.0 || eye.distanceTo(tgt) > 70) continue;
    const gridSays = grid.losClearV(eye, tgt);
    const rayS = raycastClear(eye, tgt);
    n++;
    if (gridSays === rayS) agree++;
    else if (gridSays && !rayS) {
      falseClear++;
      blockers[lastBlocker] = (blockers[lastBlocker] ?? 0) + 1;
      if (samples.length < 6) {
        samples.push({
          guard: q.id ?? q.name ?? '?',
          d: +eye.distanceTo(tgt).toFixed(1),
          eye: eye.toArray().map((v) => +v.toFixed(1)),
          tgt: tgt.toArray().map((v) => +v.toFixed(1)),
        });
      }
    } else falseBlock++;
  }
}

return {
  lines: n,
  agreePct: +((agree / n) * 100).toFixed(1),
  falseClear,
  falseClearPct: +((falseClear / n) * 100).toFixed(1),
  falseBlock,
  falseBlockPct: +((falseBlock / n) * 100).toFixed(1),
  blockers,
  solidMeshes: solids.length,
};
