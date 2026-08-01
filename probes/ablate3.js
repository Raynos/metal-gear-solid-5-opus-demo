// Per-layer ablation, auto-exposure LOCKED and a threshold above the measured
// repeat-noise floor (max-channel diff >= 8 is 0.02% false positives).
const eng = g.engine;
const gl = eng.renderer.getContext();
const scene = eng.scene;
eng.pipeline.enabled.autoExposure = false;

function grab() {
  g.settle(6);
  const s = eng.renderer.getSize(new THREE.Vector3());
  const w = s.x | 0; const h = s.y | 0;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { w, h, px };
}
const lum = (px, i) => (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;

function compare(A, B, S, TH = 8) {
  const n = A.w * A.h;
  let cnt = 0; let sa = 0; let sb = 0; let ra = 0; let ba = 0; let rb = 0; let bb = 0; let cooler = 0;
  let darker = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    // Characters and props carry state across settle() calls, so some pixels
    // move between two IDENTICAL renders. `S` is a second baseline: any pixel
    // that is not bit-stable between A and S cannot be attributed to the layer
    // being ablated, so it is excluded rather than counted as signal.
    if (S && Math.max(Math.abs(A.px[o] - S.px[o]), Math.abs(A.px[o + 1] - S.px[o + 1]), Math.abs(A.px[o + 2] - S.px[o + 2])) > 2) continue;
    const d = Math.max(Math.abs(A.px[o] - B.px[o]), Math.abs(A.px[o + 1] - B.px[o + 1]), Math.abs(A.px[o + 2] - B.px[o + 2]));
    if (d < TH) continue;
    cnt++;
    const la = lum(A.px, o); const lb = lum(B.px, o);
    sa += la; sb += lb;
    if (la < lb) darker++;
    ra += A.px[o]; ba += A.px[o + 2]; rb += B.px[o]; bb += B.px[o + 2];
    if (A.px[o] * B.px[o + 2] < B.px[o] * A.px[o + 2]) cooler++;
  }
  if (!cnt) return { px: 0 };
  return {
    px: cnt, pct: +((cnt / n) * 100).toFixed(3),
    obj: +(sa / cnt).toFixed(4), gnd: +(sb / cnt).toFixed(4),
    ratio: +(sa / sb).toFixed(3), stops: +Math.log2(sa / sb).toFixed(2),
    objRB: +(ra / ba).toFixed(3), gndRB: +(rb / bb).toFixed(3),
    cooler: +((cooler / cnt) * 100).toFixed(0), darker: +((darker / cnt) * 100).toFixed(0),
  };
}

const rocks = g.world.registry.rocks;
const layers = {};
const FAM = ['chips', 'stones', 'boulders', 'talus', 'formations', 'outcrops'];
for (const f of FAM) layers['rock:' + f] = [];
layers['rock:collar'] = [];
layers['rock:ALL'] = rocks?.group ? [rocks.group] : [];
for (const m of rocks?.meshes ?? []) {
  const fam = FAM.find((f) => m.name.includes('rock_' + f));
  if (fam) layers['rock:' + fam].push(m);
}
for (const m of rocks?.collars ?? []) layers['rock:collar'].push(m);
const VEG = {
  'veg:grassNear': /^grass-0\.5/, 'veg:grassMid': /^grass-0\.8/,
  'veg:grassFar': /^grass-1\.45/, 'veg:grassCov': /^grass-3\.1/,
  'veg:coverMat': /^grass-cover/,
  'veg:scrub': /^scrub-/, 'veg:bushNear': /^bush-n/, 'veg:bushMid': /^bush-m/,
  'veg:bushFar': /^bush-f/, 'veg:brush': /^brush-/, 'veg:tree': /^tree-/,
};
for (const k of Object.keys(VEG)) layers[k] = [];
layers['veg:ALL'] = [];
scene.traverse((o) => {
  if (!o.isMesh) return;
  for (const [k, re] of Object.entries(VEG)) if (re.test(o.name || '')) { layers[k].push(o); layers['veg:ALL'].push(o); }
});

const out = {};
for (const shot of ['outpost', 'vista', 'ground', 'gameplay']) {
  g.applyShot(shot);
  const full = grab();
  const stable = grab();
  const r = {};
  for (const [k, ms] of Object.entries(layers)) {
    if (!ms.length) continue;
    const prev = ms.map((o) => o.visible);
    ms.forEach((o) => (o.visible = false));
    const off = grab();
    ms.forEach((o, i) => (o.visible = prev[i]));
    const c = compare(full, off, stable);
    if (c.px) r[k] = c;
  }
  out[shot] = r;
}
return out;
