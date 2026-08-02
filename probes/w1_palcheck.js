// Does the three-tone palette selector actually reach the screen per bag?
//
// A value ablation cannot answer this on its own: the three authored hessians
// differ only in value, so if anything downstream compresses value the signal
// is lost in the same place the answer would be. So force the three slots to
// three unmistakable HUES, render, and classify each bag by which channel wins.
// If the selector works, ~44/22/34 of bags come back red/green/blue.
// The renderer no longer injects `g`; probes take their own handle.
const g = window.__GAME;
g.setFreeFly(false);
const engine = g.engine;
const scene = engine.scene;
const gl = engine.renderer.getContext();
const W = engine.pipeline.width;
const H = engine.pipeline.height;
const THREE = g.THREE;

let cloth = null;
const bagMeshes = [];
scene.traverse((o) => {
  if (!o.isMesh || !o.material || o.material.name !== 'op-cloth') return;
  cloth = o.material;
  if (o.isInstancedMesh) bagMeshes.push(o);
});
const u = cloth.userData.u;
const keep = [u.uBase.value.clone(), u.uBase2.value.clone(), u.uBase3.value.clone()];

function grab() {
  g.settle(3);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}
function patch(px, x, y) {
  let r = 0;
  let gg = 0;
  let b = 0;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const sx = x + dx;
      const sy = y + dy;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const j = (sy * W + sx) * 4;
      r += px[j];
      gg += px[j + 1];
      b += px[j + 2];
      n++;
    }
  }
  return [r / n, gg / n, b / n];
}

g.applyShot('outpost');
// Close pose on the densest revetment, as in w1_bags.
const mat = new THREE.Matrix4();
const pts = [];
for (const m of bagMeshes) {
  for (let i = 0; i < m.count; i++) {
    m.getMatrixAt(i, mat);
    const p = new THREE.Vector3(mat.elements[12], mat.elements[13], mat.elements[14]);
    p.applyMatrix4(m.matrixWorld);
    pts.push(p);
  }
}
let best = pts[0];
let bestN = -1;
for (let i = 0; i < pts.length; i += 3) {
  let n = 0;
  for (let j = 0; j < pts.length; j += 3) if (pts[i].distanceToSquared(pts[j]) < 16) n++;
  if (n > bestN) { bestN = n; best = pts[i]; }
}
const cam = engine.camera;
cam.position.set(best.x + 4.2, best.y + 2.0, best.z + 4.2);
cam.lookAt(best.x, best.y + 0.5, best.z);
cam.updateMatrixWorld(true);
scene.updateMatrixWorld(true);

u.uBase.value.set(0.40, 0.02, 0.02);
u.uBase2.value.set(0.02, 0.40, 0.02);
u.uBase3.value.set(0.02, 0.02, 0.40);
const P = grab();

const tally = { red: 0, green: 0, blue: 0, none: 0 };
const seen = [];
for (const m of bagMeshes) {
  for (let i = 0; i < m.count; i++) {
    m.getMatrixAt(i, mat);
    const v = new THREE.Vector3(mat.elements[12], mat.elements[13] + 0.17, mat.elements[14]);
    v.applyMatrix4(m.matrixWorld);
    v.project(cam);
    if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1 || v.z > 1) continue;
    const x = Math.round(((v.x + 1) / 2) * W);
    const y = Math.round(((v.y + 1) / 2) * H);
    const c = patch(P, x, y);
    const mx = Math.max(c[0], c[1], c[2]);
    const mn = Math.min(c[0], c[1], c[2]);
    if (mx < 12 || (mx - mn) / mx < 0.15) { tally.none++; continue; }
    if (c[0] === mx) tally.red++;
    else if (c[1] === mx) tally.green++;
    else tally.blue++;
    if (seen.length < 10) seen.push(c.map((z) => Math.round(z)));
  }
}
u.uBase.value.copy(keep[0]);
u.uBase2.value.copy(keep[1]);
u.uBase3.value.copy(keep[2]);
return { tally, sample: seen, expected: '~44 / 22 / 34 percent' };
