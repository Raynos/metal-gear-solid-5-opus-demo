// WHO draws the dead dome? Before spending another hour tuning a terrain
// shader that turned out to be bit-identical after the edit, find out which
// mesh actually rasterises the pixels in the region.
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer, scene = engine.scene;
const gl = renderer.getContext();
const W = engine.pipeline.width, H = engine.pipeline.height;

function grab() {
  g.settle(4);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}
function changedPct(A, B, b, TH = 3) {
  let n = 0, c = 0;
  for (let y = b[1]; y < b[3]; y++) {
    const row = H - 1 - y;
    for (let x = b[0]; x < b[2]; x++) {
      const i = (row * W + x) * 4;
      if (Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2])) >= TH) c++;
      n++;
    }
  }
  return +((100 * c) / n).toFixed(2);
}

const groups = {};
scene.traverse((o) => {
  if (!o.isMesh) return;
  const n = o.name || o.type;
  const k = /^terrain-L/.test(n) ? 'terrain' : /talus-apron/.test(n) ? 'apron'
    : /^rock/.test(n) ? 'rocks' : /^(grass|scrub|bush|brush|tree)/.test(n) ? 'veg' : 'other';
  (groups[k] ??= []).push(o);
});

const REGIONS = {
  ridge: { dome: [500, 800, 1200, 1050] },
  ground: { near: [300, 780, 1100, 900] },
  vista: { mid: [200, 850, 1700, 1030] },
  outpost: { mid: [1200, 830, 1900, 1000] },
};
const out = { counts: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])) };
for (const [shot, boxes] of Object.entries(REGIONS)) {
  g.applyShot(shot);
  const A = grab();
  out[shot] = {};
  for (const [gk, ms] of Object.entries(groups)) {
    const prev = ms.map((o) => o.visible);
    ms.forEach((o) => (o.visible = false));
    const B = grab();
    ms.forEach((o, i) => (o.visible = prev[i]));
    for (const [bk, b] of Object.entries(boxes)) {
      (out[shot][bk] ??= {})[gk] = changedPct(A, B, b);
    }
  }
}
return out;
