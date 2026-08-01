/**
 * (i2) INTEGRATOR, round 7 — SPECULAR EXISTS, ablated on every surface that
 * has a lobe rather than on the handful whose `material.roughness` is live.
 *
 * The round-5/6 probe (c-specular.js) wrote `material.roughness = 1` on every
 * material in the scene and measured nothing. The outpost author is right that
 * on his surfaces that is a NO-OP — and he is not alone: Terrain.js,
 * rocks/RockMaterial.js, outpost/mat.js and characters/materials.js all replace
 * `#include <roughnessmap_fragment>` with `roughnessFactor = <their own g>`, so
 * `material.roughness` is dead code on every surface that matters and the null
 * result was an artefact of the probe.
 *
 * Injecting a late override and forcing a recompile does not work in this tree:
 * several modules capture `shader.uniforms` in `onBeforeCompile` and write to
 * the captured object every frame, so `needsUpdate` silently orphans them and
 * the renderer throws on the next texture upload. This ablates through the
 * uniforms the modules already own, which needs no rebuild:
 *
 *   outpost      registry.outpostGround.setSpecAblate() -> uAbl (gRough = 1,
 *                gMetal = 0 on all 60-odd outpost surfaces)
 *   characters   material.userData.uniforms.uSpecAbl    -> roughness 1, sheen
 *                and specularColor to zero
 *   everything   material.roughness = 1 / metalness = 0, which is live on any
 *   else         material that does NOT inject its own roughnessFactor
 *
 * Terrain and rock are deliberately not driven: their authored roughness is
 * 0.92-0.99 and 0.74-0.99 respectively, so forcing them to 1.0 is inside the
 * noise floor by construction, and neither exposes a uniform to do it with.
 * `coverage` reports exactly how many materials each arm reached.
 *
 * Detector is the acceptance one: luma > 180 AND > 2.0x its 17x17 neighbourhood
 * mean AND > 70 codes above it, strictly below the true horizon.
 */
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer, pipeline = engine.pipeline;
const THREE_ = g.THREE;
const gl = renderer.getContext();
const W = pipeline.width, H = pipeline.height;
const px = new Uint8Array(W * H * 4);

const outpost = g.world.registry.outpostGround;
const charU = [];
const plain = [];
engine.scene.traverse((o) => {
  const m = o.material;
  if (!m) return;
  for (const x of Array.isArray(m) ? m : [m]) {
    if (!x || x.roughness === undefined) continue;
    const u = x.userData && x.userData.uniforms;
    if (u && u.uSpecAbl) { if (!charU.includes(u)) charU.push(u); continue; }
    if (x.userData && x.userData.u && x.userData.u.uAbl) continue;   // outpost
    if (!plain.includes(x)) plain.push(x);
  }
});
const saved = plain.map((m) => [m.roughness, m.metalness]);

function ablate(on) {
  if (outpost && outpost.setSpecAblate) outpost.setSpecAblate(on);
  for (const u of charU) u.uSpecAbl.value = on ? 1 : 0;
  plain.forEach((m, i) => {
    m.roughness = on ? 1 : saved[i][0];
    if (m.metalness !== undefined) m.metalness = on ? 0 : saved[i][1];
  });
}

function horizonRow() {
  const cam = engine.camera;
  const dir = new THREE_.Vector3();
  cam.getWorldDirection(dir);
  const p = new THREE_.Vector3(dir.x, 0, dir.z).normalize().multiplyScalar(1e6).add(cam.position);
  p.y = cam.position.y;
  p.project(cam);
  return Math.round((1 - (p.y * 0.5 + 0.5)) * H);
}

function detect(hz) {
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
  const R = 8, tmp = new Float32Array(W * H), sum = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = -R; x <= R; x++) s += L[y * W + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x++) { tmp[y * W + x] = s; s -= L[y * W + Math.min(W - 1, Math.max(0, x - R))]; s += L[y * W + Math.min(W - 1, Math.max(0, x + R + 1))]; }
  }
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = -R; y <= R; y++) s += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) { sum[y * W + x] = s; s -= tmp[Math.min(H - 1, Math.max(0, y - R)) * W + x]; s += tmp[Math.min(H - 1, Math.max(0, y + R + 1)) * W + x]; }
  }
  const N = (2 * R + 1) * (2 * R + 1);
  // readPixels is bottom-up: rows 0..(H-hz) are below the horizon.
  let all = 0, bright = 0, peak = 0, mean = 0, tot = 0;
  for (let y = 0; y < H - hz; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, l = L[i], m = sum[i] / N;
    tot++; mean += l;
    if (l > peak) peak = l;
    if (l > 180) bright++;
    if (l > 180 && l > 2 * m && l > m + 70) all++;
  }
  return { hits: all, lumaOver180: bright, brightest: Math.round(peak), meanBelowHorizon: +(mean / tot).toFixed(1) };
}

const out = {
  coverage: { outpostSwitch: !!(outpost && outpost.setSpecAblate), characterUniforms: charU.length, plainMaterials: plain.length },
  shots: {},
};
for (const shot of ['ground', 'outpost', 'gameplay', 'night']) {
  g.applyShot(shot);
  g.settle(6);
  const hz = horizonRow();
  ablate(false); g.settle(5);
  const authored = detect(hz);
  ablate(true); g.settle(5);
  const rough1 = detect(hz);
  ablate(false); g.settle(3);
  out.shots[shot] = {
    horizonRow: hz,
    authored,
    rough1,
    deltaHits: authored.hits - rough1.hits,
    deltaOver180: authored.lumaOver180 - rough1.lumaOver180,
    deltaPeak: authored.brightest - rough1.brightest,
  };
}
ablate(false);
g.settle(4);
return out;
