/**
 * gp_repro.js — reproduce MAJOR 3 (wedging), MAJOR 4 (camera in geometry) and
 * MAJOR 5 (reload) with real key events, and measure them.
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const reg = W.registry;
const gp = reg.gameplay ?? reg.player;
const eng = W.engine;
const out = [];

const held = new Set();
const key = (code, down) => {
  if (down) held.add(code); else held.delete(code);
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));
};
const clear = () => { for (const c of [...held]) key(c, false); };
const run = (n) => { for (let i = 0; i < n; i++) eng.step(1 / 60); };

W.gameState.setMode('play');
run(4);

const ctl = gp.controller;
const cam = gp.camera;
const obs = gp.obstacles;
out.push(`obstacles ok=${obs?.ok} res=${obs?.res} extent=${obs?.extent}`);

// ---------------------------------------------------------------- reload --
out.push('--- MAJOR 5 reload ---');
gp.stealth.ammo = 6;
for (let i = 0; i < 5; i++) { gp.stealth._fireCooldown = 0; gp.stealth.fire(); }
const ammoAfterFire = gp.stealth.ammo;
key('KeyR', true); run(1); key('KeyR', false);
run(Math.round(3.2 * 60));
out.push(`ammo after 5 shots=${ammoAfterFire}; after R + 3.2 s = ${gp.stealth.ammo}; reloading=${gp.stealth.reloading.toFixed(2)}; api.ammo=${gp.ammo}`);
out.push(`weapon descriptor on registry: ${JSON.stringify(gp.weapon ?? null)}`);
out.push(`health on registry: ${JSON.stringify(gp.health ?? null)}  mission: ${JSON.stringify(gp.mission ?? null)}`);

// --------------------------------------------------------------- wedging --
out.push('--- MAJOR 3 wedge ---');
// Find a wall: march out from the compound centre until the field reports one.
const c = reg.outpost.bounds.getCenter(new THREE.Vector3());
const hAt = (x, z) => reg.characters.ground.heightAt(x, z);
let wall = null;
for (let a = 0; a < 64 && !wall; a++) {
  const th = (a / 64) * Math.PI * 2;
  for (let r = 20; r < 70; r += 0.5) {
    const x = c.x + Math.sin(th) * r;
    const z = c.z + Math.cos(th) * r;
    if (obs.heightAt(x, z) > hAt(x, z) + 1.2) {
      wall = { x, z, th, r };
      break;
    }
  }
}
out.push(`wall found at ${wall ? `(${wall.x.toFixed(1)}, ${wall.z.toFixed(1)}) bearing ${(wall.th * 180 / Math.PI).toFixed(0)}` : 'none'}`);
if (wall) {
  // Stand 3 m outside it and walk straight in.
  const sx = c.x + Math.sin(wall.th) * (wall.r + 3.2);
  const sz = c.z + Math.cos(wall.th) * (wall.r + 3.2);
  ctl.position.set(sx, hAt(sx, sz), sz);
  ctl.footY = ctl.position.y;
  ctl.velocity.set(0, 0, 0);
  const yaw = Math.atan2(-(wall.x - sx), -(wall.z - sz));
  ctl.yaw = yaw;
  cam.reset(ctl.position, yaw);
  run(2);
  clear();
  key('KeyW', true);
  let stuckFrames = 0;
  let reportedWhileStuck = 0;
  let maxErr = 0;
  const p0 = ctl.position.clone();
  for (let i = 0; i < 300; i++) {
    const a = ctl.position.clone();
    eng.step(1 / 60);
    const moved = Math.hypot(ctl.position.x - a.x, ctl.position.z - a.z) * 60;
    if (moved < 0.05 && ctl.speed > 0.2) { stuckFrames++; reportedWhileStuck = Math.max(reportedWhileStuck, ctl.speed); }
    maxErr = Math.max(maxErr, ctl.speed - moved);
  }
  clear();
  out.push(`walked into the wall for 5 s: travelled ${p0.distanceTo(ctl.position).toFixed(2)} m; frames with reported speed > 0.2 but no movement: ${stuckFrames}/300; worst reported speed while pinned = ${reportedWhileStuck.toFixed(2)} m/s; worst (reported - actual) = ${maxErr.toFixed(2)} m/s`);

  // ------------------------------------------------------------- camera --
  out.push('--- MAJOR 4 camera ---');
  // Press up against the wall and sweep the camera all the way round.
  let inside = 0;
  let worst = 0;
  let samples = 0;
  for (let k = 0; k < 72; k++) {
    cam.yaw = (k / 72) * Math.PI * 2;
    cam.pitch = -0.15;
    for (let i = 0; i < 6; i++) eng.step(1 / 60);
    const p = eng.camera.position;
    const oh = obs.heightAt(p.x, p.z);
    const gh = hAt(p.x, p.z);
    const pen = Math.max(oh - p.y, gh - p.y);
    samples++;
    if (pen > 0) { inside++; worst = Math.max(worst, pen); }
  }
  out.push(`free camera, pressed to the wall: ${inside}/${samples} yaw samples put the lens inside solid geometry; deepest ${worst.toFixed(2)} m`);

  // Same again while aiming (the shorter boom).
  key('KeyF', true);   // not aim; use the real binding below instead
  clear();
  gp.stealth.isAiming = true;
  gp.stealth.aimAmount = 1;
  cam.aimBlend = 1;
  inside = 0; worst = 0; samples = 0;
  for (let k = 0; k < 72; k++) {
    cam.yaw = (k / 72) * Math.PI * 2;
    for (let i = 0; i < 6; i++) {
      eng.step(1 / 60);
      gp.stealth.isAiming = true; gp.stealth.aimAmount = 1; cam.aimBlend = 1;
    }
    const p = eng.camera.position;
    const pen = Math.max(obs.heightAt(p.x, p.z) - p.y, hAt(p.x, p.z) - p.y);
    samples++;
    if (pen > 0) { inside++; worst = Math.max(worst, pen); }
  }
  out.push(`AIMING, pressed to the wall: ${inside}/${samples} yaw samples inside geometry; deepest ${worst.toFixed(2)} m`);
}

clear();
W.gameState.setMode('godmode');
return out.join('\n');
