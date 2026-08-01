// TASK 3 acceptance.
//
// (a) VARNISH COVERAGE, as a pixel count rather than an opinion. uDbg2.z is a
//     measurement hook in the terrain shader: set it to a threshold t and every
//     bedrock fragment whose varnish weight is >= t renders black. Coverage at
//     t is then (pixels that went black) / (bedrock pixels), and bedrock pixels
//     are found by the same mechanism at t = 0.001.
// (b) DISTANT BEDROCK VALUE against the sky directly above it, in linear
//     radiance out of pipeline.hdr, since the claim is about radiance and the
//     tonemap is not order-preserving across hue.
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer;
const pipeline = engine.pipeline;
const W = pipeline.width, H = pipeline.height;
const U = g.world.terrain.uniforms;
engine.pipeline.enabled.autoExposure = false;
const gl = renderer.getContext();

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

function grabDisp() {
  g.settle(6);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}
function grabLin() {
  g.settle(6);
  copyMat.uniforms.t.value = pipeline.hdr.texture;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(fRT);
  renderer.render(qs, qc);
  renderer.readRenderTargetPixels(fRT, 0, 0, W, H, fbuf);
  renderer.setRenderTarget(prev);
  return fbuf.slice();
}
function diffMask(A, B, TH = 4) {
  const m = new Uint8Array(W * H);
  let n = 0;
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (Math.max(Math.abs(A[o] - B[o]), Math.abs(A[o + 1] - B[o + 1]), Math.abs(A[o + 2] - B[o + 2])) >= TH) { m[i] = 1; n++; }
  }
  return { m, n };
}
function boxLin(hdr, x0, yT, x1, yB) {
  let r = 0, g2 = 0, b = 0, n = 0;
  for (let y = yT; y < yB; y++) {
    const row = H - 1 - y;
    for (let x = x0; x < x1; x++) { const i = (row * W + x) * 4; r += hdr[i]; g2 += hdr[i + 1]; b += hdr[i + 2]; n++; }
  }
  return { R: r / n, G: g2 / n, B: b / n, L: (0.2126 * r + 0.7152 * g2 + 0.0722 * b) / n };
}

const out = {};
for (const shot of ['vista', 'outpost', 'ridge']) {
  g.applyShot(shot);
  U.uDbg2.value.set(1, 1, 0, 0);
  const A = grabDisp();
  U.uDbg2.value.set(1, 1, 0.001, 0);
  const allRock = grabDisp();
  const bedrock = diffMask(A, allRock);
  const cov = {};
  for (const t of [0.35, 0.5, 0.7]) {
    U.uDbg2.value.set(1, 1, t, 0);
    const B = grabDisp();
    const d = diffMask(A, B);
    cov['ge' + t] = +((100 * d.n) / Math.max(1, bedrock.n)).toFixed(1);
  }
  U.uDbg2.value.set(1, 1, 0, 0);
  out[shot] = { bedrockPx: bedrock.n, bedrockPctOfFrame: +((100 * bedrock.n) / (W * H)).toFixed(1), coveragePct: cov };
}

// Distant bedrock vs the sky above it.
g.applyShot('vista');
U.uDbg2.value.set(1, 1, 0, 0);
const lin = grabLin();
out.vistaRadiance = {
  massif_y380_460: boxLin(lin, 700, 380, 1300, 460),
  massif_y300_360: boxLin(lin, 800, 300, 1200, 360),
  skyAbove_y150_230: boxLin(lin, 800, 150, 1200, 230),
};
const m = out.vistaRadiance.massif_y300_360.L;
const s = out.vistaRadiance.skyAbove_y150_230.L;
out.vistaRadiance.rockOverSky = +(m / s).toFixed(3);
out.vistaRadiance.stops = +Math.log2(m / s).toFixed(2);
return out;
