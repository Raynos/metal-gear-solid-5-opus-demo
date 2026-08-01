/**
 * perfplay.js — frame cost with the game actually running.
 *
 * tools/probes/perf.js moves the camera by hand in godmode. This runs the real
 * play-mode stack: input polling, the controller, collision against the
 * obstacle field, the stealth verbs and the third-person camera, with the
 * player sprinting through the compound so the terrain clipmap, the shadow
 * cascades and the LOD rings all churn the way they do for a player.
 *
 * Same rules as perf.js: warm until the GPU queue is saturated, then measure
 * throughput over many frames. A number taken any other way is fiction.
 */

const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const eng = W.engine;
const gl = eng.renderer.getContext();
const api = W.registry.player;

const WARM = 24;
const N = 60;

function throughput(mutate) {
  for (let i = 0; i < WARM; i++) { mutate(i); eng.step(1 / 60); eng.render(); }
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) { mutate(i); eng.step(1 / 60); eng.render(); }
  gl.finish();
  return (performance.now() - t0) / N;
}

g.applyShot('gameplay');
g.settle(4);

const out = { resolution: `${eng.renderer.getSize(new THREE.Vector2()).x}x${eng.renderer.getSize(new THREE.Vector2()).y}` };
const cam0 = eng.camera.position.clone();
const q0 = eng.camera.quaternion.clone();

// Baseline: godmode, camera parked on the shot, nothing of mine running.
out.godmodeStatic = +throughput(() => {
  eng.camera.position.copy(cam0);
  eng.camera.quaternion.copy(q0);
}).toFixed(1);

if (!api) return { ...out, installed: false };

const held = new Set();
const key = (code, down) => {
  if (down) held.add(code); else held.delete(code);
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
};
const clear = () => { for (const c of [...held]) key(c, false); };

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
  api.camera.yaw = camYaw;
  api.camera.pitch = 0;
  api.camera.reset(api.controller.position, camYaw);
};

reset();
out.playIdle = +throughput(() => reset()).toFixed(1);

reset();
key('KeyW', true);
out.playRun = +throughput(() => {}).toFixed(1);
clear();

reset();
key('KeyW', true); key('ShiftLeft', true);
// Sprinting in a circle: translation AND rotation, which is what actually
// invalidates the TAA history and refits the cascades.
out.playSprintTurn = +throughput((i) => {
  api.camera.addLook(0.010, 0);
  if (i % 240 === 239) reset();
}).toFixed(1);
clear();

reset();
key('Mouse2', true);
out.playAim = +throughput(() => {}).toFixed(1);
clear();

// How much of that is mine? Ablate the two gameplay systems and re-measure.
const mine = eng.systems.filter((s) => s.order === 15 || s.order === 1100);
const saved = mine.map((s) => s.update);
reset();
key('KeyW', true); key('ShiftLeft', true);
const withMine = throughput((i) => { api.camera.addLook(0.010, 0); if (i % 240 === 239) reset(); });
for (const s of mine) s.update = () => {};
const withoutMine = throughput(() => {});
mine.forEach((s, i) => { s.update = saved[i]; });
out.gameplaySystemsMs = +(withMine - withoutMine).toFixed(2);

clear();
W.gameState.setMode('godmode');
g.applyShot('gameplay');
g.settle(4);

out.fps = {};
for (const k of ['godmodeStatic', 'playIdle', 'playRun', 'playSprintTurn', 'playAim']) {
  out.fps[k] = +(1000 / out[k]).toFixed(0);
}
out.budget60fps = 16.7;
out.draws = eng.pipeline?.sceneStats?.calls ?? eng.renderer.info.render.calls;
out.triangles = eng.pipeline?.sceneStats?.triangles ?? eng.renderer.info.render.triangles;
out.errors = g.errors.slice(0, 5);
return out;
