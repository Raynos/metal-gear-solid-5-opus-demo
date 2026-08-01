// Clast value against the ground, using an ID MASK rather than a diff
// threshold. Render the clast families flat magenta to get the exact set of
// pixels they cover, then read the real frame and the clast-free frame at those
// pixels. This is immune to the threshold problem: a rock that differs from its
// background by one code value is still counted, which is the whole point.
const eng = g.engine;
const gl = eng.renderer.getContext();
eng.pipeline.enabled.autoExposure = false;
const rocks = g.world.registry.rocks;
// `talus` places bodies from shapes.boulders, so its meshes are named
// rock_boulders*; the family name is not in the mesh name. Small-clast families
// are chips + stones + everything the talus/apron pass put down.
const CLAST = ['chips', 'stones', 'boulders'];
const meshes = (rocks.meshes ?? []).filter((m) => CLAST.some((f) => m.name.includes('rock_' + f)));
const idMat = new THREE.MeshBasicMaterial({ color: 0xff00ff });
function grab() {
  g.settle(6);
  const s = eng.renderer.getSize(new THREE.Vector3());
  const w = s.x | 0; const h = s.y | 0;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { w, h, px };
}
const lum = (px, i) => (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
const prev = meshes.map((m) => m.material);
const out = {};
for (const shot of ['outpost', 'ground', 'gameplay', 'vista']) {
  g.applyShot(shot);
  const full = grab();
  meshes.forEach((m) => (m.visible = false));
  const off = grab();
  meshes.forEach((m, i) => { m.visible = true; m.material = idMat; });
  const id = grab();
  meshes.forEach((m, i) => (m.material = prev[i]));
  let n = 0; let sa = 0; let sb = 0; let ra = 0; let ba = 0; let rb = 0; let bb = 0;
  let cool = 0; let dark = 0;
  for (let i = 0; i < full.w * full.h; i++) {
    const o = i * 4;
    // Interior pixels only: an antialiased edge is half ground and would drag
    // every ratio toward 1.
    if (!(id.px[o] > 150 && id.px[o + 2] > 140 && id.px[o + 1] < 100)) continue;
    n++;
    const la = lum(full.px, o); const lb = lum(off.px, o);
    sa += la; sb += lb; if (la < lb) dark++;
    ra += full.px[o]; ba += full.px[o + 2]; rb += off.px[o]; bb += off.px[o + 2];
    if (full.px[o] * off.px[o + 2] < off.px[o] * full.px[o + 2]) cool++;
  }
  out[shot] = n ? {
    maskPx: n, pctFrame: +((n / (full.w * full.h)) * 100).toFixed(3),
    rock: +(sa / n).toFixed(4), sandBehind: +(sb / n).toFixed(4),
    ratio: +(sa / sb).toFixed(3), stops: +Math.log2(sa / sb).toFixed(2),
    rockRB: +(ra / ba).toFixed(3), sandRB: +(rb / bb).toFixed(3),
    warmerPct: +(100 - (cool / n) * 100).toFixed(0), darkerPct: +((dark / n) * 100).toFixed(0),
  } : { maskPx: 0 };
}
return out;
