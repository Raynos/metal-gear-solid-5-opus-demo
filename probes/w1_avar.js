// The renderer no longer injects `g`; probes take their own handle.
const g = window.__GAME;
const scene = g.engine.scene;
const rows = [];
scene.traverse((o) => {
  if (!o.isMesh) return;
  const n = o.name || o.type;
  const mn = (o.material && o.material.name) || '';
  if (!/^op/.test(n) && !/^op-/.test(mn)) return;
  const a = o.geometry.attributes.aVar;
  rows.push({
    name: n, mat: mn,
    tris: (o.geometry.attributes.position ? o.geometry.attributes.position.count / 3 : 0) | 0,
    kind: a ? (a.isInstancedBufferAttribute ? 'inst' : 'vert') : 'NONE',
  });
});
rows.sort((x, y) => y.tris - x.tris);
const tot = rows.reduce((s, r) => s + r.tris, 0);
const none = rows.filter((r) => r.kind === 'NONE');
return {
  meshes: rows.length,
  trisTotal: tot,
  trisNoVar: none.reduce((s, r) => s + r.tris, 0),
  pctNoVar: +((100 * none.reduce((s, r) => s + r.tris, 0)) / tot).toFixed(1),
  worst: none.slice(0, 12).map((r) => r.name + '/' + r.mat + '=' + r.tris),
};
