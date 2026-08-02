/**
 * Commander-vs-guard legibility at range, measured off the geometry.
 *
 *   node probes/r8c/legibility-node.mjs
 *
 * Rasterises each built variant's bind-pose geometry into an orthographic
 * front-view mask at a given screen height and reports the two things that
 * decide whether two figures can be told apart at 60 m: the outline, and the
 * value. No GL context — the projection is orthographic and the fill is a
 * per-triangle scanline, which is all a silhouette is.
 *
 * The pixel scale is the real one: a 45-degree vertical lens on a 1080p frame
 * puts a 1.86 m figure at 1080 * 1.86 / (2 * D * tan(22.5)) px tall, i.e. 40 px
 * at 60 m. Everything is quoted at that height, because a legibility claim that
 * is not quoted at a distance is not a claim.
 */
import * as THREE from 'three';
import { buildCharacterGeometry } from '../../src/characters/character.js';
import { Z } from '../../src/characters/materials.js';

const GUARD = {
  name: 'grunt', bulk: 1.0, sleeves: 'full', headgear: 'helmet',
  vest: true, kneepads: true, beltPouches: [-0.12, 0.1],
};
const COMMANDER = {
  name: 'commander', bulk: 1.06, sleeves: 'full', headgear: 'peaked', hair: true,
  coat: true, vest: true, holster: true, kneepads: false, grenades: false,
  optic: false, slung: 'bare', cargoPockets: false, beltPouches: [-0.1, 0.1],
  head: { jawWidth: 0.88 },
};

const H_PX = 40;                                 // figure height at 60 m, 1080p, 45 deg
const pxPerM = (d) => (1080 * 1.0) / (2 * d * Math.tan((22.5 * Math.PI) / 180));

/** Orthographic front-view coverage mask, `rows` tall, over the geometry bbox. */
function mask(geo, rows, scale = 1) {
  const pos = geo.attributes.position;
  const idx = geo.index.array;
  const bb = new THREE.Box3().setFromBufferAttribute(pos);
  const hM = (bb.max.y - bb.min.y) * scale;
  const wM = (bb.max.x - bb.min.x) * scale;
  const cols = Math.max(1, Math.round((wM / hM) * rows));
  // Supersample 6x so a 25 mm strap is not quantised out of existence before
  // the downsample that is the whole point of the test.
  const S = 6;
  const R = rows * S, C = cols * S;
  const hit = new Uint8Array(R * C);
  const toC = (x) => ((x * scale - bb.min.x * scale) / wM) * (C - 1);
  const toR = (y) => (1 - (y * scale - bb.min.y * scale) / hM) * (R - 1);
  const ax = [0, 0, 0], ay = [0, 0, 0];
  for (let t = 0; t < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const i = idx[t + k];
      ax[k] = toC(pos.getX(i));
      ay[k] = toR(pos.getY(i));
    }
    const r0 = Math.max(0, Math.floor(Math.min(ay[0], ay[1], ay[2])));
    const r1 = Math.min(R - 1, Math.ceil(Math.max(ay[0], ay[1], ay[2])));
    const c0 = Math.max(0, Math.floor(Math.min(ax[0], ax[1], ax[2])));
    const c1 = Math.min(C - 1, Math.ceil(Math.max(ax[0], ax[1], ax[2])));
    const d = (ay[1] - ay[2]) * (ax[0] - ax[2]) + (ax[2] - ax[1]) * (ay[0] - ay[2]);
    if (Math.abs(d) < 1e-9) continue;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const l0 = ((ay[1] - ay[2]) * (c - ax[2]) + (ax[2] - ax[1]) * (r - ay[2])) / d;
      const l1 = ((ay[2] - ay[0]) * (c - ax[2]) + (ax[0] - ax[2]) * (r - ay[2])) / d;
      const l2 = 1 - l0 - l1;
      if (l0 >= -0.001 && l1 >= -0.001 && l2 >= -0.001) hit[r * C + c] = 1;
    }
  }
  const cov = new Float32Array(rows * cols);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    let n = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      if (hit[(y * S + sy) * C + x * S + sx]) n++;
    }
    cov[y * cols + x] = n / (S * S);
  }
  return { cov, cols, rows, heightM: hM, widthM: wM };
}
const art = (m) => {
  let s = '';
  for (let y = 0; y < m.rows; y++) {
    for (let x = 0; x < m.cols; x++) {
      const f = m.cov[y * m.cols + x];
      s += f > 0.6 ? '#' : f > 0.25 ? '+' : f > 0.05 ? '.' : ' ';
    }
    s += '\n';
  }
  return s;
};
/** Widest filled run per row, in cells — the outline width, not the extent. */
function widths(m) {
  const w = [];
  for (let y = 0; y < m.rows; y++) {
    let run = 0, best = 0;
    for (let x = 0; x < m.cols; x++) {
      if (m.cov[y * m.cols + x] > 0.25) { run++; if (run > best) best = run; } else run = 0;
    }
    w.push(best);
  }
  return w;
}

const g = buildCharacterGeometry(GUARD);
const c = buildCharacterGeometry(COMMANDER);
const mg = mask(g.geometry, H_PX, 1.0);
const mc = mask(c.geometry, H_PX, 1.06);
const wg = widths(mg), wc = widths(mc);
// The band that matters is the coat's own span: y 0.95 m (waist) down to
// y 0.66 m (hem). Converted to rows on each figure's OWN grid, because the two
// figures are not the same height and a fixed row range would compare the
// commander's coat against the guard's knee.
function bandFor(m, w, y0, y1, scale) {
  const bb = { hi: m.heightM };
  const row = (y) => Math.round((1 - (y * scale) / bb.hi) * (m.rows - 1));
  const a = row(y1), b = row(y0);
  const sl = w.slice(a, b + 1);
  return +(sl.reduce((p, q) => p + q, 0) / sl.length).toFixed(2);
}

// Value: mean linear luminance of the two palettes, area-weighted by nothing
// (the garment zones dominate both figures).
const LUM = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
const garrison = { [Z.JACKET]: [0.239, 0.220, 0.120], [Z.TROUSER]: [0.221, 0.203, 0.111], [Z.VEST]: [0.148, 0.133, 0.076] };
const cmd = { [Z.JACKET]: [0.108, 0.104, 0.057], [Z.TROUSER]: [0.098, 0.094, 0.052], [Z.VEST]: [0.085, 0.082, 0.045] };
const meanL = (p) => Object.values(p).reduce((a, v) => a + LUM(v), 0) / Object.values(p).length;

// Silhouette disagreement, commander's grid.
let diff = 0, tot = 0;
for (let y = 0; y < H_PX; y++) for (let x = 0; x < mc.cols; x++) {
  const gx = Math.min(mg.cols - 1, Math.round((x / mc.cols) * mg.cols));
  const a = mc.cov[y * mc.cols + x] > 0.25 ? 1 : 0;
  const b = mg.cov[y * mg.cols + gx] > 0.25 ? 1 : 0;
  tot++; if (a !== b) diff++;
}

console.log(JSON.stringify({
  test: 'commander vs patrol guard, bind pose, front view, 40 px tall',
  pxPerMetreAt60m: +pxPerM(60).toFixed(1),
  figureHeightPxAt60m: +(pxPerM(60) * 1.86).toFixed(1),
  bandMetres: [0.66, 0.95],
  guard: { heightM: +mg.heightM.toFixed(3), maxWidthCells: Math.max(...wg), bandCells: bandFor(mg, wg, 0.66, 0.95, 1.0) },
  commander: { heightM: +mc.heightM.toFixed(3), maxWidthCells: Math.max(...wc), bandCells: bandFor(mc, wc, 0.66, 0.95, 1.06) },
  bandWidthRatio: +(bandFor(mc, wc, 0.66, 0.95, 1.06) / bandFor(mg, wg, 0.66, 0.95, 1.0)).toFixed(2),
  overallHeightRatio: +(mc.heightM / mg.heightM).toFixed(3),
  silhouetteDisagreementPct: +((diff / tot) * 100).toFixed(1),
  valueStopsGuardOverCommander: +Math.log2(meanL(garrison) / meanL(cmd)).toFixed(2),
  guardArt: art(mg),
  commanderArt: art(mc),
}, null, 2));
