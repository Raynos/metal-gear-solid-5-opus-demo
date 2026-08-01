/**
 * playcost.js — CPU cost of the player systems alone.
 *
 * perfplay.js measures whole frames, which on a machine shared by eight agents
 * and one GPU is dominated by contention noise (a run measured godmode static
 * at 146 ms and play-mode idle at 82 ms in the same pass — the load changed
 * between scenarios, so neither number means anything). This times only the
 * gameplay systems' own update calls, with no rendering in the loop, so it is a
 * CPU number that a busy GPU cannot corrupt.
 */

const g = window.__GAME;
const W = g.world;
const eng = W.engine;
const api = W.registry.player;
if (!api) return { installed: false };

g.applyShot('gameplay');
g.settle(3);
W.gameState.setMode('play');

const held = new Set();
const key = (code, down) => {
  if (down) held.add(code); else held.delete(code);
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
};
const clear = () => { for (const c of [...held]) key(c, false); };

const home = api.position.clone();
const camYaw = api.camera.yaw;
const reset = () => {
  api.controller.position.copy(home);
  api.controller.footY = home.y;
  api.controller.velocity.set(0, 0, 0);
  api.camera.yaw = camYaw;
  api.camera.reset(api.controller.position, camYaw);
};

const mine = eng.systems.filter((s) => s.order === 15 || s.order === 1100);

/** Median of `reps` passes of N system ticks, in microseconds per tick. */
function timeSystems(N = 2000, reps = 7) {
  const runs = [];
  for (let r = 0; r < reps; r++) {
    reset();
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      if (i % 400 === 399) reset();
      for (const s of mine) s.update(1 / 60, eng);
    }
    runs.push(((performance.now() - t0) / N) * 1000);
  }
  runs.sort((a, b) => a - b);
  return +runs[reps >> 1].toFixed(2);
}

const out = { us_per_frame: {} };
reset();
out.us_per_frame.idle = timeSystems();
key('KeyW', true); key('ShiftLeft', true);
out.us_per_frame.sprinting = timeSystems();
key('Mouse2', true);
out.us_per_frame.sprintAiming = timeSystems();
clear();

// One-off: the obstacle bake, re-run so its cost is on the record.
const t0 = performance.now();
const bakeAgain = api.obstacles
  ? new (api.obstacles.constructor)(eng.renderer, [W.registry.outpost.group, W.registry.rocks?.group].filter(Boolean), {
      center: W.registry.outpost.bounds.getCenter(new g.THREE.Vector3()),
      extent: api.obstacles.extent,
      res: api.obstacles.res,
      padLevel: W.registry.outpost.padLevel ?? 0,
    })
  : null;
out.obstacleBakeMs = bakeAgain ? +(performance.now() - t0).toFixed(1) : null;
out.obstacleBakeOk = bakeAgain?.ok ?? null;
out.obstacleBytes = bakeAgain ? bakeAgain.data.length : 0;

// A fire() is the one thing that is not O(1): it integrates the dart.
reset();
const tf = performance.now();
for (let i = 0; i < 200; i++) { api.stealth.ammo = 6; api.fire(); }
out.fireUs = +(((performance.now() - tf) / 200) * 1000).toFixed(1);

clear();
W.gameState.setMode('godmode');
g.applyShot('gameplay');
g.settle(4);
out.errors = g.errors.slice(0, 5);
return out;
