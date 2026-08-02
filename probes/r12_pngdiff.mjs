// Frame-by-frame difference between two FILM runs of the same shot on two
// builds — the instrument for "what did this temporal change actually cost".
//
//   node probes/r12_pngdiff.mjs dirA dirB [x0 y0 x1 y1]
//
// `tools/shot.mjs film` advances the sim a fixed number of steps per frame and
// pins determinism once at the start, so frame f of build A and frame f of
// build B are the same simulated instant with the same camera. Anything that
// differs between them is the change under test and nothing else — which is
// what makes this able to see a one-frame-stale shadow, an artefact that no
// still frame can show and that a whole-image mean would bury.
//
// Reported per frame and in aggregate:
//   meanAbs   mean |dL| over the box, in 8-bit codes
//   p99.9     the tail — a shadow lagging behind a walking guard is a SMALL
//             number of pixels moving a LOT, so the tail is the signal and the
//             mean is not
//   pct>4     percentage of pixels moving more than 4 codes (visible on a
//             gradient, roughly the JND on flat mid-tone)
//   worstBox  the 64x64 tile with the highest mean |dL|, and where it is
import { readPNG } from './pngstat.mjs';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const [, , dirA, dirB, ...box] = process.argv;
const files = (d) => readdirSync(d).filter((f) => f.endsWith('.png')).sort();
const fa = files(dirA);
const fb = files(dirB);
const n = Math.min(fa.length, fb.length);
if (!n) throw new Error('no frames');

const lum = (im, i) => 0.2126 * im.px[i] + 0.7152 * im.px[i + 1] + 0.0722 * im.px[i + 2];

let gMean = 0;
let gWorst = null;
const rows = [];
for (let f = 0; f < n; f++) {
  const A = readPNG(path.join(dirA, fa[f]));
  const B = readPNG(path.join(dirB, fb[f]));
  const x0 = box.length ? +box[0] : 0;
  const y0 = box.length ? +box[1] : 0;
  const x1 = box.length ? +box[2] : A.w;
  const y1 = box.length ? +box[3] : A.h;
  const diffs = [];
  const TILE = 64;
  const tiles = new Map();
  let sum = 0;
  let over = 0;
  let cnt = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * A.w + x) * A.ch;
      const j = (y * B.w + x) * B.ch;
      const d = Math.abs(lum(A, i) - lum(B, j));
      sum += d;
      cnt++;
      if (d > 4) over++;
      diffs.push(d);
      const key = `${(x / TILE) | 0},${(y / TILE) | 0}`;
      const t = tiles.get(key) ?? { s: 0, c: 0 };
      t.s += d;
      t.c++;
      tiles.set(key, t);
    }
  }
  diffs.sort((a, b) => a - b);
  let worst = { key: '', m: 0 };
  for (const [k, t] of tiles) {
    const m = t.s / t.c;
    if (m > worst.m) worst = { key: k, m };
  }
  const row = {
    frame: fa[f],
    meanAbs: +(sum / cnt).toFixed(3),
    p999: +diffs[Math.floor(diffs.length * 0.999)].toFixed(1),
    max: +diffs[diffs.length - 1].toFixed(1),
    pctOver4: +((100 * over) / cnt).toFixed(3),
    worstTile: `${worst.key} @ ${worst.m.toFixed(2)}`,
  };
  rows.push(row);
  gMean += row.meanAbs;
  if (!gWorst || worst.m > gWorst.m) gWorst = { m: worst.m, key: worst.key, frame: fa[f] };
}

for (const r of rows) {
  console.log(
    `${r.frame}  mean ${String(r.meanAbs).padStart(7)}  p99.9 ${String(r.p999).padStart(6)}  ` +
      `max ${String(r.max).padStart(6)}  >4 ${String(r.pctOver4).padStart(7)}%  worst64 ${r.worstTile}`,
  );
}
console.log(
  `\nframes ${n}  meanAbs(mean) ${(gMean / n).toFixed(3)}  ` +
    `worst 64px tile ${gWorst.key} @ ${gWorst.m.toFixed(2)} on ${gWorst.frame} ` +
    `(tile origin px ${gWorst.key.split(',').map((v) => +v * 64).join(',')})`,
);
