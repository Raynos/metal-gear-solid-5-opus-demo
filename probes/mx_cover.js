// PLANFORM ground cover. A grazing gameplay camera exaggerates cover (every
// tuft occludes metres of ground behind it), so this looks straight DOWN from
// 26 m at four sites and classifies every pixel by the material that owns it.
const g = window.__GAME;
const THREE = g.THREE;
const eng = g.engine;
const renderer = eng.renderer;
const scene = eng.scene;
eng.pipeline.enabled.autoExposure = false;
g.setFreeFly(false);

const W = eng.pipeline.width | 0, H = eng.pipeline.height | 0;
const mats = [];
const matId = new Map();
const nodes = new Map();
const meshes = [];
scene.traverse((o) => {
  if (!(o.isMesh || o.isInstancedMesh || o.isSkinnedMesh)) return;
  meshes.push(o);
  for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
    if (!m) continue;
    if (!matId.has(m)) { matId.set(m, mats.length + 1); mats.push(m); nodes.set(m, new Set()); }
    const s = nodes.get(m);
    if (s.size < 6) s.add((o.name || '?').replace(/[-_.]?\d{3,}.*$/, ''));
  }
});
const idMat = new Map();
for (const m of mats) {
  const id = matId.get(m);
  idMat.set(m, new THREE.MeshBasicMaterial({
    color: new THREE.Color().setRGB((id & 255) / 255, ((id >> 8) & 255) / 255, 0, THREE.LinearSRGBColorSpace),
    side: THREE.DoubleSide, map: m.alphaTest > 0 ? (m.map ?? m.alphaMap ?? null) : null,
    alphaTest: m.alphaTest ?? 0, fog: false, toneMapped: false,
  }));
}
const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });

function classify(m) {
  const nm = (m.name || '') + ' ' + [...nodes.get(m)].join(' ');
  if (/grass|scrub|bush|tree|veg|thorn|tuft/i.test(nm)) return 'vegetation';
  if (/rock|clast|chip|stone|boulder|talus|scree|outcrop/i.test(nm)) return 'rock/stone';
  if (/terrain/i.test(nm)) return 'bare terrain';
  if (/op-ground|op-drift|outpost-pad/i.test(nm)) return 'bare graded ground';
  if (/sky|cloud|volumetric/i.test(nm)) return 'sky/atmos';
  return 'man-made/other';
}


let s = 'Ground cover by SCREEN AREA from the canonical cameras (LOD rings fully populated).\n'
      + 'whole frame / bottom third (the near ground band, where cover is legible)\n';
for (const shot of ['ground', 'gameplay', 'vista', 'outpost']) {
  g.applyShot(shot);
  g.settle(10);
  const savedM = meshes.map((o) => o.material);
  meshes.forEach((o) => { o.material = Array.isArray(o.material) ? o.material.map((m) => idMat.get(m)) : idMat.get(o.material); });
  const fog = scene.fog, bg = scene.background; scene.fog = null; scene.background = null;
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, true, true);
  renderer.render(scene, eng.camera);
  const px = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
  renderer.setRenderTarget(null);
  scene.fog = fog; scene.background = bg;
  meshes.forEach((o, i) => (o.material = savedM[i]));

  const all = new Map(), low = new Map(), per = new Map();
  let nAll = 0, nLow = 0;
  for (let y = 0; y < H; y++) {
    // readRenderTargetPixels is bottom-up: y=0 is the BOTTOM of the image.
    const isLow = y < H / 3;
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const id = px[o] | (px[o + 1] << 8);
      const c = (!id || id > mats.length) ? 'sky/nothing' : classify(mats[id - 1]);
      nAll++; all.set(c, (all.get(c) || 0) + 1);
      if (isLow) { nLow++; low.set(c, (low.get(c) || 0) + 1); }
      if (id && id <= mats.length && (c === 'vegetation' || c === 'rock/stone')) {
        const m = mats[id - 1];
        const k = c + ' :: ' + ((m.name || '') + ' ' + [...nodes.get(m)].slice(0, 2).join(' ')).trim();
        per.set(k, (per.get(k) || 0) + 1);
      }
    }
  }
  s += `\n--- ${shot}\n`;
  const keys = new Set([...all.keys(), ...low.keys()]);
  for (const k of [...keys].sort((a, b) => (all.get(b) || 0) - (all.get(a) || 0))) {
    s += `    ${k.padEnd(22)} ${((100 * (all.get(k) || 0)) / nAll).toFixed(2).padStart(6)}%   ${((100 * (low.get(k) || 0)) / nLow).toFixed(2).padStart(6)}%\n`;
  }
  for (const [k, v] of [...per].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    s += `      ${k.slice(0, 54).padEnd(55)} ${((100 * v) / nAll).toFixed(3).padStart(6)}%\n`;
  }
}
return s;
