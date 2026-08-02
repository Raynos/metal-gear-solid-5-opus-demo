/**
 * Did the round-8 draw-call cut LOSE anything?
 *
 * 8ec47aa regrouped rock scatter (71 -> 52 meshes) and scrub tiles (67 -> 37) and
 * argues the regrouping is lossless because every new bounding volume strictly
 * contains the old ones. That argument is about CULLING; it says nothing about
 * whether an instance was dropped on the floor during the regroup. This counts
 * the instances that actually exist, so the same probe run against the reverted
 * tree answers it by subtraction rather than by reading the diff.
 *
 * `count` on an InstancedMesh is the number DRAWN, which is what matters, and it
 * can be lower than `instanceMatrix.count` — both are reported.
 */
const g = window.__GAME;
const scene = g.engine.scene;
const groups = {};
scene.traverse((o) => {
  if (!o.isMesh && !o.isInstancedMesh) return;
  // Attribute a mesh to a module by walking up to the nearest named ancestor.
  let n = o, tag = 'unknown';
  while (n) { if (n.name) { tag = n.name; break; } n = n.parent; }
  const G = groups[tag] || (groups[tag] = { meshes: 0, instancesDrawn: 0, instancesAllocated: 0, triangles: 0 });
  G.meshes++;
  const inst = o.isInstancedMesh ? o.count : 1;
  G.instancesDrawn += inst;
  G.instancesAllocated += o.isInstancedMesh ? o.instanceMatrix.count : 1;
  const ix = o.geometry?.index;
  const tris = ix ? ix.count / 3 : (o.geometry?.attributes?.position?.count ?? 0) / 3;
  G.triangles += tris * inst;
});
const total = { meshes: 0, instancesDrawn: 0, triangles: 0 };
for (const G of Object.values(groups)) {
  G.triangles = Math.round(G.triangles);
  total.meshes += G.meshes; total.instancesDrawn += G.instancesDrawn; total.triangles += G.triangles;
}
return {
  total,
  byGroup: Object.fromEntries(Object.entries(groups).sort((a, b) => b[1].instancesDrawn - a[1].instancesDrawn)),
};
