/**
 * Sweep the afternoon haze density and re-measure BOTH acceptance conditions at
 * once: fog opacity on a ridge at a measured 3-5 km, and "is every ridge still
 * darker than the sky above it".
 *
 * This is the question round 6 left open. The volumetrics author cut `dustBeta`
 * 3.7x AND fixed the per-channel/scalar alpha bug in the same round, and only
 * the second of those was load-bearing for the fatal: with one luminance-
 * weighted scalar the composite is a true convex combination, so a surface
 * darker than the sky can only approach it from below AT ANY DENSITY. If that
 * is true, density is now a free art-direction parameter again — and this sweep
 * is what proves it rather than asserting it.
 */
g.setFreeFly(false);
const engine = g.engine, scene = engine.scene, renderer = engine.renderer;
const pipeline = engine.pipeline;
const pass = g.world.registry.volumetrics.pass;
const skyMesh = g.world.sky.mesh;
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
function grab(tex, w = W, h = H) {
  copyMat.uniforms.t.value = tex;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(fRT); renderer.render(qs, qc);
  renderer.readRenderTargetPixels(fRT, 0, 0, w, h, fbuf);
  renderer.setRenderTarget(prev);
  return fbuf.slice(0, w * h * 4);
}
function boxL(b, x0, yTop, x1, yBot, w = W, h = H) {
  let r = 0, g2 = 0, bl = 0, n = 0;
  for (let y = yTop; y < yBot; y++) for (let x = x0; x < x1; x++) {
    const i = ((h - 1 - y) * w + x) * 4; r += b[i]; g2 += b[i + 1]; bl += b[i + 2]; n++;
  }
  return { L: (0.2126 * r + 0.7152 * g2 + 0.0722 * bl) / n };
}
const hidden = [];
const hideWorld = () => scene.traverse((o) => {
  if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
  if (o === skyMesh || o === pass.compositeMesh) return;
  if (o.visible) { hidden.push(o); o.visible = false; }
});
const showWorld = () => { for (const o of hidden) o.visible = true; hidden.length = 0; };

const BANDS = [[980, 1120], [640, 780], [1400, 1540], [200, 340], [1700, 1840]];
const SWEEP = [
  { beta: 1.18e-4, height: 360 },   // shipped
  { beta: 1.8e-4, height: 600 },
  { beta: 2.4e-4, height: 900 },
  { beta: 3.0e-4, height: 1200 },
  { beta: 3.6e-4, height: 1600 },
];
g.applyShot('vista');
const keepB = pass.params.dustBeta, keepH = pass.params.dustHeight;
const results = [];
for (const s of SWEEP) {
  pass.params.dustBeta = s.beta;
  pass.params.dustHeight = s.height;
  g.settle(14);
  const A = grab(pipeline.hdr.texture);
  const dRT = pass.depthRT;
  const D = grab(dRT.texture, dRT.width, dRT.height);
  const keepG = pass.params.apGain;
  pass.params.apGain = 0; g.settle(12);
  const B = grab(pipeline.hdr.texture);
  pass.params.apGain = keepG;
  hideWorld(); g.settle(12);
  const K = grab(pipeline.hdr.texture);
  showWorld(); g.settle(10);

  function skylineRow(x0, x1) {
    let run = 0;
    for (let y = 0; y < H - 2; y++) {
      const a = boxL(A, x0, y, x1, y + 1), k = boxL(K, x0, y, x1, y + 1);
      if (Math.abs(a.L - k.L) / Math.max(k.L, 1e-6) > 0.03) { if (++run >= 24) return y - 23; }
      else run = 0;
    }
    return -1;
  }
  const bands = [];
  let worstRatio = 0;
  for (const [x0, x1] of BANDS) {
    const sk = skylineRow(x0, x1);
    if (sk < 0 || sk > H - 90) { bands.push(null); continue; }
    const y0 = sk + 8, y1 = sk + 68;
    const sky = boxL(A, x0, Math.max(0, sk - 70), x1, Math.max(1, sk - 8));
    const a = boxL(A, x0, y0, x1, y1), b = boxL(B, x0, y0, x1, y1), k = boxL(K, x0, y0, x1, y1);
    const sx = dRT.width / W, sy = dRT.height / H;
    const dist = (() => {
      let t = 0, n = 0;
      for (let y = Math.round(y0 * sy); y < Math.round(y1 * sy); y++)
        for (let x = Math.round(x0 * sx); x < Math.round(x1 * sx); x++) { t += fbuf[0] * 0; n++; }
      return 0;
    })();
    let dsum = 0, dn = 0;
    for (let y = Math.round(y0 * sy); y < Math.round(y1 * sy); y++)
      for (let x = Math.round(x0 * sx); x < Math.round(x1 * sx); x++) {
        const i = ((dRT.height - 1 - y) * dRT.width + x) * 4; dsum += D[i]; dn++;
      }
    const ratio = a.L / sky.L;
    worstRatio = Math.max(worstRatio, ratio);
    bands.push({
      x: x0, dist_m: Math.round(dsum / dn), skyline: sk,
      opacity: +((a.L - b.L) / Math.max(k.L, 1e-9)).toFixed(4),
      ridgeOverSky: +ratio.toFixed(4),
      fracOfTarget: +(a.L / k.L).toFixed(4),
    });
  }
  results.push({ beta: s.beta, height: s.height, visualRange_km: +(3.912 / s.beta / 1000).toFixed(1), worstRidgeOverSky: +worstRatio.toFixed(4), bands });
}
pass.params.dustBeta = keepB; pass.params.dustHeight = keepH;
g.settle(6);
fRT.dispose();
return results;
