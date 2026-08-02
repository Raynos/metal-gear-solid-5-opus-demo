// Does uPerf actually reach the shader? Read the frame back with each hook set
// and compare against the shipped path. A cost hook that changes no pixels is
// measuring nothing, and r12_ab.js reported ~0 for every one of them.
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const renderer = eng.renderer;
const gl = renderer.getContext();
g.applyShot('gameplay');
g.settle(30);
// Freeze the clock. settle() advances time, and grain/TAA/volumetric history
// alone moved 59% of the pixels between two identical configurations — a
// control that large makes every reading below it meaningless.
eng.deterministic = true;
eng.stop();
for (let i = 0; i < 12; i++) eng.render();

let U = null;
eng.scene.traverse((o) => {
  if (o.isMesh && /^terrain-L/.test(o.name || '') && o.material?.userData?.shader) U = o.material.userData.shader.uniforms;
});
if (!U) return { error: 'no uniforms' };

const W = renderer.domElement.width, H = renderer.domElement.height;
function grab() {
  for (let i = 0; i < 12; i++) eng.render();
  const buf = new Uint8Array(W * H * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return buf;
}
function stats(a, b) {
  let diff = 0, n = 0, sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > 3) diff++;
    sum += d; n++;
  }
  return { pctChanged: +(100 * diff / n).toFixed(2), meanAbsDiff: +(sum / n / 3).toFixed(3) };
}

U.uPerf.value.set(0, 0, 0, 0);
const base = grab();
U.uPerf.value.set(0, 0, 0, 0);
const ctrl = grab();
const out = { nullControl: stats(base, ctrl) };
for (const [k, v] of [['flat', [1, 0, 0, 0]], ['noBedrock', [0, 1, 0, 0]], ['noDetailNrm', [0, 0, 1, 0]], ['noNearField', [0, 0, 0, 1]]]) {
  U.uPerf.value.set(...v);
  out[k] = stats(base, grab());
}
U.uPerf.value.set(0, 0, 0, 0);
return out;
