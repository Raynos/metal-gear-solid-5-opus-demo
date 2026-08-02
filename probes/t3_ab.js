/**
 * The soil class, ablated in place, measured where the terrain actually reaches
 * the screen.
 *
 * probes/t3_reach.js established that a terrain pixel is only 60% terrain in the
 * vista's mid band, 16-18% in any far band, and 0-1% anywhere near the camera —
 * so a whole-frame statistic cannot see this layer at all. This measures the
 * band where it can: mean L*, spread, and the high-pass at 8 and 32 px, with
 * uDbg3.x at 1 and at 0 on the same build and the same frame.
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

function stat(px, w, x0, y0, bw, bh) {
  const ls = [];
  const grey = new Float64Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = ((y + y0) * w + (x + x0)) * 4;
      grey[y * bw + x] = (px[i] + px[i + 1] + px[i + 2]) / 3;
      ls.push(lstar(0.2126 * LIN[px[i]] + 0.7152 * LIN[px[i + 1]] + 0.0722 * LIN[px[i + 2]]));
    }
  }
  const n = ls.length;
  const m = ls.reduce((a, v) => a + v, 0) / n;
  const sd = Math.sqrt(ls.reduce((a, v) => a + (v - m) ** 2, 0) / n);
  let gm = 0;
  for (let i = 0; i < grey.length; i++) gm += grey[i];
  gm /= grey.length;
  const hp = [];
  for (const r of [8, 32]) {
    let s2 = 0;
    let k = 0;
    const st = Math.max(1, r >> 2);
    for (let y = r; y < bh - r; y++) {
      for (let x = r; x < bw - r; x++) {
        let s = 0;
        let c2 = 0;
        for (let j = -r; j <= r; j += st) for (let i2 = -r; i2 <= r; i2 += st) { s += grey[(y + j) * bw + (x + i2)]; c2++; }
        const d = grey[y * bw + x] - s / c2;
        s2 += d * d;
        k++;
      }
    }
    hp.push(+(Math.sqrt(s2 / k) / gm * 100).toFixed(2));
  }
  return `L* ${m.toFixed(2)} sd ${sd.toFixed(2)} hp8 ${hp[0]}% hp32 ${hp[1]}%`;
}

const lines = [];
for (const [name, lo, hi] of [['vista', 0.55, 0.70], ['ridge', 0.40, 0.62], ['outpost', 0.28, 0.46]]) {
  await g.applyShot(name);
  await g.settle(16);
  const c = eng.renderer.domElement;
  const w = c.width;
  const h = c.height;
  const y0 = Math.round(h * lo);
  const bh = Math.round(h * hi) - y0;
  const x0 = Math.round(w * 0.05);
  const bw = Math.round(w * 0.95) - x0;

  const on = stat(grab(), w, x0, y0, bw, bh);
  T.uniforms.uDbg3.value.x = 0;
  await g.settle(12);
  const off = stat(grab(), w, x0, y0, bw, bh);
  T.uniforms.uDbg3.value.x = 1;
  await g.settle(6);
  lines.push(`${name.padEnd(8)} rows ${y0}-${y0 + bh}\n   class on   ${on}\n   class off  ${off}`);
}
return lines.join('\n');
