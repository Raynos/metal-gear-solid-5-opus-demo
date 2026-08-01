import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { RenderPipeline } from './render/RenderPipeline.js';
import { Sky } from './render/Sky.js';
import { Lighting } from './render/Lighting.js';
import { Terrain } from './world/Terrain.js';
import { SHOTS } from './debug/Shots.js';

// Feature modules. Each is owned by exactly one author and exposes install(world).
// Order matters: later modules may read handles published by earlier ones.
import { install as installVolumetrics } from './render/volumetrics/index.js';
import { install as installRocks } from './world/rocks/index.js';
import { install as installVegetation } from './world/vegetation/index.js';
import { install as installOutpost } from './world/outpost/index.js';
import { install as installCharacters } from './characters/index.js';
import { install as installGameplay } from './gameplay/index.js';
import { install as installUI } from './ui/index.js';
import { install as installAudio } from './audio/index.js';

const container = document.getElementById('app');
const engine = new Engine(container);

const { width, height } = engine.size;
engine.pipeline = new RenderPipeline(engine.renderer, width, height, engine.renderer.getPixelRatio());

const sky = new Sky();
engine.scene.add(sky.mesh);

const lighting = new Lighting(engine, sky);
engine.addSystem(lighting);
engine.addSystem({
  order: -60,
  update: (dt, e) => sky.update(dt, e.camera, e.elapsed),
});

const terrain = new Terrain({ size: 4096, segments: 512 });
engine.scene.add(terrain.mesh);

/**
 * Game state. Three modes share one world:
 *
 *   'menu'    front end; the world renders behind it as a live backdrop
 *   'godmode' free-fly camera — ALSO what the screenshot harness drives, so it
 *             must keep working exactly as it does today or every canonical shot
 *             and every visual regression check breaks
 *   'play'    the actual game: player controller, AI, HUD
 *
 * Modules subscribe with onModeChange() and enable/disable their own systems.
 * Owning this here keeps four modules (ui, gameplay, ai, audio) out of main.js.
 */
const modeListeners = new Set();
let mode = 'menu';

function setMode(next) {
  if (next === mode) return mode;
  const prev = mode;
  mode = next;
  // Free-fly is godmode's camera; the harness poses the camera itself and must
  // never have it fighting back, so applyShot() also parks us in godmode.
  freeFly = next === 'godmode';
  for (const fn of modeListeners) {
    try {
      fn(next, prev);
    } catch (err) {
      console.error('mode listener failed:', err);
    }
  }
  return mode;
}

const gameState = {
  get mode() {
    return mode;
  },
  setMode,
  onModeChange(fn) {
    modeListeners.add(fn);
    return () => modeListeners.delete(fn);
  },
};

/** World services other systems resolve against. */
const registry = {};
const world = { engine, sky, lighting, terrain, scene: engine.scene, registry, gameState };
window.__WORLD = world;

// --- free-fly camera for manual inspection -------------------------------
const keys = new Set();
window.addEventListener('keydown', (e) => keys.add(e.code));
window.addEventListener('keyup', (e) => keys.delete(e.code));
let yaw = 0;
let pitch = 0;
let dragging = false;
container.addEventListener('mousedown', () => (dragging = true));
window.addEventListener('mouseup', () => (dragging = false));
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  yaw -= e.movementX * 0.0026;
  pitch = THREE.MathUtils.clamp(pitch - e.movementY * 0.0026, -1.4, 1.4);
});

let freeFly = true;


engine.addSystem({
  order: 1000,
  update: (dt, e) => {
    if (!freeFly) return;
    const speed = (keys.has('ShiftLeft') ? 60 : 16) * dt;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    e.camera.quaternion.copy(q);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    if (keys.has('KeyW')) e.camera.position.addScaledVector(fwd, speed);
    if (keys.has('KeyS')) e.camera.position.addScaledVector(fwd, -speed);
    if (keys.has('KeyA')) e.camera.position.addScaledVector(right, -speed);
    if (keys.has('KeyD')) e.camera.position.addScaledVector(right, speed);
    if (keys.has('KeyE')) e.camera.position.y += speed;
    if (keys.has('KeyQ')) e.camera.position.y -= speed;
  },
});

function applyShot(name) {
  const s = SHOTS[name];
  if (!s) throw new Error(`unknown shot: ${name}`);
  // The harness poses the camera directly; make sure no play/menu camera system
  // is still driving it, then park free-fly so nothing overwrites the pose.
  if (mode !== 'godmode') setMode('godmode');
  freeFly = false;
  engine.camera.position.set(...s.position);
  engine.camera.lookAt(new THREE.Vector3(...s.target));
  engine.camera.fov = s.fov;
  engine.camera.updateProjectionMatrix();
  const e = new THREE.Euler().setFromQuaternion(engine.camera.quaternion, 'YXZ');
  yaw = e.y;
  pitch = e.x;
  lighting.setTimeOfDay(s.tod);
  // The AF point travels with the shot: an over-the-shoulder framing focuses on
  // its subject, not on whatever the optical axis happens to hit.
  engine.pipeline.afPoint.set(...(s.focus ?? [0.5, 0.5]));
  return s;
}

// --- harness API ---------------------------------------------------------
window.__GAME = {
  engine,
  world,
  THREE,
  shots: SHOTS,
  applyShot,
  setTimeOfDay: (n) => lighting.setTimeOfDay(n),
  setFreeFly: (v) => (freeFly = v),
  gameState,
  setMode,
  /**
   * Advance the simulation deterministically then render one frame.
   *
   * The pipeline's frame counter is rewound first, and that is not cosmetic:
   * it drives the TAA jitter phase (`JITTER[frame % 16]`), the AO's temporal
   * rotation (`frame % 64`) and the grain's time seed. It is a free-running
   * counter over the life of the page, so the phase a shot landed on depended
   * on how many frames the warm world happened to have drawn before it — a
   * different number in every run, and a different number for the same shot
   * depending on its position in the batch.
   *
   * Measured before this line existed: two runs of the SAME source, same shot,
   * differed by RMS 0.0106 in linear luminance on near sand — 5.6% of the
   * surface's own mean, and TWICE the size of the entire near-field grit
   * signal an A/B was trying to measure (0.0055). Every ablation this round,
   * mine and the nine authors', was being read through a noise floor larger
   * than most of the effects. Resetting it makes a shot a pure function of the
   * source, which is what a screenshot harness has to be.
   */
  settle(frames = 6, dt = 1 / 60) {
    engine.deterministic = true;
    engine.stop();
    if (engine.pipeline) engine.pipeline.frame = 0;
    // Same argument for the clock: wind sway, the cloud pan and the cloud
    // shadow all read `engine.elapsed`, which is cumulative over the life of
    // the warm world, so shot N of a batch was drawn at a different moment in
    // the weather than shot N of the previous batch.
    engine.elapsed = 0;
    for (let i = 0; i < frames; i++) {
      engine.step(dt);
      engine.render();
    }
    // Timed pass: steady-state THROUGHPUT, not the latency of a few frames.
    //
    // This used to time five frames and divide, which reported 3.4 ms while the
    // game actually ran at 14-24 FPS. Those frames are only enqueued: straight
    // after a settle the GPU queue is empty, so submission returns at
    // command-buffer write speed and you measure the driver, not the frame. The
    // cost ramp over consecutive 20-frame blocks is [2.8, 47.4, 40.7, 40.8,
    // 40.4, 41.5] — only the first block is cheap, and that was the window
    // being sampled. Warm until the queue is saturated, then measure.
    const gl = engine.renderer.getContext();
    for (let i = 0; i < 24; i++) {
      engine.step(dt);
      engine.render();
    }
    gl.finish();
    const t0 = performance.now();
    const N = 30;
    for (let i = 0; i < N; i++) {
      engine.step(dt);
      engine.render();
    }
    gl.finish();
    return (performance.now() - t0) / N;
  },
  /**
   * Read back the presented frame and report a luminance histogram. This is how
   * exposure/grade calibration is verified numerically instead of by eyeballing
   * a PNG — "is the sand at 0.55 or 0.98" is not a judgement call.
   */
  probeLuminance() {
    const gl = engine.renderer.getContext();
    const w = 320;
    const h = 180;
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType });
    const prevSize = engine.renderer.getSize(new THREE.Vector2());
    // Re-run the composite into a small RT by temporarily retargeting.
    engine.renderer.setRenderTarget(null);
    const px = new Uint8Array(prevSize.x * prevSize.y * 4);
    gl.readPixels(0, 0, prevSize.x, prevSize.y, gl.RGBA, gl.UNSIGNED_BYTE, px);
    rt.dispose();
    let sum = 0;
    const hist = new Array(16).fill(0);
    const n = prevSize.x * prevSize.y;
    let clipped = 0;
    for (let i = 0; i < n; i++) {
      const r = px[i * 4] / 255;
      const g = px[i * 4 + 1] / 255;
      const b = px[i * 4 + 2] / 255;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += l;
      hist[Math.min(15, Math.floor(l * 16))]++;
      if (l > 0.985) clipped++;
    }
    return {
      mean: +(sum / n).toFixed(4),
      clippedPct: +((clipped / n) * 100).toFixed(2),
      hist: hist.map((c) => +((c / n) * 100).toFixed(1)),
    };
  },
  stats() {
    const info = engine.renderer.info;
    const scene = engine.pipeline?.sceneStats ?? info.render;
    return {
      calls: scene.calls,
      triangles: scene.triangles,
      programs: info.programs?.length ?? 0,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
    };
  },
  ready: false,
  errors: [],
};

window.addEventListener('error', (e) => window.__GAME.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__GAME.errors.push(String(e.reason)));

// --- module installation -------------------------------------------------
const MODULES = [
  ['volumetrics', installVolumetrics],
  ['rocks', installRocks],
  ['vegetation', installVegetation],
  ['outpost', installOutpost],
  ['characters', installCharacters],
  ['gameplay', installGameplay],
  ['ui', installUI],
  ['audio', installAudio],
];

async function boot() {
  for (const [name, install] of MODULES) {
    try {
      registry[name] = await install(world);
    } catch (err) {
      // One broken module must not take the whole build down — the harness
      // reports it, everything else still renders.
      console.error(`module "${name}" failed to install:`, err);
      window.__GAME.errors.push(`module ${name}: ${err?.message ?? err}`);
    }
  }

  // Prime shader compilation before declaring ready so the first screenshot is
  // never a half-compiled frame.
  engine.camera.position.set(...SHOTS.vista.position);
  engine.camera.lookAt(new THREE.Vector3(...SHOTS.vista.target));
  engine.renderer.compile(engine.scene, engine.camera);
  engine.step(0);
  engine.render();
  engine.start();
  window.__GAME.ready = true;
}

boot();
