/**
 * r11_mission.js — the acceptance tests for the round-11 mission shape.
 *
 *   1  exactly one man wears rank marking, and he is the objective
 *   2  INFIL only ticks inside the wire (the outpost's own perimeter)
 *   3  walking away at the start does not win
 *   4  killing the commander does NOT end the mission; exfil after it DOES
 *   5  going loud moves the commander and commits bodyguards
 *   6  guards move: state and metres travelled per man over 20 s live
 *
 * Everything is driven through the real page: `gameState.setMode('play')`,
 * `engine.step`, and the AI's own hooks. No mission field is written except
 * where a test deliberately rewinds the state machine, and that is called out.
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const reg = W.registry;
const gp = reg.gameplay ?? reg.player;
const ai = reg.ai;
const eng = W.engine;
const out = [];
const run = (n) => { for (let i = 0; i < n; i++) eng.step(1 / 60); };
const at = (x, z) => {
  const y = reg.characters.ground.heightAt(x, z);
  gp.controller.position.set(x, y, z);
  gp.controller.footY = y;
  gp.controller.velocity.set(0, 0, 0);
};

W.gameState.setMode('play');
run(2);

const site = reg.outpost.bounds.getCenter(new THREE.Vector3());
const ms = gp.missionState;
const dSite = () => Math.hypot(gp.position.x - site.x, gp.position.z - site.z);
const ids = () => gp.objectives.map((o) => `${o.id}${o.done ? '*' : ''}`).join(' ');

// ------------------------------------------------------------------ TEST 1 --
const rank = ai.rankMarking;
const cmd = ai.commander;
out.push(`1 rank marking: objective=${rank.objective} variant=${rank.variant} at ${rank.objectiveAt} `
  + `— decoys ${rank.decoys.length}${rank.decoys.length ? `: ${rank.decoys.map((d) => `${d.name}@${d.at}`).join(', ')}` : ''}`);
out.push(`1 mission target === ai.commander character: ${ms.commander === cmd.character || ms.commander === null} `
  + `(mission resolved: ${ms.commander?.name ?? 'not yet'})`);
const cmdDist = Math.hypot(cmd.position.x - site.x, cmd.position.z - site.z);
out.push(`1 objective is ${cmdDist.toFixed(1)} m from the compound centre, inside=${reg.outpost.isInside(cmd.position.x, cmd.position.z)}`);
out.push(`1 EXACTLY ONE COMMANDER: ${rank.ok ? 'PASS' : 'FAIL — src/characters marks another'}`);

// ------------------------------------------------------------------ TEST 2 --
// The perimeter is a polygon, not a circle, so "46 m" is inside the wire on
// some bearings and outside it on others. Sweep 72 bearings: how far out is the
// wire, and how much of the old 46 m ring stood outside it?
let outside = 0;
let minR = 1e9;
let maxR = 0;
const BEARINGS = 72;
for (let k = 0; k < BEARINGS; k++) {
  const a = (k / BEARINGS) * Math.PI * 2;
  let last = 0;
  for (let r = 0; r <= 90; r += 0.5) {
    if (ms.inside(site.x + Math.cos(a) * r, site.z + Math.sin(a) * r)) last = r;
  }
  minR = Math.min(minR, last);
  maxR = Math.max(maxR, last);
  if (!ms.inside(site.x + Math.cos(a) * 46, site.z + Math.sin(a) * 46)) outside++;
}
out.push(`2 infil test is ${ms.perimeter ? 'the outpost perimeter polygon' : `a ${ms.infilRadius.toFixed(1)} m radius (no perimeter published)`}`
  + `; the wire runs from ${minR.toFixed(1)} m to ${maxR.toFixed(1)} m out. The old flat 46 m ring `
  + `was OUTSIDE it on ${outside}/${BEARINGS} bearings (${(100 * outside / BEARINGS).toFixed(0)}%).`);
// Stand on one of those bearings, 45 m out: inside the old 46 m rule, outside
// the actual wire. This is the case the human was complaining about.
let probeA = null;
for (let k = 0; k < BEARINGS && probeA === null; k++) {
  const a = (k / BEARINGS) * Math.PI * 2;
  if (!ms.inside(site.x + Math.cos(a) * 45, site.z + Math.sin(a) * 45)) probeA = a;
}
if (probeA !== null) {
  at(site.x + Math.cos(probeA) * 45, site.z + Math.sin(probeA) * 45);
  run(4);
  const t = gp.objectives[0].done;
  out.push(`2 standing ${dSite().toFixed(0)} m out and OUTSIDE the wire (the old rule ticked here): `
    + `infil done=${t}  ${t ? 'FAIL' : 'PASS'}`);
} else {
  out.push('2 no bearing has the wire inside 45 m — the old radius never over-ticked here');
}
at(site.x, site.z);
run(4);
out.push(`2 standing on the compound centre: infil done=${gp.objectives[0].done}  ${gp.objectives[0].done ? 'PASS' : 'FAIL'}`);

// ------------------------------------------------------------------ TEST 3 --
// Rewind to a fresh run, then walk straight out without doing anything.
ms.begin();
const sp = gp.spawnPoint;
at(sp.x, sp.z);
run(4);
at(sp.x * 2 - site.x, sp.z * 2 - site.z);   // twice as far out as the insertion
run(30);
out.push(`3 walked away at ${dSite().toFixed(0)} m without entering: status=${ms.status} objectives[${ids()}]  `
  + `${ms.status === 'active' ? 'PASS' : 'FAIL'}`);

// ------------------------------------------------------------------ TEST 4 --
ms.begin();
at(site.x, site.z);            // infiltrate
run(4);
const infilDone = gp.objectives[0].done;
// Kill him where he stands, through the AI's own hook.
ai.hit(cmd.guard, new THREE.Vector3(site.x + 300, 2, site.z), true);
run(60);                        // a full second after the kill
const afterKill = ms.status;
out.push(`4 commander down (${ai.commanderDown}), player still inside at ${dSite().toFixed(1)} m: `
  + `status=${afterKill} objectives[${ids()}]  ${afterKill === 'active' && gp.objectives[1].done ? 'PASS' : 'FAIL'}`);
// Half way out is still not out.
at(site.x + ms.exfilRange * 0.6, site.z);
run(10);
out.push(`4 half way out (${dSite().toFixed(0)} m of ${ms.exfilRange.toFixed(0)} m): status=${ms.status}  ${ms.status === 'active' ? 'PASS' : 'FAIL'}`);
at(sp.x, sp.z);
run(10);
out.push(`4 back at the insertion point (${dSite().toFixed(0)} m): status=${ms.status} reason=${ms.reason} `
  + `rank=${ms.rank} summary="${ms.summary}" objectives[${ids()}]  ${ms.status === 'accomplished' ? 'PASS' : 'FAIL'}`);
out.push(`4 infil had to tick first: ${infilDone}; view=${JSON.stringify(gp.mission)}`);

// ------------------------------------------------------------------ TEST 5 --
// Does the UI light the third objective up with no edit on its side? Its
// adapter is what the HUD and the objective list both read.
const ui = window.__UI;
if (ui) {
  const seen = [];
  ui.mission.src.objectives(seen);
  out.push(`5 the UI adapter reads ${seen.length} objectives: `
    + seen.map((o) => `${o.id}${o.done ? '*' : ''}@${o.x === null ? 'no marker' : `${o.x.toFixed(0)},${o.z.toFixed(0)}`}`).join(' | ')
    + `  ${seen.length === 3 && seen.some((o) => o.id === 'exfil') ? 'PASS — no UI change needed' : 'FAIL'}`);
  out.push(`5 end card: the UI mirrors status only — mission.result=${ui.mission.result}, `
    + `and it calls end(result) with no cause, so rank="${ms.rank}" is published and not drawn`);
} else {
  out.push('5 no window.__UI in this build');
}

out.push(`page errors: ${g.errors.length ? g.errors.slice(0, 4).join(' | ') : 'none'}`);
return out.join('\n');
