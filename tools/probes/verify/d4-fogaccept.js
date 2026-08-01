/**
 * Sweep the haze against the ACCEPTANCE metrics it can break, not just the one
 * it is meant to fix. Raising the density lifts the mid-field, the illuminant-
 * derived exposure does not move, and the top of the range goes with it — so
 * (e) HIGHLIGHT RANGE and (i) DUSK COOL have to be re-measured at every step or
 * the fix trades a passing criterion for a failing one.
 *
 * Reads the presented frame directly, so these are the same numbers the PNG
 * suite reports.
 */
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer, pipeline = engine.pipeline;
const gl = renderer.getContext();
const pass = g.world.registry.volumetrics.pass;
const W = pipeline.width, H = pipeline.height;
const px = new Uint8Array(W * H * 4);

function frameStats() {
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const n = W * H;
  const hist = new Float64Array(256);
  let ge230 = 0, cool = 0;
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const m = Math.max(px[j], px[j + 1], px[j + 2]);
    hist[m]++;
    if (m >= 230) ge230++;
    if (px[j + 2] > px[j] + 4) cool++;
  }
  const q = (t) => { let c = 0; for (let v = 0; v < 256; v++) { c += hist[v]; if (c >= t * n) return v; } return 255; };
  return { pctGE230: +((ge230 / n) * 100).toFixed(4), p9999: q(0.9999), coolPct: +((cool / n) * 100).toFixed(2) };
}

const SWEEP = {
  // The shipped value is measured FIRST and again LAST: eye adaptation carries
  // across settles, and a sweep that does not close the loop cannot tell a real
  // trend from the tail of the previous step.
  vista: [[1.18e-4, 360], [1.6e-4, 700], [2.0e-4, 900], [2.4e-4, 1100], [3.2e-4, 1400], [1.18e-4, 360]],
  ground: [[1.10e-4, 420], [1.6e-4, 700], [2.0e-4, 900], [2.4e-4, 1100], [3.2e-4, 1500], [1.10e-4, 420]],
  ridge: [[1.35e-4, 320], [1.7e-4, 600], [2.2e-4, 900], [1.35e-4, 320]],
};
const out = {};
for (const shot of Object.keys(SWEEP)) {
  g.applyShot(shot);
  const kb = pass.params.dustBeta, kh = pass.params.dustHeight;
  out[shot] = [];
  for (const [beta, height] of SWEEP[shot]) {
    pass.params.dustBeta = beta;
    pass.params.dustHeight = height;
    g.settle(60);
    out[shot].push({ beta: +beta.toExponential(2), height, ...frameStats() });
  }
  pass.params.dustBeta = kb; pass.params.dustHeight = kh;
  g.settle(4);
}
return out;
