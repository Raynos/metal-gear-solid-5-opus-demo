/**
 * gp_recon.js — read the world's geometry so the spawn can be CHOSEN, not guessed.
 * Reports: outpost bounds/gate, guard posts, patrol extents, current player spawn,
 * distance from spawn to the nearest guard, and terrain profiles on candidate rays.
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const reg = W.registry;
const out = {};

const outpost = reg.outpost;
const chars = reg.characters;
const ai = reg.ai;
const gp = reg.gameplay ?? reg.player;

const b = outpost?.bounds;
const c = b ? b.getCenter(new THREE.Vector3()) : new THREE.Vector3();
out.outpost = b ? {
  center: [+c.x.toFixed(1), +c.z.toFixed(1)],
  min: [+b.min.x.toFixed(1), +b.min.z.toFixed(1)],
  max: [+b.max.x.toFixed(1), +b.max.z.toFixed(1)],
  padLevel: +outpost.padLevel.toFixed(2),
  gate: outpost.gate ? [+outpost.gate.x.toFixed(1), +outpost.gate.z.toFixed(1)] : null,
  theta: outpost.theta,
} : null;

const spawn = chars?.playerSpawn;
out.playerSpawn = spawn ? { x: +spawn.x.toFixed(2), z: +spawn.z.toFixed(2), yaw: +spawn.yaw.toFixed(3) } : null;

const guards = (chars?.characters ?? []).filter((ch) => !ch.isPlayer);
out.guardCount = guards.length;
out.guards = guards.map((ch, i) => ({
  i,
  at: [+ch.position.x.toFixed(1), +ch.position.z.toFixed(1)],
  d: spawn ? +Math.hypot(ch.position.x - spawn.x, ch.position.z - spawn.z).toFixed(1) : null,
}));

// Patrol route extent: worst-case guard reach.
const routes = outpost?.patrolWaypoints ?? [];
out.patrolPoints = routes.flat().map((p) => [+p.x.toFixed(0), +p.z.toFixed(0)]);

const ground = chars?.ground ?? W.terrain;
const hAt = (x, z) => ground.heightAt(x, z);

// Candidate spawns: rings at 80..130 m from the compound centre, 24 bearings.
// Score = distance to the nearest guard/patrol node, plus how much of the
// compound centre is above the local horizon (we want to SEE the compound).
function losClear(ax, az, ay, bx, bz, by, steps) {
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    const y = ay + (by - ay) * t;
    if (hAt(x, z) > y) return false;
  }
  return true;
}
const nodes = out.patrolPoints.concat(guards.map((ch) => [ch.position.x, ch.position.z]));
const cands = [];
for (let r = 78; r <= 132; r += 6) {
  for (let k = 0; k < 36; k++) {
    const a = (k / 36) * Math.PI * 2;
    const x = c.x + Math.sin(a) * r;
    const z = c.z + Math.cos(a) * r;
    const y = hAt(x, z);
    let near = 1e9;
    for (const n of nodes) near = Math.min(near, Math.hypot(x - n[0], z - n[1]));
    // Can we see the compound centre (a man standing there, 1.6 m)?
    const sees = losClear(x, z, y + 1.6, c.x, c.z, hAt(c.x, c.z) + 1.6, 40);
    // Local flatness — do not put the player on a 45 degree scree slope.
    const grad = Math.max(
      Math.abs(hAt(x + 2, z) - hAt(x - 2, z)) / 4,
      Math.abs(hAt(x, z + 2) - hAt(x, z - 2)) / 4,
    );
    cands.push({ a: +a.toFixed(2), r, x: +x.toFixed(1), z: +z.toFixed(1), y: +y.toFixed(1), near: +near.toFixed(1), sees, grad: +grad.toFixed(2) });
  }
}
const good = cands.filter((q) => q.sees && q.grad < 0.28 && q.near > 60);
good.sort((p, q) => (q.y - q.grad * 20 + q.near * 0.1) - (p.y - p.grad * 20 + p.near * 0.1));
out.candidates = good.slice(0, 18);
out.candidateCount = good.length;

// Alert level right now, and after 30 s of play with no input.
if (ai && W.gameState) {
  out.alertBefore = ai.alertLevel;
  W.gameState.setMode('play');
  out.alertOnEnter = ai.alertLevel;
  for (let i = 0; i < 30 * 60; i++) W.engine.step(1 / 60);
  out.alertAfter30s = ai.alertLevel;
  out.playerAfter = gp ? [+gp.position.x.toFixed(1), +gp.position.z.toFixed(1)] : null;
  const rep = ai.report();
  out.guardStates = rep.guards.map((q) => `${q.id}:${q.state}:${q.aware}`);
  W.gameState.setMode('godmode');
}

return out;
