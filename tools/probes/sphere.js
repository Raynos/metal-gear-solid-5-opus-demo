/**
 * ACCEPTANCE TEST — neutral 0.5-grey matte probe sphere in FULL CAST SHADOW,
 * binned by surface normal Y, reported as up-over-down stops.
 *
 * Two readings per configuration:
 *   disp — off the PRESENTED frame (post stack, grade, tonemap), sRGB-decoded.
 *          This is the round-5 ground-truth method and the acceptance number.
 *   lin  — a second forward render straight into a linear-HDR target: no grade,
 *          no lift, no barrel distortion, no grain. The honest radiance ratio.
 *
 * Sweeps `lighting.ambientModel.nearSkyBlock` when given a list, so before/after
 * is one ablation inside one page rather than two builds.
 *
 *   node tools/shot.mjs eval tools/probes/sphere.js
 */
// The free-fly camera system (order 1000) rewrites engine.camera.quaternion
// every step from its own yaw/pitch. On a page where no shot has been applied
// yet it is still armed, and it silently re-aims any camera a probe installs.
g.setFreeFly(false);
const L = g.world.lighting;
const engine = g.engine;
const scene = engine.scene;
const renderer = engine.renderer;
const gl = renderer.getContext();
const terrain = g.world.terrain;

const TODS = ['afternoon', 'noon', 'dusk', 'night'];
const SWEEP = [0, L.ambientModel.nearSkyBlock];

const W = 1920, H = 1080;
const R = 1.35;
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
const NB = 8;
const srgb = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

/** Bin whatever `get(i)` returns (linear luminance) by the sphere's normal Y. */
function bin(get, flipY) {
  const sums = new Float64Array(NB), cnt = new Float64Array(NB);
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
    // Reject the silhouette ring: sub-pixel coverage and grazing normals there
    // are where a rendered probe lies to you.
    if (-(nx * v.x + ny * v.y + nz * v.z) < 0.20) continue;
    const row = flipY ? H - 1 - y : y;
    const i = (row * W + x) * 4;
    sums[Math.min(NB - 1, Math.floor(((1 - ny) / 2) * NB))] += get(i);
    cnt[Math.min(NB - 1, Math.floor(((1 - ny) / 2) * NB))]++;
  }
  const out = [];
  for (let i = 0; i < NB; i++) out.push(cnt[i] > 120 ? +(sums[i] / cnt[i]).toFixed(5) : null);
  const raw = [...sums].map((v, i) => (cnt[i] ? v / cnt[i] : 0));
  const gt = out[1] != null && out[6] != null ? +Math.log2(out[1] / out[6]).toFixed(3) : null;
  return { raw: raw.map(v=>+v.toFixed(5)), cnt: [...cnt], bins: out, stops: +Math.log2(out[0] / out[NB - 1]).toFixed(3), gtStops: gt, px: cnt.reduce((a, b) => a + b, 0) };
}

const results = {};
for (const tod of TODS) {
  const perTod = {};
  for (const nsb of SWEEP) {
    L.ambientModel.nearSkyBlock = nsb;
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

    // (1) the presented, graded frame — the ground-truth method
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, bbuf);
    const disp = bin((i) =>
      0.2126 * srgb(bbuf[i] / 255) + 0.7152 * srgb(bbuf[i + 1] / 255) + 0.0722 * srgb(bbuf[i + 2] / 255), false);

    // (2) the same frame in linear HDR, no post
    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, W, H, fbuf);
    renderer.setRenderTarget(prevRT);
    const lin = bin((i) => 0.2126 * fbuf[i] + 0.7152 * fbuf[i + 1] + 0.0722 * fbuf[i + 2], false);

    perTod['nearSkyBlock=' + nsb] = { dispBins: disp.bins, dispStops: disp.stops, dispGT: disp.gtStops, linBins: lin.bins, linRaw: lin.raw, linCnt: lin.cnt, linStops: lin.stops, linGT: lin.gtStops, px: disp.px };
  }
  results[tod] = perTod;
}

scene.remove(sphere, plate);
engine.camera = prevCam;
rt.dispose();
return results;
