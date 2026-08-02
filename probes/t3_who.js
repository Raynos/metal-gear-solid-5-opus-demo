/**
 * What the terrain actually owns, and what this round's layers actually move.
 *
 *   bash <scratch>/t3_probe.sh probes/t3_who.js
 *
 * For each shot: the fraction of the near-ground band that CHANGES when the
 * terrain mesh is hidden (the honest "terrain is N% of this band"), and the
 * fraction that changes when each of the round's new layers is ablated through
 * its own uDbg hook. Ablating in place beats diffing against a previous build,
 * where five things moved at once.
 */
const g = window.__GAME;
const W = g.world;
const eng = W.engine;
const T = W.terrain;

const SHOTS = ['ground', 'vista', 'ridge', 'gameplay'];
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

function compare(a, b, w, y0, y1) {
  let n = 0;
  let diff = 0;
  let sum = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = Math.round(w * 0.08); x < Math.round(w * 0.92); x++) {
      const i = (y * w + x) * 4;
      n++;
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      sum += d;
      if (d > 8) diff++;
    }
  }
  return [diff / n, sum / n];
}

lines.push(`wearBound=${T.uniforms.uWearOn.value} state=${T._wearState}`);

for (const name of SHOTS) {
  await g.applyShot(name);
  await g.settle(12);
  const c = eng.renderer.domElement;
  const w = c.width;
  const h = c.height;
  const y0 = Math.round(h * 0.72);
  const y1 = Math.round(h * 0.98);
  const base = grab();

  T.mesh.visible = false;
  const [fT] = compare(base, grab(), w, y0, y1);
  T.mesh.visible = true;

  const d3 = T.uniforms.uDbg3.value;
  d3.x = 0;
  const [fS, mS] = compare(base, grab(), w, y0, y1);
  d3.x = 1;
  d3.y = 0;
  const [fW, mW] = compare(base, grab(), w, y0, y1);
  d3.y = 1;
  const d = T.uniforms.uDbg.value;
  d.y = 0;
  const [fG, mG] = compare(base, grab(), w, y0, y1);
  d.y = 1;

  lines.push(`${name.padEnd(9)} terrain=${fT.toFixed(3)}  soil=${fS.toFixed(3)}/${mS.toFixed(1)}`
    + `  wear=${fW.toFixed(3)}/${mW.toFixed(1)}  grit=${fG.toFixed(3)}/${mG.toFixed(1)}`);
}

return lines.join('\n');
