/**
 * r13_whodraws.js — which mesh draws a given pixel, by ablation rather than by
 * raycast.
 *
 *   node tools/shot.mjs eval probes/r13_whodraws.js <x>,<y> [<x>,<y> ...] [--film N]
 *
 * A raycast answers this in one call and here it does not: the bars that sweep
 * the frame in motion are not hit by `intersectObjects` at the pixels they
 * visibly occupy — procedurally merged and instanced geometry in this project
 * carries bounding spheres the raycaster rejects on before it ever tests a
 * triangle. Hiding one mesh at a time and re-reading the pixel cannot lie about
 * that: it asks the renderer the same question the screenshot did.
 *
 * ~230 meshes at one render each is a few seconds, which is cheaper than the
 * four wrong guesses it replaces.
 */
const g = window.__GAME;
const THREE = g.THREE;
const eng = g.engine ?? g.world.engine;
const canvas = eng.renderer.domElement;

const args = (typeof ARGS !== 'undefined' && ARGS ? ARGS : []).slice();
let filmSteps = 0;
const fi = args.indexOf('--film');
if (fi >= 0) { filmSteps = +args[fi + 1] || 0; args.splice(fi, 2); }
const PIX = args.length
  ? args.map((a) => a.split(',').map(Number))
  : [[1310, 580]];

g.applyShot('ground');
if (window.__pinDeterminism) window.__pinDeterminism();
eng.deterministic = true;
eng.stop();

// Reproduce `film`'s camera exactly (tools/render.mjs) when asked, so a defect
// that only exists while the camera trucks can be interrogated at all.
if (filmSteps) {
  const p0 = eng.camera.position.clone();
  const q0 = eng.camera.quaternion.clone();
  let t = 0;
  for (let k = 0; k < filmSteps; k++) {
    t += 1 / 60;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(t * 0.22) * 0.16);
    eng.camera.quaternion.copy(q).multiply(q0);
    eng.camera.position.copy(p0);
    eng.camera.position.x += Math.sin(t * 0.35) * 3.2;
    eng.camera.position.z += (Math.cos(t * 0.35) - 1) * 3.2;
    eng.step(1 / 60);
  }
} else {
  g.settle(16);
}

const c2 = document.createElement('canvas');
c2.width = canvas.width; c2.height = canvas.height;
const ctx = c2.getContext('2d', { willReadFrequently: true });
const sx = canvas.width / 1920, sy = canvas.height / 1080;
function read() {
  for (let i = 0; i < 3; i++) eng.render();
  ctx.drawImage(canvas, 0, 0);
  return PIX.map(([px, py]) => {
    const d = ctx.getImageData(Math.round(px * sx), Math.round(py * sy), 3, 3).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return s / (d.length / 4);
  });
}

const base = read();
const meshes = [];
g.world.scene.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && o.visible) meshes.push(o); });

const found = [];
for (const o of meshes) {
  o.visible = false;
  const now = read();
  o.visible = true;
  const delta = now.map((v, i) => +(v - base[i]).toFixed(1));
  if (delta.some((d) => Math.abs(d) > 6)) {
    found.push({ mesh: o.name || '(unnamed)', mat: o.material?.name || o.material?.type || '', delta });
  }
}

// Null control: the same read twice with nothing hidden, so the noise floor of
// the method is next to its results.
const nullCtl = read().map((v, i) => +(v - base[i]).toFixed(1));

return { pixels: PIX, base: base.map((v) => +v.toFixed(1)), nullControl: nullCtl, found, scanned: meshes.length };
