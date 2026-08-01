// What is actually in the "dead plastic dome"? Distance, normal, linear
// radiance and display modulation over the region the critic measured, for
// every daylight shot, so the fix can be aimed rather than guessed.
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

// image-space box (top-down y) -> stats in both spaces
function stats(hdr, disp, x0, yT, x1, yB) {
  let n = 0, sl = 0, sl2 = 0, sd = 0, sd2 = 0;
  for (let y = yT; y < yB; y++) {
    const row = H - 1 - y;              // buffers are bottom-up
    for (let x = x0; x < x1; x++) {
      const i = (row * W + x) * 4;
      const L = 0.2126 * hdr[i] + 0.7152 * hdr[i + 1] + 0.0722 * hdr[i + 2];
      const D = 0.2126 * disp[i] + 0.7152 * disp[i + 1] + 0.0722 * disp[i + 2];
      sl += L; sl2 += L * L; sd += D; sd2 += D * D; n++;
    }
  }
  const mL = sl / n, mD = sd / n;
  const sdL = Math.sqrt(Math.max(0, sl2 / n - mL * mL));
  const sdD = Math.sqrt(Math.max(0, sd2 / n - mD * mD));
  return {
    linMean: +mL.toFixed(5), linStd: +sdL.toFixed(5), linRel: +(100 * sdL / mL).toFixed(2),
    dispMean: +mD.toFixed(2), dispStd: +sdD.toFixed(2), dispRel: +(100 * sdD / mD).toFixed(2),
  };
}

// Raycast a grid of pixels to learn the distance range of a region.
const ray = new THREE.Raycaster();
function probeDist(cam, x0, yT, x1, yB, targets) {
  const ds = [];
  for (let k = 0; k < 40; k++) {
    const x = x0 + ((x1 - x0) * ((k * 7) % 40)) / 40;
    const y = yT + ((yB - yT) * ((k * 13) % 40)) / 40;
    ray.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -((y / H) * 2 - 1)), cam);
    const hit = ray.intersectObjects(targets, true)[0];
    if (hit) ds.push(hit.distance);
  }
  ds.sort((a, b) => a - b);
  return ds.length ? { n: ds.length, min: +ds[0].toFixed(1), med: +ds[ds.length >> 1].toFixed(1), max: +ds[ds.length - 1].toFixed(1) } : null;
}

const terrainMeshes = [];
scene.traverse((o) => { if (o.isMesh && /clip|terrain|ring/i.test(o.name || '')) terrainMeshes.push(o); });

const out = { W, H, terrainMeshes: terrainMeshes.map((m) => m.name) };
const REGIONS = {
  ridge: [[500, 800, 1200, 1050]],
  vista: [[500, 640, 1400, 760], [200, 850, 1700, 1030]],
  outpost: [[100, 700, 900, 820], [1200, 830, 1900, 1000]],
  ground: [[300, 780, 1100, 900], [1200, 900, 1900, 1040]],
};
for (const [shot, boxes] of Object.entries(REGIONS)) {
  g.applyShot(shot);
  g.settle(6);
  const hdr = hdrRead();
  const disp = dispRead();
  const cam = engine.camera;
  out[shot] = boxes.map((b) => ({
    box: b, ...stats(hdr, disp, b[0], b[1], b[2], b[3]),
    dist: probeDist(cam, b[0], b[1], b[2], b[3], terrainMeshes),
  }));
}
return out;
