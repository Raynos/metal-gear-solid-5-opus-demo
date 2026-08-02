/** gp_pocket.js — at the wedge point, which directions are actually legal? */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const reg = W.registry;
const gp = reg.gameplay ?? reg.player;
const eng = W.engine;
const out = [];
const key = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));

W.gameState.setMode('play');
eng.step(1 / 60);
const ctl = gp.controller;
const obs = gp.obstacles;
const site = reg.outpost.bounds.getCenter(new THREE.Vector3());
const hAt = (x, z) => reg.characters.ground.heightAt(x, z);

// Walk into the same wall until pinned.
let wall = null;
for (let a = 0; a < 96 && !wall; a++) {
  const th = (a / 96) * Math.PI * 2;
  for (let r = 18; r < 62; r += 0.4) {
    const x = site.x + Math.sin(th) * r;
    const z = site.z + Math.cos(th) * r;
    if (obs.maxIn(x, z, 0.4) > hAt(x, z) + 1.4) { wall = { x, z, th, r }; break; }
  }
}
const sx = site.x + Math.sin(wall.th) * (wall.r + 2.6);
const sz = site.z + Math.cos(wall.th) * (wall.r + 2.6);
ctl.position.set(sx, hAt(sx, sz), sz);
ctl.footY = ctl.position.y;
ctl.velocity.set(0, 0, 0);
ctl.yaw = Math.atan2(-(wall.x - sx), -(wall.z - sz)) + 28 * Math.PI / 180;
gp.camera.reset(ctl.position, ctl.yaw);
eng.step(1 / 60);
key('KeyW', true);
for (let i = 0; i < 150; i++) eng.step(1 / 60);
key('KeyW', false);

const p = ctl.position;
out.push(`pinned at (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) footY=${ctl.footY.toFixed(2)} ground=${hAt(p.x, p.z).toFixed(2)} obsMax(r=0.34)=${obs.maxIn(p.x, p.z, 0.34).toFixed(2)} obsPoint=${obs.heightAt(p.x, p.z).toFixed(2)} step=${ctl.env.step}`);
out.push(`stance=${ctl.stance} blocked=${ctl.blocked} v=(${ctl.velocity.x.toFixed(2)},${ctl.velocity.z.toFixed(2)}) speed=${ctl.speed.toFixed(2)}`);

// Which directions can he step 60 mm in?
let legal = '';
for (let k = 0; k < 16; k++) {
  const a = (k / 16) * Math.PI * 2;
  const x0 = p.x; const z0 = p.z;
  const r = ctl._try(Math.cos(a) * 0.06, Math.sin(a) * 0.06);
  p.x = x0; p.z = z0;
  legal += `${(a * 180 / Math.PI) | 0}:${r === 0 ? 'ok' : r === 1 ? 'solid' : 'slope'}  `;
}
out.push('60 mm probe by direction — ' + legal);

// What the field looks like right here, 0.25 m grid, relative to footY.
let grid = '';
for (let dz = -4; dz <= 4; dz++) {
  for (let dx = -4; dx <= 4; dx++) {
    const h = obs.heightAt(p.x + dx * 0.25, p.z + dz * 0.25);
    grid += (h < -1e8 ? '  .  ' : (h - ctl.footY).toFixed(1).padStart(5));
  }
  grid += '\n';
}
out.push('obstacle height minus footY, 0.25 m grid (+z down the page):\n' + grid);
out.push(`terrain here vs 1 m out: ${hAt(p.x, p.z).toFixed(2)} / ${hAt(p.x + 1, p.z).toFixed(2)} ${hAt(p.x - 1, p.z).toFixed(2)} ${hAt(p.x, p.z + 1).toFixed(2)} ${hAt(p.x, p.z - 1).toFixed(2)}`);

W.gameState.setMode('godmode');
return out.join('\n');
