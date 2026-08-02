/**
 * r11_walk.js — why does a guard on a 60 m walk cover 4.5 m in 20 s?
 *
 * Traces ONE man given a long goal: commanded speed, the speed the animator is
 * actually integrating, the path he was given, and the ground he covers.
 */
const g = window.__GAME;
const W = g.world;
const reg = W.registry;
const ai = reg.ai;
const eng = W.engine;
const out = [];
const run = (n) => { for (let i = 0; i < n; i++) eng.step(1 / 60); };

W.gameState.setMode('play');
run(2);

const pool = ai.roster.pool;
const a = pool[0];
const b = pool.slice(1).sort((p, q) => p.home.distanceToSquared(a.home) - q.home.distanceToSquared(a.home))[0];
const target = b.home.clone();
out.push(`tracing #${a.id} ${a.role} from ${a.ch.position.x.toFixed(1)},${a.ch.position.z.toFixed(1)} `
  + `to ${target.x.toFixed(1)},${target.z.toFixed(1)} — ${a.ch.position.distanceTo(target).toFixed(1)} m`);

a.home.copy(target);
a.enter('return', ai.squad ? { ...W.registry.ai, grid: ai.navGrid, requestPath: () => {} } : null);
// The state machine's own entry, not a hand-built ctx: re-enter through think()
// by clearing the goal and letting tickReturn ask for it.
a.state = 'return';
a.goal = target.clone();
a.goalKind = 'return';
a.path = null;
a.pathI = 0;

let travelled = 0;
let px = a.ch.position.x;
let pz = a.ch.position.z;
for (let s = 0; s < 20; s++) {
  for (let i = 0; i < 60; i++) {
    eng.step(1 / 60);
    travelled += Math.hypot(a.ch.position.x - px, a.ch.position.z - pz);
    px = a.ch.position.x;
    pz = a.ch.position.z;
  }
  const L = a.ch.anim.loco;
  out.push(`t=${s + 1}s state=${a.state.padEnd(9)} goalDist=${a.goalDist().toFixed(1).padStart(5)} `
    + `path=${a.path ? a.path.length : 'none'}/${a.pathI} desired=${(a.desiredSpeed ?? 0).toFixed(2)} `
    + `applied=${a.speedNow.toFixed(2)} smooth=${(L?.smoothSpeed ?? -1).toFixed(2)} `
    + `moving=${(L?.moving ?? -1).toFixed(2)} travelled=${travelled.toFixed(1)} stuck=${a.stuck.toFixed(2)} `
    + `lodTier=${a.ch.lodState?.tier} vis=${a.ch.lodState?.visible}`);
}
out.push(`page errors: ${g.errors.length ? g.errors.slice(0, 3).join(' | ') : 'none'}`);
return out.join('\n');
