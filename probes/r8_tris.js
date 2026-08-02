// ROUND 8. Where do the 4.9 M triangles actually live?
//
// The brief says terrain + rocks + vegetation are "the whole geometry load" and
// that play mode submits ~4.7 M against a 2.5 M budget. Before LODing anything,
// find out which module owns them — and note that perf.js puts scene+shadows at
// 12.4 ms of a 24.5 ms frame with the post chain at 12.1 ms, so triangles are at
// most half the problem.
const engine = g.engine, scene = engine.scene;
const groups = {};
scene.traverse((o) => {
  if (!o.isMesh || !o.visible) return;
  const n = o.name || o.type;
  const k = /^terrain-L/.test(n) ? 'terrain'
    : /talus|apron/i.test(n) ? 'talus'
    : /^rock/i.test(n) ? 'rocks'
    : /^grass/.test(n) ? 'grass'
    : /scrub|bush|brush|tree|tumble/i.test(n) ? 'scrub'
    : /outpost|pad|wall|fence|building|container|sandbag|barrel|tent/i.test(n) ? 'outpost'
    : 'other';
  const geo = o.geometry;
  const per = geo?.index ? geo.index.count / 3 : (geo?.attributes?.position?.count ?? 0) / 3;
  const inst = o.isInstancedMesh ? o.count : 1;
  const g0 = (groups[k] ??= { meshes: 0, instances: 0, tris: 0, names: {} });
  g0.meshes++;
  g0.instances += inst;
  g0.tris += per * inst;
  g0.names[n] = Math.round((g0.names[n] ?? 0) + per * inst);
});
const out = {};
for (const [k, v] of Object.entries(groups).sort((a, b) => b[1].tris - a[1].tris)) {
  out[k] = {
    meshes: v.meshes,
    instances: v.instances,
    tris: Math.round(v.tris),
    top: Object.entries(v.names).sort((a, b) => b[1] - a[1]).slice(0, 4),
  };
}
return out;
