// Where are the small clasts? Magenta ID pass, depth on and off.
const eng = g.engine;
const gl = eng.renderer.getContext();
eng.pipeline.enabled.autoExposure = false;
const rocks = g.world.registry.rocks;
const CLAST = ['chips', 'stones', 'talus'];
const meshes = (rocks.meshes ?? []).filter((m) => CLAST.some((f) => m.name.includes('rock_' + f)));
const id = new THREE.MeshBasicMaterial({ color: 0xff00ff });
function count(name) {
  g.settle(4);
  window.__snaps[name] = eng.renderer.domElement.toDataURL('image/png');
  const s = eng.renderer.getSize(new THREE.Vector3());
  const px = new Uint8Array((s.x | 0) * (s.y | 0) * 4);
  gl.readPixels(0, 0, s.x | 0, s.y | 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] > 150 && px[i + 2] > 150 && px[i + 1] < 110) n++;
  return n;
}
const prev = meshes.map((m) => m.material);
meshes.forEach((m) => (m.material = id));
const out = { meshes: meshes.length, instances: meshes.reduce((a, m) => a + m.count, 0) };
g.applyShot('outpost');
out.outpostDepthOn = count('outpost-clast-id');
id.depthTest = false; id.needsUpdate = true;
out.outpostDepthOff = count('outpost-clast-nodepth');
id.depthTest = true; id.needsUpdate = true;
g.applyShot('gameplay');
out.gameplayDepthOn = count('gameplay-clast-id');
meshes.forEach((m, i) => (m.material = prev[i]));
out.perMesh = meshes.map((m) => ({ n: m.name, c: m.count, cast: m.castShadow })).slice(0, 40);
return out;
