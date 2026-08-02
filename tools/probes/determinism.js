/**
 * determinism.js — is a frame of this build a pure function of the source?
 *   node tools/shot.mjs probe tools/probes/determinism.js [shot]
 *
 * WHY. For several rounds "no visual change" was an unfalsifiable claim: two
 * runs of the SAME build produced frames differing by RMS 0.23-4.93 codes,
 * which is larger than most of the effects being A/B'd. `settle()` already
 * pins the pipeline frame counter (TAA jitter phase, AO rotation, grain seed)
 * and `engine.elapsed` (wind, cloud pan, cloud shadow). Those were necessary
 * and not sufficient, because several buffers carry state ACROSS a settle:
 *
 *   - the TAA history pair (taaA/taaB) still holds the previous shot's image;
 *     `_historyValid` is only cleared by a camera cut, and a re-settle of the
 *     SAME pose is not a cut
 *   - the auto-exposure adaptation pair (adaptA/adaptB) is an exponential
 *     average with no reset; it converges towards the right value from
 *     wherever the previous shot left it
 *   - every shadow cascade above 0 is on a refresh schedule keyed to a
 *     free-running counter, so which cascades are fresh depends on how many
 *     frames the warm world happened to have drawn
 *
 * This probe measures the residual, bisects which of those matter, and reports
 * how many settle frames are needed for a capture to become reproducible. It
 * prints the exact preamble that makes a frame deterministic, which is what
 * tools/shotd.mjs now runs before every screenshot.
 */

const g = window.__GAME;
const THREE = g.THREE;
const eng = g.world.engine;
const renderer = eng.renderer;
const pipe = eng.pipeline;
const lighting = g.world.lighting;
const gl = renderer.getContext();

const shot = (typeof ARGS !== 'undefined' && ARGS && ARGS[0]) || 'gameplay';
g.applyShot(shot);
g.settle(8);

const size = renderer.getSize(new THREE.Vector2());
const W = Math.min(640, size.x);
const H = Math.min(360, size.y);
const X = (size.x - W) >> 1;
const Y = (size.y - H) >> 1;

function read() {
  const buf = new Uint8Array(W * H * 4);
  gl.readPixels(X, Y, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return buf;
}

function diff(a, b) {
  let sq = 0;
  let max = 0;
  let n = 0;
  let differing = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue; // alpha
    const d = a[i] - b[i];
    if (d) differing++;
    sq += d * d;
    if (Math.abs(d) > max) max = Math.abs(d);
    n++;
  }
  return { rms: +Math.sqrt(sq / n).toFixed(4), maxCode: max, pctPixelsDiffering: +((differing / n) * 100).toFixed(2) };
}

/**
 * Character animation clocks.
 *
 * `Animator` seeds `t`, `phase` and `breath` from `Math.random()` and then
 * integrates them with dt forever. `settle()` rewinds `engine.elapsed`, but not
 * these — so a soldier's idle sway, his gait phase and his breathing depend on
 * how many frames the warm world had drawn before the shot, which is a
 * different number in every run and for every position in a batch. Eight
 * soldiers plus the player, each with a cast shadow, is exactly the 16% of
 * pixels and the 144-code peaks this probe was chasing.
 *
 * Re-seeded per index rather than to a constant, so the crowd does not idle in
 * lockstep — the values are arbitrary but fixed, which is all reproducibility
 * needs.
 */
function pinAnimators() {
  const list = g.world.registry?.characters?.characters;
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const a = list[i]?.anim;
    if (!a) continue;
    a.t = 7.31 * i + 3.5;
    a.phase = (0.6180339887 * (i + 1)) % 1;
    a.breath = 2.17 * i + 1.1;
    a.hitTime = 1e3;
    // The integrators as well: each is an exponential chase with a time
    // constant of 4-7 frames, so leaving them where the last shot put them
    // costs another ~20 frames of convergence per capture.
    a.smoothSpeed = a.speed ?? 0;
    a.stanceBlend = a.stance === 'crouch' ? 1 : 0;
    a.proneBlend = a.stance === 'prone' ? 1 : 0;
    a.bobY = 0;
    a.weaponSway?.set?.(0, 0, 0);
    a.weaponSwayVel?.set?.(0, 0, 0);
    a.lookBlend?.set?.(0, 0);
    n++;
  }
  return n;
}

/**
 * One capture. `pins` selects which sources of carried-over state are reset,
 * so the probe can attribute the residual instead of guessing at it.
 */
function capture(frames, pins) {
  eng.deterministic = true;
  eng.stop();
  if (pins.frameCounter) pipe.frame = 0;
  if (pins.clock) eng.elapsed = 0;
  if (pins.taaHistory) {
    pipe._historyValid = false;
    // Clearing the flag stops the NEXT frame reading history, but the buffers
    // themselves still hold the old image and are re-read from frame 2 on, so
    // the pair has to actually be wiped.
    for (const rt of [pipe.taaA, pipe.taaB]) {
      renderer.setRenderTarget(rt);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(null);
  }
  if (pins.exposureHistory) {
    for (const rt of [pipe.adaptA, pipe.adaptB]) {
      renderer.setRenderTarget(rt);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(null);
  }
  if (pins.shadows) lighting.invalidateShadows();
  if (pins.animators) pinAnimators();
  for (let i = 0; i < frames; i++) {
    eng.step(1 / 60);
    eng.render();
  }
  gl.finish();
  return read();
}

/** Push the world into a DIFFERENT state between captures, the way a batch of
 *  shots does — this is what made same-build diffs non-reproducible in the
 *  first place, and a capture that survives it is genuinely pure. */
function disturb() {
  const p = eng.camera.position.clone();
  const q = eng.camera.quaternion.clone();
  eng.camera.position.set(p.x + 120, p.y + 40, p.z - 90);
  for (let i = 0; i < 20; i++) {
    eng.step(1 / 60);
    eng.render();
  }
  eng.camera.position.copy(p);
  eng.camera.quaternion.copy(q);
}

const NONE = {};
const SETTLE_TODAY = { frameCounter: true, clock: true };
const ALL = { frameCounter: true, clock: true, taaHistory: true, exposureHistory: true, shadows: true, animators: true };

/** Where in the frame does the residual live? Four horizontal bands. */
function bands(a, b) {
  const out = {};
  const rows = H >> 2;
  for (let band = 0; band < 4; band++) {
    let sq = 0;
    let n = 0;
    let max = 0;
    for (let y = band * rows; y < (band + 1) * rows; y++) {
      for (let x = 0; x < W; x++) {
        for (let c = 0; c < 3; c++) {
          const i = (y * W + x) * 4 + c;
          const d = a[i] - b[i];
          sq += d * d;
          if (Math.abs(d) > max) max = Math.abs(d);
          n++;
        }
      }
    }
    // readPixels is bottom-up, so band 0 is the bottom of the frame.
    out[['bottom', 'lowerMid', 'upperMid', 'top'][band]] = { rms: +Math.sqrt(sq / n).toFixed(3), maxCode: max };
  }
  return out;
}

function trial(pins, frames, { disturbed = true } = {}) {
  const a = capture(frames, pins);
  if (disturbed) disturb();
  const b = capture(frames, pins);
  return diff(a, b);
}

// First question, and the one the earlier version of this probe skipped: does a
// capture repeat at all when NOTHING happens between the two? If it does not,
// the world is not converging and `disturb()` is a red herring.
const backToBack = (() => {
  const a = capture(16, ALL);
  const b = capture(16, ALL);
  return { ...diff(a, b), bands: bands(a, b) };
})();

const disturbedBands = (() => {
  const a = capture(16, ALL);
  disturb();
  const b = capture(16, ALL);
  return { ...diff(a, b), bands: bands(a, b) };
})();

const results = {
  backToBackNoDisturbance: backToBack,
  afterACameraExcursion: disturbedBands,
  nothingPinned: trial(NONE, 12),
  whatSettleDoesToday: trial(SETTLE_TODAY, 12),
  plusAnimationClocks: trial({ ...SETTLE_TODAY, animators: true }, 12),
  plusShadowCascades: trial({ ...SETTLE_TODAY, animators: true, shadows: true }, 12),
  everythingPinned12: trial(ALL, 12),
};

// How many frames does the pinned preamble need to converge? Walk it up until
// two disturbed captures are bit-identical, so the answer is measured rather
// than a round number somebody liked.
let convergesAt = null;
const convergence = {};
for (const n of [16, 32]) {
  const d = trial(ALL, n);
  convergence[`frames${n}`] = d;
  if (d.rms === 0 && convergesAt === null) convergesAt = n;
}

lighting.invalidateShadows();
g.settle(8);

return {
  shot,
  window: `${W}x${H} centred, 8-bit sRGB codes`,
  results,
  convergenceWithFullPinSet: convergence,
  bitIdenticalFromNSettleFrames: convergesAt,
  verdict:
    convergence.frames32.rms === 0
      ? 'BIT-IDENTICAL with the full pin set at 32 frames — an A/B diff is now falsifiable'
      : `residual ${convergence.frames32.rms} rms / max ${convergence.frames32.maxCode} codes at 32 pinned frames, ` +
        `against ${results.whatSettleDoesToday.rms} rms with what settle() pins today`,
  note:
    'nothingPinned is what a raw render loop gives. whatSettleDoesToday is main.js settle(): ' +
    'frame counter + clock only. The rows below add, one at a time, the buffers that survive a ' +
    'settle. Whichever row first reaches rms 0 names the fix.',
};
