const rocks = g.world.registry.rocks;
const CLAST = ['chips', 'stones', 'boulders'];
const meshes = (rocks.meshes ?? []).filter((m) => CLAST.some((f) => m.name.includes('rock_' + f)));
const m4 = new THREE.Matrix4();
const cam = g.shots.outpost.position;
let alive = 0; let zeroed = 0;
const bins = {};
for (const mesh of meshes) {
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m4);
    const e = m4.elements;
    if (e[0] === 0 && e[5] === 0 && e[10] === 0) { zeroed++; continue; }
    alive++;
    const d = Math.hypot(e[12] - cam[0], e[14] - cam[2]);
    const b = Math.min(9, Math.floor(d / 50));
    bins[b * 50] = (bins[b * 50] || 0) + 1;
  }
}
return { alive, zeroed, distFromOutpostCam: bins, clearRadii: rocks.clearRadii };
