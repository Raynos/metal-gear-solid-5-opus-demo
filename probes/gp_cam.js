/**
 * gp_cam.js — MAJOR 4, measured properly.
 *
 * Walk the player over every open cell in the compound, sweep the camera through
 * a full turn at each, and count the poses where the LENS is inside solid
 * geometry. "Inside" is a sphere test, not a point test: a camera whose centre is
 * 150 mm from a wall face still renders that wall's interior across the frame,
 * because the near plane is in front of the origin.
 *
 * ARGS[0] = sphere radius (default 0.30)
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const reg = W.registry;
const gp = reg.gameplay ?? reg.player;
const eng = W.engine;
const obs = gp.obstacles;
const hAt = (x, z) => reg.characters.ground.heightAt(x, z);
const R = +(ARGS[0] ?? 0.30);

W.gameState.setMode('play');
eng.step(1 / 60);

const ctl = gp.controller;
const cam = gp.camera;
const c = reg.outpost.bounds.getCenter(new THREE.Vector3());

/**
 * How far INTO solid the lens is, 0..R metres.
 *
 * Not "how tall is the thing near the camera" — that was the first version of
 * this metric and it reported a 2.35 m wall standing 0.4 m away as a 2.09 m
 * penetration, which is a height, not a depth. This binary-searches the largest
 * sphere that is still clear at this position and reports how much smaller than
 * R that is. 0 means a 300 mm lens fits; R means the origin itself is buried.
 */
function clear(p, r) {
  const o = obs.maxIn(p.x, p.z, r);
  const gr = Math.max(hAt(p.x + r, p.z), hAt(p.x - r, p.z), hAt(p.x, p.z + r), hAt(p.x, p.z - r), hAt(p.x, p.z));
  return Math.max(o, gr) <= p.y - r;
}
function pen(p) {
  if (clear(p, R)) return 0;
  let lo = 0;
  let hi = R;
  for (let i = 0; i < 8; i++) {
    const m = (lo + hi) / 2;
    if (clear(p, m)) lo = m; else hi = m;
  }
  return R - lo;
}

let poses = 0;
let bad = 0;
let worst = 0;
const worstAt = [];
for (let ix = -44; ix <= 40; ix += 7) {
  for (let iz = -40; iz <= 38; iz += 7) {
    const x = c.x + ix;
    const z = c.z + iz;
    const gy = hAt(x, z);
    // Only start from places the player could actually stand.
    if (obs.maxIn(x, z, 0.34) > gy + 0.45) continue;
    for (const aiming of [false, true]) {
      ctl.position.set(x, gy, z);
      ctl.footY = gy;
      ctl.velocity.set(0, 0, 0);
      cam.reset(ctl.position, 0);
      for (let k = 0; k < 16; k++) {
        cam.yaw = (k / 16) * Math.PI * 2;
        cam.pitch = -0.1;
        // Long enough for the boom's ease-out to settle, so a rig that pulls in
        // and drifts back is measured where it actually rests.
        for (let i = 0; i < 14; i++) {
          gp.stealth.isAiming = aiming;
          gp.stealth.aimAmount = aiming ? 1 : 0;
          cam.aimBlend = aiming ? 1 : 0;
          eng.step(1 / 60);
        }
        const p = eng.camera.position;
        const d = pen(p);
        poses++;
        if (d > 0) {
          bad++;
          if (d > worst) { worst = d; }
          if (worstAt.length < 6) worstAt.push(`(${x.toFixed(0)},${z.toFixed(0)}) yaw${(k / 16 * 360) | 0} aim=${aiming} pen=${d.toFixed(2)}`);
        }
      }
    }
  }
}
gp.stealth.isAiming = false;
W.gameState.setMode('godmode');
return [
  `sphere radius ${R} m`,
  `camera poses tested: ${poses}`,
  `lens inside geometry: ${bad} (${(bad / poses * 100).toFixed(1)}%), deepest ${worst.toFixed(2)} m`,
  ...worstAt,
].join('\n');
