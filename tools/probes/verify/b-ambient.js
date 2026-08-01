/**
 * (b) DIRECTIONAL AMBIENT — integrator acceptance, round 6.
 *
 * Reproduces the round-5 ground-truth rig exactly: a neutral 0.5-grey matte
 * sphere placed in FULL cast shadow (a shadow-casting plate on the key axis, so
 * direct sun contributes 0 and the only light is ambient), luminance binned by
 * surface normal Y over 8 bins spanning n.y +1..-1, reported as up-over-down
 * stops.
 *
 * Read two ways, because the lighting author is right that display-space moves
 * with the tonemap toe:
 *   disp — the presented, graded frame (the ground-truth number, 0.74 in r5)
 *   lin  — a second forward render into a linear-HDR target, no post at all
 *
 * Also verifies the sphere really is in shadow: `sunFrac` is the fraction of
 * sampled surface receiving any direct sun, computed by ablating the key light
 * (intensity 0) and diffing. If that is not ~0 the measurement is confounded by
 * the sun's own N.L cosine, which is the mistake that produced 4.85 stops.
 */
g.setFreeFly(false);
const L = g.world.lighting;
const engine = g.engine;
const scene = engine.scene;
const renderer = engine.renderer;
const gl = renderer.getContext();
const terrain = g.world.terrain;

const W = 1920, H = 1080, R = 1.35, NB = 8;
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
const srgb = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

// Precompute which pixels hit the sphere and in which normal-Y bin, once.
const hits = [];
{
  const invP = cam.projectionMatrixInverse, mw = cam.matrixWorld;
  // filled after the camera is placed; see place()
  hits.length = 0;
}
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
    // Reject the silhouette ring: sub-pixel coverage and grazing normals lie.
    if (-(nx * v.x + ny * v.y + nz * v.z) < 0.20) continue;
    hits.push((y * W + x) * 4, Math.min(NB - 1, Math.floor(((1 - ny) / 2) * NB)));
  }
}

function bin(get) {
  const sums = new Float64Array(NB), cnt = new Float64Array(NB);
  for (let i = 0; i < hits.length; i += 2) { sums[hits[i + 1]] += get(hits[i]); cnt[hits[i + 1]]++; }
  const bins = [];
  for (let i = 0; i < NB; i++) bins.push(cnt[i] > 120 ? +(sums[i] / cnt[i]).toFixed(5) : null);
  return { bins, stops: +Math.log2(bins[0] / bins[NB - 1]).toFixed(3), px: cnt.reduce((a, b) => a + b, 0) };
}
function linRead() {
  const prevRT = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(scene, cam);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, fbuf);
  renderer.setRenderTarget(prevRT);
  return bin((i) => 0.2126 * fbuf[i] + 0.7152 * fbuf[i + 1] + 0.0722 * fbuf[i + 2]);
}

const out = {};
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
  const disp = bin((i) =>
    0.2126 * srgb(bbuf[i] / 255) + 0.7152 * srgb(bbuf[i + 1] / 255) + 0.0722 * srgb(bbuf[i + 2] / 255));
  const lin = linRead();

  // Shadow check: kill the key and see how much the probe changes.
  const sun = L.sun ?? L.key ?? null;
  let sunFrac = null;
  if (sun) {
    const keep = sun.intensity;
    sun.intensity = 0;
    L.invalidateShadows();
    g.settle(6);
    const noSun = linRead();
    sun.intensity = keep;
    L.invalidateShadows();
    g.settle(6);
    sunFrac = lin.bins.map((v, i) => +(1 - noSun.bins[i] / v).toFixed(4));
  }
  out[tod] = { dispBins: disp.bins, dispStops: disp.stops, linBins: lin.bins, linStops: lin.stops, px: disp.px, sunLeakPerBin: sunFrac };
}

scene.remove(sphere, plate);
engine.camera = prevCam;
rt.dispose();
return out;
