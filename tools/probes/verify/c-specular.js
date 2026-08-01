/**
 * (c) SPECULAR EXISTS — and if it does not, WHY not.
 *
 * The acceptance detector (luma > 180 AND > 2.0x its 17x17 neighbourhood mean
 * AND > 70 codes above it, strictly below the horizon) finds ~1 pixel in
 * ground.png. The interesting question is whether that is the scene or the
 * detector, so this reports the criteria separately AND ablates roughness:
 *
 *   base      shipped
 *   rough1    every material forced to roughness 1 (no specular lobe left)
 *   rough02   every material forced to roughness 0.2 (glints if the plumbing
 *             works at all)
 *
 * If `rough02` produces highlights and `base` does not, the IBL/specular path
 * is intact and the materials are simply authored flat — which is a tuning
 * finding for four different owners, not one bug.
 */
g.setFreeFly(false);
const engine = g.engine, scene = engine.scene, renderer = engine.renderer, pipeline = engine.pipeline;
const gl = renderer.getContext();
const W = pipeline.width, H = pipeline.height;
const px = new Uint8Array(W * H * 4);
const HORIZON = { ground: 515, outpost: 399 };

const mats = new Set();
scene.traverse((o) => {
  if (!o.isMesh && !o.isPoints) return;
  for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
    if (m && m.roughness !== undefined) mats.add(m);
  }
});
const saved = [...mats].map((m) => [m, m.roughness, m.metalness, m.envMapIntensity]);

function detect(hz) {
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
  const R = 8, tmp = new Float32Array(W * H), sum = new Float32Array(W * H);
  for (let y = 0; y < H; y++) { let s = 0;
    for (let x = -R; x <= R; x++) s += L[y * W + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x++) { tmp[y * W + x] = s; s -= L[y * W + Math.min(W - 1, Math.max(0, x - R))]; s += L[y * W + Math.min(W - 1, Math.max(0, x + R + 1))]; } }
  for (let x = 0; x < W; x++) { let s = 0;
    for (let y = -R; y <= R; y++) s += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) { sum[y * W + x] = s; s -= tmp[Math.min(H - 1, Math.max(0, y - R)) * W + x]; s += tmp[Math.min(H - 1, Math.max(0, y + R + 1)) * W + x]; } }
  const N = (2 * R + 1) * (2 * R + 1);
  // readPixels is bottom-up: rows 0..(H-hz) are below the horizon.
  let all = 0, bright = 0, ratio = 0, delta = 0, tot = 0, peak = 0;
  for (let y = 0; y < H - hz; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, l = L[i], m = sum[i] / N; tot++;
    if (l > peak) peak = l;
    if (l > 180) bright++;
    if (l > 2 * m) ratio++;
    if (l > m + 70) delta++;
    if (l > 180 && l > 2 * m && l > m + 70) all++;
  }
  return { belowHorizonPx: tot, brightestLuma: +peak.toFixed(0), lumaOver180: bright, over2xNbhd: ratio, overNbhdPlus70: delta, allThree: all };
}

const out = {};
for (const shot of Object.keys(HORIZON)) {
  g.applyShot(shot);
  out[shot] = {};
  g.settle(12); out[shot].base = detect(HORIZON[shot]);
  for (const [m] of saved) { m.roughness = 1.0; m.needsUpdate = true; }
  g.settle(12); out[shot].rough1 = detect(HORIZON[shot]);
  for (const [m] of saved) { m.roughness = 0.2; m.needsUpdate = true; }
  g.settle(12); out[shot].rough02 = detect(HORIZON[shot]);
  for (const [m, r, mt, e] of saved) { m.roughness = r; m.metalness = mt; m.envMapIntensity = e; m.needsUpdate = true; }
  g.settle(6);
}
out.materialsTouched = saved.length;
out.roughnessHistogram = (() => {
  const h = {};
  for (const [, r] of saved) { const k = (Math.round(r * 10) / 10).toFixed(1); h[k] = (h[k] ?? 0) + 1; }
  return h;
})();
return out;
