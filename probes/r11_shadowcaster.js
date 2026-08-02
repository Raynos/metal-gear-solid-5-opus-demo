/**
 * r11_shadowcaster.js — "what is casting that black polygon?"
 *
 * TODO.md 1.3 says the hard-edged black blobs are real cast shadows (they go
 * away with shadowMap.enabled = false) but nobody has ever named the occluder.
 * Guessing from a screenshot is how the pale-shard defect stayed misattributed
 * for two rounds. This answers it geometrically: take the canonical `ground`
 * pose, shoot a ray from the camera through a named screen pixel to find the
 * receiver, then shoot a second ray from that receiver up the key direction and
 * report every mesh it passes through, with names and distances.
 *
 * It also reports the cascade each sample lands in and that cascade's texel
 * footprint in metres, because "hard edge" and "10 cm texel" are the same
 * sentence and the frame cannot tell you which cascade drew it.
 */
const g = window.__GAME;
const THREE = g.THREE;
const world = g.world;
const lighting = world.lighting;

g.applyShot('ground');
if (window.__pinDeterminism) window.__pinDeterminism();
for (let i = 0; i < 8; i++) g.engine.step(1 / 60);
const cam = g.engine.camera;
cam.updateMatrixWorld();

const W = 1920, H = 1080;
// Pixels picked off shots/before/ground.png: two inside the big black polygon,
// one inside the pure-black pocket under the tarp, one on lit sand as a control.
const PIX = [
  ['blob-left', 950, 740],
  ['blob-mid', 1150, 775],
  ['tarp-black', 1660, 760],
  ['lit-control', 1100, 930],
];

const rc = new THREE.Raycaster();
rc.far = 4000;
const out = [];
const key = lighting.keyDirection.clone();

const splits = Array.from(lighting._splits ?? []);

for (const [name, px, py] of PIX) {
  const ndc = new THREE.Vector2((px / W) * 2 - 1, -((py / H) * 2 - 1));
  rc.setFromCamera(ndc, cam);
  const hits = rc.intersectObjects(world.scene.children, true).filter((h) => h.object.visible);
  if (!hits.length) { out.push({ name, receiver: 'MISS' }); continue; }
  const hit = hits[0];
  const p = hit.point.clone();
  const dist = p.distanceTo(cam.position);

  // Which cascade owns this depth, and what is one of its texels worth?
  let cascade = -1;
  for (let c = 0; c < splits.length - 1; c++) {
    if (dist >= splits[c] && dist < splits[c + 1]) { cascade = c; break; }
  }
  const L = lighting.cascades[Math.max(cascade, 0)];
  const radius = L ? (L.shadow.camera.right - L.shadow.camera.left) / 2 : 0;
  const texelM = L ? (2 * radius) / L.shadow.mapSize.x : 0;

  // Now up the sun ray from just above the receiver.
  const rc2 = new THREE.Raycaster(p.clone().addScaledVector(key, 0.05), key.clone(), 0, 900);
  const occ = rc2
    .intersectObjects(world.scene.children, true)
    .filter((h) => h.object.visible && h.object.castShadow !== false)
    .slice(0, 6)
    .map((h) => ({
      name: h.object.name || '(unnamed)',
      mat: h.object.material?.name || '',
      up: +h.distance.toFixed(2),
      cast: !!h.object.castShadow,
    }));

  out.push({
    name,
    receiver: hit.object.name || '(unnamed)',
    receiverMat: hit.object.material?.name || '',
    receiveShadow: !!hit.object.receiveShadow,
    camDist: +dist.toFixed(1),
    cascade,
    cascadeRadiusM: +radius.toFixed(1),
    texelCm: +(texelM * 100).toFixed(1),
    occluders: occ,
  });
}

return {
  keyDir: key.toArray().map((v) => +v.toFixed(3)),
  splits: splits.map((v) => +v.toFixed(1)),
  cascadeCount: lighting.cascadeCount,
  mapSizes: lighting.cascades.map((l) => l.shadow.mapSize.x),
  refreshInterval: lighting.refreshInterval,
  samples: out,
};
