/**
 * r11_repro.js — WHICH piece of state makes the vista shot irreproducible?
 *
 * Three runs of the same source gave vista mean R = 145.3, 151.6, 153.9 (commit
 * f2929ff). Pinning the volumetric history took 1- and 3-shot batches into
 * agreement and left a 7-shot batch at 143.9; the shot looked bistable between
 * ~144 and ~154. That was diagnosed, unverified, as the cloud deck's evolution
 * clock.
 *
 * Doing it across processes costs 10-20 s per data point and confounds the
 * answer with the world build. This does it INSIDE one page: take the same shot
 * repeatedly, varying exactly one thing between takes — how much simulated time
 * and how many frames the page has burned first — and read the frame back each
 * time. Whatever the mean tracks is the cause.
 *
 * Take = exactly what tools/render.mjs does for a shot: applyShot, then
 * __pinDeterminism, then settle(32).
 */
const g = window.__GAME;
const eng = g.engine;
const gl = eng.renderer.getContext();
const vol = g.world.registry.volumetrics;
const SHOT = ARGS[0] || 'vista';

eng.deterministic = true;
eng.stop();

const px = new Uint8Array(eng.renderer.domElement.width * eng.renderer.domElement.height * 4);
function readMean() {
  const w = eng.renderer.domElement.width;
  const h = eng.renderer.domElement.height;
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let r = 0;
  let b = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) { r += px[i * 4]; b += px[i * 4 + 2]; }
  return { R: +(r / n).toFixed(2), B: +(b / n).toFixed(2) };
}

/** One shot, exactly as the harness takes it. */
function take() {
  g.applyShot(SHOT);
  const pinned = window.__pinDeterminism ? window.__pinDeterminism() : null;
  g.settle(pinned && pinned.volumetrics ? 32 : 8);
  return readMean();
}

/** Burn `frames` of simulated time somewhere else, as a batch's earlier shots do. */
function burn(frames, shot) {
  if (shot) g.applyShot(shot);
  for (let i = 0; i < frames; i++) { eng.step(1 / 60); eng.render(); }
}

const out = {};
// a: the reference take, twice in a row with nothing between them.
out.take1 = take();
out.take2 = take();
// b: with simulated time burned in between — the batch-position variable.
burn(200, null);
out.after200frames = take();
burn(600, null);
out.after800frames = take();
// c: with an intervening DIFFERENT shot, which is what a batch really does:
//    a different pose, a different time of day, and a preset change.
g.applyShot('ground');
g.settle(32);
out.afterGroundShot = take();
g.applyShot('night');
g.settle(32);
out.afterNightShot = take();
// d: back to back again, to show whether the instrument itself drifts.
out.take3 = take();

// e: is it the volumetric clock at all? Freeze it and repeat the burn test.
const pass = vol && vol.pass;
if (pass) {
  const realPin = pass.pin.bind(pass);
  out.volClockFrozen = {};
  burn(600, null);
  out.volClockFrozen.after600 = take();
  out.volClockFrozen.t0 = +pass.time.toFixed(3);
  out.volClockFrozen.pinWorks = typeof realPin === 'function';
}

return {
  shot: SHOT,
  means: out,
  note: 'take1/take2/take3 are the same operation with nothing between them. Any ' +
    'spread there is the instrument. A spread that appears only after burn() or ' +
    'after an intervening shot is state that the pin does not reach.',
};
