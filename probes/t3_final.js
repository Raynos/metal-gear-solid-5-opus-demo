/**
 * Exposure guard plus this round's ablations, per shot.
 *
 * probeLuminance must stay inside mean 0.42-0.55 and clipped < 0.6% for the
 * daylight shots — the whole-frame calibration this round must not disturb —
 * and each new layer is toggled through its own uDbg hook so its contribution
 * is a measured difference on ONE build rather than a diff against a previous
 * one where five things moved at once.
 */
const g = window.__GAME;
const W = g.world;
const eng = W.engine;
const T = W.terrain;

const lines = [];

function grab() {
  eng.render();
  const c = eng.renderer.domElement;
  const cv = document.createElement('canvas');
  cv.width = c.width;
  cv.height = c.height;
  cv.getContext('2d').drawImage(c, 0, 0);
  return cv.getContext('2d').getImageData(0, 0, c.width, c.height).data;
}

function delta(a, b) {
  let s = 0;
  let n = 0;
  let over = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    s += d;
    n++;
    if (d > 8) over++;
  }
  return [+(s / n).toFixed(2), +(over / n).toFixed(3)];
}

lines.push(`wear: on=${T.uniforms.uWearOn.value} state=${T._wearState}`);

for (const name of ['ground', 'vista', 'outpost', 'gameplay', 'ridge', 'dawn', 'night']) {
  await g.applyShot(name);
  await g.settle(16);
  const lum = g.probeLuminance();
  const base = grab();

  T.uniforms.uDbg3.value.x = 0;
  await g.settle(10);
  const soil = delta(base, grab());
  T.uniforms.uDbg3.value.x = 1;

  T.uniforms.uDbg3.value.y = 0;
  await g.settle(10);
  const wear = delta(base, grab());
  T.uniforms.uDbg3.value.y = 1;
  await g.settle(6);

  lines.push(`${name.padEnd(9)} lum ${lum.mean.toFixed(3)} clip ${lum.clippedPct.toFixed(2)}%`
    + `   soil dE ${soil[0]} frac ${soil[1]}   wear dE ${wear[0]} frac ${wear[1]}`);
}

return lines.join('\n');
