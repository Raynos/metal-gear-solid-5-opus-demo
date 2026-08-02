/**
 * gp_final.js — the invariants that must survive this round, plus the cost of
 * everything added to the frame.
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const reg = W.registry;
const gp = reg.gameplay ?? reg.player;
const eng = W.engine;
const out = [];

// --- the canonical pose survives a round trip through play mode -------------
g.applyShot('gameplay');
g.settle(2);
const ch = reg.characters.player;
const before = { x: ch.position.x, y: ch.position.y, z: ch.position.z, yaw: ch.yaw, stance: ch.anim.stance, aim: ch.anim.aim, fov: eng.camera.fov };
W.gameState.setMode('play');
for (let i = 0; i < 240; i++) eng.step(1 / 60);
W.gameState.setMode('godmode');
const after = { x: ch.position.x, y: ch.position.y, z: ch.position.z, yaw: ch.yaw, stance: ch.anim.stance, aim: ch.anim.aim, fov: eng.camera.fov };
const drift = Math.max(...['x', 'y', 'z', 'yaw', 'aim', 'fov'].map((k) => Math.abs(after[k] - before[k])));
out.push(`parked pose round trip: worst drift ${drift.toExponential(2)}, stance ${before.stance} -> ${after.stance}  ${drift < 1e-9 && before.stance === after.stance ? 'PASS' : 'FAIL'}`);

// --- no gameplay DOM in a harness frame -------------------------------------
const ret = document.querySelector('.gp-ret');
const cs = ret ? getComputedStyle(ret) : null;
out.push(`reticle outside play: present=${!!ret} opacity=${cs?.opacity}  ${cs && +cs.opacity === 0 ? 'PASS' : 'FAIL'}`);

// --- cost --------------------------------------------------------------------
// Time the three systems this round added, by running each in isolation over a
// long enough window that the number is not a scheduling artefact.
W.gameState.setMode('play');
for (let i = 0; i < 60; i++) eng.step(1 / 60);
function timeIt(fn, n) {
  fn(1 / 60); fn(1 / 60);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn(1 / 60);
  return (performance.now() - t0) / n;
}
const vitalsMs = timeIt((dt) => gp.vitals.update(dt), 4000);
const missionMs = timeIt((dt) => gp.missionState.update(dt), 4000);
const reticleMs = timeIt((dt) => gp.reticle.update(dt, eng.camera, true), 2000);
// The dart trace behind the reticle's range readout, at its real 20 Hz rate.
gp.stealth.aimAmount = 1;
const predictMs = timeIt((dt) => { gp.stealth._predictT = 0; gp.stealth._predict(dt); }, 400);
gp.stealth.aimAmount = 0;
out.push(`per-frame cost added: vitals ${vitalsMs.toFixed(4)} ms, mission ${missionMs.toFixed(4)} ms, reticle ${reticleMs.toFixed(4)} ms`);
out.push(`aim trace (throttled to 20 Hz, so 1/3 of a frame's worth at 60 fps): ${predictMs.toFixed(3)} ms per run = ${(predictMs * 20 / 60).toFixed(4)} ms per frame`);

// Collision resolution cost, clear vs in contact.
const ctl = gp.controller;
const site = reg.outpost.bounds.getCenter(new THREE.Vector3());
const hAt = (x, z) => reg.characters.ground.heightAt(x, z);
function moveCost(x, z, yaw) {
  ctl.position.set(x, hAt(x, z), z);
  ctl.footY = ctl.position.y;
  ctl.velocity.set(0, 0, 0);
  ctl.yaw = yaw;
  for (let i = 0; i < 40; i++) ctl.update(1 / 60, { moveX: 0, moveY: 1, camYaw: yaw });
  const t0 = performance.now();
  for (let i = 0; i < 3000; i++) ctl.update(1 / 60, { moveX: 0, moveY: 1, camYaw: yaw });
  return { ms: (performance.now() - t0) / 3000, blocked: ctl.blocked };
}
const open = moveCost(gp.spawnPoint.x, gp.spawnPoint.z, 0);
// Find a real wall and walk into it, so the "in contact" number is measured
// with the slide resolver actually running its sweep.
let wall = null;
for (let a = 0; a < 96 && !wall; a++) {
  const th = (a / 96) * Math.PI * 2;
  for (let r = 18; r < 62; r += 0.4) {
    const x = site.x + Math.sin(th) * r;
    const z = site.z + Math.cos(th) * r;
    if (gp.obstacles.maxIn(x, z, 0.4) > hAt(x, z) + 1.4) { wall = { x, z, th, r }; break; }
  }
}
// Facing inward, i.e. straight at the wall: the controller's forward is
// (-sin yaw, -cos yaw), so yaw = the outward bearing puts the wall dead ahead.
const wallRun = moveCost(
  site.x + Math.sin(wall.th) * (wall.r + 0.9),
  site.z + Math.cos(wall.th) * (wall.r + 0.9),
  wall.th,
);
out.push(`controller.update: ${open.ms.toFixed(4)} ms in the open, ${wallRun.ms.toFixed(4)} ms against geometry (blocked=${wallRun.blocked})`);

W.gameState.setMode('godmode');
out.push(`page errors: ${g.errors.length ? g.errors.slice(0, 4).join(' | ') : 'none'}`);
return out.join('\n');
