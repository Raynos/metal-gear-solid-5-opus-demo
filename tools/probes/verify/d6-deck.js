/**
 * Shape of the cumulus deck, measured on the deck's OWN contribution.
 *
 * The deck mask is the difference between the shipped frame and the same frame
 * with `ablate.clouds`, so it contains the cumulus and nothing else — no sky
 * gradient, no cirrus, no terrain.
 *
 * For each elevation band it reports the mean RUN LENGTH of contiguous deck
 * along a screen row and along a screen column, converted to DEGREES. A field
 * of discrete puffs has a vertical run comparable to its horizontal one and
 * both shrink toward the horizon. A vertically extruded field — a sky of
 * curtains — has a vertical run several times the horizontal one, because each
 * cloud is drawn across every elevation whose slab chord crosses its range.
 */
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer, pipeline = engine.pipeline;
const pass = g.world.registry.volumetrics.pass;
const W = pipeline.width, H = pipeline.height;
const px = new Uint8Array(W * H * 4);
function grab() {
  const gl = renderer.getContext();
  renderer.setRenderTarget(null);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px.slice();
}
g.applyShot('vista');
pass.ablate.cirrus = true;
pass.ablate.vsquash = (typeof VSQ_OFF !== 'undefined');
pass.ablate.clouds = false; g.settle(16);
const A = grab();
pass.ablate.clouds = true; g.settle(16);
const B = grab();
pass.ablate.clouds = false; pass.ablate.cirrus = false; pass.ablate.vsquash = false; g.settle(6);

const cam = engine.camera;
const invVP = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
const rayFor = (x, y) => new THREE.Vector3((x / W) * 2 - 1, 1 - (y / H) * 2, 1)
  .applyMatrix4(invVP).sub(cam.position).normalize();
const at = (x, y) => ((H - 1 - y) * W + x) * 4;
const L = (b, i) => 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2];
const mask = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = at(x, y);
  mask[y * W + x] = Math.abs(L(A, i) - L(B, i)) > 6 ? 1 : 0;
}
// degrees per pixel, vertically, at the middle of each band
const elAt = (y) => Math.asin(rayFor(W / 2, y).y) * 57.2958;
const degPerRow = Math.abs(elAt(H / 2) - elAt(H / 2 + 1));
const azAt = (x) => Math.atan2(rayFor(x, H / 2).z, rayFor(x, H / 2).x) * 57.2958;
const degPerCol = Math.abs(azAt(W / 2 + 1) - azAt(W / 2));

const BANDS = [[2, 6], [6, 10], [10, 15], [15, 22], [22, 35]];
const rows = BANDS.map(([a, b]) => {
  let y0 = H, y1 = 0;
  for (let y = 0; y < H; y++) { const e = elAt(y); if (e >= a && e < b) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
  if (y1 <= y0 + 4) return { band: `${a}-${b}`, n: 0 };
  let hRun = 0, hN = 0, vRun = 0, vN = 0, px2 = 0;
  for (let y = y0; y <= y1; y++) {
    let run = 0;
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) { run++; px2++; }
      else if (run) { hRun += run; hN++; run = 0; }
    }
    if (run) { hRun += run; hN++; }
  }
  for (let x = 0; x < W; x += 2) {
    let run = 0;
    for (let y = y0; y <= y1; y++) {
      if (mask[y * W + x]) run++;
      else if (run) { vRun += run; vN++; run = 0; }
    }
    if (run) { vRun += run; vN++; }
  }
  return {
    band: `${a}-${b}`, rows: [y0, y1], coverPct: +(100 * px2 / ((y1 - y0 + 1) * W)).toFixed(1),
    horzRun_deg: hN ? +((hRun / hN) * degPerCol).toFixed(3) : null,
    vertRun_deg: vN ? +((vRun / vN) * degPerRow).toFixed(3) : null,
    vOverH: hN && vN ? +(((vRun / vN) * degPerRow) / ((hRun / hN) * degPerCol)).toFixed(2) : null,
  };
});
// Directional autocorrelation of the deck's OWN contribution (A - B), which is
// zero outside the clouds and therefore carries no sky gradient to confound it.
// Streaks pointing at the horizon stay correlated over a long VERTICAL lag.
const delta = new Float32Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = at(x, y); delta[y * W + x] = L(A, i) - L(B, i);
}
function corr(dx, dy, y0, y1) {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  for (let y = y0; y < y1 - dy; y++) for (let x = 40; x < W - 40 - dx; x++) {
    const a = delta[y * W + x], b = delta[(y + dy) * W + (x + dx)];
    sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
  }
  const ca = saa - sa * sa / n, cb = sbb - sb * sb / n;
  return (sab - sa * sb / n) / Math.sqrt(Math.max(ca * cb, 1e-9));
}
const acorr = [];
for (const [a, b] of [[6, 10], [10, 15]]) {
  let y0 = H, y1 = 0;
  for (let y = 0; y < H; y++) { const e = elAt(y); if (e >= a && e < b) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
  const row = { band: `${a}-${b}` };
  for (const lag of [24, 48]) {
    const rv = corr(0, lag, y0, y1), rh = corr(lag, 0, y0, y1);
    row['lag' + lag] = { rVert: +rv.toFixed(3), rHorz: +rh.toFixed(3), ratio: +(rv / rh).toFixed(2) };
  }
  acorr.push(row);
}
return { acorr, vsquashAblated: (typeof VSQ_OFF !== 'undefined'), degPerRow: +degPerRow.toFixed(4), degPerCol: +degPerCol.toFixed(4), rows };
