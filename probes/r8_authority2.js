// ROUND 8 — THE AUTHORITY MEASUREMENT.
//
// Round 8's brief said the scene is low-dynamic-range and that "flat albedo
// across the whole landscape is a large part of it". Widening the terrain's
// albedo swing from 0.82 stops to 1.38 and its saturation from R/B 1.28 to 1.70
// moved the vista's mid-pan spatial sd from 12.4% to 12.2%. Ablating the ENTIRE
// tonal modulation (uDbg2.y = 0) moved it by 3%. Something downstream of albedo
// is deciding those pixels.
//
// This measures it directly. uDbg2.w = 6 forces the terrain's albedo to BLACK,
// = 7 forces it to WHITE. Everything below the black reading is atmospheric
// inscatter plus whatever is drawn in front of the terrain — light that arrives
// at the pixel without ever touching the ground — and no albedo, roughness or
// palette change can move it. (black, white) is therefore the full range this
// module is permitted, and (shipped - black) / (white - black) is how much of it
// is currently being used.
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer;
const gl = renderer.getContext();
const W = engine.pipeline.width, H = engine.pipeline.height;
const terrainU = g.world?.terrain?.uniforms ?? engine.world?.terrain?.uniforms ?? null;
if (!terrainU) return { error: 'no terrain uniforms' };

function grab() {
  g.settle(4);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}
function mean(px, y0f, y1f) {
  let s = 0, n = 0;
  for (let y = Math.round(y0f * H); y < Math.round(y1f * H); y += 2) {
    const row = H - 1 - y;
    for (let x = 0; x < W; x += 3) {
      const i = (row * W + x) * 4;
      s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      n++;
    }
  }
  return s / n;
}
// Bands as fractions of frame height, top-down.
const BANDS = { far: [0.22, 0.36], mid: [0.36, 0.55], near: [0.55, 0.78] };

const out = {};
for (const shot of ['vista', 'ridge', 'outpost', 'ground', 'gameplay']) {
  g.applyShot(shot);
  const reads = {};
  for (const [k, w] of [['shipped', 0], ['black', 6], ['white', 7]]) {
    terrainU.uDbg2.value.w = w;
    const px = grab();
    reads[k] = Object.fromEntries(Object.entries(BANDS).map(([b, r]) => [b, mean(px, r[0], r[1])]));
  }
  terrainU.uDbg2.value.w = 0;
  out[shot] = Object.fromEntries(Object.keys(BANDS).map((b) => {
    const s = reads.shipped[b], k = reads.black[b], wt = reads.white[b];
    return [b, {
      shipped: +s.toFixed(1),
      floor: +k.toFixed(1),          // luma with terrain albedo = 0
      ceiling: +wt.toFixed(1),       // luma with terrain albedo = 1
      // How many display codes the whole albedo axis is worth in this band.
      swingCodes: +(wt - k).toFixed(1),
      // Fraction of the shipped pixel that is NOT terrain albedo.
      inscatterPct: +(100 * k / Math.max(s, 1e-3)).toFixed(1),
    }];
  }));
}
return out;
