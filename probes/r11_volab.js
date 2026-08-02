/**
 * r11_volab.js — does the round-11 upsample fast path change any pixels?
 *
 * Comparing two PNGs from two harness runs cannot answer this: the settle
 * length, the deck's clock and the particle layer all move between them, and
 * the resulting mean absolute difference (3.06 codes on vista) is dominated by
 * things that have nothing to do with the change. So this flips the switch
 * INSIDE one page, one frame apart, and carries a NULL CONTROL — the same flip
 * performed between two identical configurations. The change is real only if it
 * exceeds what one frame of ordinary temporal drift already costs.
 *
 * The other round-11 saving, the discarded tWeather fetch in weatherAt(), needs
 * no A/B: at uCloudStreak = 0 the expression it feeds is mix(s.r, X, 0.0),
 * which is s.r * 1.0 + X * 0.0 — exactly s.r for any finite X. The branch
 * cannot change a pixel; it only stops the fetch happening.
 */
const g = window.__GAME;
const eng = g.engine;
const gl = eng.renderer.getContext();
const vol = g.world.registry.volumetrics;
if (!vol?.pass) return { error: 'volumetrics did not install' };
const U = vol.pass.compositeMat.uniforms;

const w = eng.renderer.domElement.width;
const h = eng.renderer.domElement.height;
const A = new Uint8Array(w * h * 4);
const B = new Uint8Array(w * h * 4);
eng.deterministic = true;
eng.stop();

function grab(buf) {
  eng.step(1 / 60);
  eng.render();
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
}
function diff() {
  let sum = 0;
  let mx = 0;
  let over1 = 0;
  let over4 = 0;
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(A[i * 4 + c] - B[i * 4 + c]);
      sum += d; n++;
      if (d > mx) mx = d;
      if (d >= 1) over1++;
      if (d >= 4) over4++;
    }
  }
  return {
    meanAbs: +(sum / n).toFixed(4),
    max: mx,
    pctGE1: +((over1 / n) * 100).toFixed(3),
    pctGE4: +((over4 / n) * 100).toFixed(4),
  };
}

const out = {};
for (const shot of ARGS.length ? ARGS : ['vista', 'ridge', 'ground', 'outpost']) {
  g.applyShot(shot);
  if (window.__pinDeterminism) window.__pinDeterminism();
  U.uFastUpsample.value = 1;
  g.settle(64);
  grab(A);
  // The control: the same one-frame gap with NOTHING changed.
  grab(B);
  const control = diff();
  grab(A);
  U.uFastUpsample.value = 0;
  grab(B);
  const change = diff();
  U.uFastUpsample.value = 1;
  out[shot] = { fastPathVsSlow: change, nullControlOneFrame: control };
}
return {
  out,
  note: 'nullControlOneFrame is one frame of ordinary temporal drift with no flip. ' +
    'The fast path is only a visible change where it exceeds that.',
};
