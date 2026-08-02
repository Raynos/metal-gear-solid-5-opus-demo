/**
 * r11_blob2.js — name the layer that paints the black polygon.
 *
 * r11_blob.js established that the polygon is the `outpost-pad` mesh
 * (material `op-ground`) and not the terrain and not a shadow: hiding that one
 * mesh removes the blob and exposes raw terrain underneath. `op-ground` samples
 * outpost/wear.js's field, whose alpha channel is documented as "spill — oil,
 * diesel, hydraulic — dark and glossy". Read that texture on the CPU at the
 * blob's world position and at a lit control 3 m away, so the handoff to the
 * outpost author is a channel and a value rather than a guess.
 */
const g = window.__GAME;
const THREE = g.THREE;
const world = g.world;

g.applyShot('ground');
if (window.__pinDeterminism) window.__pinDeterminism();
for (let i = 0; i < 8; i++) { g.engine.step(1 / 60); g.engine.render(); }
const cam = g.engine.camera;
cam.updateMatrixWorld();

let pad = null;
world.scene.traverse((o) => {
  if (!pad && o.isMesh && /outpost-pad/.test(o.name || '')) pad = o;
});
if (!pad) return { err: 'no outpost-pad' };
const u = pad.material?.userData?.u ?? pad.material?.uniforms ?? null;
const keys = u ? Object.keys(u) : [];

// Pull the wear map's pixels back onto the CPU through a canvas.
function sampler(tex) {
  if (!tex || !tex.image) return null;
  const img = tex.image;
  const w = img.width, h = img.height;
  const data = img.data;
  if (!data) return null;
  return { w, h, at: (x, y) => {
    const ix = ((Math.round(x) % w) + w) % w;
    const iy = ((Math.round(y) % h) + h) % h;
    const i = (iy * w + ix) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  } };
}

const rc = new THREE.Raycaster();
const W = 1920, H = 1080;
const inv = new THREE.Matrix4().copy(pad.matrixWorld).invert();

const wearTex = u?.uWearMap?.value ?? null;
const lightTex = u?.uWearLightMap?.value ?? u?.uWearMap2?.value ?? null;
const sw = sampler(wearTex);
const sl = sampler(lightTex);

const out = [];
for (const [name, px, py] of [
  ['blob-mid', 1150, 775], ['blob-left', 950, 740], ['lit-control', 1100, 930], ['lit-control2', 700, 950],
]) {
  rc.setFromCamera(new THREE.Vector2((px / W) * 2 - 1, -((py / H) * 2 - 1)), cam);
  const hit = rc.intersectObjects(world.scene.children, true).filter((h) => h.object.visible)[0];
  if (!hit) { out.push({ name, err: 'miss' }); continue; }
  const local = hit.point.clone().applyMatrix4(inv);
  const rec = { name, world: hit.point.toArray().map((v) => +v.toFixed(2)), local: local.toArray().map((v) => +v.toFixed(2)) };
  if (sw) {
    // The pad's wear uv is its own object-space xz (see Terrain._trackWear).
    const org = u.uWearOrg?.value;
    const uu = org ? (local.x - org.x) * org.z : local.x;
    const vv = org ? (local.z - org.y) * org.w : local.z;
    rec.wearUV = [+uu.toFixed(4), +vv.toFixed(4)];
    rec.wearRGBA = sw.at(uu * sw.w, vv * sw.h);
  }
  if (sl) rec.lightRGBA = sl.at(0, 0) ? sl.at(local.x, local.z) : null;
  out.push(rec);
}

return {
  padName: pad.name,
  padMat: pad.material?.name,
  uniformKeys: keys,
  wearOrg: u?.uWearOrg?.value?.toArray?.(),
  wearSize: sw ? [sw.w, sw.h] : null,
  samples: out,
};
