/**
 * r12_jump.js — two discontinuities the film showed, per frame.
 *
 * `probes/r12_film.mjs` caught the reticle stepping 53 px vertically part-way
 * through the aim raise, and again 45 px on the frame after the shot. Neither
 * is in any of the still measurements. Log every term that feeds the reticle's
 * position, one line per simulation frame, and stop guessing.
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const reg = W.registry;
const gp = reg.gameplay ?? reg.player;
const eng = W.engine;
const st = gp.stealth;
const pc = gp.camera;
const cam3 = eng.camera;
const ctl = gp.controller;
const out = [];
const key = (c, d) => window.dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { code: c, bubbles: true }));
const run = (n) => { for (let i = 0; i < n; i++) eng.step(1 / 60); };
const VW = window.innerWidth;
const VH = window.innerHeight;
const syncCam = () => {
  cam3.updateMatrixWorld(true);
  cam3.matrixWorldInverse.copy(cam3.matrixWorld).invert();
  cam3.updateProjectionMatrix();
};

W.gameState.setMode('play');
run(3);
const ai = reg.ai;
const v = ai.guards.find((q) => !q.down).ch;
v.controlled = true;
v.anim.speed = 0;
const gnd = reg.characters.ground;
const x = v.position.x + Math.sin(v.yaw) * 16;
const z = v.position.z + Math.cos(v.yaw) * 16;
ctl.position.set(x, gnd.heightAt(x, z), z);
ctl.footY = ctl.position.y;
ctl.velocity.set(0, 0, 0);
ctl.yaw = v.yaw + Math.PI;
pc.reset(ctl.position, ctl.yaw);
run(20);
const target = new THREE.Vector3(v.position.x, (v.groundY ?? 0) + 1.25, v.position.z);
for (let i = 0; i < 24; i++) {
  const w = target.clone().sub(cam3.position).normalize();
  const have = pc.forward(new THREE.Vector3());
  pc.pitch += Math.asin(THREE.MathUtils.clamp(w.y, -1, 1)) - Math.asin(THREE.MathUtils.clamp(have.y, -1, 1));
  const wy = Math.atan2(-w.x, -w.z);
  pc.yaw += Math.atan2(Math.sin(wy - pc.yaw), Math.cos(wy - pc.yaw));
  eng.step(1 / 60);
}

const line = (tag) => {
  syncCam();
  const h = st.aimHit;
  const p = (h?.point ?? st.aimPoint).clone().project(cam3);
  const rx = (p.x * 0.5 + 0.5) * VW - VW / 2;
  const ry = (-p.y * 0.5 + 0.5) * VH - VH / 2;
  out.push(`${tag.padEnd(11)} aim=${st.aimAmount.toFixed(3)} fov=${cam3.fov.toFixed(1).padStart(4)} `
    + `conv=${st.convergeRange.toFixed(1).padStart(5)} `
    + `aimHit=${h ? `${(h.character ? 'CHAR ' : h.dist >= 0 ? 'world' : '?')}${h.dist.toFixed(1)}m` : 'NULL (falls back to aimPoint, which has NO ballistic drop)'} `
    + `reticle=(${rx.toFixed(0)}, ${ry.toFixed(0)}) kick=${(pc._kick * 180 / Math.PI).toFixed(2)}/${(pc._kickYaw * 180 / Math.PI).toFixed(2)}`);
};

out.push(`--- the aim raise, one line per frame (target ${v.name} at ${cam3.position.distanceTo(target).toFixed(1)} m, axis on his chest)`);
line('hip');
key('KeyE', true);
for (let i = 1; i <= 22; i++) { eng.step(1 / 60); line(`ads-f${String(i).padStart(2, '0')}`); }
run(20);
out.push('');
out.push('--- one round, one line per frame');
line('pre-shot');
st._fireCooldown = 0;
const hit = st.fire();
out.push(`fire() -> ${hit ? (hit.character ? `${hit.character.name} headshot=${hit.headshot}` : `${hit.surface} at ${hit.point.distanceTo(st._ao).toFixed(1)} m`) : 'NOTHING (dart expired)'}`);
for (let i = 1; i <= 14; i++) { eng.step(1 / 60); line(`kick-f${String(i).padStart(2, '0')}`); }
out.push('');
// IS THERE ACTUALLY SOMETHING AT 9.3 m? The look march and the ballistic trace
// disagreed about this pose, and exactly one of "the march tunnelled through a
// wall" and "the dart correctly hit a wall the camera can see over" is true.
{
  const o = new THREE.Vector3();
  const d = new THREE.Vector3();
  st.aimRay(o, d);
  const rows = [];
  for (let t = 6; t <= 13; t += 0.5) {
    const px = o.x + d.x * t;
    const py = o.y + d.y * t;
    const pz = o.z + d.z * t;
    const ob = gp.obstacles?.ok ? gp.obstacles.heightAt(px, pz) : NaN;
    rows.push(`${t.toFixed(1)}m ray-y=${py.toFixed(2)} ground=${gnd.heightAt(px, pz).toFixed(2)} obstacle=${Number.isFinite(ob) ? ob.toFixed(2) : 'n/a'}`);
  }
  out.push('along the dart line, is there a structure in the way:');
  out.push('  ' + rows.join('\n  '));
  // And the same question along the LOOK line, from the lens.
  const lo = cam3.position.clone();
  const ld = st._lookDir(new THREE.Vector3());
  const hit = [];
  for (let t = 6; t <= 13; t += 0.5) {
    const px = lo.x + ld.x * t;
    const pz = lo.z + ld.z * t;
    const py = lo.y + ld.y * t;
    const ob = gp.obstacles?.ok ? gp.obstacles.heightAt(px, pz) : NaN;
    if (ob > py) hit.push(t.toFixed(1));
  }
  out.push(`the LOOK line from the lens is inside a structure at: ${hit.length ? hit.join(', ') + ' m' : 'nowhere in 6-13 m'}`);
  out.push(`_lookMarch says ${st._lookMarch(cam3.position, ld).toFixed(2)} m`);
}
out.push(`target ${v.name}: downed=${v.downed} tranquillised=${v.tranquillised}`);
out.push(`page errors: ${g.errors.length ? g.errors.slice(0, 4).join(' | ') : 'none'}`);
return out.join('\n');
