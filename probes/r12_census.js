/**
 * r12_census.js — re-derive the geometry / caster / alpha-test census at the
 * gameplay pose, from the scene graph, after the LOD rings have populated.
 * Six frames is not enough (ARCHITECTURE.md); settle hard first.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
g.applyShot('gameplay');
g.settle(90);

const groups = {};
const cam = eng.camera;
eng.scene.traverse((o) => {
  if (!o.isMesh || !o.visible) return;
  let p = o, hidden = false;
  while (p) { if (!p.visible) hidden = true; p = p.parent; }
  if (hidden) return;
  const n = o.name || o.type;
  const k = /^terrain-L|^terrain/.test(n) ? 'terrain'
    : /talus|apron/i.test(n) ? 'talus'
    : /clast/i.test(n) ? 'clast'
    : /^rock/i.test(n) ? 'rock'
    : /^grass/.test(n) ? 'grass'
    : /scrub|bush|brush|tree|tumble/i.test(n) ? 'scrub'
    : /^op-|outpost|pad|wall|fence|building|container|sandbag|barrel|tent/i.test(n) ? 'outpost'
    : /char|person|soldier|guard|body|head|torso|leg|arm/i.test(n) ? 'char'
    : 'other';
  const geo = o.geometry;
  const per = geo?.index ? geo.index.count / 3 : (geo?.attributes?.position?.count ?? 0) / 3;
  const inst = o.isInstancedMesh ? o.count : 1;
  const G = (groups[k] ??= { meshes: 0, instances: 0, tris: 0, casters: 0, casterTris: 0, alphaTest: 0, transparent: 0, names: {}, mats: {} });
  G.meshes++; G.instances += inst; G.tris += per * inst;
  if (o.castShadow) { G.casters++; G.casterTris += per * inst; }
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  for (const m of mats) {
    if (!m) continue;
    if (m.alphaTest > 0) G.alphaTest++;
    if (m.transparent) G.transparent++;
    const key = `${m.type}${m.alphaTest > 0 ? ' aT=' + m.alphaTest : ''}${m.transparent ? ' TRANSP' : ''}${m.side === 2 ? ' 2side' : ''}`;
    G.mats[key] = (G.mats[key] ?? 0) + 1;
  }
  G.names[n] = Math.round((G.names[n] ?? 0) + per * inst);
});
const out = {};
let total = 0, casterTotal = 0;
for (const [k, v] of Object.entries(groups).sort((a, b) => b[1].tris - a[1].tris)) {
  total += v.tris; casterTotal += v.casterTris;
  out[k] = {
    meshes: v.meshes, instances: v.instances,
    tris: Math.round(v.tris),
    casterMeshes: v.casters, casterTris: Math.round(v.casterTris),
    alphaTestMats: v.alphaTest, transparentMats: v.transparent,
    mats: Object.entries(v.mats).sort((a, b) => b[1] - a[1]).slice(0, 4),
    top: Object.entries(v.names).sort((a, b) => b[1] - a[1]).slice(0, 4),
  };
}
const info = eng.renderer.info.render;
return {
  totalTris: Math.round(total),
  casterTris: Math.round(casterTotal),
  rendererInfo: { calls: info.calls, triangles: info.triangles, frame: info.frame },
  groups: out,
};
