/**
 * Where every soldier lands on screen in a given shot, so the cast can actually
 * be cropped and looked at instead of hunted for. Reports the commander first.
 * usage: probes/run.sh probes/r9_cast.js [shot]
 */
const g = window.__GAME;
const THREE = g.THREE;
const chars = g.world.registry?.characters;
g.applyShot((typeof ARGS !== 'undefined' && ARGS && ARGS[0]) || 'ground');
g.settle(6);
const cam = g.world.engine.camera;
const size = g.world.engine.renderer.getSize(new THREE.Vector2());
const out = [];
for (const c of chars.characters) {
  const p = new THREE.Vector3(c.position.x, c.position.y + 0.95, c.position.z);
  const d = p.distanceTo(cam.position);
  const v = p.clone().project(cam);
  if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) continue;
  // Screen height of a 1.86 m man at this depth, for the 40 px acceptance test.
  const hPx = (1.86 / (2 * d * Math.tan((cam.fov * Math.PI) / 360))) * size.y;
  out.push({
    name: c.name,
    role: c.role ?? '',
    x: Math.round(((v.x + 1) / 2) * size.x),
    y: Math.round(((1 - v.y) / 2) * size.y),
    distM: +d.toFixed(1),
    heightPx: Math.round(hPx),
  });
}
out.sort((a, b) => (b.role === 'commander') - (a.role === 'commander') || a.distM - b.distM);
return out;
