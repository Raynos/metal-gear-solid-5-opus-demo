/**
 * playshots.js — measure the play-mode camera in each of its states.
 *
 * The canonical shots only ever see the parked pose. These are the framings a
 * player actually looks at: mid-run, sprinting, crouched, prone, shouldered and
 * peeking out of cover.
 *
 * It reports where the SUBJECT lands, not just where the camera is, because
 * that is the thing being judged: MGSV puts the head on the left third with the
 * aim space open right, and `headX` near 0.30 is what that means numerically.
 * (It used to also write a PNG per state through the harness's `__snaps` hook;
 * that hook went away with the render daemon, and the projected head position
 * is the part that was actually being read off those images anyway.)
 */

const g = window.__GAME;
const W = g.world;
const eng = W.engine;
const api = W.registry.player;
const out = {};
if (!api) return { installed: false };

const held = new Set();
const key = (code, down) => {
  if (down) held.add(code); else held.delete(code);
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
};
const clear = () => { for (const c of [...held]) key(c, false); };
const run = (n) => { for (let i = 0; i < n; i++) { eng.step(1 / 60); eng.render(); } };
const THREE = g.THREE;
const _v = new THREE.Vector3();
/** Project a world point to frame fractions: 0,0 top-left, 1,1 bottom-right. */
const toScreen = (x, y, z) => {
  _v.set(x, y, z).project(eng.camera);
  return [+((_v.x * 0.5 + 0.5)).toFixed(3), +((-_v.y * 0.5 + 0.5)).toFixed(3)];
};

const snap = (name) => {
  run(8);
  const p = api.position;
  const stand = api.stance === 'prone' ? 0.45 : api.stance === 'crouch' ? 1.25 : 1.72;
  const head = toScreen(p.x, p.y + stand, p.z);
  out[name] = {
    cam: eng.camera.position.toArray().map((v) => +v.toFixed(2)),
    boom: +Math.hypot(eng.camera.position.x - p.x, eng.camera.position.z - p.z).toFixed(2),
    headX: head[0],
    headY: head[1],
    fov: +eng.camera.fov.toFixed(1),
    stance: api.stance,
    speed: +api.speed.toFixed(2),
    aim: api.isAiming,
    noise: +api.noiseLevel.toFixed(2),
  };
};

g.applyShot('gameplay');
g.settle(3);
W.gameState.setMode('play');

const home = api.position.clone();
const homeYaw = api.controller.yaw;
const camYaw = api.camera.yaw;
const reset = () => {
  clear();
  api.controller.position.copy(home);
  api.controller.footY = home.y;
  api.controller.velocity.set(0, 0, 0);
  api.controller.yaw = homeYaw;
  api.controller.stance = 'stand';
  api.controller.stanceTimer = 0;
  api.camera.yaw = camYaw;
  api.camera.pitch = 0;
  api.stealth.inCover = false;
  api.stealth.aimAmount = 0;
  run(4);
};

reset();
snap('play-idle');

reset();
key('KeyW', true);
run(40);
snap('play-run');

reset();
key('KeyW', true); key('ShiftLeft', true);
run(70);
snap('play-sprint');

reset();
key('KeyC', true); run(2); key('KeyC', false);
key('KeyW', true);
run(40);
snap('play-crouch');

reset();
key('KeyZ', true); run(2); key('KeyZ', false);
run(60);
key('KeyW', true);
run(40);
snap('play-prone');

// 'Mouse2' rides the same source set as a key code, so the synthetic keyboard
// route exercises the real binding without a pointer-lock request.
reset();
key('Mouse2', true);
run(30);
snap('play-aim');
clear();

reset();
api.camera.swapShoulder();
run(30);
snap('play-leftshoulder');
api.camera.swapShoulder();

// Cover: walk into the nearest wall the field knows about, then press to it.
reset();
{
  const p = api.position.clone();
  let best = null;
  for (let a = 0; a < 48; a++) {
    const ang = (a / 48) * Math.PI * 2;
    for (let d = 1.5; d < 26; d += 0.25) {
      const x = p.x + Math.cos(ang) * d;
      const z = p.z + Math.sin(ang) * d;
      if (api.obstacles.heightAt(x, z) > api.controller.footY + 1.2) {
        if (!best || d < best.d) best = { ang, d, x: p.x + Math.cos(ang) * (d - 0.55), z: p.z + Math.sin(ang) * (d - 0.55) };
        break;
      }
    }
  }
  if (best) {
    const gr = W.registry.characters.ground;
    api.controller.position.set(best.x, gr.heightAt(best.x, best.z), best.z);
    api.controller.footY = api.controller.position.y;
    api.camera.yaw = Math.atan2(-Math.cos(best.ang), -Math.sin(best.ang));
    run(6);
    key('Space', true); run(2); key('Space', false);
    run(20);
    out.coverEngaged = api.inCover;
    snap('play-cover');
    if (api.inCover) {
      key('Mouse2', true);
      key('KeyD', true);
      run(30);
      snap('play-peek');
      clear();
    }
  } else {
    out.coverEngaged = 'no wall found';
  }
}

clear();
W.gameState.setMode('godmode');
g.applyShot('gameplay');
g.settle(4);
out.errors = g.errors.slice(0, 6);
return out;
