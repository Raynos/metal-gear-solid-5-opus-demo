/**
 * player.js — exercise the player controller inside the live page.
 *
 * Drives the real input path (synthetic KeyboardEvents on window, which is what
 * src/core/Input.js listens to) rather than poking the controller, so a binding
 * that is wired wrong fails here instead of in a browser.
 */

const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const eng = W.engine;
const api = W.registry.player;
const out = { installed: !!api };
if (!api) return out;

const gs = W.gameState;
const held = new Set();
const key = (code, down) => {
  if (down) held.add(code); else held.delete(code);
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));
};
const clear = () => { for (const c of [...held]) key(c, false); };
const run = (n) => { for (let i = 0; i < n; i++) { eng.step(1 / 60); } };

g.applyShot('gameplay');
g.settle(2);

out.obstacles = api.obstacles
  ? { ok: api.obstacles.ok, res: api.obstacles.res, extent: api.obstacles.extent }
  : null;

gs.setMode('play');
out.active = api.active;
out.inputEnabled = api.input.enabled;

// --- the rig reproduces the canonical shot -------------------------------
run(2);
eng.systems.filter((s) => s.order === 1100).forEach((s) => s.update(1 / 60, eng));
const shot = g.shots.gameplay;
out.rigVsShot = {
  cam: eng.camera.position.toArray().map((v) => +v.toFixed(3)),
  shotCam: shot.position,
  err: +eng.camera.position.distanceTo(new THREE.Vector3(...shot.position)).toFixed(3),
  fov: +eng.camera.fov.toFixed(2),
};

// --- locomotion -----------------------------------------------------------
function gait(keys, seconds) {
  clear();
  api.controller.velocity.set(0, 0, 0);
  const p0 = api.position.clone();
  for (const k of keys) key(k, true);
  const n = Math.round(seconds * 60);
  let peak = 0;
  let t63 = -1;
  for (let i = 0; i < n; i++) {
    eng.step(1 / 60);
    peak = Math.max(peak, api.speed);
  }
  // time to 63% of peak, measured on a second run from rest
  api.controller.velocity.set(0, 0, 0);
  api.controller.position.copy(p0);
  for (let i = 0; i < n; i++) {
    eng.step(1 / 60);
    if (t63 < 0 && api.speed > peak * 0.63) t63 = +((i + 1) / 60).toFixed(3);
  }
  const dist = api.position.distanceTo(p0);
  clear();
  return { peak: +peak.toFixed(2), t63, dist: +dist.toFixed(2), stance: api.stance, noise: +api.noiseLevel.toFixed(2) };
}

const home = api.position.clone();
const homeYaw = api.controller.yaw;
const reset = () => {
  clear();
  api.controller.position.copy(home);
  api.controller.footY = home.y;
  api.controller.velocity.set(0, 0, 0);
  api.controller.yaw = homeYaw;
  api.controller.stance = 'stand';
  api.controller.stanceTimer = 0;
  api.stealth.inCover = false;
  run(2);
};

out.walk = gait(['KeyW', 'AltLeft'], 1.6);
reset();
out.run = gait(['KeyW'], 2.0);
reset();
out.sprint = gait(['KeyW', 'ShiftLeft'], 2.4);
reset();

// stop distance from a sprint
clear();
key('KeyW', true); key('ShiftLeft', true);
run(140);
const vAtRelease = api.speed;
const pRelease = api.position.clone();
clear();
run(90);
out.stopping = {
  fromSpeed: +vAtRelease.toFixed(2),
  metres: +api.position.distanceTo(pRelease).toFixed(2),
};
reset();

// crouch / prone
key('KeyC', true); run(1); key('KeyC', false);
run(30);
out.crouch = gait(['KeyW'], 1.5);
key('KeyZ', true); run(1); key('KeyZ', false);
run(60);
out.prone = gait(['KeyW'], 1.5);
key('KeyZ', true); run(1); key('KeyZ', false);
run(90);
out.backToCrouch = api.stance;
reset();

// --- collision ------------------------------------------------------------
// Walk straight at the compound's structures from eight headings and check the
// player never ends up standing inside something solid.
const inside = [];
for (let i = 0; i < 16; i++) {
  reset();
  api.controller.yaw = (i / 16) * Math.PI * 2;
  api.camera.yaw = api.controller.yaw;
  key('KeyW', true);
  run(180);
  clear();
  const p = api.position;
  const obs = api.obstacles?.ok ? api.obstacles.maxIn(p.x, p.z, 0.3) : -1e9;
  if (obs > api.controller.footY + 0.55) inside.push([+p.x.toFixed(1), +p.z.toFixed(1), +obs.toFixed(2)]);
}
out.walkedIntoGeometry = inside;
reset();

// --- weapon ---------------------------------------------------------------
const chars = W.registry.characters.characters.filter((c) => !c.isPlayer);
const victim = chars.reduce((a, c) => {
  const d = c.position.distanceTo(api.position);
  return d < a.d ? { c, d } : a;
}, { c: null, d: 1e9 });
out.nearestGuard = victim.c ? +victim.d.toFixed(1) : null;
if (victim.c) {
  // Aim at his chest and pull the trigger.
  const t = victim.c;
  const dx = t.position.x - api.position.x;
  const dz = t.position.z - api.position.z;
  api.camera.yaw = Math.atan2(-dx, -dz);
  const dist = Math.hypot(dx, dz);
  // Lead the drop: 9.81 * (d/62)^2 / 2 metres of fall.
  const drop = (9.81 * (dist / 62) ** 2) / 2;
  api.camera.pitch = Math.atan2((t.groundY + 1.25 + drop) - (api.position.y + 1.42), dist) + 0.081;
  run(2);
  api.stealth.holdingBreath = true;
  const hit = api.fire();
  out.shot = {
    dist: +dist.toFixed(1),
    hit: !!hit,
    onGuard: hit?.character === t,
    downed: !!t.downed,
    tranq: !!t.tranquillised,
    ammo: api.ammo,
  };
}
reset();

// --- CQC ------------------------------------------------------------------
const mark = chars.find((c) => !c.downed);
if (mark) {
  // Stand behind him, facing his back.
  const bx = mark.position.x + Math.sin(mark.yaw) * 1.0;
  const bz = mark.position.z + Math.cos(mark.yaw) * 1.0;
  api.controller.position.set(bx, W.registry.characters.ground.heightAt(bx, bz), bz);
  api.controller.footY = api.controller.position.y;
  api.controller.yaw = mark.yaw;
  run(2);
  out.cqcTargetFound = api.cqcTarget === mark;
  key('KeyF', true); run(2); key('KeyF', false); run(2);
  out.cqc = { downed: !!mark.downed, stance: mark.anim.stance, controlled: !!mark.controlled };
  run(60);   // the takedown commits the body for 0.75 s
  // drag him, then stow him
  key('KeyE', true); run(2); key('KeyE', false); run(2);
  out.dragging = api.carrying === mark;
  const cp = W.registry.outpost.coverPoints[0];
  api.controller.position.set(cp.position.x + 1, api.controller.position.y, cp.position.z);
  run(2);
  key('KeyQ', true); run(2); key('KeyQ', false); run(2);
  out.stowed = { hidden: !!mark.hidden, visible: mark.root.visible };
}
clear();

// --- cover ----------------------------------------------------------------
reset();
{
  // Find a wall: march out from the player until the field says something is
  // there, then stand a body radius off it.
  const p = api.position.clone();
  let found = null;
  for (let a = 0; a < 32 && !found; a++) {
    const ang = (a / 32) * Math.PI * 2;
    for (let d = 1; d < 30; d += 0.25) {
      const x = p.x + Math.cos(ang) * d;
      const z = p.z + Math.sin(ang) * d;
      if (api.obstacles.heightAt(x, z) > api.controller.footY + 1.0) {
        found = { x: p.x + Math.cos(ang) * (d - 0.6), z: p.z + Math.sin(ang) * (d - 0.6) };
        break;
      }
    }
  }
  if (found) {
    api.controller.position.set(found.x, W.registry.characters.ground.heightAt(found.x, found.z), found.z);
    api.controller.footY = api.controller.position.y;
    run(2);
    key('Space', true); run(2); key('Space', false); run(2);
    out.cover = { inCover: api.inCover, foundWallAt: [+found.x.toFixed(1), +found.z.toFixed(1)] };
    key('Space', true); run(2); key('Space', false); run(2);
    out.coverReleased = !api.inCover;
  } else {
    out.cover = 'no wall found';
  }
}

// --- hand the world back --------------------------------------------------
clear();
gs.setMode('godmode');
out.afterExit = {
  active: api.active,
  inputEnabled: api.input.enabled,
  playerPos: W.registry.characters.player.position.toArray().map((v) => +v.toFixed(3)),
  playerYaw: +W.registry.characters.player.yaw.toFixed(4),
  aim: +W.registry.characters.player.anim.aim.toFixed(3),
  fov: eng.camera.fov,
};
g.applyShot('gameplay');
g.settle(4);
out.afterExit.camBackOnShot = +eng.camera.position.distanceTo(new THREE.Vector3(...g.shots.gameplay.position)).toFixed(4);
out.errors = g.errors.slice(0, 5);
return out;
