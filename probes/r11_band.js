/**
 * r11_band.js — stop guessing which term paints the black band.
 *
 * The band on the ground shot reads RGB 44 against sunlit sand at 180 (0.24x).
 * It has now been blamed on, and survived, four different fixes:
 *   - cascade texel size / dithered PCF   (TODO.md 1.3)  -- disproved: not a shadow
 *   - the vehicle-corridor `dirt` term    -- 0.40x -> 0.70x moved it 44.0 -> 43.8
 *   - the oil spill floor and blend       -- 0.030@0.86 -> 0.086@0.62 moved nothing
 *   - the terrain's own shading           -- disproved: --hide terrain leaves it
 * while `--hide op-ground` removes it outright. So it IS this material, and it
 * is none of the terms I have edited.
 *
 * mat.js already carries the instrument: uWearCtl.x scales the whole wear map
 * (r, b, a) and uWearCtl.y switches the ground to a debug view that paints
 * (foot, corridor+rut, spill|scorch) straight into RGB. Read the band through
 * both instead of editing another constant on a hunch.
 */
const g = window.__GAME;
const eng = g.engine;
const renderer = eng.renderer;
const gl = renderer.getContext();

g.applyShot('ground');
eng.deterministic = true;
eng.stop();

// The band, and a sunlit sand control at the same depth, in frame coords with
// y measured from the TOP (readPixels is bottom-up, so it is flipped below).
const BAND = { x: 1000, y: 730, w: 300, h: 40 };
const SAND = { x: 500, y: 880, w: 300, h: 40 };

function sample(r) {
  const fw = renderer.domElement.width;
  const fh = renderer.domElement.height;
  const y0 = fh - (r.y + r.h);
  const px = new Uint8Array(r.w * r.h * 4);
  gl.readPixels(r.x, y0, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let R = 0, G = 0, B = 0;
  const n = r.w * r.h;
  for (let i = 0; i < n; i++) { R += px[i * 4]; G += px[i * 4 + 1]; B += px[i * 4 + 2]; }
  return [+(R / n).toFixed(1), +(G / n).toFixed(1), +(B / n).toFixed(1)];
}

/** Every ground material that carries the wear uniforms. */
const mats = [];
g.world.scene.traverse((o) => {
  const m = o.material;
  if (m && m.uniforms && m.uniforms.uWearCtl) mats.push(m);
});
const setCtl = (fn) => mats.forEach((m) => fn(m.uniforms.uWearCtl.value));

function shot(label) {
  g.settle(16);
  return { label, band: sample(BAND), sand: sample(SAND) };
}

const out = [];
const ref = setCtl.length; // noop, keeps linters quiet
const saved = mats.length ? mats[0].uniforms.uWearCtl.value.clone() : null;

out.push(shot('as shipped'));

// 1. Kill the whole wear map. If the band survives this, nothing driven by
//    WR.r/.b/.a -- corridor, rut, foot, spill, scorch -- can be responsible.
setCtl((v) => { v.x = 0; });
out.push(shot('uWearCtl.x = 0 (whole wear map off)'));

// 2. Debug view: R = footpath, G = corridor + rut, B = spill | scorch.
setCtl((v) => { v.x = saved ? saved.x : 1; v.y = 1; });
out.push(shot('debug masks: R=foot G=corridor+rut B=spill|scorch'));

setCtl((v) => { v.x = saved ? saved.x : 1; v.y = saved ? saved.y : 0; });

return {
  note: 'band is the dark region on the ground shot; sand is a sunlit control at the same depth',
  materialsWithWearUniforms: mats.length,
  reads: out,
  reading:
    'If "whole wear map off" leaves the band dark, the cause is NOT the wear ' +
    'field and every fix aimed at corridor/spill was aimed at the wrong term. ' +
    'The debug row then says which mask, if any, actually covers those pixels.',
};
