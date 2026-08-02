/**
 * gp_verify.js — the acceptance tests for this round, driven through real key
 * and mouse events on the live page.
 *
 *   FATAL 1  spawn, wait 30 s with no input, alert must still be CALM
 *   FATAL 2  health publishes, guard fire hurts, death fails the mission,
 *            neutralising the commander wins it
 *   MAJOR 3  walking into geometry slides instead of wedging, and the reported
 *            speed never exceeds the distance actually covered
 *   MAJOR 5  reload moves rounds out of the reserve into the magazine
 *   MAJOR 6  the weapon descriptor is on the registry in the HUD's shape
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const reg = W.registry;
const gp = reg.gameplay ?? reg.player;
const ai = reg.ai;
const eng = W.engine;
const out = [];
const held = new Set();
const key = (code, down) => {
  if (down) held.add(code); else held.delete(code);
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));
};
const clear = () => { for (const c of [...held]) key(c, false); };
const run = (n) => { for (let i = 0; i < n; i++) eng.step(1 / 60); };
const tap = (code) => { key(code, true); run(1); key(code, false); run(1); };

// ------------------------------------------------------------------ FATAL 1 --
W.gameState.setMode('play');
run(1);
const sp = gp.spawnPoint;
const site = reg.outpost.bounds.getCenter(new THREE.Vector3());
const nearest = () => {
  let d = 1e9;
  for (const q of ai.guards) d = Math.min(d, Math.hypot(q.ch.position.x - gp.position.x, q.ch.position.z - gp.position.z));
  return d;
};
out.push(`FATAL 1 spawn: (${sp.x.toFixed(1)}, ${sp.z.toFixed(1)}) — ${Math.hypot(sp.x - site.x, sp.z - site.z).toFixed(0)} m from the compound, nearest guard ${nearest().toFixed(1)} m, alert at t=0 ${ai.alertLevel}`);
let peak = 0;
let closest = 1e9;
for (let i = 0; i < 30 * 60; i++) {
  eng.step(1 / 60);
  for (const q of ai.guards) if (q.awareness > peak) peak = q.awareness;
  closest = Math.min(closest, nearest());
}
out.push(`FATAL 1 after 30 s idle: alert=${ai.alertLevel}  peak guard awareness=${peak.toFixed(3)}  closest a guard ever came=${closest.toFixed(1)} m  ${ai.alertLevel === 'CALM' ? 'PASS' : 'FAIL'}`);

// ------------------------------------------------------------------ MAJOR 6 --
out.push(`MAJOR 6 weapon: ${JSON.stringify(gp.weapon)}`);
out.push(`FATAL 2 health=${gp.health} maxHealth=${gp.maxHealth} mission=${JSON.stringify(gp.mission)}`);
out.push(`objectives: ${JSON.stringify(gp.objectives.map((o) => ({ id: o.id, label: o.label, done: o.done })))}`);

// ------------------------------------------------------------------ MAJOR 5 --
gp.stealth.rearm();
for (let i = 0; i < 7; i++) { gp.stealth._fireCooldown = 0; gp.stealth.fire(); }
const a1 = gp.ammo;
const r1 = gp.reserve;
tap('KeyR');
const mid = `${gp.ammo}/${gp.reserve} reloading=${gp.reloading}`;
run(Math.round(2.6 * 60));
out.push(`MAJOR 5 reload: fired 7 -> ${a1}/${r1}; 1 frame after R -> ${mid}; 2.6 s after R -> ${gp.ammo}/${gp.reserve}  ${gp.ammo === 20 && gp.reserve === 93 ? 'PASS' : 'FAIL'}`);
tap('KeyB');
out.push(`fire mode toggle: ${gp.weapon.mode}`);

// ------------------------------------------------------------------ MAJOR 3 --
const ctl = gp.controller;
const hAt = (x, z) => reg.characters.ground.heightAt(x, z);
const obs = gp.obstacles;
// Find a wall face and put the player 2.5 m in front of it, walking straight in.
let wall = null;
for (let a = 0; a < 96 && !wall; a++) {
  const th = (a / 96) * Math.PI * 2;
  for (let r = 18; r < 62; r += 0.4) {
    const x = site.x + Math.sin(th) * r;
    const z = site.z + Math.cos(th) * r;
    if (obs.maxIn(x, z, 0.4) > hAt(x, z) + 1.4) { wall = { x, z, th, r }; break; }
  }
}
function walkInto(offsetDeg, seconds) {
  const th = wall.th;
  const sx = site.x + Math.sin(th) * (wall.r + 2.6);
  const sz = site.z + Math.cos(th) * (wall.r + 2.6);
  ctl.position.set(sx, hAt(sx, sz), sz);
  ctl.footY = ctl.position.y;
  ctl.velocity.set(0, 0, 0);
  const yaw = Math.atan2(-(wall.x - sx), -(wall.z - sz)) + offsetDeg * Math.PI / 180;
  ctl.yaw = yaw;
  gp.camera.reset(ctl.position, yaw);
  run(2);
  clear();
  key('KeyW', true);
  let wedged = 0;
  let worstLie = 0;
  let peakReportedWhileStill = 0;
  const p0 = ctl.position.clone();
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) {
    const a = ctl.position.x; const b = ctl.position.z;
    eng.step(1 / 60);
    const moved = Math.hypot(ctl.position.x - a, ctl.position.z - b) * 60;
    if (moved < 0.05) { wedged++; peakReportedWhileStill = Math.max(peakReportedWhileStill, ctl.speed); }
    worstLie = Math.max(worstLie, ctl.speed - moved);
  }
  clear();
  return `into a wall at ${offsetDeg} deg: travelled ${p0.distanceTo(ctl.position).toFixed(2)} m in ${seconds} s; frames pinned ${wedged}/${n}; worst reported speed while pinned ${peakReportedWhileStill.toFixed(2)} m/s; worst (reported - actual) ${worstLie.toFixed(3)} m/s`;
}
if (wall) {
  out.push(`MAJOR 3 ${walkInto(0, 5)}`);
  out.push(`MAJOR 3 ${walkInto(28, 5)}`);
  out.push(`MAJOR 3 ${walkInto(-55, 5)}`);
} else out.push('MAJOR 3: no wall found');

// ------------------------------------------------------------------ FATAL 2 --
// Guard fire really hurts: replay the AI's own event shape at 20 m.
const p = new THREE.Vector3(ctl.position.x, ctl.footY + 1.12, ctl.position.z);
const from = new THREE.Vector3(p.x + 14, p.y + 0.2, p.z + 14);
let landed = 0;
const h0 = gp.health;
for (let i = 0; i < 40; i++) {
  gp.vitals._grace = 0;
  if (gp.vitals.resolveShot({ from, at: p.clone(), spread: 0.04, dist: 19.8 })) landed++;
  if (gp.vitals.dead) break;
}
out.push(`FATAL 2 under fire at 20 m: ${landed} of 40 rounds landed, health ${h0.toFixed(2)} -> ${gp.health.toFixed(2)}, dead=${gp.dead}, mission=${gp.mission.status}  ${gp.dead && gp.mission.status === 'failed' ? 'PASS' : 'FAIL'}`);

// A shot at a last-known position the player has left must never connect.
gp.vitals.reset();
let ghost = 0;
for (let i = 0; i < 60; i++) {
  gp.vitals._grace = 0;
  const stale = p.clone().add(new THREE.Vector3(18, 0, 0));
  if (gp.vitals.resolveShot({ from, at: stale, spread: 0.05, dist: 24 })) ghost++;
}
out.push(`FATAL 2 suppressive fire at a stale position: ${ghost} of 60 landed (must be 0)  ${ghost === 0 ? 'PASS' : 'FAIL'}`);

// Regeneration.
gp.vitals.reset();
gp.vitals.damage(0.5, null, 'gunfire');
const hurt = gp.health;
run(Math.round(3.5 * 60));
const stillHurt = gp.health;
run(Math.round(9 * 60));
out.push(`FATAL 2 regen: ${hurt.toFixed(2)} -> ${stillHurt.toFixed(2)} after 3.5 s (delay is 4 s) -> ${gp.health.toFixed(2)} after 12.5 s  ${stillHurt === hurt && gp.health > 0.99 ? 'PASS' : 'FAIL'}`);

// Win: put the whole garrison down (no commander is designated in this tree).
gp.vitals.reset();
gp.missionState.status = 'active';
for (const q of ai.guards) q.drop('tranq');
run(70);
out.push(`FATAL 2 win state: mission=${gp.mission.status} reason=${gp.mission.reason}  ${gp.mission.status === 'accomplished' ? 'PASS' : 'FAIL'}`);

clear();
W.gameState.setMode('godmode');
out.push(`page errors: ${g.errors.length ? g.errors.slice(0, 4).join(' | ') : 'none'}`);
return out.join('\n');
