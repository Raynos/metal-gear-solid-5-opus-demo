// Ablation probe: measure rock pixels and vegetation pixels against the exact
// ground pixels they cover, in the same frame, with the pipeline frozen.
const g0 = g;
const eng = g.engine;
const gl = eng.renderer.getContext();

function grab() {
  g.settle(6);
  const s = eng.renderer.getSize(new THREE.Vector3());
  const w = s.x | 0;
  const h = s.y | 0;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { w, h, px };
}

const rocks = g.world.registry.rocks;
const veg = g.world.registry.vegetation;

function rockMeshes() {
  const out = [];
  if (rocks?.group) out.push(rocks.group);
  return out;
}
function vegMeshes() {
  const out = [];
  const scene = g.scene ?? eng.scene;
  scene.traverse((o) => {
    if (o.isMesh && /^(grass-|scrub-|bush-|brush-|tree-|tumbleweed)/.test(o.name || '')) out.push(o);
  });
  return out;
}

function lum(px, i) {
  return (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
}

function compare(A, B, label) {
  const n = A.w * A.h;
  let cnt = 0;
  let sa = 0;
  let sb = 0;
  let ra = 0; let ba = 0; let rb = 0; let bb = 0;
  let cooler = 0;
  const rows = { top: 0, mid: 0, bot: 0 };
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.abs(A.px[o] - B.px[o]) + Math.abs(A.px[o + 1] - B.px[o + 1]) + Math.abs(A.px[o + 2] - B.px[o + 2]);
    if (d < 9) continue;
    cnt++;
    sa += lum(A.px, o);
    sb += lum(B.px, o);
    ra += A.px[o]; ba += A.px[o + 2];
    rb += B.px[o]; bb += B.px[o + 2];
    if (A.px[o] / Math.max(1, A.px[o + 2]) < B.px[o] / Math.max(1, B.px[o + 2])) cooler++;
    const y = Math.floor(i / A.w);
    if (y > (A.h * 2) / 3) rows.top++;
    else if (y > A.h / 3) rows.mid++;
    else rows.bot++;
  }
  return {
    label,
    pixels: cnt,
    pctFrame: +((cnt / n) * 100).toFixed(2),
    meanObj: +(sa / cnt).toFixed(4),
    meanGround: +(sb / cnt).toFixed(4),
    ratio: +(sa / sb).toFixed(3),
    stops: +(Math.log2(sa / sb)).toFixed(2),
    objRB: +(ra / ba).toFixed(3),
    groundRB: +(rb / bb).toFixed(3),
    pctCooler: +((cooler / cnt) * 100).toFixed(1),
    bandsBotMidTop: [rows.bot, rows.mid, rows.top],
  };
}

const out = {};
for (const shot of ['outpost', 'vista', 'ground']) {
  g.applyShot(shot);
  const full = grab();
  const rg = rockMeshes();
  rg.forEach((o) => (o.visible = false));
  const noRock = grab();
  rg.forEach((o) => (o.visible = true));
  const vm = vegMeshes();
  vm.forEach((o) => (o.visible = false));
  const noVeg = grab();
  vm.forEach((o) => (o.visible = true));
  out[shot] = {
    rocks: compare(full, noRock, 'rocks'),
    veg: compare(full, noVeg, 'veg'),
  };
}
out.counts = {
  rockMeshes: rocks?.meshes?.length, rockSpent: rocks?.spent, rockRejected: rocks?.rejected,
  vegStats: veg?.stats,
};
return out;
