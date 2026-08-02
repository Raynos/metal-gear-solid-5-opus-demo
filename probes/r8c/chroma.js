// Where the character's colour goes.
//
// Measured on the shipped r8 gameplay PNG the player is ACHROMATIC — R-B
// between -2.3 and +4.5 and saturation 6-7% — in a frame whose own sunlit
// ground manages R-B +13.6, and against a real game whose Snake measures R-B
// +13 in shade and +25..+51 lit at 30-45% saturation. This probe reads the
// LINEAR hdr buffer rather than the encoded PNG, so the answer separates
// "the albedo is neutral", "the light on him is blue" and "an additive lobe is
// diluting him", which the PNG cannot.
//
// Everything is reported per lighting population (sun-lit vs sun-shaded, from
// the geometric N.L, not from a brightness threshold) and against the ground in
// the same frame, so the numbers survive whatever the global grade does.
g.setFreeFly(false);
g.applyShot('gameplay');
g.settle(8);
const engine = g.engine, scene = engine.scene, renderer = engine.renderer;
const pipeline = engine.pipeline;
const player = g.world.registry.characters.player;
const cam = engine.camera;
const W = pipeline.width, H = pipeline.height;

const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: true });
const buf = new Uint8Array(W * H * 4);
const flat = new THREE.MeshBasicMaterial({ color: 0xffffff });
const normalMat = new THREE.MeshNormalMaterial();
function overrideRender(root, mat) {
  const hidden = [];
  scene.traverse((o) => {
    if (o.isMesh || o.isPoints || o.isLine || o.isSprite) {
      let p = o, keep = root === null;
      while (p && root) { if (p === root) { keep = true; break; } p = p.parent; }
      if (o.visible !== keep) { hidden.push([o, o.visible]); o.visible = keep; }
    }
  });
  const bg = scene.background; scene.background = null;
  scene.overrideMaterial = mat;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 1); renderer.clear();
  renderer.render(scene, cam);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
  renderer.setRenderTarget(prev);
  scene.overrideMaterial = null; scene.background = bg;
  for (const [o, v] of hidden) o.visible = v;
  return buf.slice();
}
const maskBuf = overrideRender(player.root, flat);
const mask = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) mask[i] = maskBuf[i * 4] > 127 ? 1 : 0;
const nrmAll = overrideRender(null, normalMat);

// Sun direction, so "lit" is geometry and not brightness.
let sunDir = new THREE.Vector3(0, 1, 0);
let sunCol = new THREE.Vector3(1, 1, 1);
scene.traverse((o) => {
  if (o.isDirectionalLight && o.intensity > 0.01) {
    sunDir.copy(o.position).sub(o.target.position).normalize();
    sunCol.set(o.color.r, o.color.g, o.color.b).multiplyScalar(o.intensity);
  }
});
const camM = new THREE.Matrix3().setFromMatrix4(cam.matrixWorld);
const ndl = new Float32Array(W * H);
{
  const _n = new THREE.Vector3();
  for (let i = 0; i < W * H; i++) {
    _n.set(nrmAll[i * 4] / 127.5 - 1, nrmAll[i * 4 + 1] / 127.5 - 1, nrmAll[i * 4 + 2] / 127.5 - 1);
    if (_n.lengthSq() < 0.2) { ndl[i] = -9; continue; }
    ndl[i] = _n.applyMatrix3(camM).normalize().dot(sunDir);
  }
}

// ---- linear HDR readback (blit half-float -> float first) ------------------
const copyMat = new THREE.ShaderMaterial({
  uniforms: { t: { value: null } },
  vertexShader: 'varying vec2 v; void main(){ v = uv; gl_Position = vec4(position.xy*2.0, 0.0, 1.0); }',
  fragmentShader: 'uniform sampler2D t; varying vec2 v; void main(){ gl_FragColor = texture2D(t, v); }',
  depthTest: false, depthWrite: false,
});
const qs = new THREE.Scene(); qs.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), copyMat));
const qc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const fRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, colorSpace: THREE.NoColorSpace, depthBuffer: false });
const hdr = new Float32Array(W * H * 4);
function readHDR() {
  g.settle(2);
  copyMat.uniforms.t.value = pipeline.hdr.texture;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(fRT);
  renderer.render(qs, qc);
  renderer.readRenderTargetPixels(fRT, 0, 0, W, H, hdr);
  renderer.setRenderTarget(prev);
  return hdr;
}

function mean(px, pick) {
  let n = 0, r = 0, gg = 0, b = 0;
  for (let i = 0; i < W * H; i++) {
    if (!pick(i)) continue;
    n++; r += px[i * 4]; gg += px[i * 4 + 1]; b += px[i * 4 + 2];
  }
  if (!n) return null;
  r /= n; gg /= n; b /= n;
  return {
    n,
    rgb: [r, gg, b].map((v) => +v.toFixed(5)),
    rOverB: +(r / Math.max(b, 1e-9)).toFixed(3),
    gOverR: +(gg / Math.max(r, 1e-9)).toFixed(3),
  };
}

const px = readHDR();
const out = {
  sun: { dir: sunDir.toArray().map((v) => +v.toFixed(3)), colorRoverB: +(sunCol.x / Math.max(sunCol.z, 1e-9)).toFixed(3), color: sunCol.toArray().map((v) => +v.toFixed(3)) },
  playerLit: mean(px, (i) => mask[i] && ndl[i] > 0.25),
  playerShaded: mean(px, (i) => mask[i] && ndl[i] > -9 && ndl[i] < 0.02),
  // Ground in the same frame: the bottom 12% of the image, excluding the player.
  groundAll: mean(px, (i) => !mask[i] && Math.floor(i / W) < H * 0.12),
  groundLit: mean(px, (i) => !mask[i] && Math.floor(i / W) < H * 0.12 && ndl[i] > 0.25),
  groundShaded: mean(px, (i) => !mask[i] && Math.floor(i / W) < H * 0.12 && ndl[i] > -9 && ndl[i] < 0.02),
};

// ---- ablations: which term is diluting the chroma? ------------------------
const mats = Object.values(player.materials);
const setU = (name, v) => { for (const m of mats) if (m.userData.uniforms?.[name]) m.userData.uniforms[name].value = v; };
const getU = (name) => { for (const m of mats) if (m.userData.uniforms?.[name]) return m.userData.uniforms[name].value; return null; };

const ablate = {};
const rimWas = getU('uRimAmt'), sunRimWas = getU('uSunRim'), warmWas = getU('uWarmMix'), bounceWas = getU('uBounceAmt');
function probe(label, apply, undo) {
  apply();
  const p = readHDR();
  ablate[label] = { lit: mean(p, (i) => mask[i] && ndl[i] > 0.25), shaded: mean(p, (i) => mask[i] && ndl[i] > -9 && ndl[i] < 0.02) };
  undo();
}
probe('rimZero', () => { setU('uRimAmt', 0); setU('uSunRim', 0); }, () => { setU('uRimAmt', rimWas); setU('uSunRim', sunRimWas); });
probe('specZero', () => setU('uSpecAbl', 1), () => setU('uSpecAbl', 0));
probe('envZero', () => { for (const m of mats) { m.userData._env = m.envMapIntensity; m.envMapIntensity = 0; } },
  () => { for (const m of mats) m.envMapIntensity = m.userData._env; });
probe('warmMix060', () => setU('uWarmMix', 0.6), () => setU('uWarmMix', warmWas));
probe('bounce030', () => setU('uBounceAmt', 0.3), () => setU('uBounceAmt', bounceWas));
readHDR();

out.shipped = { rim: rimWas, sunRim: sunRimWas, warmMix: warmWas, bounce: bounceWas };
out.ablations = ablate;
rt.dispose();
return out;
