// Per-material screen coverage + rendered-pixel statistics, via a flat ID pass.
// Answers: which material owns what fraction of the frame, what colour it
// ACTUALLY lands at on screen (shader-injected albedo included), and how much
// it varies WITHIN its own footprint (macro vs micro).
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

// --- collect materials -----------------------------------------------------
const mats = [];
const matId = new Map();
function reg(m) {
  if (!m || matId.has(m)) return matId.get(m);
  const id = mats.length + 1; // 0 = background
  matId.set(m, id);
  mats.push(m);
  return id;
}
const meshes = [];
scene.traverse((o) => {
  if (!o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh && !o.isPoints && !o.isLine) return;
  if (o.isPoints || o.isLine) return;
  meshes.push(o);
  const ms = Array.isArray(o.material) ? o.material : [o.material];
  ms.forEach(reg);
});

// ID materials: flat colour, but preserve alpha cutout / sidedness so foliage
// and chain-link do not become solid cards.
const idMat = new Map();
for (const m of mats) {
  const id = matId.get(m);
  const b = new THREE.MeshBasicMaterial({
    color: new THREE.Color().setRGB(((id >> 0) & 255) / 255, ((id >> 8) & 255) / 255, 0, THREE.LinearSRGBColorSpace),
    side: m.side,
    map: m.alphaTest > 0 ? m.map ?? m.alphaMap ?? null : null,
    alphaTest: m.alphaTest ?? 0,
    transparent: false,
    depthWrite: m.depthWrite !== false,
    fog: false,
    toneMapped: false,
  });
  // Copy vertex-shader-affecting flags so instanced/skinned/wind geometry lands
  // in the same place as the beauty pass.
  b.onBeforeCompile = (sh) => {
    // reproduce nothing; instancing + skinning are handled by three itself
  };
  idMat.set(m, b);
}

const rt = new THREE.WebGLRenderTarget(W, H, {
  type: THREE.UnsignedByteType, colorSpace: THREE.NoColorSpace, depthBuffer: true,
  minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
});

function grabBeauty() {
  g.settle(8);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}
function grabIds() {
  const saved = meshes.map((o) => o.material);
  meshes.forEach((o) => {
    o.material = Array.isArray(o.material) ? o.material.map((m) => idMat.get(m)) : idMat.get(o.material);
  });
  const prevFog = scene.fog; scene.fog = null;
  const prevBg = scene.background; scene.background = null;
  const prevEnv = scene.environment;
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, true, true);
  renderer.render(scene, eng.camera);
  const px = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
  renderer.setRenderTarget(null);
  scene.fog = prevFog; scene.background = prevBg; scene.environment = prevEnv;
  meshes.forEach((o, i) => (o.material = saved[i]));
  return px;
}

const srgb2lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

const out = {};
for (const shot of ['ground', 'gameplay', 'outpost', 'vista']) {
  g.applyShot(shot);
  const B = grabBeauty();
  const I = grabIds();
  // per material accumulators
  const acc = new Map();
  const N = W * H;
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    const id = I[o] | (I[o + 1] << 8);
    if (!id || id > mats.length) continue;
    let a = acc.get(id);
    if (!a) { a = { n: 0, r: 0, g: 0, b: 0, l: 0, l2: 0, hp: 0, hpn: 0, min: 1, max: 0 }; acc.set(id, a); }
    const r = B[o] / 255, gg = B[o + 1] / 255, bb = B[o + 2] / 255;
    const l = 0.2126 * r + 0.7152 * gg + 0.0722 * bb;
    a.n++; a.r += r; a.g += gg; a.b += bb; a.l += l; a.l2 += l * l;
    if (l < a.min) a.min = l; if (l > a.max) a.max = l;
    // high-pass: |this - neighbour 8px away| samples MACRO texture at ~8px scale
    const x = i % W, y = (i / W) | 0;
    if (x + 8 < W) {
      const o2 = (y * W + x + 8) * 4;
      const id2 = I[o2] | (I[o2 + 1] << 8);
      if (id2 === id) {
        const l2 = 0.2126 * B[o2] / 255 + 0.7152 * B[o2 + 1] / 255 + 0.0722 * B[o2 + 2] / 255;
        a.hp += Math.abs(l - l2); a.hpn++;
      }
    }
  }
  const rows = [];
  for (const [id, a] of acc) {
    if (a.n < N * 0.0006) continue;
    const m = mats[id - 1];
    const mean = a.l / a.n;
    const sd = Math.sqrt(Math.max(0, a.l2 / a.n - mean * mean));
    rows.push({
      name: m.name || '(unnamed)',
      pct: +((100 * a.n) / N).toFixed(2),
      // screen colour, 0-255 sRGB
      rgb: [Math.round((a.r / a.n) * 255), Math.round((a.g / a.n) * 255), Math.round((a.b / a.n) * 255)],
      L: +mean.toFixed(3),
      // contrast within the surface, relative to its own brightness
      cv: +(sd / Math.max(1e-4, mean)).toFixed(3),
      // macro texture at ~8px: mean abs luminance step, relative
      macro: a.hpn ? +((a.hp / a.hpn) / Math.max(1e-4, mean)).toFixed(4) : null,
      rng: +((a.max - a.min)).toFixed(3),
      rough: m.roughness, metal: m.metalness,
    });
  }
  rows.sort((x, y) => y.pct - x.pct);
  out[shot] = rows.slice(0, 22);
}
// compact text table
let s = '';
for (const [shot, rows] of Object.entries(out)) {
  s += `\n=== ${shot} ===\n`;
  s += 'name              pct%   sRGB          L     R-B   cv    macro  rng  rgh  met\n';
  let tot = 0;
  for (const r of rows) {
    tot += r.pct;
    s += `${r.name.padEnd(17)} ${String(r.pct).padStart(5)}  ${String(r.rgb[0]).padStart(3)},${String(r.rgb[1]).padStart(3)},${String(r.rgb[2]).padStart(3)}  ${r.L.toFixed(3)} ${String(r.rgb[0] - r.rgb[2]).padStart(4)}  ${String(r.cv).padStart(5)} ${String(r.macro).padStart(6)} ${String(r.rng).padStart(5)} ${String(r.rough).padStart(4)} ${String(r.metal).padStart(4)}\n`;
  }
  s += `(top rows cover ${tot.toFixed(1)}% of frame)\n`;
}
return s;
