// Screen coverage of the ground surfaces, per shot, on a 16x9 tile grid.
// Ablation-based: a pixel "belongs" to a mesh if hiding that mesh changes it.
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer, scene = engine.scene;
const gl = renderer.getContext();
const W = engine.pipeline.width, H = engine.pipeline.height;
function grab() {
  g.settle(5);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}
const sets = { terrain: [], pad: [], cover: [] };
scene.traverse((o) => {
  if (!o.isMesh) return;
  const n = o.name || '';
  if (/^terrain-L/.test(n)) sets.terrain.push(o);
  else if (n === 'outpost-pad') sets.pad.push(o);
  else if (n === 'grass-cover') sets.cover.push(o);
});
const TX = 16, TY = 9;
function tiles(A, B, TH = 3) {
  const out = [];
  for (let ty = 0; ty < TY; ty++) {
    const r = [];
    for (let tx = 0; tx < TX; tx++) {
      let n = 0, c = 0;
      for (let y = (ty * H) / TY; y < ((ty + 1) * H) / TY; y += 2) {
        const row = H - 1 - (y | 0);
        for (let x = (tx * W) / TX; x < ((tx + 1) * W) / TX; x += 2) {
          const i = (row * W + (x | 0)) * 4;
          if (Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2])) >= TH) c++;
          n++;
        }
      }
      r.push(Math.round((100 * c) / n));
    }
    out.push(r.join(' ').padStart(0));
  }
  return out;
}
const out = {};
for (const shot of ['ridge', 'vista', 'outpost', 'ground', 'gameplay']) {
  g.applyShot(shot);
  const A = grab();
  out[shot] = {};
  for (const [k, ms] of Object.entries(sets)) {
    if (!ms.length) continue;
    ms.forEach((o) => (o.visible = false));
    const Bp = grab();
    ms.forEach((o) => (o.visible = true));
    let n = 0, c = 0;
    for (let i = 0; i < W * H; i++) {
      const o4 = i * 4;
      if (Math.max(Math.abs(A[o4] - Bp[o4]), Math.abs(A[o4 + 1] - Bp[o4 + 1]), Math.abs(A[o4 + 2] - Bp[o4 + 2])) >= 3) c++;
      n++;
    }
    out[shot][k] = { framePct: +((100 * c) / n).toFixed(1), tiles: tiles(A, Bp) };
  }
}
return out;
