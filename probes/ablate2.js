// Per-layer ablation. Hide one named layer at a time and diff against the full
// frame, so each tier is measured against the exact pixels it covers.
const eng = g.engine;
const gl = eng.renderer.getContext();
const scene = eng.scene;

function grab() {
  g.settle(6);
  const s = eng.renderer.getSize(new THREE.Vector3());
  const w = s.x | 0;
  const h = s.y | 0;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { w, h, px };
}
const lum = (px, i) => (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;

function compare(A, B) {
  const n = A.w * A.h;
  let cnt = 0; let sa = 0; let sb = 0; let ra = 0; let ba = 0; let rb = 0; let bb = 0; let cooler = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.abs(A.px[o] - B.px[o]) + Math.abs(A.px[o + 1] - B.px[o + 1]) + Math.abs(A.px[o + 2] - B.px[o + 2]);
    if (d < 9) continue;
    cnt++;
    sa += lum(A.px, o); sb += lum(B.px, o);
    ra += A.px[o]; ba += A.px[o + 2]; rb += B.px[o]; bb += B.px[o + 2];
    if (A.px[o] * B.px[o + 2] < B.px[o] * A.px[o + 2]) cooler++;
  }
  if (!cnt) return { pixels: 0 };
  return {
    px: cnt, pct: +((cnt / n) * 100).toFixed(2),
    obj: +(sa / cnt).toFixed(4), gnd: +(sb / cnt).toFixed(4),
    ratio: +(sa / sb).toFixed(3), stops: +Math.log2(sa / sb).toFixed(2),
    objRB: +(ra / ba).toFixed(3), gndRB: +(rb / bb).toFixed(3),
    cooler: +((cooler / cnt) * 100).toFixed(0),
  };
}

// --- layer groups ---------------------------------------------------------
const rocks = g.world.registry.rocks;
const layers = {};
// rocks by family
const FAM = ['chips', 'stones', 'boulders', 'talus', 'formations', 'outcrops'];
for (const f of FAM) layers['rock:' + f] = [];
layers['rock:collar'] = [];
for (const m of rocks?.meshes ?? []) {
  const fam = FAM.find((f) => m.name.includes('rock_' + f));
  if (fam) layers['rock:' + fam].push(m);
}
for (const m of rocks?.collars ?? []) layers['rock:collar'].push(m);
// vegetation by tier
const VEG = {
  'veg:grass-near': /^grass-0\.5/, 'veg:grass-mid': /^grass-0\.8/,
  'veg:grass-far': /^grass-1\.45/, 'veg:grass-cov': /^grass-3\.1/,
  'veg:cover': /^grass-cover/,
  'veg:scrub': /^scrub-/, 'veg:bushNear': /^bush-n/, 'veg:bushMid': /^bush-m/,
  'veg:bushFar': /^bush-f/, 'veg:brush': /^brush-/, 'veg:tree': /^tree-/,
};
for (const k of Object.keys(VEG)) layers[k] = [];
scene.traverse((o) => {
  if (!o.isMesh) return;
  for (const [k, re] of Object.entries(VEG)) if (re.test(o.name || '')) layers[k].push(o);
});

const out = {};
for (const shot of ['outpost', 'vista', 'ground', 'gameplay']) {
  g.applyShot(shot);
  const full = grab();
  const r = {};
  for (const [k, ms] of Object.entries(layers)) {
    if (!ms.length) continue;
    ms.forEach((o) => (o.visible = false));
    const off = grab();
    ms.forEach((o) => (o.visible = true));
    const c = compare(full, off);
    if (c.px) r[k] = c;
  }
  out[shot] = r;
}
return out;
