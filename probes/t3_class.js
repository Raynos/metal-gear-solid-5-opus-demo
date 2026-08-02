/**
 * Soil-class coverage, as a pixel count rather than an opinion.
 *
 *   bash <scratch>/t3_probe.sh probes/t3_class.js
 *
 * uDbg3.z paints each ground fragment with its class as a flat primary; this
 * counts them per shot. Also reports the same band statistics higher up the
 * frame than probes/t3_stats.js, because the bottom quarter of the ground shot
 * is inside the depth-of-field blur and a high-pass measured there is measuring
 * the blur kernel.
 */
const g = window.__GAME;
const W = g.world;
const eng = W.engine;
const T = W.terrain;

const SHOTS = ['ground', 'vista', 'gameplay', 'outpost'];
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

const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const lstar = (y) => (y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y);

for (const name of SHOTS) {
  await g.applyShot(name);
  await g.settle(14);
  const c = eng.renderer.domElement;
  const w = c.width;
  const h = c.height;

  // Whole ground half of the frame, not just the near band.
  const y0 = Math.round(h * 0.50);
  const y1 = Math.round(h * 0.98);
  const x0 = Math.round(w * 0.05);
  const x1 = Math.round(w * 0.95);

  const base = grab();
  T.uniforms.uDbg3.value.z = 1;
  await g.settle(8);
  const cls = grab();
  T.uniforms.uDbg3.value.z = 0;
  await g.settle(8);

  const cnt = [0, 0, 0, 0];
  let n = 0;
  const ls = [];
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * w + x) * 4;
      const r = cls[i];
      const gg = cls[i + 1];
      const b = cls[i + 2];
      // Only pixels the class pass actually painted are terrain ground.
      const s = r + gg + b;
      if (s < 40) continue;
      n++;
      if (b > r * 0.8 && b > gg) cnt[2]++;            // blue  -> C
      else if (r > 100 && gg < r * 0.45) cnt[3]++;    // red   -> D
      else if (gg > r * 0.92) cnt[0]++;               // white -> A
      else cnt[1]++;                                  // yellow-> B
      const j = i;
      ls.push(lstar(0.2126 * LIN[base[j]] + 0.7152 * LIN[base[j + 1]] + 0.0722 * LIN[base[j + 2]]));
    }
  }
  if (!n) { lines.push(`${name}: no ground`); continue; }
  const mean = ls.reduce((a, v) => a + v, 0) / ls.length;
  const sd = Math.sqrt(ls.reduce((a, v) => a + (v - mean) ** 2, 0) / ls.length);
  lines.push(`${name.padEnd(9)} n=${n}  A ${(cnt[0] / n).toFixed(3)}  B ${(cnt[1] / n).toFixed(3)}`
    + `  C ${(cnt[2] / n).toFixed(3)}  D ${(cnt[3] / n).toFixed(3)}`
    + `   L* ${mean.toFixed(1)} sd ${sd.toFixed(2)}`
    + `  >85 ${(ls.filter((v) => v > 85).length / ls.length).toFixed(4)}`
    + `  >75 ${(ls.filter((v) => v > 75).length / ls.length).toFixed(4)}`);
}

return lines.join('\n');
