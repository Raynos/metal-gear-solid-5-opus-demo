/**
 * ui8_cost.js — what the HUD costs per frame, in the worst state it can reach.
 *
 * The claim this UI is built on is that a DOM HUD is free: no draw calls, no
 * GPU frame time. Free of GPU time is by construction. Free of CPU time is not
 * — it is a property of the change-gated setters in dom.js and of nothing in
 * the tick reading geometry — so it has to be measured, and measured with the
 * ring FULL, which is the only state where the per-marker work exists.
 *
 * Reported: microseconds per HUD tick, and the tick runs at 30 Hz, so the
 * per-frame share at 60 fps is half the number shown.
 */

const g = window.__GAME;
const W = g.world;
const eng = W.engine;
const UI = window.__UI;
if (!UI) return { installed: false };

g.applyShot('gameplay');
g.settle(2);
eng.deterministic = false;
UI.show();
W.gameState.setMode('play');
UI.demo(true);

const run = (n) => { for (let i = 0; i < n; i++) { eng.step(1 / 60); eng.render(); } };
run(120);

const marks = () => UI.root.querySelectorAll('.mk').length;

// Force the tick every call: the accumulator gates on TICK = 1/30.
const time = (n, dt) => {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) UI.hud.update(dt, eng);
  return ((performance.now() - t0) / n) * 1000; // microseconds per tick
};

const out = { markers: marks() };
// Steady state: every value the same, so every change-gated setter no-ops.
out.usSteady = +time(600, 1 / 30).toFixed(1);

// Worst case: the magazine changes every tick, which rewrites the comb, plus a
// full ring of markers moving.
const w = UI.hud.src.playerObject().weapon;
let flip = 0;
const t0 = performance.now();
for (let i = 0; i < 600; i++) {
  w.ammo = (flip = (flip + 1) % (w.magSize + 1));
  UI.hud.update(1 / 30, eng);
}
out.usChurn = +(((performance.now() - t0) / 600) * 1000).toFixed(1);
out.markersAtEnd = marks();

// And with the ring empty, which is what a calm run actually pays.
UI.demo(false);
run(4);
out.usNoMarkers = +time(600, 1 / 30).toFixed(1);

out.note = 'microseconds per HUD tick; the tick is 30 Hz so halve for the per-frame share at 60 fps';
return out;
