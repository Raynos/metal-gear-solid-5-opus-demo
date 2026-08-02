/**
 * r11_warm.js — TODO 1.1 says the haze reads warm sepia past 300 m. Does it,
 * and is the haze what is doing it?
 *
 * The TODO's stated cause is gone: `dustWarm` is 0.0 in all five presets, so
 * the authored warm tilt is not applied at all. The successor suspicion was
 * `WARM = [1.10, 1.0, 0.86]` in VolumetricPass.syncTimeOfDay — but that lives
 * in the branch taken only when Sky exposes no query API, and it does: measured
 * on the shipped build, `uSkyLutValid` is 1 and `_skyRad` is populated, so the
 * horizon radiance comes straight out of Sky's own integrator and the WARM
 * constant never executes.
 *
 * So the question is what the haze is converging ONTO. This ablates the haze
 * (`pass.ablate.haze`, which syncTimeOfDay cannot revert) and measures R-B in
 * three horizontal bands of the vista frame. If the haze were adding warmth,
 * turning it off would make those bands cooler. If the far field is warm with
 * the haze off too, the warmth is the sky's own horizon and the sand under it.
 */
const g = window.__GAME;
const eng = g.engine;
const gl = eng.renderer.getContext();
const vol = g.world.registry.volumetrics;
if (!vol?.pass) return { error: 'volumetrics did not install' };
const pass = vol.pass;

const w = eng.renderer.domElement.width;
const h = eng.renderer.domElement.height;
const px = new Uint8Array(w * h * 4);
eng.deterministic = true;
eng.stop();

// Image-space bands, top-down, as a fraction of height. sky is clear dome above
// the deck; skyline is the massif at ~2-4 km; midField is the valley floor.
const BANDS = { sky: [0.06, 0.11], skyline: [0.25, 0.30], midField: [0.45, 0.52], near: [0.82, 0.90] };

function measure() {
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const o = {};
  for (const [name, [a, b]] of Object.entries(BANDS)) {
    // readPixels is bottom-up; the band fractions are top-down.
    const y0 = Math.floor((1 - b) * h);
    const y1 = Math.floor((1 - a) * h);
    let R = 0;
    let G = 0;
    let B = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = Math.floor(w * 0.35); x < Math.floor(w * 0.65); x++) {
        const i = (y * w + x) * 4;
        R += px[i]; G += px[i + 1]; B += px[i + 2]; n++;
      }
    }
    o[name] = {
      R: +(R / n).toFixed(2), G: +(G / n).toFixed(2), B: +(B / n).toFixed(2),
      RminusB: +((R - B) / n).toFixed(2), RoverB: +(R / B).toFixed(4),
    };
  }
  return o;
}

g.applyShot('vista');
if (window.__pinDeterminism) window.__pinDeterminism();

pass.ablate.haze = false;
g.settle(64);
const withHaze = measure();

pass.ablate.haze = true;
g.settle(64);
const noHaze = measure();
pass.ablate.haze = false;

// The crepuscular lobe is the pass's only term that in-scatters the KEY light's
// own chroma rather than the sky's, and uKeyColor is R/B 1.395 at afternoon. If
// the mid-field's warmth is coming from inside this pass at all, it is here.
pass.ablate.shafts = true;
g.settle(64);
const noShafts = measure();
pass.ablate.shafts = false;
g.settle(8);

const delta = {};
const shaftDelta = {};
for (const k of Object.keys(BANDS)) {
  delta[k] = {
    RminusB: +(withHaze[k].RminusB - noHaze[k].RminusB).toFixed(2),
    RoverB: +(withHaze[k].RoverB - noHaze[k].RoverB).toFixed(4),
  };
  shaftDelta[k] = {
    RminusB: +(withHaze[k].RminusB - noShafts[k].RminusB).toFixed(2),
    RoverB: +(withHaze[k].RoverB - noShafts[k].RoverB).toFixed(4),
    dLuma: +(withHaze[k].G - noShafts[k].G).toFixed(2),
  };
}

return {
  skyLutValid: pass.volMat.uniforms.uSkyLutValid.value,
  skyHorizonRadiance: pass.volMat.uniforms.uSkyHorizon.value.toArray().map((v) => +v.toFixed(4)),
  skyLutMean: pass.skyLut.valid ? pass.skyLut.mean.map((v) => +v.toFixed(4)) : null,
  dustWarmPreset: pass.params.dustWarm,
  withHaze,
  hazeAblated: noHaze,
  shaftsAblated: noShafts,
  hazeContributionToWarmth: delta,
  shaftContributionToWarmth: shaftDelta,
  note: 'A POSITIVE RoverB delta means the haze is making that band warmer than it ' +
    'would otherwise be. Negative means the haze is COOLING it.',
};
