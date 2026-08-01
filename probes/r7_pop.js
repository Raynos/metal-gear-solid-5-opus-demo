// How many small clasts actually survive near the play space, and how big are
// they on screen? The value work is pointless if the population is empty.
g.setFreeFly(false);
const rocks = g.world.registry.rocks;
const THREEj = THREE;
const m = new THREEj.Matrix4();
const p = new THREEj.Vector3();
const s = new THREEj.Vector3();
const q = new THREEj.Quaternion();
const out = { perMesh: [] };
const rings = [10, 20, 30, 40, 60, 90, 140];
const tally = {};
for (const mesh of rocks.meshes) {
  const fam = (mesh.name.match(/rock_([a-z]+)/) || [])[1] || '?';
  if (!['chips', 'stones', 'talus'].includes(fam)) continue;
  let alive = 0, zeroed = 0;
  const hist = new Array(rings.length + 1).fill(0);
  let sizeSum = 0;
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    m.decompose(p, q, s);
    if (s.x === 0) { zeroed++; continue; }
    alive++;
    sizeSum += s.x;
    const d = Math.hypot(p.x, p.z);
    let k = rings.findIndex((r) => d < r);
    if (k < 0) k = rings.length;
    hist[k]++;
  }
  tally[fam] ??= { alive: 0, zeroed: 0, hist: new Array(rings.length + 1).fill(0), sizeSum: 0 };
  tally[fam].alive += alive; tally[fam].zeroed += zeroed; tally[fam].sizeSum += sizeSum;
  hist.forEach((v, k) => (tally[fam].hist[k] += v));
}
for (const [k, v] of Object.entries(tally)) {
  v.meanScale = +(v.sizeSum / Math.max(1, v.alive)).toFixed(3);
  delete v.sizeSum;
}
out.rings = rings;
out.byFamily = tally;
out.clearRadii = rocks.clearRadii;
return out;
