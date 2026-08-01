// Ablation of the round-7 terrain layers, in display codes and in linear
// radiance, over the regions the critique named. Each layer is toggled through
// the material's own uniform hook, so A and B differ in exactly one term.
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer;
const pipeline = engine.pipeline;
const W = pipeline.width, H = pipeline.height;
const t = g.world.terrain;
const U = t.uniforms;
engine.pipeline.enabled.autoExposure = false;

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
const gl = renderer.getContext();

function grab() {
  g.settle(6);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  copyMat.uniforms.t.value = pipeline.hdr.texture;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(fRT);
  renderer.render(qs, qc);
  renderer.readRenderTargetPixels(fRT, 0, 0, W, H, fbuf);
  renderer.setRenderTarget(prev);
  return { px, hdr: fbuf.slice() };
}

function boxBlur(src, w, h, r) {
  const t1 = new Float32Array(w * h), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      t1[y * w + x] = acc / (2 * r + 1);
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.min(w - 1, Math.max(0, x - r))];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += t1[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      o[y * w + x] = acc / (2 * r + 1);
      acc += t1[Math.min(h - 1, y + r + 1) * w + x] - t1[Math.min(h - 1, Math.max(0, y - r)) * w + x];
    }
  }
  return o;
}
function plane(buf, stride, x0, yT, x1, yB) {
  const w = x1 - x0, h = yB - yT;
  const p = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = H - 1 - (yT + y);
    for (let x = 0; x < w; x++) {
      const i = (row * W + x0 + x) * stride;
      p[y * w + x] = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
    }
  }
  return { p, w, h };
}
function hp(buf, stride, b) {
  const { p, w, h } = plane(buf, stride, b[0], b[1], b[2], b[3]);
  const lo = boxBlur(p, w, h, 5);
  let s = 0, s2 = 0, m = 0, n = 0;
  const M = 6;
  for (let y = M; y < h - M; y++) for (let x = M; x < w - M; x++) {
    const d = p[y * w + x] - lo[y * w + x];
    s += d; s2 += d * d; m += lo[y * w + x]; n++;
  }
  const rms = Math.sqrt(Math.max(0, s2 / n - (s / n) * (s / n)));
  let ss = 0, ss2 = 0;
  for (let i = 0; i < w * h; i++) { ss += p[i]; ss2 += p[i] * p[i]; }
  const mn = ss / (w * h);
  return {
    mean: +mn.toFixed(5),
    std: +Math.sqrt(Math.max(0, ss2 / (w * h) - mn * mn)).toFixed(5),
    hpRms: +rms.toFixed(5),
    hpPct: +((100 * rms) / (m / n)).toFixed(2),
  };
}
/** Fraction of the box that moved by more than TH display codes. */
function changed(A, B, b, TH = 2) {
  let n = 0, c = 0;
  for (let y = b[1]; y < b[3]; y++) {
    const row = H - 1 - y;
    for (let x = b[0]; x < b[2]; x++) {
      const i = (row * W + x) * 4;
      const d = Math.max(Math.abs(A.px[i] - B.px[i]), Math.abs(A.px[i + 1] - B.px[i + 1]), Math.abs(A.px[i + 2] - B.px[i + 2]));
      if (d >= TH) c++;
      n++;
    }
  }
  return +((100 * c) / n).toFixed(2);
}

// Boxes chosen off an ablation map of which mesh owns which tile (see
// probes/r7_who.js): `terr` boxes are >90% terrain clipmap, `dome` is the region
// the round-6 critique named and is 99.9% outpost-pad.
const REGIONS = {
  ridge: { dome: [500, 800, 1200, 1050], terr: [120, 360, 1080, 600] },
  vista: { pan: [60, 620, 620, 810], terr: [600, 360, 1800, 600], far: [500, 640, 1400, 760] },
  outpost: { terr: [120, 360, 1200, 480] },
  ground: { near: [300, 780, 1100, 900] },
};

const out = {};
for (const [shot, boxes] of Object.entries(REGIONS)) {
  g.applyShot(shot);
  U.uDbg2.value.set(1, 1, 0, 0);
  U.uDbg.value.set(1, 1, 1, 1);
  const A = grab();
  U.uDbg2.value.set(0, 1, 0, 0);              // pavement off
  const noPav = grab();
  U.uDbg2.value.set(1, 0, 0, 0);              // mid-field albedo swing off
  const noMid = grab();
  U.uDbg2.value.set(1, 1, 0, 0);
  U.uDbg.value.set(1, 0, 1, 1);               // near grit off
  const noGrit = grab();
  U.uDbg.value.set(1, 1, 1, 1);
  const r = {};
  for (const [k, b] of Object.entries(boxes)) {
    r[k] = {
      shipped: { disp: hp(A.px, 4, b), lin: hp(A.hdr, 4, b) },
      noPavement: { disp: hp(noPav.px, 4, b), lin: hp(noPav.hdr, 4, b), changedPct: changed(A, noPav, b) },
      noMidSwing: { disp: hp(noMid.px, 4, b), changedPct: changed(A, noMid, b) },
      noNearGrit: { disp: hp(noGrit.px, 4, b), changedPct: changed(A, noGrit, b) },
    };
  }
  out[shot] = r;
}
return out;
