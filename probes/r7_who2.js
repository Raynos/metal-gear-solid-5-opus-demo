// Raycast the region against EVERYTHING and report which object is nearest.
g.setFreeFly(false);
const engine = g.engine, scene = engine.scene;
const W = engine.pipeline.width, H = engine.pipeline.height;
const ray = new THREE.Raycaster();
const out = {};
const REGIONS = {
  ridge: [500, 800, 1200, 1050],
  ground: [300, 780, 1100, 900],
  vista: [200, 850, 1700, 1030],
  outpost: [1200, 830, 1900, 1000],
};
for (const [shot, b] of Object.entries(REGIONS)) {
  g.applyShot(shot);
  g.settle(2);
  const cam = engine.camera;
  const tally = {};
  const dists = [];
  for (let k = 0; k < 220; k++) {
    const x = b[0] + Math.random() * (b[2] - b[0]);
    const y = b[1] + Math.random() * (b[3] - b[1]);
    ray.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -((y / H) * 2 - 1)), cam);
    const hits = ray.intersectObjects(scene.children, true)
      .filter((h) => h.object.visible && h.object.isMesh && h.object.name !== 'sky');
    const h = hits[0];
    const n = h ? (h.object.name || h.object.type) : 'MISS';
    tally[n] = (tally[n] ?? 0) + 1;
    if (h) dists.push(h.distance);
  }
  dists.sort((a, c) => a - c);
  out[shot] = {
    top: Object.entries(tally).sort((a, c) => c[1] - a[1]).slice(0, 8),
    dist: dists.length ? { min: +dists[0].toFixed(1), med: +dists[dists.length >> 1].toFixed(1), max: +dists[dists.length - 1].toFixed(1) } : null,
  };
}
return out;
