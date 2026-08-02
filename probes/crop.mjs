// Crop + nearest-neighbour magnify a PNG, WITHOUT the render daemon.
//
//   node probes/crop.mjs in.png x y w h scale out.png
//
// `shot.mjs pix crop` does the same thing but routes through the daemon, and
// with nine authors sharing one chromium the daemon is the flakiest thing in
// the loop. Reading a shipped PNG has no reason to need a browser at all — the
// same argument that put a reader in probes/pngstat.mjs, extended to the writer.
import { writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { readPNG } from './pngstat.mjs';

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

export function writePNG(file, w, h, rgb) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy ? rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3)
             : Buffer.from(rgb.subarray(y * w * 3, (y + 1) * w * 3)).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

const [, , inFile, xs, ys, ws, hs, ss, outFile] = process.argv;
if (!outFile) {
  console.error('usage: node probes/crop.mjs in.png x y w h scale out.png');
  process.exit(1);
}
const im = readPNG(inFile);
const x0 = +xs;
const y0 = +ys;
const cw = +ws;
const chh = +hs;
const sc = +ss;
const ow = cw * sc;
const oh = chh * sc;
const out = Buffer.alloc(ow * oh * 3);
for (let y = 0; y < oh; y++) {
  const sy = Math.min(im.h - 1, y0 + ((y / sc) | 0));
  for (let x = 0; x < ow; x++) {
    const sx = Math.min(im.w - 1, x0 + ((x / sc) | 0));
    const si = (sy * im.w + sx) * im.ch;
    const di = (y * ow + x) * 3;
    out[di] = im.px[si];
    out[di + 1] = im.px[si + 1];
    out[di + 2] = im.px[si + 2];
  }
}
writePNG(outFile, ow, oh, out);
console.log(outFile, `${ow}x${oh}`);
