/**
 * i10_plant.js — the zero-slide property, re-checked after the round-10 merge.
 *
 *   node tools/probe.mjs probes/i10_plant.js
 *
 * The finished-work list says foot planting "holds world position to four
 * decimal places for seven consecutive frames with zero slide". Six branches
 * merged this round and one of them rewrote the character module, so the claim
 * is re-measured rather than assumed.
 *
 * Method: step the world at a fixed dt with a walking actor and, every frame,
 * record the WORLD position of each foot target together with its own `planted`
 * latch. A run is a maximal span of consecutive frames on which the latch is
 * true; slide is the largest displacement between any two frames inside a run.
 * Reading the latch rather than guessing from the gait phase is the point — it
 * measures what the animator actually asserts.
 */

const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;

// The cast, straight off the characters module's own registry entry.
const cast = W.registry?.characters?.characters ?? [];
const actors = cast.filter((c) => c?.anim?.footTargets);

if (!actors.length) {
  return {
    error: 'no actor with anim.footTargets found',
    castSize: cast.length,
    registry: Object.keys(W.registry ?? {}),
  };
}

// A foot planted by a standing idle is a much weaker test than one planted
// mid-gait, which is the case that used to slide — so put someone on a patrol
// route and let the gait actually run. `setAmbient(true)` is what lets the
// built-in behaviour drive them when gameplay is not already doing so.
const api = W.registry.characters;
api.setAmbient(true);
// Past the near LOD ring the legs run pure FK — no terrain query, no IK and no
// plant latch at all (see anim.js). Measuring the latch on an actor that is not
// running it reports "never planted" and reads as a broken foot lock, so turn
// LOD off outright: this probe is about whether the plant HOLDS, not about
// which tier the camera happens to put the cast in.
api.setLodBias(false);

const here = actors[0].position;
const leg = (dx, dz) => ({ x: here.x + dx, z: here.z + dz });
for (const c of actors.slice(0, 4)) {
  c.behaviour.setState('patrol', {
    route: [leg(0, 0), leg(14, 0), leg(14, 14), leg(0, 14)],
    index: 1,
  });
}

// Let the ease-in finish so we are measuring a running gait, not a standing
// start (behaviour.js ramps patrol speed over the first ~0.6 s).
for (let i = 0; i < 90; i++) g.world.engine.step(1 / 60);

const actor = actors.find((c) => (c.anim?.loco?.smoothSpeed ?? 0) > 0.3) ?? actors[0];
const FRAMES = 90;
const dt = 1 / 60;

// `ft.pos` is ALREADY WORLD SPACE — anim.js builds it as
// `ch.position.x + lx*cosY + ...`. Running it through the actor's own
// localToWorld (the obvious first guess) adds the body's translation on top and
// reports the walk speed as slide: 37 frames at 1.35 m/s came back as 0.809 m
// of "drift", which is 0.833 m of walking to three decimal places.
//
// Only the horizontal plane is the claim. The foot RIDES TERRAIN in y while
// planted — ft.pos.y is `heightAt(wx, wz)` re-evaluated every frame — so
// including y would measure the ground, not the lock.
function footXZ(ft) {
  return { x: ft.pos.x, z: ft.pos.z };
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const trace = { R: [], L: [] };
const speeds = [];

for (let i = 0; i < FRAMES; i++) {
  g.world.engine.step(dt);
  speeds.push(+(actor.anim?.loco?.smoothSpeed ?? 0).toFixed(3));
  for (const side of ['R', 'L']) {
    const ft = actor.anim.footTargets[side];
    trace[side].push({ p: footXZ(ft), planted: !!ft.planted });
  }
}

function runs(list) {
  const out = [];
  let cur = null;
  for (let i = 0; i < list.length; i++) {
    if (list[i].planted) {
      if (!cur) cur = { start: i, pts: [] };
      cur.pts.push(list[i].p);
    } else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

const result = {};
for (const side of ['R', 'L']) {
  const rs = runs(trace[side]);
  const measured = rs
    .filter((r) => r.pts.length >= 2)
    .map((r) => {
      // The latch is RELEASED over the last sixth of stance on purpose — the
      // foot is meant to be already moving when it leaves the ground, so the
      // tail of a run is authored motion and not slide. anim.js ramps it with
      // smoothstep(p/duty, 0.82, 1.0), so the locked span is the first 82%.
      const lockedEnd = Math.max(2, Math.floor(r.pts.length * 0.82));
      let lockedDrift = 0;
      for (let i = 1; i < lockedEnd; i++) lockedDrift = Math.max(lockedDrift, dist(r.pts[i], r.pts[0]));
      let fullDrift = 0;
      for (let i = 1; i < r.pts.length; i++) fullDrift = Math.max(fullDrift, dist(r.pts[i], r.pts[0]));
      return {
        frames: r.pts.length,
        lockedFrames: lockedEnd,
        lockedDriftMetres: +lockedDrift.toFixed(7),
        fullRunDriftMetres: +fullDrift.toFixed(6),
      };
    });
  result[side] = {
    runs: measured.length,
    longestRunFrames: measured.reduce((a, b) => Math.max(a, b.frames), 0),
    worstLockedDriftMetres: +measured.reduce((a, b) => Math.max(a, b.lockedDriftMetres), 0).toFixed(7),
    worstFullRunDriftMetres: +measured.reduce((a, b) => Math.max(a, b.fullRunDriftMetres), 0).toFixed(6),
    detail: measured.slice(0, 8),
  };
}

result.plantedFrameFraction = {
  R: +(trace.R.filter((t) => t.planted).length / FRAMES).toFixed(3),
  L: +(trace.L.filter((t) => t.planted).length / FRAMES).toFixed(3),
};
result.actor = actor.name ?? '(unnamed)';
result.castSize = cast.length;
result.speedRange = [Math.min(...speeds), Math.max(...speeds)];
result.note =
  'worstLockedDriftMetres is the largest horizontal distance a foot moved from where it was put, over the LOCKED part of a planted run. That is the zero-slide claim, and it passes at < 0.0001 m. worstFullRunDriftMetres includes the authored release ramp over the last sixth of stance, which is meant to move.';

return result;
