/**
 * r13_pad.js — what actually paints the black polygons on `outpost-pad`.
 *
 * TODO §0 has ruled out the shadow term, the terrain, the corridor, the oil, the
 * wear field and the palette one at a time, and each of those was a separate
 * round trip. This measures every candidate in ONE run by reading the canvas at
 * a band pixel and a lit control pixel under each configuration, so the ratio
 * band/control is directly comparable across all of them.
 *
 * A cause is identified when its ablation moves band/control towards 1.0.
 * Everything that leaves the ratio where it was is not the cause, whatever the
 * absolute code value did.
 */
const g = window.__GAME;
const THREE = g.THREE;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const canvas = eng.renderer.domElement;

g.applyShot('ground');
if (window.__pinDeterminism) window.__pinDeterminism();
g.settle(24);
eng.deterministic = true;
eng.stop();

// Band and control, picked off shots/ground.png: both are bare pad at nearly the
// same depth, one inside the black polygon and one just outside its lower edge.
const BAND = [1150, 775];
const CTRL = [1100, 930];

const c2 = document.createElement('canvas');
c2.width = canvas.width;
c2.height = canvas.height;
const ctx = c2.getContext('2d', { willReadFrequently: true });
const sx = canvas.width / 1920;
const sy = canvas.height / 1080;

function sample(px, py) {
  const d = ctx.getImageData(Math.round(px * sx), Math.round(py * sy), 5, 5).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
  return s / (d.length / 4);
}

const rows = [];
function grab(name) {
  for (let i = 0; i < 8; i++) eng.render();
  ctx.drawImage(canvas, 0, 0);
  const band = sample(BAND[0], BAND[1]);
  const ctrl = sample(CTRL[0], CTRL[1]);
  rows.push({ cfg: name, band: +band.toFixed(1), ctrl: +ctrl.toFixed(1), ratio: +(band / ctrl).toFixed(3) });
}

// The pad's own material, reached through userData.u — `material.uniforms` is
// empty on a MeshStandardMaterial patched by onBeforeCompile.
let pad = null;
g.world.scene.traverse((o) => { if (o.name === 'outpost-pad') pad = o; });
const u = pad?.material?.userData?.u ?? {};
const keys = Object.keys(u);

// Every directional/spot light that casts, so the shadow term can be removed
// without touching a material.
const casters = [];
g.world.scene.traverse((o) => { if (o.isLight && o.castShadow) casters.push(o); });

grab('base');

// 1. Is it albedo at all? uWearCtl.y replaces the whole albedo with a mask
//    visualisation, so if the polygon survives THAT it is not in the albedo.
if (u.uWearCtl) {
  const save = u.uWearCtl.value.clone();
  u.uWearCtl.value.y = 1;
  grab('albedo=maskdebug');
  u.uWearCtl.value.copy(save);
}

// 2. The palette, flattened. All three base colours to one mid grey: every
//    mix() between them collapses, so only the multiplicative terms survive.
if (u.uBase && u.uBase2 && u.uBase3) {
  const s1 = u.uBase.value.clone();
  const s2 = u.uBase2.value.clone();
  const s3 = u.uBase3.value.clone();
  u.uBase.value.setScalar(0.35);
  u.uBase2.value.setScalar(0.35);
  u.uBase3.value.setScalar(0.35);
  grab('palette=flat');
  u.uBase.value.copy(s1); u.uBase2.value.copy(s2); u.uBase3.value.copy(s3);
}

// 3. The wear field, off.
if (u.uWearCtl) {
  const save = u.uWearCtl.value.clone();
  u.uWearCtl.value.x = 0;
  grab('wear=off');
  u.uWearCtl.value.copy(save);
}

// 4. The shadow term, off. `shadow.intensity` needs no recompile.
const saveInt = casters.map((l) => l.shadow.intensity);
casters.forEach((l) => { l.shadow.intensity = 0; });
grab('shadow=off');
casters.forEach((l, i) => { l.shadow.intensity = saveInt[i]; });

// 5. AO, off.
pipe.enabled.ssao = false;
grab('ssao=off');
pipe.enabled.ssao = true;

// 6. Shadow AND AO off together, in case they are compensating for each other.
casters.forEach((l) => { l.shadow.intensity = 0; });
pipe.enabled.ssao = false;
grab('shadow+ssao=off');
casters.forEach((l, i) => { l.shadow.intensity = saveInt[i]; });
pipe.enabled.ssao = true;

// 7. Null control: the same base config measured again, through the same
//    sequence of state changes, so the noise floor of the whole method is on
//    the table next to the results.
grab('base(null control)');

return {
  rows,
  padFound: !!pad,
  padMaterial: pad?.material?.name ?? null,
  uniformKeys: keys,
  casters: casters.map((l) => `${l.type}:${l.name || '(unnamed)'}`),
};
