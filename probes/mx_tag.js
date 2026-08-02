// Attribution. Replace uRust with pure GREEN and uDust with pure BLUE, then
// render the unlit albedo. The green/blue that comes back IS the mix weight of
// the rust and dust films on that surface, per pixel, area-averaged. Anything
// left in red is the material's own authored paint.
const g = window.__GAME;
const THREE = g.THREE;
const eng = g.engine;
const renderer = eng.renderer;
const scene = eng.scene;
eng.pipeline.enabled.autoExposure = false;
g.setFreeFly(false);
const W = eng.pipeline.width | 0, H = eng.pipeline.height | 0;

const mats = [], matId = new Map(), nodes = new Map(), meshes = [];
scene.traverse((o) => {
  if (!(o.isMesh || o.isInstancedMesh || o.isSkinnedMesh)) return;
  meshes.push(o);
  for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
    if (!m) continue;
    if (!matId.has(m)) { matId.set(m, mats.length + 1); mats.push(m); nodes.set(m, new Set()); }
    if (nodes.get(m).size < 3) nodes.get(m).add((o.name || '?').replace(/[-_.]?\d{3,}.*$/, ''));
  }
});
const idMat = new Map();
for (const m of mats) {
  const id = matId.get(m);
  idMat.set(m, new THREE.MeshBasicMaterial({
    color: new THREE.Color().setRGB((id & 255) / 255, ((id >> 8) & 255) / 255, 0, THREE.LinearSRGBColorSpace),
    side: m.side, map: m.alphaTest > 0 ? (m.map ?? m.alphaMap ?? null) : null,
    alphaTest: m.alphaTest ?? 0, fog: false, toneMapped: false,
  }));
}
const rtId = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
const rtLin = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, colorSpace: THREE.NoColorSpace });
function renderTo(rt, arr) {
  renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 1); renderer.clear(true, true, true);
  renderer.render(scene, eng.camera);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, arr);
  renderer.setRenderTarget(null);
}
function grabIds() {
  const sv = meshes.map((o) => o.material);
  meshes.forEach((o) => { o.material = Array.isArray(o.material) ? o.material.map((m) => idMat.get(m)) : idMat.get(o.material); });
  const fog = scene.fog, bg = scene.background; scene.fog = null; scene.background = null;
  const px = new Uint8Array(W * H * 4); renderTo(rtId, px);
  scene.fog = fog; scene.background = bg; meshes.forEach((o, i) => (o.material = sv[i]));
  return px;
}
function grabAlbedo() {
  const lights = [];
  scene.traverse((o) => { if (o.isLight) { lights.push([o, o.intensity]); o.intensity = 0; } });
  const env = scene.environment, envI = scene.environmentIntensity, fog = scene.fog, bg = scene.background;
  scene.environment = null; scene.environmentIntensity = 0; scene.fog = null; scene.background = null;
  const amb = new THREE.AmbientLight(0xffffff, Math.PI); scene.add(amb);
  const px = new Uint8Array(W * H * 4); renderTo(rtLin, px);
  scene.remove(amb);
  lights.forEach(([o, i]) => (o.intensity = i));
  scene.environment = env; scene.environmentIntensity = envI; scene.fog = fog; scene.background = bg;
  return px;
}
const U = mats.filter((m) => m.userData?.u?.uDust || m.userData?.u?.uRust || m.userData?.u?.uBounce);
const SV = U.map((m) => ({
  m,
  dust: m.userData.u.uDust?.value?.clone?.(),
  rust: m.userData.u.uRust?.value?.clone?.(),
  bounce: m.userData.u.uBounce?.value?.clone?.(),
  base: m.userData.u.uBase?.value?.clone?.(), base2: m.userData.u.uBase2?.value?.clone?.(), base3: m.userData.u.uBase3?.value?.clone?.(),
}));
function tag(on) {
  for (const s of SV) {
    const u = s.m.userData.u;
    if (u.uBounce) u.uBounce.value.set(0, 0, 0);
    if (!on) {
      if (u.uDust && s.dust) u.uDust.value.copy(s.dust);
      if (u.uRust && s.rust) u.uRust.value.copy(s.rust);
      if (u.uBase && s.base) u.uBase.value.copy(s.base);
      if (u.uBase2 && s.base2) u.uBase2.value.copy(s.base2);
      if (u.uBase3 && s.base3) u.uBase3.value.copy(s.base3);
      if (u.uBounce && s.bounce) u.uBounce.value.copy(s.bounce);
    } else {
      // paint -> RED, rust -> GREEN, dust -> BLUE. Equal luminance-free markers.
      if (u.uBase) u.uBase.value.set(0.8, 0, 0);
      if (u.uBase2) u.uBase2.value.set(0.8, 0, 0);
      if (u.uBase3) u.uBase3.value.set(0.8, 0, 0);
      if (u.uRust) u.uRust.value.set(0, 0.8, 0);
      if (u.uDust) u.uDust.value.set(0, 0, 0.8);
    }
  }
}
let s = `tagged materials: ${U.length}/${mats.length}\n`;
for (const shot of ['ground', 'outpost']) {
  g.applyShot(shot);
  const I = grabIds();
  tag(true);
  const A = grabAlbedo();
  tag(false);
  const acc = new Map();
  const N = W * H;
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    const id = I[o] | (I[o + 1] << 8);
    if (!id || id > mats.length) continue;
    let a = acc.get(id);
    if (!a) { a = { n: 0, r: 0, g: 0, b: 0 }; acc.set(id, a); }
    a.n++; a.r += A[o]; a.g += A[o + 1]; a.b += A[o + 2];
  }
  s += `\n=== ${shot} === share of each surface owned by its authored PAINT / RUST film / DUST film\n`;
  s += 'material            pct%   paint%  rust%  dust%   nodes\n';
  const rows = [...acc].filter(([id, v]) => v.n > N * 0.0012 && U.includes(mats[id - 1])).sort((a, b) => b[1].n - a[1].n);
  for (const [id, v] of rows) {
    const m = mats[id - 1];
    const R = v.r / v.n, G = v.g / v.n, B = v.b / v.n, T = R + G + B || 1;
    s += `${(m.name || '(unnamed)').padEnd(15)} ${((100 * v.n) / N).toFixed(2).padStart(6)}  ${((100 * R) / T).toFixed(1).padStart(6)} ${((100 * G) / T).toFixed(1).padStart(6)} ${((100 * B) / T).toFixed(1).padStart(6)}   ${[...nodes.get(m)].join(' ')}\n`;
  }
}
return s;
