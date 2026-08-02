/**
 * gp_tranq.js — a dart that connects must put a man down and KEEP him down.
 * The shipped build threw a TypeError inside `_putDown` before any of this could
 * happen; this is the end-to-end check that it now works, ten seconds later.
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const reg = W.registry;
const gp = reg.gameplay ?? reg.player;
const ai = reg.ai;
const eng = W.engine;
const out = [];

W.gameState.setMode('play');
eng.step(1 / 60);

// Stand 12 m behind the nearest guard and put a dart in him.
const guard = ai.guards[0];
const t = guard.ch;
const ctl = gp.controller;
const hAt = (x, z) => reg.characters.ground.heightAt(x, z);
const bx = t.position.x + Math.sin(t.yaw) * 12;
const bz = t.position.z + Math.cos(t.yaw) * 12;
ctl.position.set(bx, hAt(bx, bz), bz);
ctl.footY = ctl.position.y;
ctl.velocity.set(0, 0, 0);
ctl.yaw = Math.atan2(-(t.position.x - bx), -(t.position.z - bz));
gp.camera.reset(ctl.position, ctl.yaw);
gp.camera.pitch = 0;
for (let i = 0; i < 8; i++) eng.step(1 / 60);

const hit = gp.stealth.fire();
out.push(`dart: hit=${!!hit} onGuard=${!!hit?.character} ammo=${gp.ammo} errors=${g.errors.length}`);
const sample = (label) => {
  out.push(`${label}: ch.downed=${t.downed} guard.down=${guard.down} guard.state=${guard.state} stance=${t.anim.stance} controlled=${t.controlled} speed=${t.anim.speed.toFixed(2)} y=${t.position.y.toFixed(2)}`);
};
for (let i = 0; i < 120; i++) eng.step(1 / 60);
sample('t+2 s ');
for (let i = 0; i < 480; i++) eng.step(1 / 60);
sample('t+10 s');
out.push(`squad alert after a silenced dart: ${ai.alertLevel}`);
out.push(`mission: ${JSON.stringify(gp.mission)}`);

// And the CQC path, which shares `_putDown`.
const g2 = ai.guards.find((q) => !q.down);
const t2 = g2.ch;
const cx = t2.position.x + Math.sin(t2.yaw) * 1.1;
const cz = t2.position.z + Math.cos(t2.yaw) * 1.1;
ctl.position.set(cx, hAt(cx, cz), cz);
ctl.footY = ctl.position.y;
ctl.yaw = Math.atan2(-(t2.position.x - cx), -(t2.position.z - cz));
for (let i = 0; i < 4; i++) eng.step(1 / 60);
const did = gp.cqc();
for (let i = 0; i < 180; i++) eng.step(1 / 60);
out.push(`cqc: fired=${did} ch.downed=${t2.downed} guard.down=${g2.down} stance=${t2.anim.stance}`);
out.push(`page errors: ${g.errors.length ? g.errors.slice(0, 4).join(' | ') : 'none'}`);

W.gameState.setMode('godmode');
return out.join('\n');
