// Per-material surface statistics, measured on the pixels that material
// actually rasterises.
//
// For each named outpost material: render the shot, hide every mesh that uses
// it, render again, and treat the pixels that changed as that material's own.
// Then report over exactly those pixels: mean sRGB, B/R, and the two things
// this round is about — the fraction that is warm enough to be rust, and the
// spread of tone between distinct objects.
//
// `uVarAmt` and the rust edges are ablatable in place, so a before/after is one
// build and two passes rather than two checkouts.
// The renderer no longer injects `g`; probes take their own handle.
const g = window.__GAME;
g.setFreeFly(false);
const engine = g.engine;
const renderer = engine.renderer;
const scene = engine.scene;
const gl = renderer.getContext();
const W = engine.pipeline.width;
const H = engine.pipeline.height;

const WANT = new Set([
  'op-corr', 'op-metal', 'op-mil', 'op-cloth', 'op-canvas', 'op-net',
  'op-masonry', 'op-concrete', 'op-steel',
]);
const byMat = new Map();
scene.traverse((o) => {
  if (!o.isMesh || !o.material || !o.material.name) return;
  // Only the materials this round is about: 25 x 2 renders x 4 passes is a
  // three-minute job on a daemon five agents are sharing.
  if (!WANT.has(o.material.name)) return;
  const k = o.material.name;
  if (!byMat.has(k)) byMat.set(k, { meshes: [], mat: o.material });
  byMat.get(k).meshes.push(o);
});

function grab() {
  g.settle(3);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}

// uVarAmt 0 reproduces round 9's merged meshes exactly: vOPV pinned to zero.
function setVar(v) {
  for (const [, rec] of byMat) {
    const u = rec.mat.userData && rec.mat.userData.u;
    if (u && u.uVarAmt) u.uVarAmt.value = v;
  }
}

const SHOTS = ['outpost', 'gameplay', 'outpost/flat'];
const out = {};
for (const key of SHOTS) {
  const [shot, mode] = key.split('/');
  setVar(mode === 'flat' ? 0 : 1);
  g.applyShot(shot);
  const A = grab();
  const rows = {};
  for (const [name, rec] of byMat) {
    const prev = rec.meshes.map((m) => m.visible);
    rec.meshes.forEach((m) => (m.visible = false));
    const B = grab();
    rec.meshes.forEach((m, i) => (m.visible = prev[i]));
    let n = 0;
    let r = 0;
    let gg = 0;
    let b = 0;
    let warm = 0;
    let sum = 0;
    let sum2 = 0;
    for (let i = 0; i < W * H; i++) {
      const j = i * 4;
      const d = Math.max(Math.abs(A[j] - B[j]), Math.abs(A[j + 1] - B[j + 1]), Math.abs(A[j + 2] - B[j + 2]));
      if (d < 6) continue;
      n++;
      r += A[j];
      gg += A[j + 1];
      b += A[j + 2];
      const L = 0.299 * A[j] + 0.587 * A[j + 1] + 0.114 * A[j + 2];
      sum += L;
      sum2 += L * L;
      // Rust is the only thing on these materials that is both warm and
      // strongly red-dominant; paint, primer and drab are not.
      if (A[j] > A[j + 2] * 1.85 && A[j] > 40) warm++;
    }
    if (n < 300) continue;
    const mean = sum / n;
    rows[name] = {
      px: n,
      pct: +((100 * n) / (W * H)).toFixed(2),
      rgb: [Math.round(r / n), Math.round(gg / n), Math.round(b / n)],
      BR: +((b / n) / (r / n)).toFixed(3),
      rust: +((100 * warm) / n).toFixed(1),
      sd: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(1),
    };
  }
  out[key] = rows;
}
setVar(1);
return out;
