// Why do 94 materials with genuinely different authored albedos all land on the
// same rust-brown on screen? Ablate the two shared films -- the desert dust
// (uDustAmt) and the corrosion/wear term (uWear) -- and re-measure the UNLIT
// albedo each material resolves to. If chroma spread across materials jumps
// when they are off, the films are eating the palette.
const g = window.__GAME;
const THREE = g.THREE;
const eng = g.engine;
const renderer = eng.renderer;
const scene = eng.scene;
eng.pipeline.enabled.autoExposure = false;
g.setFreeFly(false);
const W = eng.pipeline.width | 0;
const H = eng.pipeline.height | 0;

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
    if (s.size < 4) s.add((o.name || '?').replace(/[-_]?\d{3,}.*$/, ''));
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
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, true, true);
  renderer.render(scene, eng.camera);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, arr);
  renderer.setRenderTarget(null);
}
function grabIds() {
  const saved = meshes.map((o) => o.material);
  meshes.forEach((o) => { o.material = Array.isArray(o.material) ? o.material.map((m) => idMat.get(m)) : idMat.get(o.material); });
  const fog = scene.fog, bg = scene.background; scene.fog = null; scene.background = null;
  const px = new Uint8Array(W * H * 4);
  renderTo(rtId, px);
  scene.fog = fog; scene.background = bg;
  meshes.forEach((o, i) => (o.material = saved[i]));
  return px;
}
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

// uniform handles on the outpost surfaces
const U = mats.filter((m) => m.userData?.u?.uDustAmt || m.userData?.u?.uWear);
const savedU = U.map((m) => ({ m, d: m.userData.u.uDustAmt?.value, w: m.userData.u.uWear?.value }));
// uBounce is a warm ground-bounce ADD proportional to albedo; it is not a light,
// so killing the lights does not kill it. Zero it in every albedo pass or every
// measurement comes back warmer than the material is.
const BOUNCE = mats.filter((m) => m.userData?.u?.uBounce).map((m) => ({ m, v: m.userData.u.uBounce.value.clone() }));
function setBounce(on) { for (const b of BOUNCE) b.m.userData.u.uBounce.value.copy(on ? b.v : new THREE.Vector3(0, 0, 0)); }
function setFilms(dust, wear) {
  for (const s of savedU) {
    if (s.m.userData.u.uDustAmt) s.m.userData.u.uDustAmt.value = dust === null ? s.d : dust;
    if (s.m.userData.u.uWear) s.m.userData.u.uWear.value = wear === null ? s.w : wear;
  }
}

function measure(I, A) {
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
  const out = new Map();
  for (const [id, a] of acc) out.set(id, { n: a.n, R: a.r / a.n / 255, G: a.g / a.n / 255, B: a.b / a.n / 255 });
  return out;
}
// area-weighted spread of hue across materials (excluding sky), in log-chroma
function spread(map, N) {
  let wsum = 0, hr = [], hb = [];
  for (const [id, v] of map) {
    if (v.n < N * 0.001) continue;
    if (v.R > 0.6 && v.B >= v.R) continue; // sky
    const w = v.n;
    wsum += w; hr.push([w, Math.log(Math.max(1e-3, v.G) / Math.max(1e-3, v.R))]); hb.push([w, Math.log(Math.max(1e-3, v.B) / Math.max(1e-3, v.R))]);
  }
  const wm = (arr) => arr.reduce((s, [w, v]) => s + w * v, 0) / wsum;
  const wsd = (arr, m) => Math.sqrt(arr.reduce((s, [w, v]) => s + w * (v - m) ** 2, 0) / wsum);
  const mg = wm(hr), mb = wm(hb);
  return { gr: mg.toFixed(3), br: mb.toFixed(3), sdGR: wsd(hr, mg).toFixed(3), sdBR: wsd(hb, mb).toFixed(3) };
}

let s = `films-controlled materials: ${U.length}/${mats.length}\n`;
const CASES = [['as-authored', null, null], ['dust=0', 0, null], ['wear=0', null, 0], ['dust=0 wear=0', 0, 0]];
for (const shot of ['ground', 'outpost']) {
  g.applyShot(shot);
  const I = grabIds();
  const N = W * H;
  const res = {};
  setBounce(false);
  for (const [label, d, w] of CASES) {
    setFilms(d, w);
    res[label] = measure(I, grabAlbedo());
  }
  setFilms(null, null);
  setBounce(true);
  s += `\n=== ${shot} ===  area-weighted hue spread across materials (log ratios, higher sd = more varied palette)\n`;
  for (const [label] of CASES) {
    const sp = spread(res[label], N);
    s += `  ${label.padEnd(15)} mean log(G/R)=${sp.gr} log(B/R)=${sp.br}   sd(G/R)=${sp.sdGR} sd(B/R)=${sp.sdBR}\n`;
  }
  s += `\n  per material, albedo R,G,B: as-authored -> dust=0,wear=0\n`;
  const rows = [...res['as-authored']].filter(([, v]) => v.n > N * 0.0012).sort((a, b) => b[1].n - a[1].n).slice(0, 18);
  for (const [id, v] of rows) {
    const m = mats[id - 1];
    const c = res['dust=0 wear=0'].get(id);
    s += `  ${(m.name || '(unnamed)').padEnd(14)} ${((100 * v.n) / N).toFixed(2).padStart(5)}%  ${[v.R, v.G, v.B].map((x) => x.toFixed(3)).join(',')}  ->  ${[c.R, c.G, c.B].map((x) => x.toFixed(3)).join(',')}   nodes=${[...nodes.get(m)].join(' ')}\n`;
  }
}
return s;
