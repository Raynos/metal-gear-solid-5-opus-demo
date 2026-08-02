/**
 * r12_chevao.js — the mountain herringbone is the AO pass. Which part of it?
 *
 * Two candidates inside that pass, both fixable and only one of them recent:
 *
 *   FROZEN DITHER. GTAO dithers its slice rotation per pixel and per frame;
 *   with TAA off the pipeline now pins uFrame to 0, which turns that dither
 *   into a fixed spatial field. With 3 slices there are few effective
 *   configurations, so the field is structured rather than noisy.
 *
 *   CLAMPED RADIUS AT RANGE. `pixRadius = clamp(uRadius * pixPerMetre, 3.0,
 *   52.0)`. At a kilometre the 1.15 m broad radius projects to about one pixel
 *   and is clamped UP to three, so the horizon search stops measuring occlusion
 *   and starts measuring the local slope and the depth buffer's quantisation.
 *   The micro term is explicitly protected from this — `microFade =
 *   smoothstep(1.3, 2.6, microPixRaw)` fades it out below 2.6 px — and the
 *   broad term is not.
 *
 * uFrame is written every frame by the pipeline, so it is overridden here by
 * wrapping _blit rather than by assignment, which would be undone before the
 * pass ran.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();
const canvas = renderer.domElement;

g.applyShot('gameplay');
g.setMode('play');
window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
for (let k = 0; k < 45; k++) eng.step(1 / 60);
g.settle(32);
eng.deterministic = true;
eng.stop();

const orig = pipe._blit.bind(pipe);
const ctl = { unfreeze: false, radius: null };
let tick = 0;
pipe._blit = function (mat, target) {
  if (mat === pipe.aoMat) {
    if (ctl.unfreeze) mat.uniforms.uFrame.value = (tick++) % 64;
    if (ctl.radius !== null) mat.uniforms.uRadius.value = ctl.radius;
  }
  return orig(mat, target);
};
const R0 = pipe.aoMat.uniforms.uRadius.value;

const W = canvas.width, H = canvas.height;
const buf = new Uint8Array(W * H * 4);
const X0 = 260, X1 = 820, Y0 = 30, Y1 = 300;
function spectrumY() {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const n = Y1 - Y0, m = X1 - X0;
  const prof = new Float64Array(n);
  for (let u = 0; u < n; u++) {
    let acc = 0;
    for (let v = 0; v < m; v++) {
      const o = ((H - 1 - (Y0 + u)) * W + (X0 + v)) * 4;
      acc += 0.2126 * buf[o] + 0.7152 * buf[o + 1] + 0.0722 * buf[o + 2];
    }
    prof[u] = acc / m;
  }
  const R = 12, hp = new Float64Array(n);
  for (let x = 0; x < n; x++) {
    let s = 0, c = 0;
    for (let k = -R; k <= R; k++) { const j = x + k; if (j >= 0 && j < n) { s += prof[j]; c++; } }
    hp[x] = prof[x] - s / c;
  }
  let rms = 0;
  for (let x = 0; x < n; x++) rms += hp[x] * hp[x];
  for (let x = 0; x < n; x++) hp[x] *= 0.5 - 0.5 * Math.cos((2 * Math.PI * x) / (n - 1));
  let best = [0, 0];
  for (let p = 5; p <= 80; p += 0.25) {
    let re = 0, im = 0;
    for (let x = 0; x < n; x++) { const a = (2 * Math.PI * x) / p; re += hp[x] * Math.cos(a); im += hp[x] * Math.sin(a); }
    const amp = (2 * Math.hypot(re, im)) / n;
    if (amp > best[1]) best = [p, amp];
  }
  return { peakPx: +best[0].toFixed(2), ampCodes: +best[1].toFixed(3), hpRms: +Math.sqrt(rms / n).toFixed(3) };
}
const CX = 200, CY = 20, CW = 640, CH = 300;
function shot() {
  const c = document.createElement('canvas');
  c.width = CW * 2; c.height = CH * 2;
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = false;
  x.drawImage(canvas, CX, CY, CW, CH, 0, 0, CW * 2, CH * 2);
  return c.toDataURL('image/png');
}
function run() { for (let i = 0; i < 14; i++) eng.render(); return spectrumY(); }

const out = {};
const imgs = {};
out.shipped = run(); imgs.shipped = shot();
out.shippedCtrl = run();
ctl.unfreeze = true; out.ditherUnfrozen = run(); imgs.ditherUnfrozen = shot(); ctl.unfreeze = false;
ctl.radius = R0 * 0.25; out.radiusQuarter = run(); imgs.radiusQuarter = shot(); ctl.radius = null;
pipe.enabled.ssao = false; out.aoOff = run(); imgs.aoOff = shot(); pipe.enabled.ssao = true;
pipe._blit = orig;
return { broadRadiusM: R0, spectra: out, imgs };
