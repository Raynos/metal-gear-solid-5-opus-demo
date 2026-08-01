/**
 * (d) THE HORIZON IS POSSIBLE — ridge vs the sky above it, and the ridge's fog
 * opacity at a MEASURED distance, all by ablation in linear radiance.
 *
 * Read out of `pipeline.hdr`, the linear half-float scene target the volumetric
 * in-scatter is composited into, copied into a float RT for exact readback.
 * Display space is not used for the physics claim: the tonemap is not order
 * preserving across hue, so "is the ridge darker than the sky" has to be asked
 * of radiance.
 *
 * The composite the volumetric pass performs is
 *     pixel = surface * Ts + src * (1 - Ts) * apGain
 * so four renders pin every term down:
 *   A   shipped
 *   B   pass.params.apGain = 0           -> surface * Ts   (extinction only)
 *   S   composite quad hidden            -> surface        (no haze at all)
 *   K   world hidden except the sky dome -> the convergence target along the
 *                                           SAME ray, not a neighbouring one
 * giving  Ts = B/S,  opacity = 1 - Ts,  mixWeight = (1 - Ts) * apGain.
 *
 * NOTE for anyone re-running this: `syncTimeOfDay()` pushes `pass.params` into
 * the uniforms on EVERY frame, so setting `volMat.uniforms.uApGain.value`
 * directly is silently reverted before the next render. That cost me three
 * wrong measurements. Ablate `pass.params`.
 *
 * Distance comes from the pass's own linearised depth target, so "at 3-5 km" is
 * a measurement rather than an assumption about which ridge is which.
 */
g.setFreeFly(false);
const engine = g.engine, scene = engine.scene, renderer = engine.renderer;
const pipeline = engine.pipeline;
const pass = g.world.registry?.volumetrics?.pass;
if (!pass) return { error: 'volumetric pass not found' };
const skyMesh = g.world.sky?.mesh;
if (!skyMesh) return { error: 'sky mesh not found' };

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
const buf = new Float32Array(W * H * 4);
function grab(tex, w = W, h = H) {
  copyMat.uniforms.t.value = tex;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(fRT);
  renderer.render(qs, qc);
  renderer.readRenderTargetPixels(fRT, 0, 0, w, h, buf);
  renderer.setRenderTarget(prev);
  return buf.slice(0, w * h * 4);
}
const hdrRead = () => grab(pipeline.hdr.texture);
// hdr rows are bottom-up, image rows top-down
function boxL(b, x0, yTop, x1, yBot, w = W, h = H) {
  let r = 0, g2 = 0, bl = 0, n = 0;
  for (let y = yTop; y < yBot; y++) for (let x = x0; x < x1; x++) {
    const i = ((h - 1 - y) * w + x) * 4;
    r += b[i]; g2 += b[i + 1]; bl += b[i + 2]; n++;
  }
  return { R: r / n, G: g2 / n, B: bl / n, L: (0.2126 * r + 0.7152 * g2 + 0.0722 * bl) / n, n };
}

const hidden = [];
const hideWorld = () => scene.traverse((o) => {
  if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
  if (o === skyMesh || o === pass.compositeMesh) return;
  if (o.visible) { hidden.push(o); o.visible = false; }
});
const showWorld = () => { for (const o of hidden) o.visible = true; hidden.length = 0; };

const BANDS = {
  vista: [[980, 1120], [640, 780], [1400, 1540]],
  ridge: [[700, 840], [1250, 1390]],
  ground: [[760, 900]],
};
const out = {};
for (const shotName of Object.keys(BANDS)) {
  g.applyShot(shotName);
  g.settle(14);
  const A = hdrRead();
  const dRT = pass.depthRT;
  const D = grab(dRT.texture, dRT.width, dRT.height);
  const keep = pass.params.apGain;
  pass.params.apGain = 0; g.settle(12);
  const B = hdrRead();
  pass.params.apGain = keep;
  pass.compositeMesh.visible = false; g.settle(12);
  const S = hdrRead();
  pass.compositeMesh.visible = true;
  hideWorld(); g.settle(12);
  const K = hdrRead();
  showWorld(); g.settle(12);

  // The skyline is the first row from the top at which the shipped frame stops
  // agreeing with the sky-only render.
  // Require the disagreement to PERSIST for 24 rows. A single row is a cloud
  // edge or a bird; a skyline is opaque all the way down.
  function skylineRow(x0, x1) {
    let run = 0;
    for (let y = 0; y < H - 2; y++) {
      const a = boxL(A, x0, y, x1, y + 1), k = boxL(K, x0, y, x1, y + 1);
      if (Math.abs(a.L - k.L) / Math.max(k.L, 1e-6) > 0.03) { if (++run >= 24) return y - 23; }
      else run = 0;
    }
    return -1;
  }
  const rows = [];
  for (const [x0, x1] of BANDS[shotName]) {
    const sk = skylineRow(x0, x1);
    if (sk < 0 || sk > H - 90) { rows.push({ band: [x0, x1], skylineRow: sk, note: 'no skyline in band' }); continue; }
    const y0 = sk + 8, y1 = sk + 68;
    const sky = boxL(A, x0, Math.max(0, sk - 70), x1, Math.max(1, sk - 8));
    const a = boxL(A, x0, y0, x1, y1);
    const b = boxL(B, x0, y0, x1, y1);
    const s = boxL(S, x0, y0, x1, y1);
    const k = boxL(K, x0, y0, x1, y1);
    const sx = dRT.width / W, sy = dRT.height / H;
    const dist = boxL(D, Math.round(x0 * sx), Math.round(y0 * sy), Math.round(x1 * sx), Math.round(y1 * sy), dRT.width, dRT.height);
    // A - B is exactly src*(1-Ts)*apGain and K is src, so their ratio is the
    // blend weight the composite actually used. This does not need the
    // no-haze render, which is unusable at dusk: hiding the composite quad
    // also removes the cloud and shaft in-scatter, which at that hour is
    // larger than the aerial perspective being measured.
    const mix = (a.L - b.L) / Math.max(k.L, 1e-9);
    rows.push({
      band: [x0, x1], skylineRow: sk,
      depthChannels: [+dist.R.toFixed(1), +dist.G.toFixed(1), +dist.B.toFixed(1)],
      skyAboveL: +sky.L.toFixed(5),
      ridgeL: +a.L.toFixed(5),
      ridgeOverSky: +(a.L / sky.L).toFixed(4),
      ridgeDarkerThanSky: a.L < sky.L,
      surfaceRawL: +s.L.toFixed(5),
      surfaceExtinguishedL: +b.L.toFixed(5),
      convergenceTargetL: +k.L.toFixed(5),
      fogOpacity: +mix.toFixed(4),
      impliedTransmittance: +(1 - mix / keep).toFixed(4),
      ridgeFractionOfTarget: +(a.L / k.L).toFixed(4),
    });
  }
  out[shotName] = { apGain: keep, dustBeta: pass.params.dustBeta, dustHeight: pass.params.dustHeight, bands: rows };
}
fRT.dispose();
return out;
