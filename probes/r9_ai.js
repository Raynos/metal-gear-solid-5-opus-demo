/**
 * r9_ai.js — the detection gradient, the alert cycle and the module's cost,
 * measured in the real compound rather than against the headless stub.
 *
 * `node src/ai/_sim.mjs` covers the behaviour against one wall on flat ground.
 * This covers what only the real level can answer: the compound's occlusion in
 * the LOS march, the real nav bake under the sweep, and what the module costs
 * per frame with all of it running.
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const eng = W.engine;
const ai = W.registry.ai;
const chars = W.registry.characters;
if (!ai) return { error: 'no ai module' };

const out = {};
const player = chars.player;
const home = player.position.clone();
const err0 = g.errors.length;

// Step the world, and give up the moment the page starts throwing rather than
// filling the console transport with ten thousand copies of the same error.
function run(frames, each) {
  for (let f = 0; f < frames; f++) {
    if (each && each(f) === false) return f;
    eng.step(1 / 60);
    if ((f & 255) === 0 && g.errors.length > err0 + 4) return -f;
  }
  return frames;
}

// --- detection, on the real ground -----------------------------------------
//
// One guard, everyone else's meter pinned down so nobody escalates the squad
// out from under the measurement. The player is teleported onto the bearing
// the guard is already facing, so this is the perception curve and not a test
// of whether he happens to be looking the right way.
function timeToDetect(gd, { dist, stance, shadow, max = 60 }) {
  ai.setLive(true);
  ai.setShadowOverride(shadow);
  ai.squad.set('CALM', null, 'probe');
  ai.squad.hasLastKnown = false;
  ai.squad.timer = 1e6;
  for (const x of ai.guards) { x.awareness = 0; x.awareReason = null; }
  const a = gd.homeYaw;
  // Pin the guard. He crosses SUSPECT long before DETECT at range and walks off
  // to investigate; with the target teleported to a FIXED bearing that turns
  // the experiment into a measurement of his walking speed. Freeze the man,
  // vary only the thing under test.
  const gp = gd.ch.position.clone();
  const px = gp.x - Math.sin(a) * dist;
  const pz = gp.z - Math.cos(a) * dist;
  let hit = -1;
  const n = run(max * 60, (f) => {
    gd.ch.position.copy(gp);
    gd.desiredSpeed = 0;
    player.position.set(px, home.y, pz);
    player.setStance(stance);
    gd.lookTimer = 1e9;
    gd.lookGoal = gd.homeYaw;
    gd.lookYaw = gd.homeYaw;
    for (const x of ai.guards) if (x !== gd) x.awareness = 0;
    if (gd.awareness >= 1) { hit = f; return false; }
    return true;
  });
  gd.ch.position.copy(gp);
  ai.setShadowOverride(null);
  if (n < 0) return 'page error';
  return hit < 0 ? `>${max}s` : +(hit / 60).toFixed(2);
}

// The man with the longest clear arc, so the number is the perception model and
// not the compound's walls.
function arcReach(gd) {
  const eye = new THREE.Vector3();
  ai.eyeOf(gd.ch, eye);
  let best = 0;
  for (let r = 4; r <= 90; r += 2) {
    const x = gd.ch.position.x - Math.sin(gd.homeYaw) * r;
    const z = gd.ch.position.z - Math.cos(gd.homeYaw) * r;
    if (!ai.navGrid.losClear(eye.x, eye.y, eye.z, x, ai.navGrid.heightAt(x, z) + 1.3, z)) break;
    best = r;
  }
  return best;
}
const probe = ai.guards.slice().sort((a, b) => arcReach(b) - arcReach(a))[0];
out.probeGuard = { role: probe.role, clearArc: arcReach(probe) };
out.detect = {
  '15 m standing, open, still': timeToDetect(probe, { dist: 15, stance: 'stand', shadow: false }),
  '15 m standing, open, walking': null, // filled below — needs real motion
  '40 m crouched, IN SHADOW, still': timeToDetect(probe, { dist: 40, stance: 'crouch', shadow: true, max: 90 }),
  '40 m prone, IN SHADOW, still': timeToDetect(probe, { dist: 40, stance: 'prone', shadow: true, max: 90 }),
  '25 m standing, open, still': timeToDetect(probe, { dist: 25, stance: 'stand', shadow: false }),
  '40 m standing, open, still': timeToDetect(probe, { dist: 40, stance: 'stand', shadow: false }),
  '60 m standing, open, still': timeToDetect(probe, { dist: 60, stance: 'stand', shadow: false }),
  '90 m standing, open, still': timeToDetect(probe, { dist: 90, stance: 'stand', shadow: false, max: 15 }),
};
delete out.detect['15 m standing, open, walking'];

// --- the whole ladder, on the real bake ------------------------------------
player.position.copy(home);
player.setStance('stand');
ai.setLive(true);
ai.squad.set('CALM', null, 'probe');
ai.squad.hasLastKnown = false;
ai.squad.timer = 0;
for (const x of ai.guards) { x.awareness = 0; x.awareReason = null; }

const ladder = [];
let t = 0;
const off = ai.onAlertChange((e) => ladder.push({ at: +t.toFixed(1), to: e.to, why: e.reason }));
const sx = probe.ch.position.x - Math.sin(probe.homeYaw) * 12;
const sz = probe.ch.position.z - Math.cos(probe.homeYaw) * 12;
const trace = [];
const frames = run(60 * 155, (f) => {
  if (f < 60 * 6) { player.position.set(sx, home.y, sz); probe.lookYaw = probe.lookGoal = probe.homeYaw; probe.lookTimer = 1e9; }
  else if (f === 60 * 6) player.position.set(home.x + 600, home.y, home.z + 600);
  if (f % 60 === 0 && f < 60 * 10) {
    trace.push(`${(f / 60)}s aware ${probe.awareness.toFixed(2)} sees ${probe.vis.visible} `
      + `d ${Number.isFinite(probe.vis.dist) ? probe.vis.dist.toFixed(1) : '-'} `
      + `rate ${probe.vis.rate.toFixed(2)} state ${probe.state} ${ai.alertLevel}`);
  }
  t += 1 / 60;
  return true;
});
out.trace = trace;
off();
out.ladderFrames = frames;
out.ladder = ladder;
out.phases = ladder.slice(1).map((e, i) => `${ladder[i].to} for ${(e.at - ladder[i].at).toFixed(1)}s`);
out.endLevel = ai.alertLevel;
out.reserve = ai.reserve;
out.commanderState = ai.commander?.state ?? null;
out.gunfire = ai.gunfire;
out.detectionSnapshot = ai.detection();

// --- what it costs ---------------------------------------------------------
// Same frames, module live vs module in backdrop: the difference is the AI.
function stepCost(live) {
  ai.setLive(live);
  for (let i = 0; i < 30; i++) eng.step(1 / 60);
  const t0 = performance.now();
  for (let i = 0; i < 300; i++) eng.step(1 / 60);
  return (performance.now() - t0) / 300;
}
ai.squad.set('ALERT', player.position, 'cost probe');
player.position.set(home.x, home.y, home.z);
const live = stepCost(true);
const idle = stepCost(false);
out.cost = {
  guards: ai.guards.length,
  emaMs: ai.stats.ms,
  peakMs: ai.stats.msPeak,
  stepLiveMs: +live.toFixed(3),
  stepBackdropMs: +idle.toFixed(3),
  aiOnlyMs: +(live - idle).toFixed(3),
};

player.position.copy(home);
ai.setLive(false);
out.newErrors = g.errors.length - err0;
out.errorText = g.errors.slice(err0, err0 + 3);
return out;
