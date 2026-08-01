/**
 * Screen row of the true horizon (elevation 0) at frame centre for every
 * canonical shot, plus the row of the highest and lowest horizon point across
 * the frame width. Used to bound "strictly below the horizon" tests so they are
 * geometry, not a guess off a thumbnail.
 */
g.setFreeFly(false);
const engine = g.engine;
const W = 1920, H = 1080;
const out = {};
for (const name of Object.keys(g.shots)) {
  g.applyShot(name);
  engine.camera.aspect = W / H;
  engine.camera.updateProjectionMatrix();
  engine.camera.updateMatrixWorld();
  g.settle(2);
  const rows = [];
  for (let i = 0; i <= 32; i++) {
    // A ray in the horizontal plane through the camera, swept across the frame.
    const ndcX = (i / 32) * 2 - 1;
    const v = new THREE.Vector3(ndcX, 0, 0.5).unproject(engine.camera).sub(engine.camera.position);
    v.y = 0;
    v.normalize().add(engine.camera.position);
    const s = v.project(engine.camera);
    rows.push(((1 - s.y) / 2) * H);
  }
  out[name] = {
    centre: +rows[16].toFixed(1),
    min: +Math.min(...rows).toFixed(1),
    max: +Math.max(...rows).toFixed(1),
    camY: +engine.camera.position.y.toFixed(2),
  };
}
return out;
