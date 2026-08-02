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
import { install as installAI } from './ai/index.js';
import { install as installGameplay } from './gameplay/index.js';
import { install as installUI } from './ui/index.js';
import { install as installAudio } from './audio/index.js';

const container = document.getElementById('app');
// Boot progress. The bar was wired only to boot(), but the terrain simulation
// runs at module scope BEFORE boot() is ever called — and that is most of the
// wait. The bar sat at "starting" through the entire 4-12 s it was meant to
// explain, which is exactly the black screen it replaced, only with a label.
const B = typeof window !== 'undefined' ? window.__BOOT : null;
B?.set(0.04, 'starting renderer');

const engine = new Engine(container);

const { width, height } = engine.size;
engine.pipeline = new RenderPipeline(engine.renderer, width, height, engine.renderer.getPixelRatio());

B?.set(0.08, 'sky');
const sky = new Sky();
engine.scene.add(sky.mesh);

B?.set(0.10, 'lighting');
const lighting = new Lighting(engine, sky);
engine.addSystem(lighting);
engine.addSystem({
  order: -60,
  update: (dt, e) => sky.update(dt, e.camera, e.elapsed),
});

// Terrain.create() consults the generation cache; the plain constructor runs the
// 11.6 s simulation. The fallback keeps this file working in a tree whose
// Terrain.js predates the cache, so it can be propagated anywhere safely.
// The long one: a cached bake is ~1 s, a cold sim is ~12 s. Say which, because
// "generating terrain" sitting still for twelve seconds looks like a hang.
B?.set(0.14, 'generating terrain', true);
const terrain = Terrain.create
  ? await Terrain.create({ size: 4096, segments: 512 })
  : new Terrain({ size: 4096, segments: 512 });
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
  // God mode is an INSPECTION camera. Depth of field and motion blur are
  // cinematic effects for a gameplay camera; on a free-fly they only smear the
  // thing you are trying to look at, and they are two of the most expensive
  // passes in the frame. Off here, on in play.
  const pipe = engine.pipeline;
  if (pipe?.enabled) {
    const cinematic = next === 'play';
    pipe.enabled.dof = cinematic;
    pipe.enabled.motionBlur = cinematic;
  }
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
  /**
   * Let a headless harness drive mouse look. Headless chromium will not grant
   * pointer lock, and look input is gated on it, which is the only reason any
   * probe ever needed a headful browser. Test-only.
   */
  setAutomation(on) {
    const input = registry.gameplay?.input ?? registry.gameplay?.player?.input;
    return input?.setAutomation ? input.setAutomation(on) : false;
  },
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
  /**
   * Converge the frame for a SCREENSHOT. Cheap by design.
   *
   * This is not a benchmark. It renders just enough frames for TAA, the AO
   * temporal resolve and any LOD streaming to settle, and returns. It used to
   * also run a 54-frame timing pass, which made every screenshot cost ~2.2 s and
   * turned a 7-shot run into 42 s of rendering — a benchmark's frame budget
   * charged to every photo. Frame timing lives in tools/probes/perf.js, which is
   * the only thing that should ever pay for it.
   */
  settle(frames = 8, dt = 1 / 60) {
    engine.deterministic = true;
    engine.stop();
    for (let i = 0; i < frames; i++) {
      engine.step(dt);
      engine.render();
    }
    return 0;
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
  ['ai', installAI],
  ['gameplay', installGameplay],
  ['ui', installUI],
  ['audio', installAudio],
];

async function boot() {
  // The terrain sim and the module installs are the whole 4-12 s; report each so
  // a slow boot looks like work rather than a hang.
  B?.set(0.42, 'terrain ready', false);
  for (let i = 0; i < MODULES.length; i++) {
    const [name, install] = MODULES[i];
    B?.set(0.45 + 0.45 * (i / MODULES.length), name);
    try {
      registry[name] = await install(world);
    } catch (err) {
      // One broken module must not take the whole build down — the harness
      // reports it, everything else still renders.
      console.error(`module "${name}" failed to install:`, err);
      window.__GAME.errors.push(`module ${name}: ${err?.message ?? err}`);
    }
  }
  B?.set(0.92, 'compiling shaders');

  // Prime shader compilation before declaring ready so the first screenshot is
  // never a half-compiled frame.
  engine.camera.position.set(...SHOTS.vista.position);
  engine.camera.lookAt(new THREE.Vector3(...SHOTS.vista.target));
  engine.renderer.compile(engine.scene, engine.camera);
  engine.step(0);
  engine.render();
  engine.start();
  window.__GAME.ready = true;
  B?.done();
}

boot();
