// Is the per-instance palette pick actually reaching the sandbags, and how
// wide is the resulting spread in ALBEDO (not in lit pixels)?
// The renderer no longer injects `g`; probes take their own handle.
const g = window.__GAME;
const scene = g.engine.scene;
const rows = [];
scene.traverse((o) => {
  if (!o.isMesh || !o.material || o.material.name !== 'op-cloth') return;
  const a = o.geometry.attributes.aVar;
  if (!a) return rows.push({ inst: !!o.isInstancedMesh, aVar: 'MISSING' });
  const ys = [];
  for (let i = 0; i < Math.min(a.count, 40); i++) ys.push(+a.getY(i).toFixed(3));
  rows.push({
    inst: !!o.isInstancedMesh,
    count: o.isInstancedMesh ? o.count : 0,
    kind: a.isInstancedBufferAttribute ? 'instanced' : 'per-vertex',
    normalized: !!a.normalized,
    attrCount: a.count,
    firstY: ys.slice(0, 12),
    // How many distinct palette slots the pick actually lands in.
    slots: ys.reduce((s, v) => { s[v < 0.44 ? 0 : v < 0.66 ? 1 : 2]++; return s; }, [0, 0, 0]),
  });
});
return rows.slice(0, 8);
