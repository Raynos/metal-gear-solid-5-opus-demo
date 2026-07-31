import * as THREE from 'three';
import { Engine } from '../core/Engine.js';
import { RenderPipeline } from '../render/RenderPipeline.js';
import { Sky } from '../render/Sky.js';
import { Lighting } from '../render/Lighting.js';
import { PALETTE } from '../config/ArtDirection.js';
import { install as installCharacters } from './index.js';

/**
 * Character studio (dev tool, characters module only).
 *
 * The same engine, sky, lighting and post stack the game uses, but with the
 * world replaced by a flat sand plane. Two reasons this exists alongside
 * `_preview.mjs`:
 *
 *  - Isolation. Several authors edit this repo simultaneously; a syntax error
 *    in terrain or volumetrics blocks the full build, and character iteration
 *    should not stop because of it. Nothing here imports outside
 *    `src/characters/`, `src/core/` and `src/render/`.
 *  - Judgement. A character has to be evaluated against the ground value it is
 *    actually standing on. The plane is authored at the terrain palette's sand
 *    albedo, so the value contrast between soldier and ground reads true.
 */

const container = document.getElementById('app');
const engine = new Engine(container);
const { width, height } = engine.size;
engine.pipeline = new RenderPipeline(engine.renderer, width, height, engine.renderer.getPixelRatio());

const sky = new Sky();
engine.scene.add(sky.mesh);

const lighting = new Lighting(engine, sky);
engine.addSystem(lighting);
engine.addSystem({ order: -60, update: (dt, e) => sky.update(dt, e.camera, e.elapsed) });

// Flat sand pad standing in for the terrain, at the real terrain albedo so the
// character's value separation from the ground is judged honestly.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(2000, 2000, 1, 1),
  new THREE.MeshStandardMaterial({
    // Midway between the palette's light and dark sand: the real terrain is a
    // mix, and judging a soldier against the brightest possible ground makes
    // every garment look darker than it will be in the game.
    color: new THREE.Color(
      (PALETTE.sandLight[0] + PALETTE.sandDark[0]) / 2,
      (PALETTE.sandLight[1] + PALETTE.sandDark[1]) / 2,
      (PALETTE.sandLight[2] + PALETTE.sandDark[2]) / 2,
    ),
    roughness: 0.95,
    metalness: 0,
  }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
engine.scene.add(ground);

const terrain = {
  mesh: ground,
  heightAt: () => 0,
  normalAt: () => new THREE.Vector3(0, 1, 0),
};

const registry = {};
const world = { engine, sky, lighting, terrain, scene: engine.scene, registry };
window.__WORLD = world;

const ready = (async () => {
  registry.characters = await installCharacters(world);
})();

window.__STUDIO = {
  engine,
  lighting,
  THREE,
  ready: false,
  /** Frame a character and render deterministically. */
  pose(v) {
    const mod = registry.characters;
    const ch = v.who === 'player' ? mod.player : mod.characters.find((c) => !c.isPlayer);
    lighting.setTimeOfDay(v.tod ?? 'afternoon');
    // Depth of field and motion blur are the renderer author's to judge; here
    // they only hide the sculpt. Everything else in the stack stays on, because
    // colour has to be judged through the real grade.
    Object.assign(engine.pipeline.enabled, { dof: false, motionBlur: false, taa: false, autoExposure: true });
    // Diagnostic: separate "this surface is unlit" from "this surface is in a
    // cast shadow". Without it a self-shadowing bug and a shading bug look
    // identical in a portrait.
    engine.renderer.shadowMap.enabled = !v.noShadow;
    for (const c of mod.characters) c.controlled = true;
    // Park the garrison well outside the frame — a close portrait otherwise
    // ends up looking straight through whichever guard spawned near the origin.
    let park = 0;
    for (const c of mod.characters) {
      if (c === ch) continue;
      c.root.visible = false;
      c.position.set(400 + park * 6, 0, 400);
      park++;
    }
    ch.root.visible = true;

    ch.position.set(0, 0, 0);
    ch.anim.speed = v.speed ?? 0;
    ch.anim.smoothSpeed = v.speed ?? 0;
    ch.setStance(v.stance ?? 'stand');
    ch.anim.stanceBlend = v.stance === 'crouch' ? 1 : 0;
    ch.anim.proneBlend = v.stance === 'prone' ? 1 : 0;
    ch.anim.aim = v.aim ?? 0;
    ch.anim.t = 12.3;
    ch.anim.breath = 3.1;
    ch.anim.phase = 0.18;

    // Pose the subject relative to the sun, the way a character render is set
    // up, unless the view explicitly asks for the ambient-only read.
    const sd = lighting.sunDirection;
    const sunAz = Math.atan2(sd.x, sd.z);
    const camAz = sunAz + (v.sunOff ?? 0.6);
    ch.yaw = v.shadeSide ? camAz : camAz + Math.PI + (v.faceOff ?? 0);
    if (v.yaw !== undefined) ch.yaw = camAz + v.yaw;
    ch.anim.lookTarget = new THREE.Vector3(
      -Math.sin(ch.yaw) * 24,
      1.66,
      -Math.cos(ch.yaw) * 24,
    );
    if (v.aim) ch.anim.aimTarget.set(0, 1.4, -30);

    const warm = v.warm ?? 0.7;
    const steps = Math.max(1, Math.round(warm * 60));
    for (let i = 0; i < steps; i++) {
      if (v.speed) ch.drive(1 / 60, v.speed, ch.yaw);
      ch.update(1 / 60);
    }
    ch.position.set(0, 0, 0);
    ch.update(1 / 60);

    const yaw = camAz;
    engine.camera.position.set(Math.sin(yaw) * v.dist, v.h, Math.cos(yaw) * v.dist);
    engine.camera.fov = v.fov;
    engine.camera.updateProjectionMatrix();
    engine.camera.lookAt(new THREE.Vector3(0, v.look, 0));

    const cam = engine.camera.position.clone();
    const quat = engine.camera.quaternion.clone();
    engine.deterministic = true;
    engine.stop();
    // Tick lighting and sky BY HAND rather than through engine.step(): the
    // cascades and the sky PMREM have to converge against the final camera, but
    // stepping the whole engine would also advance the character out of the
    // pose we just built.
    for (let i = 0; i < 8; i++) {
      engine.camera.position.copy(cam);
      engine.camera.quaternion.copy(quat);
      engine.camera.updateMatrixWorld(true);
      lighting.update(1 / 60, engine);
      sky.update(1 / 60, engine.camera, engine.elapsed);
      engine.render();
    }
    // Drive the frame to a fixed mid-grey and hold it. Two reasons: the diff
    // measurement below needs a stationary exposure, and pinning every capture
    // to the same key makes successive iterations of the character art
    // comparable frame to frame instead of floating with the sky's tuning.
    engine.pipeline.enabled.autoExposure = false;
    for (let i = 0; i < 6; i++) {
      engine.camera.position.copy(cam);
      engine.camera.quaternion.copy(quat);
      engine.render();
      const m = frameMean();
      engine.pipeline.exposure *= Math.pow((v.key ?? 0.46) / Math.max(0.02, m), 0.9);
    }
    const t0 = performance.now();
    for (let i = 0; i < 4; i++) engine.render();
    const gl = engine.renderer.getContext();
    gl.finish();
    const ms = +((performance.now() - t0) / 4).toFixed(2);
    const stats = measure(gl, ch, cam, quat);
    // measure() leaves the last render as the character-hidden pass; put the
    // subject back on screen before the screenshot is taken.
    for (let i = 0; i < 3; i++) {
      engine.camera.position.copy(cam);
      engine.camera.quaternion.copy(quat);
      engine.render();
    }
    return { ms, ...stats };
  },
};

/**
 * Channel means over the frame, and over the character ALONE.
 *
 * "Red must exceed blue in every daylight frame" is a measurement, not a
 * judgement call — eyeballing a PNG is how round 1 shipped a scene whose blue
 * channel beat its red one in every shot. Sampling a box around the subject is
 * not good enough either: the background dominates it and hides the answer. So
 * the character is rendered twice, visible and hidden, and only the pixels that
 * actually changed are counted. That is the character's own colour, with the
 * grade applied, and nothing else.
 */
/** Mean display luminance of the presented frame, 0..1. */
function frameMean() {
  const gl = engine.renderer.getContext();
  const w = engine.renderer.domElement.width;
  const h = engine.renderer.domElement.height;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let s = 0;
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    s += 0.2126 * px[j] + 0.7152 * px[j + 1] + 0.0722 * px[j + 2];
  }
  return s / (w * h * 255);
}

function measure(gl, ch, cam, quat) {
  const w = engine.renderer.domElement.width;
  const h = engine.renderer.domElement.height;
  const a = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, a);

  ch.root.visible = false;
  for (let i = 0; i < 2; i++) {
    engine.camera.position.copy(cam);
    engine.camera.quaternion.copy(quat);
    engine.render();
  }
  const b = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
  ch.root.visible = true;

  let fr = 0;
  let fg = 0;
  let fb = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  const total = w * h;
  for (let i = 0; i < total; i++) {
    const j = i * 4;
    fr += a[j];
    fg += a[j + 1];
    fb += a[j + 2];
    const d = Math.abs(a[j] - b[j]) + Math.abs(a[j + 1] - b[j + 1]) + Math.abs(a[j + 2] - b[j + 2]);
    if (d > 14) {
      sr += a[j];
      sg += a[j + 1];
      sb += a[j + 2];
      n++;
    }
  }
  const r = (x) => Math.round(x);
  return {
    frame: [r(fr / total), r(fg / total), r(fb / total)],
    subject: n ? [r(sr / n), r(sg / n), r(sb / n)] : [0, 0, 0],
    coverage: +((n / total) * 100).toFixed(1),
  };
}

ready.then(() => {
  window.__STUDIO.ready = true;
});
