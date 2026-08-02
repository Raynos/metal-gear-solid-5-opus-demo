/**
 * Isolate this round's terrain work from everything else in the frame.
 *
 * For each shot: build a mask of the pixels the terrain owns (by hiding the
 * terrain mesh and keeping what changed), then report, over that mask only, the
 * mean RGB and the L* spread with the soil palette ON and with every class
 * forced to 1.0 — which is exactly the previous build's single-surface ground.
 * Everything else in the frame is identical between the two, so the difference
 * is the layer and nothing else.
 */
const g = window.__GAME;
const W = g.world;
const eng = W.engine;
const T = W.terrain;

const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const lstar = (y) => (y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y);

function grab() {
  eng.render();
  const c = eng.renderer.domElement;
  const cv = document.createElement('canvas');
  cv.width = c.width;
  cv.height = c.height;
  cv.getContext('2d').drawImage(c, 0, 0);
  return cv.getContext('2d').getImageData(0, 0, c.width, c.height).data;
}

function stats(px, mask, w, x0, y0, bw, bh) {
  const ls = [];
  let r = 0;
  let gg = 0;
  let b = 0;
  const grey = new Float64Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = ((y + y0) * w + (x + x0)) * 4;
      grey[y * bw + x] = (px[i] + px[i + 1] + px[i + 2]) / 3;
      if (!mask[y * bw + x]) continue;
      r += px[i]; gg += px[i + 1]; b += px[i + 2];
      ls.push(lstar(0.2126 * LIN[px[i]] + 0.7152 * LIN[px[i + 1]] + 0.0722 * LIN[px[i + 2]]));
    }
  }
  const n = ls.length || 1;
  const mean = ls.reduce((a, v) => a + v, 0) / n;
  const sd = Math.sqrt(ls.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
  const hp = [];
  for (const rad of [2, 8, 32]) {
    let s2 = 0;
    let k = 0;
    const step = Math.max(1, rad >> 2);
    for (let y = rad; y < bh - rad; y++) {
      for (let x = rad; x < bw - rad; x++) {
        if (!mask[y * bw + x]) continue;
        let s = 0;
        let c2 = 0;
        for (let j = -rad; j <= rad; j += step) {
          for (let i2 = -rad; i2 <= rad; i2 += step) { s += grey[(y + j) * bw + (x + i2)]; c2++; }
        }
        const d = grey[y * bw + x] - s / c2;
        s2 += d * d;
        k++;
      }
    }
    hp.push(+(Math.sqrt(s2 / Math.max(1, k)) / Math.max(1, (r + gg + b) / (3 * n)) * 100).toFixed(2));
  }
  return {
    n,
    rgb: [r / n, gg / n, b / n].map((v) => +v.toFixed(1)),
    L: +mean.toFixed(2),
    sd: +sd.toFixed(2),
    hi85: +(ls.filter((v) => v > 85).length / n).toFixed(4),
    hi75: +(ls.filter((v) => v > 75).length / n).toFixed(4),
    hp,
  };
}

const SAVE = ['uSoilA', 'uSoilB', 'uSoilC', 'uSoilD'].map((k) => T.uniforms[k].value.clone());
const out = {};

for (const name of ['ground', 'gameplay', 'vista']) {
  await g.applyShot(name);
  await g.settle(14);
  const c = eng.renderer.domElement;
  const w = c.width;
  const h = c.height;
  const y0 = Math.round(h * 0.55);
  const y1 = Math.round(h * 0.99);
  const x0 = Math.round(w * 0.04);
  const x1 = Math.round(w * 0.96);
  const bw = x1 - x0;
  const bh = y1 - y0;

  const on = grab();
  T.mesh.visible = false;
  await g.settle(8);
  const off = grab();
  T.mesh.visible = true;
  await g.settle(8);

  const mask = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = ((y + y0) * w + (x + x0)) * 4;
      const d = Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1]) + Math.abs(on[i + 2] - off[i + 2]);
      if (d > 8) mask[y * bw + x] = 1;
    }
  }

  const withSoil = stats(on, mask, w, x0, y0, bw, bh);
  for (const k of ['uSoilA', 'uSoilB', 'uSoilC', 'uSoilD']) T.uniforms[k].value.setRGB(1, 1, 1);
  await g.settle(10);
  const noSoil = stats(grab(), mask, w, x0, y0, bw, bh);
  SAVE.forEach((v, i) => T.uniforms[['uSoilA', 'uSoilB', 'uSoilC', 'uSoilD'][i]].value.copy(v));
  await g.settle(6);

  out[name] = { cover: +(withSoil.n / (bw * bh)).toFixed(3), withSoil, noSoil };
}

return JSON.stringify(out, null, 1);
