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

/** World services other systems resolve against. */
const registry = {};
const world = { engine, sky, lighting, terrain, scene: engine.scene, registry };
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
  /** Advance the simulation deterministically then render one frame. */
  settle(frames = 6, dt = 1 / 60) {
    engine.deterministic = true;
    engine.stop();
    for (let i = 0; i < frames; i++) {
      engine.step(dt);
      engine.render();
    }
    // Timed pass: measure steady-state CPU-side frame cost.
    const t0 = performance.now();
    const N = 5;
    for (let i = 0; i < N; i++) {
      engine.step(dt);
      engine.render();
    }
    engine.renderer.getContext().finish();
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
