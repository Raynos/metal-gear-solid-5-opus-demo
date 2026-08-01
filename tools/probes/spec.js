/**
 * TASK 2 evidence — is the specular transport broken, or are the materials all
 * roughness ~1?
 *
 * (a) Census of every material actually drawn, weighted by triangle count:
 *     roughness, metalness, and whether a roughnessMap is bound.
 * (b) A controlled probe: ten spheres in FULL SUN, roughness 0.10..1.0 at
 *     metalness 0 and 1, run through the shipped post stack, scored with the
 *     same local-maxima specular detector the critique used (luma > 180, more
 *     than 2.0x its 17x17 neighbourhood mean, and more than 70 codes above it).
 */
// The free-fly camera system (order 1000) rewrites engine.camera.quaternion
// every step from its own yaw/pitch. On a page where no shot has been applied
// yet it is still armed, and it silently re-aims any camera a probe installs.
g.setFreeFly(false);
const L = g.world.lighting;
const engine = g.engine;
const scene = engine.scene;
const renderer = engine.renderer;
const gl = renderer.getContext();
const terrain = g.world.terrain;
const W = 1920, H = 1080;

// --- (a) material census --------------------------------------------------
const census = new Map();
let tris = 0;
scene.traverse((o) => {
  if (!o.isMesh && !o.isInstancedMesh) return;
  if (!o.visible) return;
  const geo = o.geometry;
  const n = geo?.index ? geo.index.count / 3 : (geo?.attributes?.position?.count ?? 0) / 3;
  const inst = o.isInstancedMesh ? o.count : 1;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  for (const m of mats) {
    if (!m) continue;
    const r = m.roughness == null ? 'n/a' : m.roughness.toFixed(2);
    const k = `${m.type} r=${r} m=${(m.metalness ?? 0).toFixed(2)} rmap=${m.roughnessMap ? 1 : 0}`;
    const e = census.get(k) ?? { tris: 0, meshes: 0 };
    e.tris += n * inst;
    e.meshes++;
    census.set(k, e);
    tris += n * inst;
  }
});
const top = [...census.entries()].sort((a, b) => b[1].tris - a[1].tris).slice(0, 22)
  .map(([k, v]) => `${(100 * v.tris / tris).toFixed(1)}% ${Math.round(v.tris)}tri x${v.meshes}  ${k}`);

// Triangle-weighted roughness histogram over everything that has one.
const hist = new Array(10).fill(0);
let rw = 0;
for (const [k, v] of census) {
  const m = /r=([\d.]+)/.exec(k);
  if (!m) continue;
  hist[Math.min(9, Math.floor(+m[1] * 10))] += v.tris;
  rw += v.tris;
}

// --- (b) controlled sun-facing spheres ------------------------------------
const ROUGH = [0.10, 0.20, 0.35, 0.55, 0.80, 1.00];
const px = -60, pz = -60;
const gy = terrain.heightAt(px, pz);
const spheres = [];
for (let mi = 0; mi < 2; mi++) {
  for (let i = 0; i < ROUGH.length; i++) {
    const s = new THREE.Mesh(
      new THREE.SphereGeometry(0.85, 96, 64),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color().setRGB(0.45, 0.42, 0.38, THREE.LinearSRGBColorSpace),
        roughness: ROUGH[i], metalness: mi,
      }),
    );
    s.castShadow = false;
    s.receiveShadow = true;
    spheres.push(s);
    scene.add(s);
  }
}

const cam = new THREE.PerspectiveCamera(34, W / H, 0.1, 3000);
const prevCam = engine.camera;
const buf = new Uint8Array(W * H * 4);

L.setTimeOfDay('afternoon');
const sun = L.sunDirection.clone();
// Stand the row across the camera's view, camera roughly opposite the sun so
// the specular lobe of each sphere points back at us.
const right = new THREE.Vector3(0, 1, 0).cross(sun).normalize();
const centre = new THREE.Vector3(px, gy + 2.2, pz);
spheres.forEach((s, idx) => {
  const i = idx % ROUGH.length;
  const mi = Math.floor(idx / ROUGH.length);
  s.position.copy(centre).addScaledVector(right, (i - (ROUGH.length - 1) / 2) * 2.2).setY(gy + 2.2 + mi * 2.2);
});
// Half-vector geometry: put the camera where H = normal on the sphere's face,
// i.e. mirror the sun about the horizontal.
const view = new THREE.Vector3(sun.x, -sun.y, sun.z).normalize();
cam.position.copy(centre).addScaledVector(view, 11).setY(centre.y + 1.4);
cam.lookAt(centre.x, centre.y + 1.1, centre.z);
cam.updateMatrixWorld();
cam.updateProjectionMatrix();
engine.camera = cam;
L.invalidateShadows();
g.settle(12);
gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
window.__snaps = window.__snaps || {};

// Local-maxima specular detector, run over the whole frame.
const luma = new Float32Array(W * H);
for (let i = 0; i < W * H; i++) luma[i] = 0.2126 * buf[i * 4] + 0.7152 * buf[i * 4 + 1] + 0.0722 * buf[i * 4 + 2];
// 17x17 box mean via a summed-area table.
const sat = new Float64Array((W + 1) * (H + 1));
for (let y = 0; y < H; y++) {
  let row = 0;
  for (let x = 0; x < W; x++) {
    row += luma[y * W + x];
    sat[(y + 1) * (W + 1) + x + 1] = sat[y * (W + 1) + x + 1] + row;
  }
}
const boxMean = (x, y, r) => {
  const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
  const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
  const s = sat[y1 * (W + 1) + x1] - sat[y0 * (W + 1) + x1] - sat[y1 * (W + 1) + x0] + sat[y0 * (W + 1) + x0];
  return s / ((x1 - x0) * (y1 - y0));
};
function detect(x0, x1, y0, y1) {
  let n = 0, peak = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const l = luma[y * W + x];
    if (l <= 180) continue;
    const m = boxMean(x, y, 8);
    if (l > 2.0 * m && l > m + 70) { n++; peak = Math.max(peak, l); }
  }
  return { n, peak: +peak.toFixed(1) };
}

// Per-sphere windows from their projected centres.
const per = {};
const v = new THREE.Vector3();
spheres.forEach((s, idx) => {
  v.copy(s.position).project(cam);
  const sx = Math.round(((v.x + 1) / 2) * W);
  const syGL = Math.round(((v.y + 1) / 2) * H);
  const sy = H - 1 - syGL;
  const rad = 90;
  const d = detect(Math.max(0, sx - rad), Math.min(W, sx + rad), Math.max(0, sy - rad), Math.min(H, sy + rad));
  let mx = 0;
  for (let y = Math.max(0, sy - rad); y < Math.min(H, sy + rad); y++)
    for (let x = Math.max(0, sx - rad); x < Math.min(W, sx + rad); x++) mx = Math.max(mx, luma[y * W + x]);
  per[`m${Math.floor(idx / ROUGH.length)}_r${ROUGH[idx % ROUGH.length]}`] = { ...d, maxLuma: +mx.toFixed(1), at: [sx, sy] };
});
const whole = detect(0, W, 0, H);

window.__snaps.spec = renderer.domElement.toDataURL('image/png');

spheres.forEach((s) => scene.remove(s));
engine.camera = prevCam;

return {
  census: top,
  roughnessHistogram: hist.map((v, i) => `${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}: ${(100 * v / rw).toFixed(1)}%`),
  probeSpheres: per,
  wholeFrame: whole,
  envIntensity: scene.environmentIntensity,
  hasEnv: !!scene.environment,
};
