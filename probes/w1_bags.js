// PER-BAG tone variation on the sandbag revetment, measured bag by bag.
//
// Every sandbag is one instance of one of seven meshes, so its screen position
// is exactly computable: project the instance origin, sample a small patch, and
// keep it only if hiding the sandbag meshes changes that patch (which rejects
// bags that are occluded, off screen or behind the camera). The statistic that
// matters is then the spread of MEAN TONE BETWEEN bags, not the variance inside
// one — a revetment of identical pillows has plenty of the latter and none of
// the former.
//
// Run twice: uVarAmt 1 is the shipped frame, uVarAmt 0 pins vOPV to (0,0,0),
// which is exactly what every merged mesh got before geo.js baked aVar through
// the merge, and what the palette selector saw on the instanced ones minus the
// three-tone pick.
// The renderer no longer injects `g`; probes take their own handle.
const g = window.__GAME;
g.setFreeFly(false);
const engine = g.engine;
const renderer = engine.renderer;
const scene = engine.scene;
const gl = renderer.getContext();
const W = engine.pipeline.width;
const H = engine.pipeline.height;
const THREE = g.THREE;

const bagMeshes = [];
const cloths = new Set();
scene.traverse((o) => {
  if (!o.isMesh || !o.material || o.material.name !== 'op-cloth') return;
  cloths.add(o);
  if (o.isInstancedMesh) bagMeshes.push(o);
});

function grab() {
  g.settle(3);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}
function patch(px, x, y) {
  let n = 0;
  let r = 0;
  let gg = 0;
  let b = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const sx = x + dx;
      const sy = y + dy;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      // readPixels rows run BOTTOM-up and so does the NDC y this is projected
      // from, so no flip: putting one in here mirrors every sample point and
      // the visibility test then rejects every bag in the frame.
      const j = (sy * W + sx) * 4;
      r += px[j];
      gg += px[j + 1];
      b += px[j + 2];
      n++;
    }
  }
  return n ? [r / n, gg / n, b / n] : null;
}

function setVar(v) {
  scene.traverse((o) => {
    const u = o.material && o.material.userData && o.material.userData.u;
    if (u && u.uVarAmt) u.uVarAmt.value = v;
  });
}

/**
 * A close pose on the revetment.
 *
 * From the canonical outpost camera a sandbag is about four pixels across, and
 * a 3x3 patch there straddles three bags and their seams — TAA and the
 * downsample then average exactly the differences being measured away. So the
 * headline number is taken from six metres, where a bag is ~60 px and the
 * measurement is of ONE bag, and the distant pose is kept as the "does it
 * survive to the frame the critics look at" figure.
 */
function closeUp() {
  const mat = new THREE.Matrix4();
  const pts = [];
  for (const m of bagMeshes) {
    for (let i = 0; i < m.count; i++) {
      m.getMatrixAt(i, mat);
      const p = new THREE.Vector3(mat.elements[12], mat.elements[13], mat.elements[14]);
      p.applyMatrix4(m.matrixWorld);
      pts.push(p);
    }
  }
  // Densest revetment: the bag with the most neighbours inside 4 m.
  let best = pts[0];
  let bestN = -1;
  for (let i = 0; i < pts.length; i += 3) {
    let n = 0;
    for (let j = 0; j < pts.length; j += 3) if (pts[i].distanceToSquared(pts[j]) < 16) n++;
    if (n > bestN) { bestN = n; best = pts[i]; }
  }
  const cam = engine.camera;
  cam.position.set(best.x + 4.2, best.y + 2.0, best.z + 4.2);
  cam.lookAt(best.x, best.y + 0.5, best.z);
  cam.updateMatrixWorld(true);
}

const out = {};
for (const shot of ['outpost', 'gameplay', 'revetment-6m']) {
  g.applyShot(shot === 'revetment-6m' ? 'outpost' : shot);
  if (shot === 'revetment-6m') closeUp();
  // Screen positions are the same in both passes, so solve visibility once.
  const A0 = grab();
  const prev = [...cloths].map((m) => m.visible);
  cloths.forEach((m) => (m.visible = false));
  const B0 = grab();
  [...cloths].forEach((m, i) => (m.visible = prev[i]));

  const camera = engine.camera;
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const pts = [];
  let inFrame = 0;
  const mat = new THREE.Matrix4();
  const v = new THREE.Vector3();
  for (const m of bagMeshes) {
    for (let i = 0; i < m.count; i++) {
      m.getMatrixAt(i, mat);
      // Sample the CROWN of the bag, not its foot. At the foot the shader's
      // seam-weep term (`c = mix(c, uDust * 1.25, run ...)`) replaces up to 70%
      // of the colour with one shared dust tint, so a sample there measures the
      // weep and not the bag — which is exactly how a first pass of this probe
      // concluded the palette pick was doing nothing.
      v.set(mat.elements[12], mat.elements[13] + 0.17, mat.elements[14]);
      v.applyMatrix4(m.matrixWorld);
      v.project(camera);
      if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;
      inFrame++;
      const x = Math.round(((v.x + 1) / 2) * W);
      const y = Math.round(((v.y + 1) / 2) * H);
      const a = patch(A0, x, y);
      const b = patch(B0, x, y);
      if (!a || !b) continue;
      // The bag has to be what is drawn there, and it has to be big enough on
      // screen to be a bag rather than a speck.
      const d = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
      if (d < 10) continue;
      pts.push([x, y]);
    }
  }

  const res = { meshes: bagMeshes.length, inFrame, candidates: pts.length };
  for (const mode of ['lit', 'flat']) {
    setVar(mode === 'flat' ? 0 : 1);
    const P = grab();
    const L = [];
    const hue = [];
    for (const [x, y] of pts) {
      const c = patch(P, x, y);
      L.push(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);
      hue.push(c[2] / Math.max(1, c[0]));
    }
    const n = L.length;
    const mu = L.reduce((s, x) => s + x, 0) / n;
    const sd = Math.sqrt(L.reduce((s, x) => s + (x - mu) * (x - mu), 0) / n);
    const hm = hue.reduce((s, x) => s + x, 0) / n;
    const hsd = Math.sqrt(hue.reduce((s, x) => s + (x - hm) * (x - hm), 0) / n);
    // Robust spread: the 10-90 range in code values across distinct bags.
    const S = [...L].sort((a, b) => a - b);
    if (!n) continue;
    res[mode] = {
      bags: n,
      meanL: +mu.toFixed(1),
      sdL: +sd.toFixed(2),
      cvPct: +((100 * sd) / mu).toFixed(1),
      p10p90: [Math.round(S[Math.floor(n * 0.1)]), Math.round(S[Math.floor(n * 0.9)])],
      meanBR: +hm.toFixed(3),
      sdBR: +hsd.toFixed(4),
    };
  }
  setVar(1);
  out[shot] = res;
}
return out;
