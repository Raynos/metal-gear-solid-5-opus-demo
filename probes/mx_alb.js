// Three tests in one pass:
//  A. UNLIT ALBEDO. Kill every light, add AmbientLight(white, PI) -> a
//     MeshStandardMaterial's output is exactly its albedo. Render DIRECT to a
//     half-float RT, bypassing the pipeline (no ACES, no grade, no fog, no
//     aerial perspective). Grouped by the ID pass -> what the shader-injected
//     albedo ACTUALLY resolves to per material, on screen, in linear.
//  B. SPECULAR ABLATION done through the material's own uAbl/uSpecAbl uniform
//     (material.roughness is dead code -- the shaders overwrite roughnessFactor).
//  C. names for the unnamed materials.
const g = window.__GAME;
const THREE = g.THREE;
const eng = g.engine;
const renderer = eng.renderer;
const scene = eng.scene;
const gl = renderer.getContext();
eng.pipeline.enabled.autoExposure = false;
g.setFreeFly(false);
const W = eng.pipeline.width | 0;
const H = eng.pipeline.height | 0;

const mats = [];
const matId = new Map();
const exemplar = new Map();
const meshes = [];
scene.traverse((o) => {
  if (!(o.isMesh || o.isInstancedMesh || o.isSkinnedMesh)) return;
  meshes.push(o);
  const ms = Array.isArray(o.material) ? o.material : [o.material];
  for (const m of ms) {
    if (!m) continue;
    if (m.userData.__nodes) m.userData.__nodes.add((o.name || '?').replace(/[-_]?\d{3,}.*$/, ''));
    if (matId.has(m)) continue;
    matId.set(m, mats.length + 1);
    mats.push(m);
    exemplar.set(m, o.name || o.parent?.name || '?');
    m.userData.__nodes = new Set();
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

function swapTo(get) {
  const saved = meshes.map((o) => o.material);
  meshes.forEach((o) => { o.material = Array.isArray(o.material) ? o.material.map(get) : get(o.material); });
  return () => meshes.forEach((o, i) => (o.material = saved[i]));
}
function renderTo(rt, arr) {
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, true, true);
  renderer.render(scene, eng.camera);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, arr);
  renderer.setRenderTarget(null);
}
function grabIds() {
  const undo = swapTo((m) => idMat.get(m));
  const fog = scene.fog, bg = scene.background; scene.fog = null; scene.background = null;
  const px = new Uint8Array(W * H * 4);
  renderTo(rtId, px);
  scene.fog = fog; scene.background = bg; undo();
  return px;
}

// --- A: unlit albedo -------------------------------------------------------
function grabAlbedo() {
  const lights = [];
  scene.traverse((o) => { if (o.isLight) { lights.push([o, o.intensity]); o.intensity = 0; } });
  const env = scene.environment, envI = scene.environmentIntensity, fog = scene.fog, bg = scene.background;
  scene.environment = null; scene.environmentIntensity = 0; scene.fog = null; scene.background = null;
  const amb = new THREE.AmbientLight(0xffffff, Math.PI);
  scene.add(amb);
  const px = new Uint8Array(W * H * 4);
  renderTo(rtLin, px);
  scene.remove(amb);
  lights.forEach(([o, i]) => (o.intensity = i));
  scene.environment = env; scene.environmentIntensity = envI; scene.fog = fog; scene.background = bg;
  return px;
}

function grabBeauty() {
  g.settle(8);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}

// --- B: specular ablation --------------------------------------------------
const ablatable = mats.filter((m) => m.userData?.u?.uAbl || m.userData?.u?.uSpecAbl);
function setAbl(v) { for (const m of ablatable) { if (m.userData.u.uAbl) m.userData.u.uAbl.value = v; if (m.userData.u.uSpecAbl) m.userData.u.uSpecAbl.value = v; } }

let s = `ablatable materials: ${ablatable.length} / ${mats.length}\n`;

for (const shot of ['ground', 'outpost', 'vista']) {
  g.applyShot(shot);
  const I = grabIds();
  const A = grabAlbedo();
  const B0 = grabBeauty();
  const BN = grabBeauty();
  setAbl(1);
  const B1 = grabBeauty();
  setAbl(0);

  const acc = new Map();
  const N = W * H;
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    const id = I[o] | (I[o + 1] << 8);
    if (!id || id > mats.length) continue;
    let a = acc.get(id);
    if (!a) { a = { n: 0, ar: 0, ag: 0, ab: 0, a2: 0, al: 0, dn: 0, dsum: 0, nn: 0, nsum: 0 }; acc.set(id, a); }
    a.n++;
    const ar = A[o] / 255, ag = A[o + 1] / 255, ab = A[o + 2] / 255;
    const al = 0.2126 * ar + 0.7152 * ag + 0.0722 * ab;
    a.ar += ar; a.ag += ag; a.ab += ab; a.al += al; a.a2 += al * al;
    // ablation delta on the beauty frame
    const d = Math.max(Math.abs(B0[o] - B1[o]), Math.abs(B0[o + 1] - B1[o + 1]), Math.abs(B0[o + 2] - B1[o + 2]));
    const nz = Math.max(Math.abs(B0[o] - BN[o]), Math.abs(B0[o + 1] - BN[o + 1]), Math.abs(B0[o + 2] - BN[o + 2]));
    a.dsum += d; a.dn++; a.nsum += nz; a.nn++;
  }
  const rows = [];
  for (const [id, a] of acc) {
    if (a.n < N * 0.001) continue;
    const m = mats[id - 1];
    const mean = a.al / a.n;
    const sd = Math.sqrt(Math.max(0, a.a2 / a.n - mean * mean));
    const R = a.ar / a.n, G = a.ag / a.n, Bc = a.ab / a.n;
    const mx = Math.max(R, G, Bc), mn = Math.min(R, G, Bc);
    rows.push({
      name: (m.name || '(unnamed)') + '|' + exemplar.get(m),
      pct: (100 * a.n) / N,
      alb: [R, G, Bc], L: mean, cv: sd / Math.max(1e-5, mean),
      sat: (mx - mn) / Math.max(1e-5, mx),
      hue: R > 1e-5 ? Bc / R : 0,
      ablMag: a.dsum / a.dn, noise: a.nsum / a.nn, nodes: [...(m.userData.__nodes || [])].slice(0, 3).join(','),
    });
  }
  rows.sort((x, y) => y.pct - x.pct);
  s += `\n=== ${shot} === (albedo = UNLIT linear; sat = chroma; B/R = hue; abl% = px changed by specular kill)\n`;
  s += 'material                        pct%   albedo linear R,G,B      L     cv     sat   B/R   specDelta noise  nodes\n';
  for (const r of rows.slice(0, 24)) {
    s += `${r.name.split('|')[0].slice(0, 14).padEnd(15)} ${r.pct.toFixed(2).padStart(5)}  ${r.alb.map((v) => v.toFixed(3).padStart(6)).join(',')}  ${r.L.toFixed(3)} ${r.cv.toFixed(3)} ${r.sat.toFixed(3)} ${r.hue.toFixed(3)}  ${r.ablMag.toFixed(2).padStart(6)} ${r.noise.toFixed(2).padStart(5)}  ${r.nodes}\n`;
  }
}
return s;
