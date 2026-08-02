/**
 * r12_chev.js — where does the mountain herringbone LIVE?
 *
 * TODO.md 2.3 blames `_smoothFlats` being gated off above 25 deg slope. Two
 * re-bakes say otherwise: ablating `_addCrags` to zero amplitude leaves the
 * chevrons untouched, and removing the slope gate from `_smoothFlats` entirely
 * leaves them untouched. So it is neither the crags nor the cell-scale
 * de-hatching, and the lead in the TODO is dead.
 *
 * This asks the next question — geometry or shading — with a statistic instead
 * of an eyeball. The chevron is a strong PERIODIC signal, so a 1-D FFT of a
 * high-passed row profile across the mountain band has a peak that grain,
 * dither and TAA jitter cannot fake. A pixel diff cannot be used here: two
 * identical configurations differ on 56% of pixels because of the per-frame
 * dither, which is 30x the effect being looked for.
 *
 * Configurations are the uPerf cost hooks, which bypass blocks of the terrain
 * fragment shader by uniform branch and need no rebuild:
 *   flat  the whole custom body, leaving only the BAKED normal -> if the peak
 *         survives this, the chevron is in the bake or the mesh, not the shader
 *   nrm   the detail-tile normal perturbation and the micro tap
 *   near  grit / pavement / ripples
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const renderer = eng.renderer;
const gl = renderer.getContext();

g.applyShot('gameplay');
g.settle(40);
eng.deterministic = true;
eng.stop();

let U = null;
eng.scene.traverse((o) => {
  if (o.isMesh && /^terrain-L/.test(o.name || '') && o.material?.userData?.shader) U = o.material.userData.shader.uniforms;
});
if (!U) return { error: 'no terrain uniforms' };

const W = renderer.domElement.width, H = renderer.domElement.height;
// Rows across the mountain band of the gameplay framing, columns clear of the
// player's body on the left and the water tower on the right.
const X0 = 700, X1 = 1500, Y0 = 60, Y1 = 300;
const buf = new Uint8Array(W * H * 4);

function spectrum() {
  for (let i = 0; i < 10; i++) eng.render();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const n = X1 - X0;
  // Average the luminance rows, then high-pass with a 33-px boxcar so the
  // landform's own gradient does not dominate the low bins.
  const prof = new Float64Array(n);
  let rows = 0;
  for (let y = Y0; y < Y1; y++) {
    const sy = H - 1 - y;             // readPixels is bottom-up
    for (let x = 0; x < n; x++) {
      const o = (sy * W + (X0 + x)) * 4;
      prof[x] += 0.2126 * buf[o] + 0.7152 * buf[o + 1] + 0.0722 * buf[o + 2];
    }
    rows++;
  }
  for (let x = 0; x < n; x++) prof[x] /= rows;
  const R = 16;
  const hp = new Float64Array(n);
  for (let x = 0; x < n; x++) {
    let s = 0, c = 0;
    for (let k = -R; k <= R; k++) { const j = x + k; if (j >= 0 && j < n) { s += prof[j]; c++; } }
    hp[x] = prof[x] - s / c;
  }
  // Hann, then a plain DFT over the periods that matter (4-64 px).
  for (let x = 0; x < n; x++) hp[x] *= 0.5 - 0.5 * Math.cos((2 * Math.PI * x) / (n - 1));
  const bins = [];
  for (let p = 4; p <= 64; p += 0.5) {
    let re = 0, im = 0;
    for (let x = 0; x < n; x++) { const a = (2 * Math.PI * x) / p; re += hp[x] * Math.cos(a); im += hp[x] * Math.sin(a); }
    bins.push([p, (2 * Math.hypot(re, im)) / n]);
  }
  bins.sort((a, b) => b[1] - a[1]);
  let rms = 0;
  for (let x = 0; x < n; x++) rms += hp[x] * hp[x];
  return {
    peakPeriodPx: +bins[0][0].toFixed(1),
    peakAmpCodes: +bins[0][1].toFixed(3),
    next: bins.slice(1, 3).map(([p, a]) => [p, +a.toFixed(3)]),
    hpRmsCodes: +Math.sqrt(rms / n).toFixed(3),
  };
}

const out = {};
const CFG = { base: [0, 0, 0, 0], baseCtrl: [0, 0, 0, 0], flat: [1, 0, 0, 0], nrm: [0, 0, 1, 0], near: [0, 0, 0, 1], noBedrock: [0, 1, 0, 0] };
for (const [k, v] of Object.entries(CFG)) { U.uPerf.value.set(...v); out[k] = spectrum(); }
U.uPerf.value.set(0, 0, 0, 0);
return { band: `x ${X0}-${X1}, y ${Y0}-${Y1}`, results: out };
