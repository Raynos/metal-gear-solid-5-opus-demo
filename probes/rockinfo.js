const r = g.world.registry.rocks;
const v = g.world.registry.vegetation;
let tris = 0;
for (const m of r.meshes) tris += (m.geometry.attributes.position.count / 3) * m.count;
let ctris = 0;
for (const m of r.collars) ctris += (m.geometry.attributes.position.count / 3) * m.count;
return {
  apronStats: r.apronStats,
  apronTris: r.apron ? r.apron.geometry.index.count / 3 : 0,
  spent: r.spent, rejected: r.rejected,
  rockTris: Math.round(tris), collarTris: Math.round(ctris),
  rockDraws: r.meshes.length + r.collars.length + (r.apron ? 1 : 0),
  veg: v?.stats,
};
