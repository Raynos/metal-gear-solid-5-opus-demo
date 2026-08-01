/**
 * (i1) INTEGRATOR, round 7 — the ambient probe read in DISPLAY CODES.
 *
 * b-ambient.js reports the shadowed sphere as stops of linear radiance and as
 * stops of *display luminance*. Neither is the acceptance number any more.
 * Round 7's finding is that the light transport was correct and the print was
 * throwing it away, so the number that decides whether the fix is visible is
 * how many 8-BIT CODES separate the top of the sphere from the bottom. Two
 * stops printed as four codes is not a gradient; the same two stops printed as
 * thirty is.
 *
 * Same rig as b-ambient.js — 0.5-grey matte sphere, 70 m plate on the key axis
 * so direct sun contributes nothing, binned over 8 normal-Y bins — with three
 * things added:
 *
 *   codeBins    mean 8-bit G of the presented frame per bin, and the top-to-
 *               bottom CODE RANGE, which is the acceptance number
 *   linStops    the same bins in linear radiance, unchanged from b-ambient
 *   hdrFloor    percentiles of scene-linear luminance actually PRESENT in each
 *               shipped frame, out of pipeline.hdr. This is what says whether
 *               the p0.01 black-point guard is measuring the curve or measuring
 *               the fact that the frame contains nothing dark.
 */
g.setFreeFly(false);
const L = g.world.lighting;
const engine = g.engine;
const scene = engine.scene;
const renderer = engine.renderer;
const pipeline = engine.pipeline;
const gl = renderer.getContext();
const terrain = g.world.terrain;

const W = pipeline.width, H = pipeline.height, R = 1.35, NB = 8;
const px = 152, pz = -138;
const centre = new THREE.Vector3(px, terrain.heightAt(px, pz) + 22.0, pz);

const sphere = new THREE.Mesh(
  new THREE.SphereGeometry(R, 128, 96),
  new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(0.5, 0.5, 0.5, THREE.LinearSRGBColorSpace),
    roughness: 1.0,
    metalness: 0.0,
  }),
);
sphere.position.copy(centre);
sphere.receiveShadow = true;
scene.add(sphere);

const plate = new THREE.Mesh(
  new THREE.BoxGeometry(70, 1.5, 70),
  new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 1 }),
);
plate.castShadow = true;
scene.add(plate);

const cam = new THREE.PerspectiveCamera(26, W / H, 0.1, 3000);
const prevCam = engine.camera;
const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, colorSpace: THREE.NoColorSpace, depthBuffer: true });
const fbuf = new Float32Array(W * H * 4);
const bbuf = new Uint8Array(W * H * 4);

const hits = [];
function buildHits() {
  hits.length = 0;
  const invP = cam.projectionMatrixInverse, mw = cam.matrixWorld;
  const ro = new THREE.Vector3().setFromMatrixPosition(mw);
  const oc = new THREE.Vector3().subVectors(ro, centre);
  const v = new THREE.Vector3();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    v.set(((x + 0.5) / W) * 2 - 1, ((y + 0.5) / H) * 2 - 1, 0.5).applyMatrix4(invP);
    v.applyMatrix4(mw).sub(ro).normalize();
    const b = oc.dot(v), c = oc.lengthSq() - R * R, disc = b * b - c;
    if (disc <= 0) continue;
    const t = -b - Math.sqrt(disc);
    if (t <= 0) continue;
    const ny = (ro.y + v.y * t - centre.y) / R;
    const nx = (ro.x + v.x * t - centre.x) / R;
    const nz = (ro.z + v.z * t - centre.z) / R;
    if (-(nx * v.x + ny * v.y + nz * v.z) < 0.20) continue;
    hits.push((y * W + x) * 4, Math.min(NB - 1, Math.floor(((1 - ny) / 2) * NB)));
  }
}
function bin(get) {
  const sums = new Float64Array(NB), cnt = new Float64Array(NB);
  for (let i = 0; i < hits.length; i += 2) { sums[hits[i + 1]] += get(hits[i]); cnt[hits[i + 1]]++; }
  const bins = [];
  for (let i = 0; i < NB; i++) bins.push(cnt[i] > 120 ? +(sums[i] / cnt[i]).toFixed(4) : null);
  return bins;
}

const out = { sphere: {} };
for (const state of ['shipped', 'rawAcesToe']) {
 pipeline.setToneToe(state === 'shipped');
 out.sphere[state] = {};
 for (const tod of ['noon', 'afternoon']) {
  L.setTimeOfDay(tod);
  const key = L.keyDirection;
  const plateY = centre.y + 18;
  const tt = (plateY - centre.y) / Math.max(key.y, 0.2);
  plate.position.set(centre.x + key.x * tt, plateY, centre.z + key.z * tt);
  plate.updateMatrixWorld();
  const h = new THREE.Vector3(key.x, 0, key.z).normalize();
  cam.position.set(centre.x - h.x * 9.0, centre.y + 0.4, centre.z - h.z * 9.0);
  cam.lookAt(centre);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  engine.camera = cam;
  L.invalidateShadows();
  g.settle(12);
  buildHits();

  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, bbuf);
  const codeBins = bin((i) => bbuf[i + 1]);

  const prevRT = renderer.getRenderTarget();
  renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, cam);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, fbuf);
  renderer.setRenderTarget(prevRT);
  const linBins = bin((i) => 0.2126 * fbuf[i] + 0.7152 * fbuf[i + 1] + 0.0722 * fbuf[i + 2]);

  // Bin 0 is the sphere's north pole: it is the one bin the plate's own bounce
  // and the bloom off the plate edge can reach, and it reads out of line with
  // its own linear value. Report the range both ways rather than pick one.
  const valid = codeBins.filter((v) => v != null);
  const lv = linBins.filter((v) => v != null);
  const v1 = valid.slice(1), l1 = lv.slice(1);
  out.sphere[state][tod] = {
    codeBins: codeBins.map((v) => (v == null ? null : +v.toFixed(1))),
    codeRange: +(Math.max(...valid) - Math.min(...valid)).toFixed(1),
    codeRangeNoPole: +(Math.max(...v1) - Math.min(...v1)).toFixed(1),
    linBins,
    linStops: +Math.log2(Math.max(...lv) / Math.min(...lv)).toFixed(3),
    codesPerStopNoPole: +((Math.max(...v1) - Math.min(...v1)) / Math.log2(Math.max(...l1) / Math.min(...l1))).toFixed(1),
  };
 }
}
pipeline.setToneToe(true);
scene.remove(sphere, plate);
engine.camera = prevCam;
rt.dispose();

/* --- what scene-linear radiance each shipped frame actually contains ------ */
const copyMat = new THREE.ShaderMaterial({
  uniforms: { t: { value: null } },
  vertexShader: 'varying vec2 v; void main(){ v = uv; gl_Position = vec4(position.xy*2.0, 0.0, 1.0); }',
  fragmentShader: 'uniform sampler2D t; varying vec2 v; void main(){ gl_FragColor = texture2D(t, v); }',
  depthTest: false, depthWrite: false,
});
const qs = new THREE.Scene(); qs.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), copyMat));
const qc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const fRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, colorSpace: THREE.NoColorSpace, depthBuffer: false });

out.hdrFloor = {};
for (const shot of ['vista', 'outpost', 'ridge', 'ground', 'gameplay', 'night', 'dawn']) {
  g.applyShot(shot);
  g.settle(8);
  copyMat.uniforms.t.value = pipeline.hdr.texture;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(fRT); renderer.render(qs, qc);
  renderer.readRenderTargetPixels(fRT, 0, 0, W, H, fbuf);
  renderer.setRenderTarget(prev);
  const lum = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) lum[i] = 0.2126 * fbuf[i * 4] + 0.7152 * fbuf[i * 4 + 1] + 0.0722 * fbuf[i * 4 + 2];
  lum.sort();
  const q = (p) => +lum[Math.min(lum.length - 1, Math.floor(p * lum.length))].toFixed(5);
  out.hdrFloor[shot] = { min: q(0), p0001: q(0.0001), p001: q(0.001), p01: q(0.01), p50: q(0.5), ev: +pipeline.exposureInfo.ev.toFixed(3) };
}
fRT.dispose();
return out;
