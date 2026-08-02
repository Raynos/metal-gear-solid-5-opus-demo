/**
 * r13_bars.js — what the solid bars sweeping the frame in motion actually are.
 *
 * TODO §3 files them as "perimeter wire and mast guys ... only visible in
 * motion", which is a guess: nothing has ever raycast one. They are only in
 * frame while the camera trucks, so reproduce `film`'s camera exactly (see
 * tools/render.mjs) rather than the static pose, and raycast frame 9.
 */
const g = window.__GAME;
const THREE = g.THREE;
const eng = g.engine ?? g.world.engine;

g.applyShot('ground');
if (window.__pinDeterminism) window.__pinDeterminism();
eng.deterministic = true;
eng.stop();
const p0 = eng.camera.position.clone();
const q0 = eng.camera.quaternion.clone();
let t = 0;
// film ground --frames 10 --every 4 -> frame 9 is 40 steps in.
for (let k = 0; k < 40; k++) {
  t += 1 / 60;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(t * 0.22) * 0.16);
  eng.camera.quaternion.copy(q).multiply(q0);
  eng.camera.position.copy(p0);
  eng.camera.position.x += Math.sin(t * 0.35) * 3.2;
  eng.camera.position.z += (Math.cos(t * 0.35) - 1) * 3.2;
  eng.step(1 / 60);
}
const cam = eng.camera;
cam.updateMatrixWorld();

const W = 1920, H = 1080;
const rc = new THREE.Raycaster();
const at = (px, py) => {
  rc.setFromCamera(new THREE.Vector2((px / W) * 2 - 1, -((py / H) * 2 - 1)), cam);
  return rc.intersectObjects(g.world.scene.children, true)
    .filter((h) => h.object.visible)
    .slice(0, 3)
    .map((h) => `${h.object.name || '(unnamed)'}|${h.object.material?.name || ''}|${h.distance.toFixed(2)}m`);
};

// Points along the two bars in f09.
const hits = {
  'bar1 upper-right': at(1620, 130),
  'bar1 middle': at(1080, 620),
  'bar1 lower-left': at(880, 900),
  'bar2 far-right': at(1830, 55),
  'bar2 lower': at(1500, 900),
};

// Anything with a cable-ish name, with its true world extent.
const cables = [];
const c = new THREE.Vector3();
g.world.scene.traverse((o) => {
  if (!(o.isMesh || o.isInstancedMesh) || !o.visible) return;
  if (!/cable|telegraph|razor|link|mast/i.test(o.name || '')) return;
  o.geometry?.computeBoundingSphere?.();
  const bs = o.geometry?.boundingSphere;
  if (!bs) return;
  c.copy(bs.center).applyMatrix4(o.matrixWorld);
  cables.push(`${o.name}|${o.material?.name}|centre ${c.distanceTo(cam.position).toFixed(1)}m|r ${bs.radius.toFixed(1)}m`);
});

return { hits, cables, cam: cam.position.toArray().map((v) => +v.toFixed(2)) };
