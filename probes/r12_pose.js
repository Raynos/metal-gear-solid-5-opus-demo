/**
 * r12_pose.js — the shouldered pose, measured for src/characters.
 *
 * gameplay owns two channels and nothing else: `anim.aim` (0..1) and
 * `anim.aimTarget` (a world point). `probes/r12_aim.js` established that the
 * target this module publishes is 0.16 deg off the line the dart actually
 * flies, so gameplay's half of the contract is met. This measures the other
 * half — what the rig does with it — because the filmed aimed frame does not
 * read as a man with a weapon at his shoulder and somebody who owns
 * src/characters needs numbers rather than a screenshot.
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const reg = W.registry;
const gp = reg.gameplay ?? reg.player;
const eng = W.engine;
const st = gp.stealth;
const ctl = gp.controller;
const out = [];
const D = (r) => (r * 180 / Math.PI);
const ang = (a, b) => D(Math.acos(THREE.MathUtils.clamp(a.clone().normalize().dot(b.clone().normalize()), -1, 1)));

W.gameState.setMode('play');
for (let i = 0; i < 3; i++) eng.step(1 / 60);
const site = reg.outpost.bounds.getCenter(new THREE.Vector3());
const gnd = reg.characters.ground;
const yaw = Math.atan2(site.x - ctl.position.x, site.z - ctl.position.z) + Math.PI;
ctl.position.set(site.x + Math.sin(yaw) * 40, 0, site.z + Math.cos(yaw) * 40);
ctl.position.y = gnd.heightAt(ctl.position.x, ctl.position.z);
ctl.footY = ctl.position.y;
ctl.yaw = yaw;
gp.camera.reset(ctl.position, yaw);
window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
for (let i = 0; i < 120; i++) eng.step(1 / 60);

const a = gp.player;
const o = new THREE.Vector3();
const d = new THREE.Vector3();
st.aimRay(o, d);
const M = a.anim._weaponM;
const muzzle = new THREE.Vector3(0.585, 0.012, 0).applyMatrix4(M);
const grip = new THREE.Vector3(-0.078, -0.075, 0).applyMatrix4(M);
const butt = new THREE.Vector3(-0.3, -0.006, 0).applyMatrix4(M);
const axis = muzzle.clone().sub(grip);
const B = a.rig?.byName ?? a.anim?.b ?? new Map();
const bone = (n) => {
  const b = B.get ? B.get(n) : B[n];
  return b ? b.getWorldPosition(new THREE.Vector3()) : null;
};
const head = bone('head') ?? bone('neck');
const shR = bone('shoulderR') ?? bone('clavicleR') ?? bone('upperArmR');
const handR = bone('handR');
const handL = bone('handL');

out.push(`anim.aim = ${a.anim.aim.toFixed(3)}   anim.action = ${a.anim.action}   stance = ${ctl.stance}`);
out.push(`the dart flies (${d.x.toFixed(3)}, ${d.y.toFixed(3)}, ${d.z.toFixed(3)}); anim.aimTarget is `
  + `${ang(a.anim.aimTarget.clone().sub(o), d).toFixed(2)} deg off it, ${a.anim.aimTarget.distanceTo(o).toFixed(1)} m out`);
out.push('');
out.push('THE WEAPON');
out.push(`  barrel axis (grip -> muzzle) is ${ang(axis, d).toFixed(1)} deg off the dart's line`);
out.push(`  ...and ${ang(axis, a.anim.aimTarget.clone().sub(grip)).toFixed(1)} deg off the aimTarget it was handed`);
out.push(`  in the character's own frame the barrel points ${ang(axis, new THREE.Vector3(-Math.sin(a.yaw), 0, -Math.cos(a.yaw))).toFixed(1)} deg off his facing`);
out.push(`  muzzle world y ${muzzle.y.toFixed(2)}, grip ${grip.y.toFixed(2)}, butt ${butt.y.toFixed(2)} `
  + `(eye is ${st.eyeY.toFixed(2)}) — barrel rises ${(muzzle.y - grip.y).toFixed(2)} m over its ${muzzle.distanceTo(grip).toFixed(2)} m`);
out.push('');
out.push('IS IT SHOULDERED?');
if (shR && handR) {
  out.push(`  butt pad is ${butt.distanceTo(shR).toFixed(3)} m from the right shoulder bone `
    + `(a shouldered rifle is ~0.05-0.15 m; a low-ready is 0.35+)`);
  out.push(`  right hand ${handR.distanceTo(grip).toFixed(3)} m from the grip, `
    + `left hand ${handL ? handL.distanceTo(new THREE.Vector3(0.24, -0.02, 0).applyMatrix4(M)).toFixed(3) : 'n/a'} m from the handguard`);
} else {
  out.push(`  no shoulder bone published; bones seen: ${[...(B.keys ? B.keys() : [])].slice(0, 40).join(', ')}`);
}
out.push('');
out.push('WHERE IS HE LOOKING?');
if (head) {
  const look = a.anim.lookTarget ?? st.aimPoint;
  out.push(`  anim.lookTarget is ${ang(look.clone().sub(head), d).toFixed(1)} deg off the dart's line`);
}
out.push(`  the BODY's facing is ${D(Math.atan2(Math.sin(Math.atan2(-d.x, -d.z) - a.yaw), Math.cos(Math.atan2(-d.x, -d.z) - a.yaw))).toFixed(1)} deg off the dart's line in yaw `
  + `(gameplay writes ch.yaw from the controller; an aiming man should be square to his sights)`);
out.push('');
out.push(`page errors: ${g.errors.length ? g.errors.slice(0, 4).join(' | ') : 'none'}`);
return out.join('\n');
