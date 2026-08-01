// Are the small clasts buried? Lift them and count visible pixels.
const eng = g.engine;
const gl = eng.renderer.getContext();
eng.pipeline.enabled.autoExposure = false;
const rocks = g.world.registry.rocks;
const CLAST = ['chips', 'stones', 'boulders'];
const meshes = (rocks.meshes ?? []).filter((m) => CLAST.some((f) => m.name.includes('rock_' + f)));
const id = new THREE.MeshBasicMaterial({ color: 0xff00ff });
const prev = meshes.map((m) => m.material);
meshes.forEach((m) => { m.material = id; m.matrixAutoUpdate = true; });
function count() {
  g.settle(3);
  const s = eng.renderer.getSize(new THREE.Vector3());
  const px = new Uint8Array((s.x | 0) * (s.y | 0) * 4);
  gl.readPixels(0, 0, s.x | 0, s.y | 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] > 150 && px[i + 2] > 150 && px[i + 1] < 110) n++;
  return n;
}
const out = { meshes: meshes.length, instances: meshes.reduce((a, m) => a + m.count, 0) };
g.applyShot('outpost');
for (const lift of [0, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6]) {
  meshes.forEach((m) => { m.position.y = lift; m.updateMatrix(); m.updateMatrixWorld(true); });
  out['lift' + lift] = count();
}
meshes.forEach((m, i) => { m.position.y = 0; m.updateMatrix(); m.updateMatrixWorld(true); m.material = prev[i]; m.matrixAutoUpdate = false; });
return out;
