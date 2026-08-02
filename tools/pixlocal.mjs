#!/usr/bin/env node
/**
 * pixlocal.mjs — crop / stat a rendered PNG without the render daemon.
 *
 * `shot.mjs pix` does its image work inside the daemon's chromium, which means
 * that when the shared browser dies you cannot even look at frames you have
 * already rendered. Reading a PNG is zlib and a per-row filter; it does not
 * need a GPU. Only what the harness actually emits is supported: 8-bit
 * non-interlaced RGB or RGBA.
 *
 *   node tools/pixlocal.mjs crop in.png x y w h scale out.png
 *   node tools/pixlocal.mjs stats a.png [b.png ...]
 *   node tools/pixlocal.mjs region in.png x y w h     # mean RGB over a box
 */
import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

function decode(file) {
  const buf = readFileSync(file);
  let off = 8;
  let w = 0;
  let h = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`unsupported PNG: depth ${bitDepth} colorType ${colorType}`);
      }
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * bpp);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const row = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
  }
  return { w, h, bpp, data: out };
}

function encode(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let TBL = null;
function crc32(buf) {
  if (!TBL) {
    TBL = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TBL[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TBL[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const [op, ...rest] = process.argv.slice(2);
if (op === 'crop') {
  const [file, x, y, w, h, s, out] = rest;
  // Validate before allocating. Called with the arguments in the wrong order —
  // easy, because `out` is LAST here and first in most tools — `s` parses as
  // NaN, `Buffer.alloc(NaN)` succeeds with length 0, the loops run to NaN and
  // do nothing, and the only symptom is an unrelated fs error about an
  // undefined path several seconds later. Twice. Say what is wrong instead.
  const nums = { x, y, w, h, s };
  const bad = Object.entries(nums).filter(([, v]) => !Number.isFinite(+v));
  if (!file || !out || bad.length) {
    console.error('usage: pixlocal.mjs crop <file> <x> <y> <w> <h> <scale> <out.png>');
    if (bad.length) console.error(`  not a number: ${bad.map(([k, v]) => `${k}=${v}`).join(' ')}`);
    if (!out) console.error('  missing <out.png> — it is the LAST argument, after the scale');
    process.exit(1);
  }
  const img = decode(file);
  const X = +x;
  const Y = +y;
  const W = +w;
  const H = +h;
  const S = +s;
  const dst = Buffer.alloc(W * S * H * S * 3);
  for (let j = 0; j < H * S; j++) {
    for (let i = 0; i < W * S; i++) {
      const sx = Math.min(img.w - 1, X + Math.floor(i / S));
      const sy = Math.min(img.h - 1, Y + Math.floor(j / S));
      const si = (sy * img.w + sx) * img.bpp;
      const di = (j * W * S + i) * 3;
      dst[di] = img.data[si];
      dst[di + 1] = img.data[si + 1];
      dst[di + 2] = img.data[si + 2];
    }
  }
  writeFileSync(out, encode(W * S, H * S, dst));
  console.log(out);
} else if (op === 'stats' || op === 'region') {
  const files = op === 'stats' ? rest : [rest[0]];
  const box = op === 'region' ? rest.slice(1).map(Number) : null;
  for (const f of files) {
    const img = decode(f);
    const x0 = box ? box[0] : 0;
    const y0 = box ? box[1] : 0;
    const x1 = box ? box[0] + box[2] : img.w;
    const y1 = box ? box[1] + box[3] : img.h;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * img.w + x) * img.bpp;
        r += img.data[i];
        g += img.data[i + 1];
        b += img.data[i + 2];
        n++;
      }
    }
    console.log(
      `${f} ${img.w}x${img.h} R=${(r / n).toFixed(1)} G=${(g / n).toFixed(1)} ` +
        `B=${(b / n).toFixed(1)} R-B=${((r - b) / n).toFixed(1)}`,
    );
  }
} else {
  console.error('usage: pixlocal.mjs crop|stats|region ...');
  process.exit(1);
}
