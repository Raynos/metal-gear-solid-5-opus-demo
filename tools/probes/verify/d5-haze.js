/**
 * Round-7 haze acceptance, measured by ABLATION through `pass.ablate` (applied
 * at the END of syncTimeOfDay, so it cannot be silently reverted — that is the
 * bug that made round 6's d2-fogsweep report 0.000 opacity at every density).
 *
 * Per skyline band, L = Rec.709 luminance of the LINEAR hdr buffer:
 *   S = ablate.haze        -> bare surface (no extinction, no in-scatter)
 *   B = ablate.apGain = 0  -> surface * Ts        (extinction only)
 *   A = shipped            -> surface * Ts + src * (1-Ts) * apGain
 *   fog opacity = 1 - mean(B)/mean(S)  ==  1 - Ts, exactly
 *
 * The skyline row and the band distance come from the pass's own linear depth
 * target, so they do not depend on the haze being measured.
 */
g.setFreeFly(false);
const SHOT = (typeof SHOT_NAME === 'string' && SHOT_NAME) || 'vista';
const engine = g.engine, renderer = engine.renderer, pipeline = engine.pipeline;
const pass = g.world.registry.volumetrics.pass;
const W = pipeline.width, H = pipeline.height;

const copyMat = new THREE.ShaderMaterial({
  uniforms: { t: { value: null } },
  vertexShader: 'varying vec2 v; void main(){ v = uv; gl_Position = vec4(position.xy*2.0, 0.0, 1.0); }',
  fragmentShader: 'uniform sampler2D t; varying vec2 v; void main(){ gl_FragColor = texture2D(t, v); }',
  depthTest: false, depthWrite: false,
});
const qs = new THREE.Scene(); qs.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), copyMat));
const qc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const fRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, colorSpace: THREE.NoColorSpace, depthBuffer: false });
const fbuf = new Float32Array(W * H * 4);
function grab(tex) {
  copyMat.uniforms.t.value = tex;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(fRT); renderer.render(qs, qc);
  renderer.readRenderTargetPixels(fRT, 0, 0, W, H, fbuf);
  renderer.setRenderTarget(prev);
  return fbuf.slice();
}
const px = new Uint8Array(W * H * 4);
function grabDisplay() {
  const gl = renderer.getContext();
  renderer.setRenderTarget(null);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px.slice();
}
const at = (b, x, y) => ((H - 1 - y) * W + x) * 4;   // readback is bottom-up
function boxL(b, x0, yTop, x1, yBot) {
  let r = 0, g2 = 0, bl = 0, n = 0;
  for (let y = yTop; y < yBot; y++) for (let x = x0; x < x1; x++) {
    const i = at(b, x, y); r += b[i]; g2 += b[i + 1]; bl += b[i + 2]; n++;
  }
  return { L: (0.2126 * r + 0.7152 * g2 + 0.0722 * bl) / n };
}

g.applyShot(SHOT);
pass.ablate.haze = false; pass.ablate.apGain = null;
g.settle(14);
const A = grab(pipeline.hdr.texture), Ad = grabDisplay();
const D = grab(pass.depthRT.texture);
pass.ablate.apGain = 0; g.settle(14);
const B = grab(pipeline.hdr.texture);
pass.ablate.apGain = null; pass.ablate.haze = true; g.settle(14);
const S = grab(pipeline.hdr.texture);
pass.ablate.haze = false;
// Clear-sky chroma needs the deck out of the way: `isSky` is a depth test, so a
// cumulus counts as sky and its warm white dominates any band it appears in.
pass.ablate.clouds = true; pass.ablate.cirrus = true; g.settle(14);
const Cd = grabDisplay();
pass.ablate.clouds = false; pass.ablate.cirrus = false; g.settle(6);

const cam = engine.camera, far = cam.far;
const fwd = new THREE.Vector3(); cam.getWorldDirection(fwd);
const invVP = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
const rayFor = (x, y) => new THREE.Vector3((x / W) * 2 - 1, 1 - (y / H) * 2, 1)
  .applyMatrix4(invVP).sub(cam.position).normalize();
const isSky = (x, y) => D[at(D, x, y)] > far * 0.9;
// screen row of the topmost solid pixel in a column strip
function skylineRow(x0, x1) {
  for (let y = 4; y < H - 90; y++) {
    let solid = 0;
    for (let x = x0; x < x1; x += 4) if (!isSky(x, y)) solid++;
    if (solid > (x1 - x0) / 8) return y;
  }
  return -1;
}
function rangeAt(x0, y0, x1, y1) {
  let s = 0, n = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    const z = D[at(D, x, y)];
    if (z > far * 0.9) continue;
    s += z / Math.max(0.2, rayFor(x, y).dot(fwd)); n++;
  }
  return n ? Math.round(s / n) : -1;
}

const bands = [[180, 320], [620, 760], [960, 1100], [1380, 1520], [1700, 1840]].map(([x0, x1]) => {
  const sk = skylineRow(x0, x1);
  if (sk < 0) return null;
  const y0 = sk + 8, y1 = sk + 68;
  const rA = boxL(A, x0, y0, x1, y1), rB = boxL(B, x0, y0, x1, y1), rS = boxL(S, x0, y0, x1, y1);
  const sA = boxL(A, x0, Math.max(0, sk - 70), x1, Math.max(1, sk - 8));
  return {
    x0, skyRow: sk, dist_m: rangeAt(x0, y0, x1, y1),
    opacity: +(1 - rB.L / Math.max(rS.L, 1e-9)).toFixed(3),
    ridgeOverSky: +(rA.L / Math.max(sA.L, 1e-9)).toFixed(3),
    ridgeL: +rA.L.toFixed(4), skyL: +sA.L.toFixed(4),
  };
});

let hi = 0, clip = 0;
for (let i = 0; i < W * H; i++) {
  const m = Math.max(Ad[i * 4], Ad[i * 4 + 1], Ad[i * 4 + 2]);
  if (m >= 230) hi++; if (m >= 254) clip++;
}
// Display chroma of SKY pixels only, binned by elevation.
const bins = [[2, 5], [5, 8], [8, 12], [12, 18], [18, 25], [25, 40], [40, 90]];
const acc = bins.map(() => ({ R: 0, G: 0, B: 0, S: 0, n: 0 }));
for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
  if (!isSky(x, y)) continue;
  const el = Math.asin(rayFor(x, y).y) * 57.2958;
  const k = bins.findIndex(([a, b]) => el >= a && el < b);
  if (k < 0) continue;
  const i = at(Cd, x, y);
  const r = Cd[i], g2 = Cd[i + 1], bl = Cd[i + 2];
  const a = acc[k];
  a.R += r; a.G += g2; a.B += bl;
  const mx = Math.max(r, g2, bl), mn = Math.min(r, g2, bl);
  a.S += mx > 0 ? (mx - mn) / mx : 0; a.n++;
}
const skyBands = bins.map(([lo, hiE], k) => {
  const a = acc[k];
  if (!a.n) return { elev: `${lo}-${hiE}`, n: 0 };
  return { elev: `${lo}-${hiE}`, n: a.n, R: +(a.R / a.n).toFixed(1), G: +(a.G / a.n).toFixed(1),
           B: +(a.B / a.n).toFixed(1), RminusB: +((a.R - a.B) / a.n).toFixed(1),
           sat: +(100 * a.S / a.n).toFixed(2) };
});
// Fog opacity as a function of RANGE, over every terrain pixel in the frame.
// Sum-then-divide, so dark pixels cannot blow the ratio up.
const RB = [[500, 1000], [1000, 1500], [1500, 2000], [2000, 3000], [3000, 4000], [4000, 6000], [6000, 12000]];
const racc = RB.map(() => ({ b: 0, s: 0, n: 0 }));
for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
  const z = D[at(D, x, y)];
  if (z > far * 0.9) continue;
  const d = z / Math.max(0.2, rayFor(x, y).dot(fwd));
  const k = RB.findIndex(([a, b2]) => d >= a && d < b2);
  if (k < 0) continue;
  const i = at(B, x, y);
  racc[k].b += 0.2126 * B[i] + 0.7152 * B[i + 1] + 0.0722 * B[i + 2];
  racc[k].s += 0.2126 * S[i] + 0.7152 * S[i + 1] + 0.0722 * S[i + 2];
  racc[k].n++;
}
const byRange = RB.map(([a, b2], k) => ({ range: `${a}-${b2}`, px: racc[k].n,
  opacity: racc[k].n ? +(1 - racc[k].b / racc[k].s).toFixed(3) : null }));
fRT.dispose();
return {
  shot: SHOT,
  params: { dustBeta: pass.params.dustBeta, dustTop: pass.params.dustTop,
            dustHeight: pass.params.dustHeight, apGain: pass.params.apGain,
            cloudFar: pass.params.cloudFar, cloudGain: pass.params.cloudGain,
            cloudStreak: pass.params.cloudStreak },
  highlightPct: +(100 * hi / (W * H)).toFixed(3), clipPct: +(100 * clip / (W * H)).toFixed(3),
  bands, byRange, skyBands,
};
