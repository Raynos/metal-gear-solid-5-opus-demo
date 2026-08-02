/**
 * r12_cull.js — how much of the instanced clutter is actually on screen, and
 * how big is a caster against the shadow texel it has to land on?
 *
 * The clutter rings are centred on the CAMERA, not on the frustum. A 55 deg
 * horizontal FOV can see about a sixth of a ring, so if these meshes are not
 * culled per instance the vertex/raster half of the scene pass is paying for
 * instances behind the player's head. Counting is contention-proof; timing on
 * this machine is not.
 */
const g = window.__GAME;
const THREE = g.THREE;
const eng = g.engine ?? g.world.engine;
g.applyShot('gameplay');
g.settle(90);

const cam = eng.camera;
cam.updateMatrixWorld();
const frustum = new THREE.Frustum().setFromProjectionMatrix(
  new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
);
const m = new THREE.Matrix4();
const p = new THREE.Vector3();
const sc = new THREE.Vector3();
const sph = new THREE.Sphere();

const lighting = g.world?.lighting ?? null;
const cascades = (lighting?.cascades ?? []).map((l, i) => ({
  i,
  mapSize: l.shadow.mapSize.x,
  radius: +(lighting._splits ? 0 : 0),
}));

const rows = [];
eng.scene.traverse((o) => {
  if (!o.isMesh || !o.visible) return;
  let q = o.parent, hidden = false;
  while (q) { if (!q.visible) hidden = true; q = q.parent; }
  if (hidden) return;
  const geo = o.geometry;
  const per = geo?.index ? geo.index.count / 3 : (geo?.attributes?.position?.count ?? 0) / 3;
  if (!geo.boundingSphere) geo.computeBoundingSphere();
  const r0 = geo.boundingSphere.radius;
  let inside = 0, total = 1, maxR = r0, dSum = 0, dMax = 0;
  if (o.isInstancedMesh) {
    total = o.count;
    maxR = 0;
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m);
      m.premultiply(o.matrixWorld);
      p.setFromMatrixPosition(m);
      sc.set(m.elements[0], m.elements[1], m.elements[2]);
      const s = sc.length();
      const r = r0 * s;
      maxR = Math.max(maxR, r);
      sph.center.copy(p); sph.radius = r;
      if (frustum.intersectsSphere(sph)) inside++;
      const d = p.distanceTo(cam.position);
      dSum += d; dMax = Math.max(dMax, d);
    }
  } else {
    sph.copy(geo.boundingSphere).applyMatrix4(o.matrixWorld);
    inside = frustum.intersectsSphere(sph) ? 1 : 0;
    maxR = sph.radius;
    dSum = dMax = sph.center.distanceTo(cam.position);
  }
  rows.push({
    isInst: !!o.isInstancedMesh,
    name: o.name || '(unnamed)',
    inst: total,
    inFrustum: inside,
    pctIn: +(100 * inside / total).toFixed(1),
    tris: Math.round(per * total),
    trisWasted: Math.round(per * (total - inside)),
    frustumCulled: !!o.frustumCulled,
    cast: !!o.castShadow,
    instRadiusM: +maxR.toFixed(3),
    meanDistM: +(dSum / total).toFixed(1),
    maxDistM: +dMax.toFixed(1),
  });
});
rows.sort((a, b) => b.trisWasted - a.trisWasted);
const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
return {
  cascadeMapSizes: cascades.map((c) => c.mapSize),
  shadowDistance: lighting?.shadowDistance,
  totals: {
    tris: sum((r) => r.tris),
    trisOffScreen: sum((r) => r.trisWasted),
    casterTris: sum((r) => (r.cast ? r.tris : 0)),
    casterTrisOffScreen: sum((r) => (r.cast ? r.trisWasted : 0)),
    meshesNotFrustumCulled: rows.filter((r) => !r.frustumCulled).length,
  },
  instTotals: {
    tris: sum((r) => (r.isInst ? r.tris : 0)),
    offScreen: sum((r) => (r.isInst ? r.trisWasted : 0)),
  },
  notCulled: rows.filter((r) => !r.frustumCulled).map((r) => [r.name, r.inst, r.tris, r.pctIn]).slice(0, 40),
  instRows: rows.filter((r) => r.isInst).sort((a, b) => b.trisWasted - a.trisWasted).slice(0, 40),
};
