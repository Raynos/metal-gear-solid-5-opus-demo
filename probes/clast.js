// Small-clast value against the ground they cover, at a threshold low enough to
// catch a pebble that barely differs from its background — which is the finding.
const eng = g.engine;
const gl = eng.renderer.getContext();
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
function compare(A, B, S, TH) {
  const n = A.w * A.h;
  let cnt = 0; let sa = 0; let sb = 0; let ra = 0; let ba = 0; let rb = 0; let bb = 0; let cool = 0; let dark = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (Math.max(Math.abs(A.px[o] - S.px[o]), Math.abs(A.px[o + 1] - S.px[o + 1]), Math.abs(A.px[o + 2] - S.px[o + 2])) > 2) continue;
    const d = Math.max(Math.abs(A.px[o] - B.px[o]), Math.abs(A.px[o + 1] - B.px[o + 1]), Math.abs(A.px[o + 2] - B.px[o + 2]));
    if (d < TH) continue;
    cnt++;
    const la = lum(A.px, o); const lb = lum(B.px, o);
    sa += la; sb += lb; if (la < lb) dark++;
    ra += A.px[o]; ba += A.px[o + 2]; rb += B.px[o]; bb += B.px[o + 2];
    if (A.px[o] * B.px[o + 2] < B.px[o] * A.px[o + 2]) cool++;
  }
  if (!cnt) return { px: 0 };
  return { px: cnt, pct: +((cnt / n) * 100).toFixed(3), obj: +(sa / cnt).toFixed(4), gnd: +(sb / cnt).toFixed(4),
    ratio: +(sa / sb).toFixed(3), stops: +Math.log2(sa / sb).toFixed(2),
    objRB: +(ra / ba).toFixed(3), gndRB: +(rb / bb).toFixed(3),
    warmerPct: +(100 - (cool / cnt) * 100).toFixed(0), darkerPct: +((dark / cnt) * 100).toFixed(0) };
}
const rocks = g.world.registry.rocks;
const CLAST = ['chips', 'stones', 'talus'];
const clastMeshes = (rocks.meshes ?? []).filter((m) => CLAST.some((f) => m.name.includes('rock_' + f)));
const casters = clastMeshes.filter((m) => m.castShadow);
const out = { clastMeshes: clastMeshes.length, casterMeshes: casters.length };
for (const shot of ['outpost', 'ground', 'gameplay']) {
  g.applyShot(shot);
  const full = grab();
  const stable = grab();
  clastMeshes.forEach((m) => (m.visible = false));
  const off = grab();
  clastMeshes.forEach((m) => (m.visible = true));
  casters.forEach((m) => (m.castShadow = false));
  const noSh = grab();
  casters.forEach((m) => (m.castShadow = true));
  out[shot] = {
    bodiesTH3: compare(full, off, stable, 3),
    bodiesTH8: compare(full, off, stable, 8),
    shadowsTH3: compare(full, noSh, stable, 3),
  };
}
return out;
