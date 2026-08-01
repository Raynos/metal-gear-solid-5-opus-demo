/**
 * (k3) THE FOG/EXPOSURE COUPLING, measured as a 2-D sweep instead of argued.
 *
 * The atmosphere owner needs `dustBeta`/`dustHeight` up (1.3-18% ridge opacity
 * against a 55-65% target) and correctly refused to make half of a two-file
 * change: raising the haze veils the top of the range, and at 3.2e-4 the vista
 * frame had NO pixel at max-channel 230, which is the round-5 defect that the
 * `cloudGain` lift exists to fix. Their sweep is in the header of
 * VolumetricPass.js.
 *
 * ## The answer this probe returned: the coupling is NOT through the exposure
 *
 * Two render-side knobs are swept here. `grade.whitePoint` is the linear
 * radiance that maps to display 1.0, i.e. "this scene's peak is dimmer now" —
 * the obvious matched correction. It does essentially nothing: dropping it from
 * 5.2 to 3.2, which is 0.7 stops of white point, moves the vista's pixels at
 * max-channel >= 230 from 0.008% to 0.059% at dustBeta 2.4e-4. It cannot,
 * because the haze has not compressed the top of the range, it has REMOVED the
 * radiance that used to be there.
 *
 * A straight exposure lift can buy it back and the price is absurd: at
 * 2.4e-4/900 it takes x1.6 (+0.68 stops) to get back to 3.0% and that puts the
 * vista's mean at 156; at 3.6e-4/1600 it takes x1.9 (+0.93 stops) for 3.2% at a
 * mean of 171. That is not a trim, it is a different photograph.
 *
 * So the density is NOT coupled to the exposure the way the VolumetricPass
 * header assumes. What the haze does is converge the brightest content onto the
 * sky in its direction, and at 2.4e-4 the vista's p99.99 falls from 244 to 229 —
 * the convergence TARGET is below 230. The fix is on the atmosphere side: raise
 * what a dense haze converges onto (the far sky / `cloudGain`), and the
 * highlight range comes from the sky itself instead of from the ground, at any
 * density. See the report.
 *
 * Reported per (dustBeta, whitePoint) cell:
 *   pctGE230 / p9999   the highlight-range criterion (targets 1.9-3.2 / 244-245)
 *   blackP001          the black-point criterion (target 10-12)
 *   meanRB             daylight warmth (target +8..+18)
 *   coolPct            B > R+4, the dusk criterion (ridge target >= 12)
 */
g.setFreeFly(false);
const engine = g.engine, pipeline = engine.pipeline, renderer = engine.renderer;
const gl = renderer.getContext();
const pass = g.world.registry.volumetrics.pass;
const W = pipeline.width, H = pipeline.height;
const px = new Uint8Array(W * H * 4);

function stats() {
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const n = W * H;
  const maxH = new Float64Array(256), minH = new Float64Array(256);
  let ge230 = 0, cool = 0, sr = 0, sb = 0, crushed = 0;
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const r = px[j], g2 = px[j + 1], b = px[j + 2];
    const mx = Math.max(r, g2, b), mn = Math.min(r, g2, b);
    maxH[mx]++; minH[mn]++;
    if (mx >= 230) ge230++;
    if (b > r + 4) cool++;
    if (mn === 0) crushed++;
    sr += r; sb += b;
  }
  const q = (h, t) => { let c = 0; for (let v = 0; v < 256; v++) { c += h[v]; if (c >= t * n) return v; } return 255; };
  return {
    pctGE230: +((ge230 / n) * 100).toFixed(3),
    p9999: q(maxH, 0.9999),
    blackP001: q(minH, 0.0001),
    crushedPct: +((crushed / n) * 100).toFixed(3),
    meanRB: +((sr - sb) / n).toFixed(1),
    coolPct: +((cool / n) * 100).toFixed(2),
  };
}

const BETAS = { vista: [[1.18e-4, 360], [2.4e-4, 900], [3.2e-4, 1400]], ridge: [[1.35e-4, 320], [2.2e-4, 900], [3.0e-4, 1300]] };
const WPS = [5.2, 4.4, 3.8, 3.2];
const EXPOS = [1.0, 1.35, 1.6, 1.9];
const out = {};
for (const shot of Object.keys(BETAS)) {
  g.applyShot(shot);
  const kb = pass.params.dustBeta, kh = pass.params.dustHeight, kw = pipeline.grade.whitePoint, kt = pipeline.exposure;
  out[shot] = [];
  for (const [beta, height] of BETAS[shot]) {
    pass.params.dustBeta = beta;
    pass.params.dustHeight = height;
    for (const wp of WPS) {
      pipeline.grade.whitePoint = wp;
      pipeline.refreshGrade();
      g.settle(40);
      out[shot].push({ beta: +beta.toExponential(2), height, whitePoint: wp, expo: 1, ...stats() });
    }
    pipeline.grade.whitePoint = kw;
    pipeline.refreshGrade();
    for (const m of EXPOS) {
      pipeline.exposure = kt * m;
      g.settle(40);
      out[shot].push({ beta: +beta.toExponential(2), height, whitePoint: kw, expo: m, ...stats() });
    }
    pipeline.exposure = kt;
  }
  pass.params.dustBeta = kb; pass.params.dustHeight = kh;
  pipeline.grade.whitePoint = kw; pipeline.exposure = kt; pipeline.refreshGrade();
  g.settle(6);
}
return out;
