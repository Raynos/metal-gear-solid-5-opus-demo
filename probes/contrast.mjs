// Multiscale local contrast over a box, daemon-free.
//
//   node probes/contrast.mjs img.png x0 y0 x1 y1 [label]
//
// Reports, per box-filter scale, the RMS of (L - blur_s(L)) as a percentage of
// the box's mean luminance. That is the same "local contrast at every scale
// 2-64 px" the round-8 critique measured the ground band with, so numbers from
// this tool are directly comparable to the ones in that report.
import { readPNG } from './pngstat.mjs';

const [, , file, a, b, c, d, label] = process.argv;
const im = readPNG(file);
const x0 = Math.max(0, +a);
const y0 = Math.max(0, +b);
const x1 = Math.min(im.w, +c);
const y1 = Math.min(im.h, +d);
const w = x1 - x0;
const h = y1 - y0;

const L = new Float64Array(w * h);
let mean = 0;
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = ((y + y0) * im.w + (x + x0)) * im.ch;
    const l = 0.2126 * im.px[i] + 0.7152 * im.px[i + 1] + 0.0722 * im.px[i + 2];
    L[y * w + x] = l;
    mean += l;
  }
}
mean /= w * h;

// Separable box blur via a prefix sum, so every scale is O(pixels).
const sum = new Float64Array((w + 1) * (h + 1));
for (let y = 0; y < h; y++) {
  let row = 0;
  for (let x = 0; x < w; x++) {
    row += L[y * w + x];
    sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row;
  }
}
const boxMean = (bx0, by0, bx1, by1) => {
  const area = (bx1 - bx0) * (by1 - by0);
  return (
    (sum[by1 * (w + 1) + bx1] - sum[by0 * (w + 1) + bx1] - sum[by1 * (w + 1) + bx0] + sum[by0 * (w + 1) + bx0]) /
    area
  );
};

const out = { file, label: label || '', box: `${x0},${y0}-${x1},${y1}`, meanL: +mean.toFixed(2), rmsPct: {} };
for (const s of [2, 4, 8, 16, 32, 64]) {
  const r = s >> 1;
  let acc = 0;
  let n = 0;
  for (let y = r; y < h - r; y++) {
    for (let x = r; x < w - r; x++) {
      const m = boxMean(x - r, y - r, x + r, y + r);
      const e = L[y * w + x] - m;
      acc += e * e;
      n++;
    }
  }
  out.rmsPct[s] = n ? +((Math.sqrt(acc / n) / mean) * 100).toFixed(2) : null;
}
// Darkest 2% vs brightest 2%: how much contact-scale RANGE the box carries.
const s2 = Array.from(L).sort((p, q) => p - q);
out.p2 = +s2[Math.floor(s2.length * 0.02)].toFixed(1);
out.p50 = +s2[Math.floor(s2.length * 0.5)].toFixed(1);
out.p98 = +s2[Math.floor(s2.length * 0.98)].toFixed(1);
console.log(JSON.stringify(out));
