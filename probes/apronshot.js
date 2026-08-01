// Where is the apron? Magenta with depth test ON (what you can actually see)
// versus OFF (everything that exists in the frustum). If the two differ wildly
// the aprons are buried under the drawn clipmap, not merely off-screen.
const eng = g.engine;
eng.pipeline.enabled.autoExposure = false;
const rocks = g.world.registry.rocks;
const apron = rocks.apron;
const prev = apron.material;
function snap(name) { g.settle(4); window.__snaps[name] = eng.renderer.domElement.toDataURL('image/png'); }
function count(name) {
  const gl = eng.renderer.getContext();
  const s = eng.renderer.getSize(new THREE.Vector3());
  const px = new Uint8Array((s.x | 0) * (s.y | 0) * 4);
  gl.readPixels(0, 0, s.x | 0, s.y | 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] > 150 && px[i + 2] > 150 && px[i + 1] < 110) n++;
  return { [name]: n, pct: +((n / (px.length / 4)) * 100).toFixed(3) };
}
const out = {};
g.applyShot('vista');
apron.material = new THREE.MeshBasicMaterial({ color: 0xff00ff });
snap('vista-id-depth');
out.depthOn = count('px');
apron.material.depthTest = false;
apron.material.needsUpdate = true;
snap('vista-id-nodepth');
out.depthOff = count('px');
apron.material = prev;
return out;
