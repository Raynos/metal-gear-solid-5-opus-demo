/**
 * r12_hillshade.js — draw the far heightfield's own hillshade and look at it.
 *
 * Four rebuilds have now failed to move the mountain herringbone: crags off,
 * `_smoothFlats` slope gate removed, the strata bench snap off, and the ENTIRE
 * simulation stack off (thermal, hydraulic, incision, strata, crags, relax,
 * smooth). It survives all four, and it survives uPerf.x, which bypasses the
 * whole terrain fragment body. So it is either in `_base` itself or in the way
 * the surface is sampled for drawing — and no amount of ablating the erosion
 * can tell those apart.
 *
 * This renders the truth: a Lambert hillshade of `far.h` straight out of the
 * array, at one array cell per pixel, next to the SAME window resampled at the
 * spacings the outer clipmap rings actually use. If the herringbone is in the
 * first image it is the base field; if it only appears in the resampled ones it
 * is the ring lattice beating against the 8 m grid, which no terrain edit can
 * fix and which every erosion ablation would leave untouched — exactly what has
 * been observed.
 *
 * Returned as data URLs; the caller writes them out and looks at them.
 */
const g = window.__GAME;
const t = g.world?.terrain ?? g.terrain;
const far = t.far;
const n = far.n, cell = far.cell, h = far.h;

const WIN = 256;
function slopeAt(i, j) {
  const c = j * n + i;
  return Math.hypot(h[c + 1] - h[c - 1], h[c + n] - h[c - n]) / (2 * cell);
}
let best = null;
for (let j = WIN; j < n - WIN; j += 64) {
  for (let i = WIN; i < n - WIN; i += 64) {
    let s = 0, k = 0;
    for (let b = 0; b < WIN; b += 16) for (let a = 0; a < WIN; a += 16) { s += slopeAt(i + a, j + b); k++; }
    const v = s / k;
    if (!best || v > best.v) best = { i, j, v };
  }
}

// Sun from the upper left at 35 deg, the classic hillshade rig.
const SX = -0.57, SY = 0.70, SZ = -0.43;
function shade(sample, step) {
  const c = document.createElement('canvas');
  c.width = WIN; c.height = WIN;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(WIN, WIN);
  for (let b = 1; b < WIN - 1; b++) {
    for (let a = 1; a < WIN - 1; a++) {
      const dx = (sample(a + 1, b) - sample(a - 1, b)) / (2 * cell);
      const dz = (sample(a, b + 1) - sample(a, b - 1)) / (2 * cell);
      const inv = 1 / Math.hypot(dx, 1, dz);
      const nx = -dx * inv, ny = inv, nz = -dz * inv;
      const l = Math.max(0, nx * SX + ny * SY + nz * SZ);
      const v = Math.round(Math.min(255, 40 + l * 255));
      const o = (b * WIN + a) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

const i0 = best.i, j0 = best.j;
const raw = (a, b) => h[(j0 + b) * n + (i0 + a)];
// Bilinear resample of the same window on a lattice of `step` cells, which is
// what a clipmap ring does when its vertex spacing is coarser than the grid.
function ringSampler(step) {
  return (a, b) => {
    const fa = Math.floor(a / step) * step, fb = Math.floor(b / step) * step;
    const ta = (a - fa) / step, tb = (b - fb) / step;
    const A = Math.min(fa + step, WIN - 1), B = Math.min(fb + step, WIN - 1);
    const h00 = raw(fa, fb), h10 = raw(A, fb), h01 = raw(fa, B), h11 = raw(A, B);
    return (h00 * (1 - ta) + h10 * ta) * (1 - tb) + (h01 * (1 - ta) + h11 * ta) * tb;
  };
}
return {
  windowCentreM: [Math.round(far.origin + (i0 + WIN / 2) * cell), Math.round(far.origin + (j0 + WIN / 2) * cell)],
  meanSlopeDeg: +((Math.atan(best.v) * 180) / Math.PI).toFixed(1),
  cellM: cell,
  raw: shade(raw, 1),
  ring2: shade(ringSampler(2), 2),
  ring4: shade(ringSampler(4), 4),
  ring8: shade(ringSampler(8), 8),
};
