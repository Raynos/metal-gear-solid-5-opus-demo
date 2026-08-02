/**
 * r12_hfspec.js — the mountain herringbone, measured in the HEIGHTFIELD, in
 * metres and degrees.
 *
 * Established already: it is not the crags (ablating `_addCrags` to zero
 * amplitude leaves it), it is not `_smoothFlats`' slope gate (removing the gate
 * entirely leaves it), and it is not the fragment shader (uPerf.x bypasses the
 * whole custom body and the frame's spectral peak does not move). So it is in
 * `far.h`, and the question is at what wavelength and along what axis — because
 * a 4-pass Laplacian only removes things near the grid cell, and a fix aimed at
 * the wrong band will do nothing, which is exactly what the last two rebuilds
 * demonstrated.
 *
 * Windows are taken on the steepest ground in the far grid, detrended against a
 * least-squares plane (a slope is not a defect) and Hann-windowed, then scanned
 * over direction and wavelength directly. A full 2-D DFT of a 128^2 window is
 * 2.7e8 complex terms; a directional scan is 1e7 and answers the same question.
 */
const g = window.__GAME;
const t = g.world?.terrain ?? g.terrain;
const far = t.far;
const n = far.n, cell = far.cell, h = far.h, origin = far.origin;

const WIN = 128;              // 1024 m window
function slopeAt(i, j) {
  const c = j * n + i;
  return Math.hypot(h[c + 1] - h[c - 1], h[c + n] - h[c - n]) / (2 * cell);
}

// Pick the steepest non-overlapping windows.
const cand = [];
for (let j = WIN; j < n - WIN; j += WIN) {
  for (let i = WIN; i < n - WIN; i += WIN) {
    let s = 0, k = 0;
    for (let b = 0; b < WIN; b += 8) for (let a = 0; a < WIN; a += 8) { s += slopeAt(i + a, j + b); k++; }
    cand.push({ i, j, slope: s / k });
  }
}
cand.sort((a, b) => b.slope - a.slope);

function analyse(w) {
  const { i: i0, j: j0 } = w;
  const m = new Float64Array(WIN * WIN);
  // Least-squares plane, then remove it: the landform is not the defect.
  let sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, N = WIN * WIN;
  for (let b = 0; b < WIN; b++) for (let a = 0; a < WIN; a++) {
    const v = h[(j0 + b) * n + (i0 + a)];
    sx += a; sy += b; sz += v; sxx += a * a; syy += b * b; sxy += a * b; sxz += a * v; syz += b * v;
  }
  const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, N]];
  const B = [sxz, syz, sz];
  // 3x3 solve by elimination.
  for (let p = 0; p < 3; p++) {
    let piv = p;
    for (let q = p + 1; q < 3; q++) if (Math.abs(A[q][p]) > Math.abs(A[piv][p])) piv = q;
    [A[p], A[piv]] = [A[piv], A[p]]; [B[p], B[piv]] = [B[piv], B[p]];
    for (let q = p + 1; q < 3; q++) {
      const f = A[q][p] / A[p][p];
      for (let r = p; r < 3; r++) A[q][r] -= f * A[p][r];
      B[q] -= f * B[p];
    }
  }
  const co = [0, 0, 0];
  for (let p = 2; p >= 0; p--) { let s = B[p]; for (let r = p + 1; r < 3; r++) s -= A[p][r] * co[r]; co[p] = s / A[p][p]; }
  const de = new Float64Array(WIN * WIN);
  for (let b = 0; b < WIN; b++) for (let a = 0; a < WIN; a++) {
    de[b * WIN + a] = h[(j0 + b) * n + (i0 + a)] - (co[0] * a + co[1] * b + co[2]);
  }
  // A plane is not enough. The residual landform is 90 m rms and its longest
  // in-window wavelength swamps everything: the first run of this probe put the
  // peak at 502 m in every window and every direction, which is the massif, not
  // a defect. Boxcar high-pass at 12 cells (96 m) so what is left is the band a
  // herringbone can live in.
  const R = 6;
  const hp = new Float64Array(WIN * WIN);
  const tmp = new Float64Array(WIN * WIN);
  for (let b = 0; b < WIN; b++) for (let a = 0; a < WIN; a++) {
    let s = 0, c = 0;
    for (let k = -R; k <= R; k++) { const x = a + k; if (x >= 0 && x < WIN) { s += de[b * WIN + x]; c++; } }
    tmp[b * WIN + a] = s / c;
  }
  for (let b = 0; b < WIN; b++) for (let a = 0; a < WIN; a++) {
    let s = 0, c = 0;
    for (let k = -R; k <= R; k++) { const y = b + k; if (y >= 0 && y < WIN) { s += tmp[y * WIN + a]; c++; } }
    hp[b * WIN + a] = de[b * WIN + a] - s / c;
  }
  let rms = 0;
  for (let b = 0; b < WIN; b++) for (let a = 0; a < WIN; a++) {
    const wn = (0.5 - 0.5 * Math.cos((2 * Math.PI * a) / (WIN - 1))) * (0.5 - 0.5 * Math.cos((2 * Math.PI * b) / (WIN - 1)));
    m[b * WIN + a] = hp[b * WIN + a] * wn;
    rms += hp[b * WIN + a] * hp[b * WIN + a];
  }
  rms = Math.sqrt(rms / N);

  const peaks = [];
  for (let d = 0; d < 18; d++) {
    const th = (d * Math.PI) / 18;
    const ux = Math.cos(th) / cell, uz = Math.sin(th) / cell;
    for (let lam = 16; lam <= 200; lam *= 1.06) {
      const k = (2 * Math.PI) / lam;
      let re = 0, im = 0;
      for (let b = 0; b < WIN; b++) for (let a = 0; a < WIN; a++) {
        const ph = k * (a * ux * cell * cell + b * uz * cell * cell);
        const v = m[b * WIN + a];
        re += v * Math.cos(ph); im += v * Math.sin(ph);
      }
      peaks.push([+(d * 10), +lam.toFixed(1), (2 * Math.hypot(re, im)) / N]);
    }
  }
  peaks.sort((a, b) => b[2] - a[2]);
  return {
    centreM: [Math.round(origin + (i0 + WIN / 2) * cell), Math.round(origin + (j0 + WIN / 2) * cell)],
    meanSlopeDeg: +((Math.atan(w.slope) * 180) / Math.PI).toFixed(1),
    highPassRmsM: +rms.toFixed(3),
    top: peaks.slice(0, 6).map(([deg, lam, amp]) => ({ dirDeg: deg, lambdaM: lam, ampM: +amp.toFixed(3) })),
  };
}

return {
  farGrid: { n, cellM: cell, sizeM: n * cell },
  windows: cand.slice(0, 4).map(analyse),
};
