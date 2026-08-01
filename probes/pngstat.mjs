// Minimal PNG (8-bit RGB/RGBA, non-interlaced) reader + region statistics.
// Exists so a measurement of a shipped frame does not depend on the render
// daemon being healthy — round 7 lost half an hour to another author's broken
// build while trying to read a PNG.
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

export function readPNG(file) {
  const buf = readFileSync(file);
  let p = 8;
  let w = 0, h = 0, ch = 0, bitDepth = 8;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8];
      const ct = data[9];
      ch = ct === 2 ? 3 : ct === 6 ? 4 : ct === 0 ? 1 : ct === 4 ? 2 : 0;
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bitDepth !== 8 || !ch) throw new Error(`unsupported PNG (depth ${bitDepth}, ch ${ch})`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = new Uint8Array(w * h * ch);
  let q = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[q++];
    const row = raw.subarray(q, q + stride); q += stride;
    const o = y * stride;
    const pr = o - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[o + x - ch] : 0;
      const b = y > 0 ? out[pr + x] : 0;
      const c = x >= ch && y > 0 ? out[pr + x - ch] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[o + x] = v & 255;
    }
  }
  return { w, h, ch, px: out };
}

const L = (im, i) => 0.2126 * im.px[i] + 0.7152 * im.px[i + 1] + 0.0722 * im.px[i + 2];

/** Mean/std of display luminance over a box, plus 11x11 high-pass RMS. */
export function region(im, x0, y0, x1, y1) {
  const w = x1 - x0, h = y1 - y0;
  const p = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    p[y * w + x] = L(im, ((y0 + y) * im.w + x0 + x) * im.ch);
  }
  let s = 0, s2 = 0;
  for (const v of p) { s += v; s2 += v * v; }
  const n = w * h, mean = s / n;
  const std = Math.sqrt(Math.max(0, s2 / n - mean * mean));
  // high pass against an 11x11 box mean
  const R = 5;
  let hs = 0, hs2 = 0, hn = 0;
  for (let y = R; y < h - R; y++) for (let x = R; x < w - R; x++) {
    let a = 0;
    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) a += p[(y + j) * w + x + i];
    const d = p[y * w + x] - a / ((2 * R + 1) * (2 * R + 1));
    hs += d; hs2 += d * d; hn++;
  }
  const hm = hs / hn;
  const hp = Math.sqrt(Math.max(0, hs2 / hn - hm * hm));
  return {
    mean: +mean.toFixed(2), meanNorm: +(mean / 255).toFixed(4),
    std: +std.toFixed(3), relPct: +((100 * std) / mean).toFixed(2),
    hpRms: +hp.toFixed(3), hpPct: +((100 * hp) / mean).toFixed(2),
  };
}

if (process.argv[1] && process.argv[1].endsWith('pngstat.mjs')) {
  const [file, ...rest] = process.argv.slice(2);
  const im = readPNG(file);
  const boxes = [];
  for (let i = 0; i + 3 < rest.length; i += 4) boxes.push(rest.slice(i, i + 4).map(Number));
  if (!boxes.length) boxes.push([0, 0, im.w, im.h]);
  console.log(JSON.stringify({ file, w: im.w, h: im.h, boxes: boxes.map((b) => ({ b, ...region(im, ...b) })) }, null, 1));
}
