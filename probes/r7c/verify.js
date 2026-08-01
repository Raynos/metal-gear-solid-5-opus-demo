// Round 6 character acceptance, all four by ABLATION against the same build.
//
//  2. SPECULAR — uSpecAbl drives roughness to 1 and the sheen lobe to 0 on the
//     character materials only, in place, with no rebuild. Counts specular
//     local maxima on the player's pixels and reports the linear delta.
//     (tools/probes/verify/c-specular.js could not have measured this: it sets
//     material.roughness, and every character shader overwrites roughnessFactor
//     from gRough, so material.roughness is dead code here.)
//  4. FORM IN SHADE — bins the player's SHADED-side pixels by geometric normal
//     Y and reports the luminance ramp, then ablates uWrap to 0 to separate the
//     wrapped-diffuse contribution from the directional ambient.
//  3. SILHOUETTE — renders the player alone as a flat mask, box-crops it and
//     downsamples the crop to 40 px tall, then reports how much of the frame
//     the "furniture" (anything outside the core body column) survives at.
g.setFreeFly(false);
const engine = g.engine, scene = engine.scene, renderer = engine.renderer;
const pipeline = engine.pipeline;
const player = g.world.registry.characters.player;
const geo = player.mesh.geometry;
const mats = Object.values(player.materials);
const out = {};

g.applyShot('gameplay');
g.settle(8);
const cam = engine.camera;

// ---- player pixel mask, from a flat override render -----------------------
const W = pipeline.width, H = pipeline.height;
const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: true });
const buf = new Uint8Array(W * H * 4);
const flat = new THREE.MeshBasicMaterial({ color: 0xffffff });
function maskOf(root) {
  const hidden = [];
  scene.traverse((o) => {
    if (o.isMesh || o.isPoints || o.isLine || o.isSprite) {
      let p = o, keep = false;
      while (p) { if (p === root) { keep = true; break; } p = p.parent; }
      if (o.visible !== keep) { hidden.push([o, o.visible]); o.visible = keep; }
    }
  });
  const bg = scene.background; scene.background = null;
  scene.overrideMaterial = flat;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 1); renderer.clear();
  renderer.render(scene, cam);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
  renderer.setRenderTarget(prev);
  scene.overrideMaterial = null; scene.background = bg;
  for (const [o, v] of hidden) o.visible = v;
  const m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) m[i] = buf[i * 4] > 127 ? 1 : 0;
  return m;
}
// world-space normals of the player, same framing, so pixels can be binned
const normalMat = new THREE.MeshNormalMaterial();
function normalsOf(root) {
  const hidden = [];
  scene.traverse((o) => {
    if (o.isMesh || o.isPoints || o.isLine || o.isSprite) {
      let p = o, keep = false;
      while (p) { if (p === root) { keep = true; break; } p = p.parent; }
      if (o.visible !== keep) { hidden.push([o, o.visible]); o.visible = keep; }
    }
  });
  const bg = scene.background; scene.background = null;
  scene.overrideMaterial = normalMat;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 1); renderer.clear();
  renderer.render(scene, cam);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
  renderer.setRenderTarget(prev);
  scene.overrideMaterial = null; scene.background = bg;
  for (const [o, v] of hidden) o.visible = v;
  return buf.slice();
}
const mask = maskOf(player.root);
const nrm = normalsOf(player.root);
g.settle(2);

/**
 * A per-ZONE pixel mask, by painting one cloth zone white and every other zone
 * black on the player's own material and rendering the beauty pass.
 *
 * Binning the whole character by normal Y and calling the result "the ambient
 * ramp" is wrong, and it is what the first run of this probe did: the down-
 * facing bins are dominated by pale sleeve and trouser undersides (albedo
 * 0.25) and the up-facing bins by dark pack and webbing tops (0.12-0.20), so
 * the albedo ladder is being measured, not the light. Restricted to ONE zone
 * the albedo is constant to within its own mottle and the ramp is the light.
 */
/**
 * A per-zone pixel mask built from GEOMETRY, by swapping the index buffer to
 * the triangles whose three vertices all carry that zone and rendering the flat
 * override — the same technique tools/probes/verify/a3-character.js uses.
 *
 * Two pixel-space attempts failed first and both failed silently, which is why
 * this is worth the code:
 *   1. "paint zone white, everything else black, threshold" leaks, because the
 *      specular / sheen / rim lobes are not multiplied by diffuseColor and with
 *      the round-6 F0 ladder a BLACK zone in sun still clears any threshold.
 *   2. "difference of two renders, zone black vs zone white" also leaks — it
 *      returned 13,012 hair pixels on a head whose whole projected area is
 *      about 4,800 — because changing what is in the frame changes the frame,
 *      so the difference is non-zero on pixels the zone never touched.
 * Selecting triangles cannot be fooled by either.
 */
const idxAttr = geo.index;
const idxSave = idxAttr.array;
const groupsSave = geo.groups.map((g2) => ({ ...g2 }));
function setTris(keep) {
  const outIdx = [];
  const groups = [];
  for (const gr of groupsSave) {
    const start = outIdx.length;
    for (let t = gr.start; t < gr.start + gr.count; t += 3) {
      const a = idxSave[t], b = idxSave[t + 1], c = idxSave[t + 2];
      if (keep(a, b, c, gr.materialIndex)) outIdx.push(a, b, c);
    }
    groups.push({ start, count: outIdx.length - start, materialIndex: gr.materialIndex });
  }
  geo.setIndex(new THREE.BufferAttribute(idxSave.constructor.from(outIdx), 1));
  geo.clearGroups();
  for (const gr of groups) geo.addGroup(gr.start, gr.count, gr.materialIndex);
}
function restoreTris() {
  geo.setIndex(idxAttr);
  geo.clearGroups();
  for (const gr of groupsSave) geo.addGroup(gr.start, gr.count, gr.materialIndex);
}
const zoneAttr = geo.attributes.aZone;
const matIndexOf = player.mesh.material.map((m) => m.name);
function partMask(matName, zi) {
  const mi = matIndexOf.indexOf(matName);
  setTris((a, b, c, m) => m === mi
    && Math.round(zoneAttr.getX(a)) === zi
    && Math.round(zoneAttr.getX(b)) === zi
    && Math.round(zoneAttr.getX(c)) === zi);
  const m = maskOf(player.root);
  restoreTris();
  let n = 0;
  for (let i = 0; i < W * H; i++) { if (m[i] && mask[i]) n++; else m[i] = 0; }
  return { m, n };
}
const zoneMask = (zi) => partMask('char-cloth', zi);

// MeshNormalMaterial writes VIEW-space normals; rotate the camera basis back.
const camM = new THREE.Matrix3().setFromMatrix4(cam.matrixWorld);
const _n = new THREE.Vector3();
const worldNy = new Float32Array(W * H);
for (let i = 0; i < W * H; i++) {
  if (!mask[i]) continue;
  _n.set(nrm[i * 4] / 127.5 - 1, nrm[i * 4 + 1] / 127.5 - 1, nrm[i * 4 + 2] / 127.5 - 1)
    .applyMatrix3(camM).normalize();
  worldNy[i] = _n.y;
}

// ---- HDR readback ---------------------------------------------------------
// pipeline.hdr is a HALF-float target; readRenderTargetPixels into a
// Float32Array off it comes back all zeroes on this driver (which is how the
// first version of this probe reported a 0.00-stop ramp). Blit through a
// FloatType target first, exactly as tools/probes/verify/d-horizon.js does.
const copyMat = new THREE.ShaderMaterial({
  uniforms: { t: { value: null } },
  vertexShader: 'varying vec2 v; void main(){ v = uv; gl_Position = vec4(position.xy*2.0, 0.0, 1.0); }',
  fragmentShader: 'uniform sampler2D t; varying vec2 v; void main(){ gl_FragColor = texture2D(t, v); }',
  depthTest: false, depthWrite: false,
});
const qs = new THREE.Scene(); qs.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), copyMat));
const qc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const fRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, colorSpace: THREE.NoColorSpace, depthBuffer: false });
const hdrBuf = new Float32Array(W * H * 4);
function readHDR() {
  g.settle(2);
  copyMat.uniforms.t.value = pipeline.hdr.texture;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(fRT);
  renderer.render(qs, qc);
  renderer.readRenderTargetPixels(fRT, 0, 0, W, H, hdrBuf);
  renderer.setRenderTarget(prev);
  return hdrBuf;
}
const LUM = (r, gg, b) => 0.2126 * r + 0.7152 * gg + 0.0722 * b;

// Sun direction in world space, so "shaded" is a geometric fact rather than a
// brightness threshold (which would be circular: the thing being measured IS
// brightness).
let sunDir = new THREE.Vector3(0, 1, 0);
scene.traverse((o) => { if (o.isDirectionalLight && o.intensity > 0.01) sunDir.copy(o.position).sub(o.target.position).normalize(); });
const ndl = new Float32Array(W * H);
{
  const _m = new THREE.Vector3();
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    _m.set(nrm[i * 4] / 127.5 - 1, nrm[i * 4 + 1] / 127.5 - 1, nrm[i * 4 + 2] / 127.5 - 1)
      .applyMatrix3(camM).normalize();
    ndl[i] = _m.dot(sunDir);
  }
}

function stats(px) {
  let lit = 0, shaded = 0, sumL = 0, sumS = 0;
  const bins = new Array(6).fill(null).map(() => ({ n: 0, sum: 0 }));
  // Only pixels the key CANNOT reach. This is the population the directional
  // ambient and the sky reflection have to carry on their own.
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    const L = LUM(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
    if (ndl[i] <= 0.02) {
      const b = Math.min(5, Math.max(0, Math.floor((worldNy[i] + 1) * 3)));
      bins[b].n++; bins[b].sum += L;
      shaded++; sumS += L;
    } else { lit++; sumL += L; }
  }
  // Terminator band: the only pixels a wrap term can change at all.
  let tn = 0, tsum = 0;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || ndl[i] < -0.35 || ndl[i] > 0.5) continue;
    tn++; tsum += LUM(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
  }
  return {
    litN: lit, shadedN: shaded,
    litMean: lit ? +(sumL / lit).toFixed(4) : 0,
    shadedMean: shaded ? +(sumS / shaded).toFixed(5) : 0,
    terminatorN: tn, terminatorMean: tn ? +(tsum / tn).toFixed(5) : 0,
    byNormalY: bins.map((b, i) => ({
      nyBand: [-1 + i / 3, -1 + (i + 1) / 3].map((v) => +v.toFixed(2)),
      n: b.n, mean: b.n ? +(b.sum / b.n).toFixed(5) : 0,
    })),
  };
}

// specular local maxima on the player, in linear
function highlights(px, thresh) {
  let n = 0, sum = 0;
  for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
    const i = y * W + x;
    if (!mask[i]) continue;
    const L = LUM(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
    if (L < thresh) continue;
    let isMax = true;
    for (let dy = -2; dy <= 2 && isMax; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (!dx && !dy) continue;
      const j = i + dy * W + dx;
      if (LUM(px[j * 4], px[j * 4 + 1], px[j * 4 + 2]) > L) { isMax = false; break; }
    }
    if (isMax) { n++; sum += L; }
  }
  return { count: n, meanPeak: n ? +(sum / n).toFixed(4) : 0 };
}

// ---- A: specular ablation -------------------------------------------------
const setU = (name, v) => { for (const m of mats) if (m.userData.uniforms?.[name]) m.userData.uniforms[name].value = v; };
let px = readHDR();
const onStats = stats(px);
const onHi = highlights(px, 0.05);
let totalOn = 0; for (let i = 0; i < W * H; i++) if (mask[i]) totalOn += LUM(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);

setU('uSpecAbl', 1);
px = readHDR();
const offStats = stats(px);
const offHi = highlights(px, 0.05);
let totalOff = 0; for (let i = 0; i < W * H; i++) if (mask[i]) totalOff += LUM(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
setU('uSpecAbl', 0);

out.specular = {
  maskPx: mask.reduce((a, b) => a + b, 0),
  on: onHi, ablated: offHi,
  highlightCountRatio: offHi.count ? +(onHi.count / offHi.count).toFixed(2) : null,
  linearEnergyOn: +totalOn.toFixed(1), linearEnergyAblated: +totalOff.toFixed(1),
  energyDeltaPct: +(((totalOn - totalOff) / totalOff) * 100).toFixed(2),
};

// ---- B: wrapped diffuse ablation + normal-Y ramp --------------------------
const cloth = player.materials.cloth.userData.uniforms;
const wrapWas = cloth.uWrap.value;
px = readHDR();
const wrapOn = stats(px);
cloth.uWrap.value = 0;
px = readHDR();
const wrapOff = stats(px);
cloth.uWrap.value = wrapWas;
readHDR();

const ramp = (s) => {
  const b = s.byNormalY.filter((x) => x.n > 200);
  if (b.length < 2) return null;
  const lo = b[0].mean, hi = b[b.length - 1].mean;
  return { bands: b, stopsUpOverDown: +(Math.log2(Math.max(hi, 1e-6) / Math.max(lo, 1e-6))).toFixed(2) };
};
out.formInShade = {
  wrap: wrapWas,
  sunDir: sunDir.toArray().map((v) => +v.toFixed(3)),
  rampShadedOnly: ramp(wrapOn),
  shadedMeanWrapOn: wrapOn.shadedMean, shadedMeanWrapOff: wrapOff.shadedMean,
  terminatorBand: [-0.35, 0.5],
  terminator: {
    px: wrapOn.terminatorN,
    wrapOn: wrapOn.terminatorMean,
    wrapOff: wrapOff.terminatorMean,
    stopsLifted: +(Math.log2(Math.max(wrapOn.terminatorMean, 1e-6) / Math.max(wrapOff.terminatorMean, 1e-6))).toFixed(3),
    pctLifted: +(((wrapOn.terminatorMean - wrapOff.terminatorMean) / Math.max(wrapOff.terminatorMean, 1e-9)) * 100).toFixed(2),
  },
};

// ---- B2: the same ramp on ONE zone, so albedo is constant -----------------
// Sleeve (1) and jacket (0): the two biggest single-albedo areas on the body.
out.formInShadeByZone = {};
const clothRim = player.materials.cloth.userData.uniforms.uRimAmt;
const rimNow = clothRim.value;
function zoneRamp(zm, px2) {
  const bins = new Array(6).fill(null).map(() => ({ n: 0, sum: 0 }));
  for (let i = 0; i < W * H; i++) {
    if (!zm.m[i] || ndl[i] > 0.02) continue;
    const b = Math.min(5, Math.max(0, Math.floor((worldNy[i] + 1) * 3)));
    bins[b].n++; bins[b].sum += LUM(px2[i * 4], px2[i * 4 + 1], px2[i * 4 + 2]);
  }
  const used = bins.map((b, i) => ({ ny: +(-1 + (i + 0.5) / 3).toFixed(2), n: b.n, mean: b.n ? +(b.sum / b.n).toFixed(5) : 0 }))
    .filter((b) => b.n > 150);
  let monotone = true;
  for (let i = 1; i < used.length; i++) if (used[i].mean < used[i - 1].mean * 0.97) monotone = false;
  return {
    bands: used, monotoneUpward: monotone,
    stopsUpOverDown: used.length > 1
      ? +(Math.log2(used[used.length - 1].mean / Math.max(used[0].mean, 1e-6))).toFixed(2) : null,
    stopsUpOverSide: used.length > 2
      ? +(Math.log2(used[used.length - 1].mean / Math.max(used[Math.floor(used.length / 2) - 1].mean, 1e-6))).toFixed(2) : null,
  };
}
for (const [name, zi] of [['jacket', 0], ['sleeve', 1], ['trouser', 2]]) {
  const zm = zoneMask(zi);
  out.formInShadeByZone[name] = { zonePx: zm.n, shipped: zoneRamp(zm, readHDR()) };
  if (name === 'jacket') {
    // ABLATION: the rim is the thing accused of flattening the ramp, so run
    // the same bins at rim 0 and at round 5's 0.22 on the same build.
    clothRim.value = 0; out.formInShadeByZone[name].rimZero = zoneRamp(zm, readHDR());
    clothRim.value = 0.22; out.formInShadeByZone[name].rimRound5 = zoneRamp(zm, readHDR());
    clothRim.value = rimNow; readHDR();
  }
}

// ---- B3: is the hair/skin albedo step surviving the encode? ---------------
// The authored ratio is 0.348 skin over 0.083 hair = 2.07 stops. If the linear
// render holds that and the PNG does not, the loss is in the display encode,
// which is this round's headline finding rather than a character defect.
{
  const hm = zoneMask(16);
  const sk = partMask('char-skin', 1); // SZ.NECK
  const px3 = readHDR();
  const mean = (m) => { let n = 0, s = 0; for (let i = 0; i < W * H; i++) if (m[i]) { n++; s += LUM(px3[i * 4], px3[i * 4 + 1], px3[i * 4 + 2]); } return n ? s / n : 0; };
  const mh = mean(hm.m), ms = mean(sk.m);
  out.hairVsSkin = {
    hairPx: hm.n, neckSkinPx: sk.n,
    hairLinear: +mh.toFixed(5), skinLinear: +ms.toFixed(5),
    stopsSkinOverHair: +Math.log2(Math.max(ms, 1e-6) / Math.max(mh, 1e-6)).toFixed(2),
    authoredAlbedoStops: +Math.log2(0.348 / 0.083).toFixed(2),
  };
}

// ---- C: 40 px silhouette --------------------------------------------------
let x0 = W, x1 = 0, y0 = H, y1 = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) {
  if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
}
const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
const TH = 40, TW = Math.max(1, Math.round((bw / bh) * TH));
let small = '';
const cov = [];
for (let ty = 0; ty < TH; ty++) {
  let row = '';
  for (let tx = 0; tx < TW; tx++) {
    let n = 0, tot = 0;
    // mask rows are BOTTOM-UP; ty = 0 must be the top of the figure.
    const sy1 = y1 - Math.floor((ty / TH) * bh), sy0 = y1 - Math.floor(((ty + 1) / TH) * bh);
    const sx0 = x0 + Math.floor((tx / TW) * bw), sx1 = x0 + Math.floor(((tx + 1) / TW) * bw);
    for (let y = Math.max(y0, sy0); y <= Math.min(y1, sy1); y++) for (let x = sx0; x < Math.max(sx0 + 1, sx1); x++) {
      tot++; if (mask[y * W + x]) n++;
    }
    const f = tot ? n / tot : 0;
    cov.push(f);
    row += f > 0.6 ? '#' : f > 0.25 ? '+' : f > 0.05 ? '.' : ' ';
  }
  small += row + '\n';
}
out.silhouette40 = {
  bboxPx: [bw, bh], gridWxH: [TW, TH],
  filledCells: cov.filter((f) => f > 0.25).length,
  edgeCells: cov.filter((f) => f > 0.05 && f <= 0.6).length,
  art: small,
};
rt.dispose();
return out;
