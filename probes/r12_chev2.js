/**
 * r12_chev2.js — the herringbone, in the AIMED frame, against the post chain.
 *
 * Six ablations have now failed to move it: the erosion stack in its entirety,
 * `_addCrags`, `_smoothFlats`' slope gate, the strata bench snap, the baked sky
 * occlusion, and uPerf.x (which bypasses the whole terrain fragment body). A
 * Lambert hillshade of `far.h` straight out of the array shows a clean,
 * plausible mountain with no herringbone in it at all, and neither does the same
 * window resampled onto the outer rings' vertex spacing.
 *
 * Everything ruled out is world-space. What is left is screen-space, so this
 * asks the screen-space question — and the discriminator is not just "does
 * turning the pass off remove it" but WHERE THE WAVELENGTH LIVES. A world-space
 * defect scales with the 2.13x ADS zoom; a screen-space one does not. Both
 * poses are measured here for exactly that reason.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();
const volReg = g.world?.registry?.volumetrics ?? null;

const W = renderer.domElement.width, H = renderer.domElement.height;
const buf = new Uint8Array(W * H * 4);

// The herringbone's dominant period is VERTICAL — the bands stack up the slope —
// so a row profile averaged down a column of them cancels most of the signal,
// which is why the first version of this probe read 0.37 codes for something
// plainly visible. `axis` selects which way the profile runs.
function spectrum(X0, X1, Y0, Y1, axis) {
  for (let i = 0; i < 12; i++) eng.render();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const n = axis === 'y' ? Y1 - Y0 : X1 - X0;
  const m = axis === 'y' ? X1 - X0 : Y1 - Y0;
  const prof = new Float64Array(n);
  for (let u = 0; u < n; u++) {
    let acc = 0;
    for (let v = 0; v < m; v++) {
      const x = axis === 'y' ? X0 + v : X0 + u;
      const y = axis === 'y' ? Y0 + u : Y0 + v;
      const o = ((H - 1 - y) * W + x) * 4;
      acc += 0.2126 * buf[o] + 0.7152 * buf[o + 1] + 0.0722 * buf[o + 2];
    }
    prof[u] = acc / m;
  }
  const R = 12;
  const hp = new Float64Array(n);
  for (let x = 0; x < n; x++) {
    let s = 0, c = 0;
    for (let k = -R; k <= R; k++) { const j = x + k; if (j >= 0 && j < n) { s += prof[j]; c++; } }
    hp[x] = prof[x] - s / c;
  }
  for (let x = 0; x < n; x++) hp[x] *= 0.5 - 0.5 * Math.cos((2 * Math.PI * x) / (n - 1));
  const bins = [];
  for (let p = 5; p <= 80; p += 0.25) {
    let re = 0, im = 0;
    for (let x = 0; x < n; x++) { const a = (2 * Math.PI * x) / p; re += hp[x] * Math.cos(a); im += hp[x] * Math.sin(a); }
    bins.push([p, (2 * Math.hypot(re, im)) / n]);
  }
  bins.sort((a, b) => b[1] - a[1]);
  let rms = 0;
  for (let x = 0; x < n; x++) rms += hp[x] * hp[x];
  return { peakPx: +bins[0][0].toFixed(2), ampCodes: +bins[0][1].toFixed(3), hpRms: +Math.sqrt(rms / n).toFixed(3) };
}

function aim() {
  g.applyShot('gameplay');
  g.setMode('play');
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
  for (let k = 0; k < 45; k++) eng.step(1 / 60);
  g.settle(32);
  eng.deterministic = true;
  eng.stop();
}

const E = pipe.enabled;
const save = { ...E };
function reset() { Object.assign(E, save); if (volReg) volReg.setEnabled(true); }

const BAND = { X0: 260, X1: 820, Y0: 30, Y1: 300 };
const CFG = {
  base:        () => {},
  baseCtrl:    () => {},
  noSsao:      () => { E.ssao = false; },
  noMicroAO:   () => { E.microAO = false; },
  noContact:   () => { E.contactShadows = false; },
  noAerial:    () => { E.aerial = false; },
  noDof:       () => { E.dof = false; E.motionBlur = false; },
  noBloom:     () => { E.bloom = false; },
  noVol:       () => { if (volReg) volReg.setEnabled(false); },
  noFxaa:      () => { E.fxaa = false; },
};

aim();
const aimed = {};
for (const [k, f] of Object.entries(CFG)) { reset(); f(); aimed[k] = { y: spectrum(BAND.X0, BAND.X1, BAND.Y0, BAND.Y1, 'y'), x: spectrum(BAND.X0, BAND.X1, BAND.Y0, BAND.Y1, 'x') }; }
reset();

// Same band, hip FOV. If the peak PERIOD is the same number of pixels in both,
// the pattern is screen-space; if it scales with the 2.13x zoom, it is world-space.
g.applyShot('gameplay');
g.settle(32);
eng.deterministic = true;
eng.stop();
const hip = { y: spectrum(700, 1200, 60, 260, 'y'), x: spectrum(700, 1200, 60, 260, 'x') };

return { aimedBand: BAND, aimed, hip };
