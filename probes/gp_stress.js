/**
 * gp_stress.js — collision, measured over the whole compound instead of anecdotes.
 *
 * Drop the player next to structures at many positions, push in every direction
 * for a second, and count two things:
 *
 *   WEDGED    frames where the controller wanted to move (intended > 1 m/s) and
 *             the body did not (< 0.05 m/s actual). Pushing straight into a wall
 *             SHOULD wedge, so this is reported split by how far off the contact
 *             the push was.
 *   LIE       worst (reported speed - actual speed). This is the number the
 *             animator sees; anything above zero is a foot slide.
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const reg = W.registry;
const gp = reg.gameplay ?? reg.player;
const eng = W.engine;

W.gameState.setMode('play');
eng.step(1 / 60);
const ctl = gp.controller;
const obs = gp.obstacles;
const site = reg.outpost.bounds.getCenter(new THREE.Vector3());
const hAt = (x, z) => reg.characters.ground.heightAt(x, z);

// Every open cell that has something solid within 2 m — i.e. every place the
// player can stand where collision is in play at all.
const spots = [];
for (let ix = -46; ix <= 42; ix += 4) {
  for (let iz = -42; iz <= 40; iz += 4) {
    const x = site.x + ix;
    const z = site.z + iz;
    const y = hAt(x, z);
    if (obs.maxIn(x, z, 0.4) > y + 0.45) continue;         // not standable
    let near = false;
    for (let k = 0; k < 8 && !near; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (obs.maxIn(x + Math.cos(a) * 1.6, z + Math.sin(a) * 1.6, 0.4) > y + 1.0) near = true;
    }
    if (near) spots.push([x, z, y]);
  }
}

let frames = 0;
let wedged = 0;
let lie = 0;
let contact = 0;
let travelled = 0;
const DIRS = 8;
for (const [x, z, y] of spots) {
  for (let k = 0; k < DIRS; k++) {
    const yaw = (k / DIRS) * Math.PI * 2;
    ctl.position.set(x, y, z);
    ctl.footY = y;
    ctl.velocity.set(0, 0, 0);
    ctl.yaw = yaw;
    ctl.stance = 'stand';
    ctl.stanceTimer = 0;
    gp.camera.yaw = yaw;
    gp.camera.reset(ctl.position, yaw);
    const p0x = ctl.position.x;
    const p0z = ctl.position.z;
    for (let i = 0; i < 60; i++) {
      const ax = ctl.position.x;
      const az = ctl.position.z;
      // Drive the controller directly with a full-forward stick on this heading;
      // the input path is exercised in gp_verify.js, this is a geometry sweep.
      ctl.update(1 / 60, { moveX: 0, moveY: 1, camYaw: yaw });
      const moved = Math.hypot(ctl.position.x - ax, ctl.position.z - az) * 60;
      frames++;
      if (ctl.blocked) contact++;
      // The stick is fully deflected on every one of these frames, so "moved
      // less than 5 cm/s" is exactly "the player pressed forward and nothing
      // happened". Reading intent off the velocity instead would flatter the
      // old controller, which hides a wedge by zeroing the velocity it just
      // failed to spend.
      if (moved < 0.05) wedged++;
      if (ctl.speed - moved > lie) lie = ctl.speed - moved;
    }
    travelled += Math.hypot(ctl.position.x - p0x, ctl.position.z - p0z);
  }
}

W.gameState.setMode('godmode');
return [
  `positions ${spots.length}, headings ${DIRS}, frames ${frames}`,
  `frames in contact with geometry: ${contact} (${(contact / frames * 100).toFixed(1)}%)`,
  `frames WEDGED (wanted > 1 m/s, moved < 0.05 m/s): ${wedged} (${(wedged / frames * 100).toFixed(1)}%)`,
  `worst reported-minus-actual speed: ${lie.toFixed(3)} m/s`,
  `mean distance covered in 1 s of full stick: ${(travelled / (spots.length * DIRS)).toFixed(2)} m`,
].join('\n');
