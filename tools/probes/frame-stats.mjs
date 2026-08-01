/**
 * Frame statistics the round-6 critique asks for: warm/cool pixel fractions,
 * the modal dark triple, mean luminance, and a named-region sampler.
 *
 * Self-contained PNG decode (8-bit RGB/RGBA, no interlace) so it needs no dep.
 *   node tools/probes/frame-stats.mjs a.png b.png [--rect name,x,y,w,h ...]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePNG(file) {
  const buf = fs.readFileSync(file);
  let off = 8;
  let w = 0, h = 0, depth = 0, ctype = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9];
      if (depth !== 8 || (ctype !== 2 && ctype !== 6)) throw new Error(`unsupported PNG ${depth}/${ctype}`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = ctype === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * bpp);
  const stride = w * bpp;
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const row = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

const files = [];
const rects = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--rect') {
    const [name, x, y, rw, rh] = argv[++i].split(',');
    rects.push({ name, x: +x, y: +y, w: +rw, h: +rh });
  } else files.push(argv[i]);
}

for (const f of files) {
  const im = decodePNG(f);
  const { w, h, bpp, data } = im;
  const n = w * h;
  let cool = 0, warm = 0, sumL = 0;
  const modal = new Map();
  for (let i = 0; i < n; i++) {
    const r = data[i * bpp], g = data[i * bpp + 1], b = data[i * bpp + 2];
    if (b > r + 4) cool++;
    if (r > b + 10) warm++;
    sumL += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const k = `${r},${g},${b}`;
    modal.set(k, (modal.get(k) ?? 0) + 1);
  }
  const top = [...modal.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `(${k}) ${(100 * v / n).toFixed(2)}%`);
  console.log(
    `${f}\n  cool B>R+4 ${(100 * cool / n).toFixed(2)}%   warm R>B+10 ${(100 * warm / n).toFixed(2)}%` +
    `   meanL ${(sumL / n / 255).toFixed(4)}   modal ${top.join(' | ')}`,
  );
  for (const rc of rects) {
    let R = 0, G = 0, B = 0, c = 0;
    for (let y = rc.y; y < Math.min(h, rc.y + rc.h); y++)
      for (let x = rc.x; x < Math.min(w, rc.x + rc.w); x++) {
        const i = (y * w + x) * bpp;
        R += data[i]; G += data[i + 1]; B += data[i + 2]; c++;
      }
    R /= c; G /= c; B /= c;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    console.log(
      `    ${rc.name.padEnd(10)} rgb ${R.toFixed(1)}/${G.toFixed(1)}/${B.toFixed(1)}` +
      `  L ${((0.2126 * R + 0.7152 * G + 0.0722 * B) / 255).toFixed(4)}` +
      `  sat ${(mx > 0 ? (mx - mn) / mx : 0).toFixed(3)}  B-R ${(B - R).toFixed(1)}`,
    );
  }
}
