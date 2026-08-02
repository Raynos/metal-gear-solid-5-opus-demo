/**
 * How much of a terrain pixel is the terrain?
 *
 * Every measured change this round came back at or below the noise floor, so
 * before tuning anything further: force the terrain's albedo to 0 and then to
 * 3x through the soil-class multiplier, mask to the pixels the terrain mesh
 * owns, and see how far the screen moves. If black terrain and 3x terrain land
 * in the same place, the pixel is not made of terrain — it is made of whatever
 * is in front of it — and no surface work in this file can reach the frame.
 *
 * Reported per horizontal band of the frame, because the answer is a function
 * of distance.
 */
const g = window.__GAME;
const W = g.world;
const eng = W.engine;
const T = W.terrain;
const KEYS = ['uSoilA', 'uSoilB', 'uSoilC', 'uSoilD'];
const SAVE = KEYS.map((k) => T.uniforms[k].value.clone());

function grab() {
  eng.render();
  const c = eng.renderer.domElement;
  const cv = document.createElement('canvas');
  cv.width = c.width;
  cv.height = c.height;
  cv.getContext('2d').drawImage(c, 0, 0);
  return cv.getContext('2d').getImageData(0, 0, c.width, c.height).data;
}
const setAll = (v) => KEYS.forEach((k) => T.uniforms[k].value.setRGB(v, v, v));

const lines = [];
for (const name of ['vista', 'outpost', 'ridge']) {
  await g.applyShot(name);
  await g.settle(16);
  const c = eng.renderer.domElement;
  const w = c.width;
  const h = c.height;

  const base = grab();
  T.mesh.visible = false;
  await g.settle(10);
  const off = grab();
  T.mesh.visible = true;
  await g.settle(10);

  setAll(0);
  await g.settle(10);
  const black = grab();
  setAll(3);
  await g.settle(10);
  const bright = grab();
  SAVE.forEach((v, i) => T.uniforms[KEYS[i]].value.copy(v));
  await g.settle(6);

  for (const [lo, hi, label] of [[0.40, 0.55, 'far   '], [0.55, 0.70, 'mid   '], [0.70, 0.99, 'near  ']]) {
    let n = 0;
    let sB = 0;
    let sK = 0;
    let sW = 0;
    for (let y = Math.round(h * lo); y < Math.round(h * hi); y++) {
      for (let x = Math.round(w * 0.05); x < Math.round(w * 0.95); x++) {
        const i = (y * w + x) * 4;
        const d = Math.abs(base[i] - off[i]) + Math.abs(base[i + 1] - off[i + 1]) + Math.abs(base[i + 2] - off[i + 2]);
        if (d <= 8) continue;
        n++;
        sB += (base[i] + base[i + 1] + base[i + 2]) / 3;
        sK += (black[i] + black[i + 1] + black[i + 2]) / 3;
        sW += (bright[i] + bright[i + 1] + bright[i + 2]) / 3;
      }
    }
    if (n < 400) { lines.push(`${name} ${label} n=${n}`); continue; }
    lines.push(`${name.padEnd(8)}${label} n=${n}  base ${(sB / n).toFixed(1)}`
      + `  albedo0 ${(sK / n).toFixed(1)}  albedo3x ${(sW / n).toFixed(1)}`
      + `  reach ${(((sW - sK) / n) / Math.max(1, sB / n) * 100).toFixed(1)}%`);
  }
}
return lines.join('\n');
