/**
 * r11_cqc.js — the two things the characters author handed over.
 *
 *   A  the player's OWN takedown clip plays, and it is the call plus the
 *      animator actually running it, not just the call existing
 *   B  the muzzle is read off the weapon rather than hardcoded, and the point
 *      it produces is beyond the end of the barrel rather than inside it
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

W.gameState.setMode('play');
run(2);
const st = gp.stealth;
const ch = gp.player;

// ------------------------------------------------------------------ PART B --
const rifle = ch.rifle;
const at = ch.attach?.R;
out.push(`B weapon anchors: grip=${rifle.gripCenter.toArray().map((v) => v.toFixed(3))} `
  + `muzzle=${rifle.muzzle.toArray().map((v) => v.toFixed(3))} `
  + `|grip->muzzle|=${rifle.muzzle.distanceTo(rifle.gripCenter).toFixed(3)} m, `
  + `|wrist->grip|=${at.wristToGrip.length().toFixed(3)} m`);
const reach = st.muzzleReach();
out.push(`B muzzleReach()=${reach === null ? 'null (no anchors — falls back)' : `${reach.toFixed(3)} m`} `
  + `against the old hardcoded 0.46 m — ${reach === null ? 'n/a' : `${((reach - 0.46) * 100).toFixed(1)} cm further out`}`);

// The point it produces, checked against the hand and against the aim line.
const dir = new THREE.Vector3();
const origin = new THREE.Vector3();
st.aimRay(origin, dir);
const mz = st.muzzlePoint(new THREE.Vector3(), dir);
const hand = ch.rig.byName.get('handR');
const hp = hand.getWorldPosition(new THREE.Vector3());
const along = mz.clone().sub(hp).dot(dir);
out.push(`B muzzlePoint is ${hp.distanceTo(mz).toFixed(3)} m from the handR bone, ${along.toFixed(3)} m of it `
  + `along the aim direction  ${reach === null || Math.abs(along - reach) < 1e-3 ? 'PASS' : 'FAIL'}`);

// ------------------------------------------------------------------ PART A --
// Put a guard within CQC range, behind him, and tap CQC through the verb.
const victim = ai.guards.find((q) => !q.down && q.role === 'sentry');
const v = victim.ch;
const yaw = v.yaw;
gp.controller.position.set(
  v.position.x + Math.sin(yaw) * 1.0,
  reg.characters.ground.heightAt(v.position.x, v.position.z),
  v.position.z + Math.cos(yaw) * 1.0,
);
gp.controller.footY = gp.controller.position.y;
run(2);
const target = st.nearestTarget();
out.push(`A target ${target ? target.name : 'none'} at `
  + `${target ? target.position.distanceTo(gp.controller.position).toFixed(2) : '-'} m, behind=${target ? st.isBehind(target) : false}`);

const before = ch.anim.actions.action;
const ok = st.cqc();
const A = ch.anim.actions;
out.push(`A cqc() returned ${ok}; stealth.action=${st.action} timer=${st.actionTimer.toFixed(2)} s`);
out.push(`A player action layer: was ${before}, now ${A.action} `
  + `dur=${(A.current?.dur ?? -1).toFixed(3)} s (authored 1.60) lockLoco=${A.lockLoco}  `
  + `${A.action === 'takedown' && Math.abs((A.current?.dur ?? 0) - st.actionTimer) < 1e-6 ? 'PASS' : 'FAIL'}`);

// The call taking is not the animation running. Step the freeze out and watch
// the override weights and the support hand actually move. `lockLoco` is
// allowed to drop for the last few frames: the action ends on the frame the
// timer does, and the freeze is released in the same window.
let peakL = 0;
let peakR = 0;
let locked = 0;
let travel = 0;
const wrist = () => ch.rig.byName.get('handL').getWorldPosition(new THREE.Vector3());
const w0 = wrist();
const freeze = st.actionTimer;
const frames = Math.round(freeze * 60);
for (let i = 0; i < frames; i++) {
  eng.step(1 / 60);
  peakL = Math.max(peakL, A.hand.L.w);
  peakR = Math.max(peakR, A.hand.R.w);
  if (A.lockLoco) locked++;
  travel = Math.max(travel, wrist().distanceTo(w0));
}
out.push(`A over the ${freeze.toFixed(2)} s freeze (${frames} frames): peak hand override L=${peakL.toFixed(3)} `
  + `R=${peakR.toFixed(3)}, locomotion locked ${locked}/${frames} frames, support wrist travelled `
  + `${travel.toFixed(3)} m  ${peakL > 0.9 && travel > 0.2 && locked >= frames - 6 ? 'PASS' : 'FAIL'}`);
out.push(`A after the freeze: action=${ch.anim.actions.action}, stealth.action=${st.action}`);
out.push(`A victim ${v.name} down=${victim.down} state=${victim.state}`);

out.push(`page errors: ${g.errors.length ? g.errors.slice(0, 4).join(' | ') : 'none'}`);
return out.join('\n');
