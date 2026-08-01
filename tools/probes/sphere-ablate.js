/**
 * Probe sphere, run under ablations, so the gradient loss can be attributed.
 *   base    : as shipped
 *   noB     : uAmbBounce zeroed (the sun-gated ground-bounce lobe)
 *   noAO    : uAmbAO.x = 0 (screen-space occlusion + cloud carrier off)
 *   shOnly  : both off -> pure SH light probe
 */
const mod = await import('/src/render/Lighting.js');
const SU = mod.SHARED_UNIFORMS;
// The free-fly camera system (order 1000) rewrites engine.camera.quaternion
// every step from its own yaw/pitch. On a page where no shot has been applied
// yet it is still armed, and it silently re-aims any camera a probe installs.
g.setFreeFly(false);
const L = g.world.lighting;
const engine = g.engine;
const scene = engine.scene;
const renderer = engine.renderer;
const terrain = g.world.terrain;

const TODS = ['afternoon'];
const R = 1.2;
const px = 40, pz = 40;
const centre = new THREE.Vector3(px, terrain.heightAt(px, pz) + 3.0, pz);

const sphere = new THREE.Mesh(
  new THREE.SphereGeometry(R, 96, 64),
  new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(0.5, 0.5, 0.5, THREE.LinearSRGBColorSpace),
    roughness: 1.0, metalness: 0.0, envMapIntensity: 0.0,
  }),
);
sphere.position.copy(centre);
sphere.receiveShadow = true;
scene.add(sphere);

const plate = new THREE.Mesh(
  new THREE.BoxGeometry(60, 1.5, 60),
  new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 1 }),
);
plate.castShadow = true;
scene.add(plate);

const cam = new THREE.PerspectiveCamera(30, 1920 / 1080, 0.1, 3000);
const prevCam = engine.camera;
const rt = new THREE.WebGLRenderTarget(1920, 1080, { type: THREE.FloatType, colorSpace: THREE.NoColorSpace, depthBuffer: true });
const buf = new Float32Array(1920 * 1080 * 4);
const NB = 8;

/** Ramamoorthi irradiance from the probe's own coefficients, per pixel. */
function shLum(nx, ny, nz) {
  const c = L.probe.sh.coefficients;
  const o = [0, 0, 0];
  const w = [
    0.886227,
    2.0 * 0.511664 * ny, 2.0 * 0.511664 * nz, 2.0 * 0.511664 * nx,
    2.0 * 0.429043 * nx * ny, 2.0 * 0.429043 * ny * nz,
    0.743125 * nz * nz - 0.247708,
    2.0 * 0.429043 * nx * nz,
    0.429043 * (nx * nx - ny * ny),
  ];
  for (let i = 0; i < 9; i++) { o[0] += c[i].x * w[i]; o[1] += c[i].y * w[i]; o[2] += c[i].z * w[i]; }
  return (0.5 * (0.2126 * o[0] + 0.7152 * o[1] + 0.0722 * o[2])) / Math.PI;
}

function measure(withPred) {
  const prevRT = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(scene, cam);
  renderer.readRenderTargetPixels(rt, 0, 0, 1920, 1080, buf);
  renderer.setRenderTarget(prevRT);
  const psums = new Float64Array(NB);
  const sums = new Float64Array(NB), cnt = new Float64Array(NB);
  const invP = cam.projectionMatrixInverse, mw = cam.matrixWorld;
  const ro = new THREE.Vector3().setFromMatrixPosition(mw);
  const oc = new THREE.Vector3().subVectors(ro, centre);
  const v = new THREE.Vector3();
  for (let y = 0; y < 1080; y++) for (let x = 0; x < 1920; x++) {
    v.set(((x + 0.5) / 1920) * 2 - 1, ((y + 0.5) / 1080) * 2 - 1, 0.5).applyMatrix4(invP);
    v.applyMatrix4(mw).sub(ro).normalize();
    const b = oc.dot(v), c = oc.lengthSq() - R * R, disc = b * b - c;
    if (disc <= 0) continue;
    const t = -b - Math.sqrt(disc);
    if (t <= 0) continue;
    const ny = (ro.y + v.y * t - centre.y) / R;
    const nx = (ro.x + v.x * t - centre.x) / R;
    const nz = (ro.z + v.z * t - centre.z) / R;
    if (-(nx * v.x + ny * v.y + nz * v.z) < 0.30) continue;
    const i = (y * 1920 + x) * 4;
    const bi = Math.min(NB - 1, Math.floor(((1 - ny) / 2) * NB));
    sums[bi] += 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
    if (withPred) psums[bi] += shLum(nx, ny, nz);
    cnt[bi]++;
  }
  const out = [], pout = [];
  for (let i = 0; i < NB; i++) {
    out.push(cnt[i] > 200 ? +(sums[i] / cnt[i]).toFixed(5) : null);
    pout.push(cnt[i] > 200 ? +(psums[i] / cnt[i]).toFixed(5) : null);
  }
  const r = { bins: out, stops: +Math.log2(out[0] / out[NB - 1]).toFixed(3) };
  if (withPred) {
    r.predBins = pout;
    r.predStops = +Math.log2(pout[0] / pout[NB - 1]).toFixed(3);
  }
  return r;
}

const results = {};
for (const tod of TODS) {
  L.setTimeOfDay(tod);
  const key = L.keyDirection;
  const plateY = centre.y + 16;
  const tt = (plateY - centre.y) / Math.max(key.y, 0.2);
  plate.position.set(centre.x + key.x * tt, plateY, centre.z + key.z * tt);
  plate.updateMatrixWorld();
  const h = new THREE.Vector3(key.x, 0, key.z).normalize();
  cam.position.set(centre.x - h.x * 7.5, centre.y + 0.6, centre.z - h.z * 7.5);
  cam.lookAt(centre);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  engine.camera = cam;
  L.invalidateShadows();
  g.settle(10);

  const b0 = { x: SU.uAmbBounce.x, y: SU.uAmbBounce.y, z: SU.uAmbBounce.z };
  const ao0 = SU.uAmbAO.x;
  const r = {};
  r.base = measure();
  SU.uAmbBounce.x = SU.uAmbBounce.y = SU.uAmbBounce.z = 0;
  r.noB = measure();
  SU.uAmbAO.x = 0;
  r.shOnly = measure(true);
  const pi0 = L.probe.intensity;
  L.probe.intensity = 0;
  r.probeOff = measure();
  L.probe.intensity = pi0;
  Object.assign(SU.uAmbBounce, b0);
  r.noAO = measure();
  SU.uAmbAO.x = ao0;

  results[tod] = r;
}

scene.remove(sphere, plate);
engine.camera = prevCam;
rt.dispose();
return results;
