// ROUND 8. What is the actual DISTRIBUTION of the regional tone fields?
//
// The round-8 widening claimed a 1.38-stop albedo swing on the assumption that
// `region` and `sub` span 0..1. They are the alpha channel of the detail tile,
// which is a 3-octave fbm — and a raw fbm sits in a narrow band around its mean.
// The tile builder knows this and contrast-stretches its own channels by 1.9x
// before storing them; the shader then reads that stretched channel at a 240 m
// and an 82 m tile, and whatever the true spread is, it is NOT 0..1.
//
// Measure it. uDbg2.w = 6 forces terrain albedo to black, 7 to white, and 3/4
// force it to `region`/`sub`. With (floor, ceiling) known, any mask render's
// mean and sd map straight back onto the mask's own mean and sd:
//     maskMean = (renderMean - floor) / (ceiling - floor)
//     maskSd   =  renderSd / (ceiling - floor)
// The stretch factor the shader needs is then 0.5 / (2 * maskSd), i.e. whatever
// takes 2 standard deviations out to the ends of the range.
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer;
const gl = renderer.getContext();
const W = engine.pipeline.width, H = engine.pipeline.height;
const terrainU = g.world?.terrain?.uniforms ?? null;
if (!terrainU) return { error: 'no terrain uniforms' };

function grab() {
  g.settle(4);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}
// The vista's mid band is the one place a canonical shot is mostly terrain.
const Y0 = 0.36, Y1 = 0.55;
function stat(px) {
  const v = [];
  for (let y = Math.round(Y0 * H); y < Math.round(Y1 * H); y += 2) {
    const row = H - 1 - y;
    for (let x = 0; x < W; x += 3) {
      const i = (row * W + x) * 4;
      v.push(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
    }
  }
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return { mean: m, sd: Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length) };
}

g.applyShot('vista');
const r = {};
for (const [k, w] of [['black', 6], ['white', 7], ['region', 3], ['sub', 4], ['rockW', 1]]) {
  terrainU.uDbg2.value.w = w;
  r[k] = stat(grab());
}
terrainU.uDbg2.value.w = 0;

const span = r.white.mean - r.black.mean;
const out = { swingCodes: +span.toFixed(1) };
for (const k of ['region', 'sub', 'rockW']) {
  const mean = (r[k].mean - r.black.mean) / span;
  const sd = r[k].sd / span;
  out[k] = {
    mean: +mean.toFixed(3),
    sd: +sd.toFixed(3),
    // Multiply the field by this about 0.5 to make 2 sd reach the ends.
    stretchFor2sd: +(0.25 / Math.max(sd, 1e-4)).toFixed(2),
  };
}
return out;
