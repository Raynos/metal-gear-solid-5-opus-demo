/**
 * (a) part 3 — exact part isolation by swapping the INDEX BUFFER.
 *
 * The earlier attempt displaced vertices, which stretches every triangle that
 * straddles the selection boundary across the whole frame; the "body with arms
 * deleted" mask came back larger than the whole character, which is how I know
 * it was wrong. Selecting triangles instead is exact: a triangle is drawn iff
 * all three of its vertices are in the set, and nothing is stretched.
 *
 * The rifle is welded into the skinned mesh (character.js skins it rigidly to
 * handR), so vertex sets are the only handle there is.
 */
g.setFreeFly(false);
const engine = g.engine, scene = engine.scene, renderer = engine.renderer;
const player = g.world.registry.characters.player;
const geo = player.mesh.geometry;
const pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
const bone = player.rig.skeleton.bones.map((b) => b.name);
const bi = Object.fromEntries(bone.map((n, i) => [n, i]));
const idxAttr = geo.index;
const idxSave = idxAttr.array;
const groupsSave = geo.groups.map((g2) => ({ ...g2 }));

const wOf = (i, b) => { let s = 0; for (let c = 0; c < 4; c++) if (si.array[i * 4 + c] === b) s += sw.array[i * 4 + c]; return s; };
const dom = new Int32Array(pos.count);
for (let i = 0; i < pos.count; i++) { let bb = 0, best = 0; for (let c = 0; c < 4; c++) { const w = sw.array[i * 4 + c]; if (w > bb) { bb = w; best = si.array[i * 4 + c]; } } dom[i] = best; }

const isWeapon = new Uint8Array(pos.count);
const isArm = new Uint8Array(pos.count);
for (let i = 0; i < pos.count; i++) {
  isWeapon[i] = wOf(i, bi.handR) > 0.999 ? 1 : 0;
  isArm[i] = (!isWeapon[i] && /^(clav|arm|forearm|hand)/.test(bone[dom[i]])) ? 1 : 0;
}

g.applyShot('gameplay');
g.settle(8);
const W = 960, H = 540;
const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: true });
const buf = new Uint8Array(W * H * 4);
const flat = new THREE.MeshBasicMaterial({ color: 0xffffff });
const cam = engine.camera;
const hidden = [];

function setTris(keepTri) {
  const out = [];
  const groups = [];
  for (const gr of groupsSave) {
    const start = out.length;
    for (let t = gr.start; t < gr.start + gr.count; t += 3) {
      const a = idxSave[t], b = idxSave[t + 1], c = idxSave[t + 2];
      if (keepTri(a, b, c)) out.push(a, b, c);
    }
    groups.push({ start, count: out.length - start, materialIndex: gr.materialIndex });
  }
  geo.setIndex(new THREE.BufferAttribute(idxSave.constructor.from(out), 1));
  geo.clearGroups();
  for (const gr of groups) geo.addGroup(gr.start, gr.count, gr.materialIndex);
}
function restoreTris() {
  geo.setIndex(idxAttr);
  geo.clearGroups();
  for (const gr of groupsSave) geo.addGroup(gr.start, gr.count, gr.materialIndex);
}

function maskOf() {
  scene.traverse((o) => {
    if (o.isMesh || o.isPoints || o.isLine || o.isSprite) {
      let p = o, keep = false;
      while (p) { if (p === player.root) { keep = true; break; } p = p.parent; }
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
  for (const [o, v] of hidden) o.visible = v; hidden.length = 0;
  const m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) m[i] = buf[i * 4] > 127 ? 1 : 0;
  return m;
}
const area = (m) => m.reduce((a, b) => a + b, 0);
const any = (i) => true;

setTris(any); const mAll = maskOf();
setTris((a, b, c) => isWeapon[a] && isWeapon[b] && isWeapon[c]); const mWeapon = maskOf();
setTris((a, b, c) => !(isWeapon[a] || isWeapon[b] || isWeapon[c])); const mNoWeapon = maskOf();
setTris((a, b, c) => !(isWeapon[a] || isWeapon[b] || isWeapon[c] || isArm[a] || isArm[b] || isArm[c])); const mTorso = maskOf();
setTris((a, b, c) => isArm[a] && isArm[b] && isArm[c]); const mArm = maskOf();
restoreTris();
g.settle(2);

function touch(a, b) {
  let t = 0, n = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const p = y * W + x; if (!a[p]) continue; n++;
    if (b[p] || b[p - 1] || b[p + 1] || b[p - W] || b[p + W]) t++;
  }
  return n ? +(t / n).toFixed(4) : null;
}
// components of the FULL silhouette
function comps(m) {
  const lab = new Int32Array(W * H).fill(-1), sizes = [], st = new Int32Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (!m[s] || lab[s] >= 0) continue;
    const id = sizes.length; let n = 0, sp = 0; st[sp++] = s; lab[s] = id;
    while (sp) { const p = st[--sp]; n++; const x = p % W, y = (p / W) | 0;
      if (x > 0 && m[p - 1] && lab[p - 1] < 0) { lab[p - 1] = id; st[sp++] = p - 1; }
      if (x < W - 1 && m[p + 1] && lab[p + 1] < 0) { lab[p + 1] = id; st[sp++] = p + 1; }
      if (y > 0 && m[p - W] && lab[p - W] < 0) { lab[p - W] = id; st[sp++] = p - W; }
      if (y < H - 1 && m[p + W] && lab[p + W] < 0) { lab[p + W] = id; st[sp++] = p + W; } }
    sizes.push(n);
  }
  return sizes.sort((a, b) => b - a);
}
rt.dispose();
return {
  px: { all: area(mAll), weapon: area(mWeapon), weaponVisible: area(mWeapon.map((v, i) => v && mAll[i] ? 1 : 0)),
        arm: area(mArm), armVisible: (() => { let n = 0; for (let i = 0; i < W * H; i++) if (mAll[i] && !mNoWeapon[i] === false && mArm[i]) n++; return n; })(),
        torsoOnly: area(mTorso) },
  fullSilhouetteComponents: comps(mAll).slice(0, 6),
  weaponTouchesTorso_armsPresent: touch(mWeapon, mNoWeapon),
  weaponTouchesTorso_armsDeleted: touch(mWeapon, mTorso),
  weaponTouchesArm: touch(mWeapon, mArm),
  armTouchesTorso: touch(mArm, mTorso),
};
