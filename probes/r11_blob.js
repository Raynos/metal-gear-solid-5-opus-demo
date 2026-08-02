/**
 * r11_blob.js — every mesh under the black polygon, and the terrain uniforms
 * that could be painting it.
 *
 * Three ablations have now come back negative: the blob survives the CSM shadow
 * term forced to 1.0, it survives the cloud-shadow term forced off, and it
 * survives AO forced off. TODO 1.3 says it is "CONFIRMED shadow map"; it is not.
 * So list ALL raycast hits at the blob pixels (not just the nearest — a decal
 * coplanar with the ground sorts arbitrarily) and dump the terrain material's
 * traffic/wear state, which is the one large-scale dark modulation in that
 * shader.
 */
const g = window.__GAME;
const THREE = g.THREE;
const world = g.world;

g.applyShot('ground');
if (window.__pinDeterminism) window.__pinDeterminism();
for (let i = 0; i < 8; i++) { g.engine.step(1 / 60); g.engine.render(); }
const cam = g.engine.camera;
cam.updateMatrixWorld();

const W = 1920, H = 1080;
const PIX = [['blob-mid', 1150, 775], ['lit-control', 1100, 930], ['tarp-black', 1660, 760]];
const rc = new THREE.Raycaster();
const hits = {};
for (const [name, px, py] of PIX) {
  rc.setFromCamera(new THREE.Vector2((px / W) * 2 - 1, -((py / H) * 2 - 1)), cam);
  hits[name] = rc
    .intersectObjects(world.scene.children, true)
    .filter((h) => h.object.visible)
    .slice(0, 5)
    .map((h) => ({
      obj: h.object.name || '(unnamed)',
      mat: h.object.material?.name || '',
      d: +h.distance.toFixed(3),
      y: +h.point.y.toFixed(3),
      recv: !!h.object.receiveShadow,
    }));
}

// Terrain material state.
const terr = [];
world.scene.traverse((o) => {
  if (!o.isMesh || !/terrain/i.test(o.name || '')) return;
  const u = o.material?.userData?.u;
  if (!u) { terr.push({ name: o.name, u: 'none' }); return; }
  terr.push({
    name: o.name,
    wearOn: u.uWearOn?.value,
    wearOrg: u.uWearOrg?.value?.toArray?.().map((v) => +v.toFixed(2)),
    wearXf: u.uWearXf?.value?.toArray?.().map((v) => +v.toFixed(4)),
    wearOff: u.uWearOff?.value?.toArray?.().map((v) => +v.toFixed(2)),
    wearMapSize: u.uWearMap?.value?.image?.width ?? null,
    dbg: u.uDbg?.value?.toArray?.(),
    dbg2: u.uDbg2?.value?.toArray?.(),
    dbg3: u.uDbg3?.value?.toArray?.(),
  });
});

// Everything the outpost put on the ground, by name, near the camera.
const near = [];
const p = new THREE.Vector3();
world.scene.traverse((o) => {
  if (!(o.isMesh || o.isInstancedMesh)) return;
  o.getWorldPosition(p);
  if (p.distanceTo(cam.position) > 30) return;
  near.push(`${o.name || '(unnamed)'}|${o.material?.name || ''}|${p.distanceTo(cam.position).toFixed(1)}m`);
});

return { hits, terrain: terr.slice(0, 6), nearMeshes: near.slice(0, 60) };
