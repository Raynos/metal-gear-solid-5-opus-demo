// How deep is the apron buried? Lift the whole surface and count the pixels
// that survive the depth test at each lift.
const eng = g.engine;
eng.pipeline.enabled.autoExposure = false;
const apron = g.world.registry.rocks.apron;
const prev = apron.material;
apron.material = new THREE.MeshBasicMaterial({ color: 0xff00ff });
apron.matrixAutoUpdate = true;
const gl = eng.renderer.getContext();
function count() {
  g.settle(3);
  const s = eng.renderer.getSize(new THREE.Vector3());
  const px = new Uint8Array((s.x | 0) * (s.y | 0) * 4);
  gl.readPixels(0, 0, s.x | 0, s.y | 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] > 150 && px[i + 2] > 150 && px[i + 1] < 110) n++;
  return n;
}
const out = {};
g.applyShot('vista');
for (const lift of [0, 1, 2, 4, 8, 16, 32, 64]) {
  apron.position.y = lift;
  apron.updateMatrix();
  apron.updateMatrixWorld(true);
  out['lift' + lift] = count();
}
apron.position.y = 0;
apron.updateMatrix();
apron.material = prev;
apron.matrixAutoUpdate = false;
return out;
