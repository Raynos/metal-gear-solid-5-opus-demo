/**
 * gp_spawnsim.js — the acceptance test for FATAL 1, run against candidate spawns.
 *
 * For each candidate: enter play, teleport the controller there, run 30 s of
 * simulation with NO input, report the squad's alert level and the peak
 * awareness any guard reached. CALM with peak < NOTICE is the pass.
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const reg = W.registry;
const ai = reg.ai;
const gp = reg.gameplay ?? reg.player;
const chars = reg.characters;
const c = reg.outpost.bounds.getCenter(new THREE.Vector3());
const hAt = (x, z) => chars.ground.heightAt(x, z);

const CANDS = JSON.parse(ARGS[0] ?? '[]');
const SECONDS = +(ARGS[1] ?? 30);
const lines = [];

function trial(x, z) {
  W.gameState.setMode('godmode');
  W.gameState.setMode('play');
  const ctl = gp.controller;
  ctl.position.set(x, hAt(x, z), z);
  ctl.footY = ctl.position.y;
  ctl.velocity.set(0, 0, 0);
  // Face the compound.
  const yaw = Math.atan2(-(c.x - x), -(c.z - z));
  ctl.yaw = yaw;
  gp.camera.reset(ctl.position, yaw);
  let peak = 0;
  let firstNonCalm = -1;
  const n = Math.round(SECONDS * 60);
  for (let i = 0; i < n; i++) {
    W.engine.step(1 / 60);
    for (const q of ai.guards) if (q.awareness > peak) peak = q.awareness;
    if (firstNonCalm < 0 && ai.alertLevel !== 'CALM') firstNonCalm = +(i / 60).toFixed(1);
  }
  const d = Math.hypot(ctl.position.x - c.x, ctl.position.z - c.z);
  const r = `x=${x.toFixed(1)} z=${z.toFixed(1)} dist=${d.toFixed(0)} alert=${ai.alertLevel} peakAware=${peak.toFixed(3)} firstNonCalm=${firstNonCalm}`;
  W.gameState.setMode('godmode');
  return r;
}

// Baseline: whatever the shipped build spawns at.
W.gameState.setMode('play');
let basePeak = 0;
for (let i = 0; i < Math.round(SECONDS * 60); i++) {
  W.engine.step(1 / 60);
  for (const q of ai.guards) if (q.awareness > basePeak) basePeak = q.awareness;
}
lines.push(`BASELINE at (${gp.position.x.toFixed(1)}, ${gp.position.z.toFixed(1)}): alert=${ai.alertLevel} peakAware=${basePeak.toFixed(3)}`);
W.gameState.setMode('godmode');

for (const [x, z] of CANDS) lines.push(trial(x, z));
return lines.join('\n');
