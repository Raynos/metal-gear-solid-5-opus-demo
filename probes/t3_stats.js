/**
 * Ground-band surface statistics, restricted to the pixels the TERRAIN owns.
 *
 *   bash <scratch>/t3_probe.sh probes/t3_stats.js
 *
 * The reviewer's numbers were taken over a whole band, which on the ground shot
 * is only ~55% terrain — so a terrain change measured that way is diluted by
 * whatever the outpost and the rocks are doing. This masks the band by hiding
 * the terrain mesh and keeping the pixels that changed, then reports, over that
 * mask only:
 *
 *   mean L*, sd L*, the fraction above L* 85 and 75 (the bleached-highlight
 *   measurement), mean saturation, and the high-pass RMS at 2/8/32 px as a
 *   percentage of the local mean (the local-contrast measurement).
 *
 * Reference values over the same statistic on the whole band of mgi-8/mgi-9:
 *   L* sd 18.4 / 24.1,  L*>85 0.123 / 0.044,  hp2 7.4% / 4.0%,
 *   hp8 12.9% / 11.7%,  hp32 18.9% / 20.8%.
 * Ours before this round: L* sd 4.98, L*>85 0.0000, hp2 1.98%, hp8 3.51%,
 * hp32 5.47%.
 */
const g = window.__GAME;
const W = g.world;
const eng = W.engine;

const SHOTS = ['ground', 'vista', 'gameplay'];
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
  const y0 = Math.round(h * 0.72);
  const y1 = Math.round(h * 0.98);
  const x0 = Math.round(w * 0.08);
  const x1 = Math.round(w * 0.92);

  const base = grab();
  W.terrain.mesh.visible = false;
  await g.settle(10);
  const off = grab();
  W.terrain.mesh.visible = true;
  await g.settle(10);

  // Mask and per-pixel grey, over the band only.
  const bw = x1 - x0;
  const bh = y1 - y0;
  const mask = new Uint8Array(bw * bh);
  const grey = new Float64Array(bw * bh);
  const ls = [];
  let sat = 0;
  let n = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = ((y + y0) * w + (x + x0)) * 4;
      const r = base[i];
      const gg = base[i + 1];
      const b = base[i + 2];
      grey[y * bw + x] = (r + gg + b) / 3;
      const d = Math.abs(r - off[i]) + Math.abs(gg - off[i + 1]) + Math.abs(b - off[i + 2]);
      if (d <= 8) continue;
      mask[y * bw + x] = 1;
      n++;
      ls.push(lstar(0.2126 * LIN[r] + 0.7152 * LIN[gg] + 0.0722 * LIN[b]));
      const mx = Math.max(r, gg, b);
      sat += mx ? (mx - Math.min(r, gg, b)) / mx : 0;
    }
  }
  if (n < 500) { lines.push(`${name}: only ${n} terrain px in band`); continue; }
  const mean = ls.reduce((a, v) => a + v, 0) / n;
  const sd = Math.sqrt(ls.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
  const hi85 = ls.filter((v) => v > 85).length / n;
  const hi75 = ls.filter((v) => v > 75).length / n;

  // High-pass RMS over the masked pixels, box radius r, using the full band as
  // the local mean so the mask edge does not manufacture contrast.
  const gmean = (() => { let s = 0; for (let i = 0; i < bw * bh; i++) if (mask[i]) s += grey[i]; return s / n; })();
  const hp = [];
  for (const r of [2, 8, 32]) {
    let s2 = 0;
    let k = 0;
    for (let y = r; y < bh - r; y++) {
      for (let x = r; x < bw - r; x++) {
        if (!mask[y * bw + x]) continue;
        let s = 0;
        let c2 = 0;
        for (let j = -r; j <= r; j += Math.max(1, r >> 2)) {
          for (let i = -r; i <= r; i += Math.max(1, r >> 2)) {
            s += grey[(y + j) * bw + (x + i)];
            c2++;
          }
        }
        const d = grey[y * bw + x] - s / c2;
        s2 += d * d;
        k++;
      }
    }
    hp.push((Math.sqrt(s2 / Math.max(1, k)) / gmean * 100).toFixed(2));
  }
  lines.push(`${name.padEnd(9)} n=${n}  L* ${mean.toFixed(1)} sd ${sd.toFixed(2)}`
    + `  >85 ${hi85.toFixed(4)}  >75 ${hi75.toFixed(4)}  sat ${(sat / n).toFixed(3)}`
    + `  hp2 ${hp[0]}%  hp8 ${hp[1]}%  hp32 ${hp[2]}%`);
}

lines.push(JSON.stringify(g.probeLuminance ? g.probeLuminance() : null));
return lines.join('\n');
