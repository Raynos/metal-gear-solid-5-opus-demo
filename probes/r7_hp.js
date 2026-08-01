// TEXTURE, not gradient. The dead-dome complaint is about local modulation, so
// measure the high-pass energy (pixel minus an 11x11 box mean) rather than the
// raw std, which is dominated by the shading ramp across the region. Reported
// in linear radiance (the scene's own units) and in display codes (what ships).
// Binned by distance so the fade can be aimed.
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer, scene = engine.scene;
const pipeline = engine.pipeline;
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
function hdrRead() {
  copyMat.uniforms.t.value = pipeline.hdr.texture;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(fRT);
  renderer.render(qs, qc);
  renderer.readRenderTargetPixels(fRT, 0, 0, W, H, fbuf);
  renderer.setRenderTarget(prev);
  return fbuf.slice();
}
const gl = renderer.getContext();
function dispRead() {
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}

/** Separable box blur of a float plane. */
function boxBlur(src, w, h, r) {
  const t = new Float32Array(w * h), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      t[y * w + x] = acc / (2 * r + 1);
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.min(w - 1, Math.max(0, x - r))];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += t[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      o[y * w + x] = acc / (2 * r + 1);
      acc += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.min(h - 1, Math.max(0, y - r)) * w + x];
    }
  }
  return o;
}

/** High-pass RMS over an image-space box, as a fraction of the local mean. */
function hp(buf, stride, x0, yT, x1, yB, scale) {
  const w = x1 - x0, h = yB - yT;
  const p = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = H - 1 - (yT + y);
    for (let x = 0; x < w; x++) {
      const i = (row * W + x0 + x) * stride;
      p[y * w + x] = (0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2]) * scale;
    }
  }
  const lo = boxBlur(p, w, h, 5);
  let s = 0, s2 = 0, m = 0;
  const M = 6;                                  // ignore the blur's edge bias
  let n = 0;
  for (let y = M; y < h - M; y++) for (let x = M; x < w - M; x++) {
    const d = p[y * w + x] - lo[y * w + x];
    s += d; s2 += d * d; m += lo[y * w + x]; n++;
  }
  const rms = Math.sqrt(s2 / n - (s / n) * (s / n));
  const mean = m / n;
  return { mean: +mean.toFixed(5), hpRms: +rms.toFixed(5), hpPct: +((100 * rms) / mean).toFixed(2) };
}

const out = {};
const REGIONS = {
  // (label, box) — bands chosen off the measured distances in r7_deadzone.js
  ridge: { dome: [500, 800, 1200, 1050], mid: [250, 700, 1100, 790] },
  vista: { far: [500, 640, 1400, 760], mid: [200, 850, 1700, 1030] },
  outpost: { mid: [1200, 830, 1900, 1000], far: [100, 700, 900, 820] },
  ground: { near: [300, 780, 1100, 900], vnear: [1200, 900, 1900, 1040] },
};
for (const [shot, boxes] of Object.entries(REGIONS)) {
  g.applyShot(shot);
  g.settle(6);
  const hdr = hdrRead();
  const disp = dispRead();
  out[shot] = {};
  for (const [k, b] of Object.entries(boxes)) {
    out[shot][k] = {
      lin: hp(hdr, 4, b[0], b[1], b[2], b[3], 1),
      disp: hp(disp, 4, b[0], b[1], b[2], b[3], 1),
    };
  }
}
return out;
