/**
 * ui8_hud.js — prove the HUD out without a picture of it.
 *
 * The screenshot harness takes a FULL-PAGE capture and the UI hides itself the
 * instant the harness touches anything, by design — so there is no way to
 * photograph this HUD without corrupting every canonical frame in the repo.
 * What can be done instead is measure it: geometry, computed colour, and text,
 * for every element, in every state. That is what this reports.
 *
 *   node tools/shot.mjs eval probes/ui8_hud.js
 *
 * Read the output as: does the weapon plate EXIST and sit in the bottom-right
 * corner; is the magazine comb as long as the magazine; do the detection
 * markers land on the true bearings; does the wound state reach the frame.
 */

const g = window.__GAME;
const W = g.world;
const eng = W.engine;
const UI = window.__UI;
if (!UI) return { installed: false };

const run = (n) => { for (let i = 0; i < n; i++) { eng.step(1 / 60); eng.render(); } };
const R = (el) => {
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
};
const vis = (el) => {
  if (!el) return null;
  const s = getComputedStyle(el);
  return { o: +(+s.opacity).toFixed(2), display: s.display, visibility: s.visibility, color: s.color };
};
const q = (sel) => UI.root.querySelector(sel);
const txt = (sel) => (q(sel) ? q(sel).textContent : null);

const out = { viewport: [innerWidth, innerHeight] };

// The harness has already latched; un-latch and take the frame back. Clearing
// `deterministic` matters as much as `UI.show()` — the per-frame guard in
// index.js re-hides and early-returns on it, so without this the HUD never
// ticks and every readout below measures an empty DOM.
g.applyShot('gameplay');
g.settle(2);
eng.deterministic = false;
UI.show();
W.gameState.setMode('play');
UI.demo(true);
run(90);

// --- 1. the widget that never appeared ------------------------------------
out.adapter = UI.describe();
out.weaponPlate = {
  box: R(q('.wpl')),
  opacity: vis(q('.wpn')).o,
  name: txt('.wtop em'),
  chip: txt('.wtop i'),
  chipColour: vis(q('.wtop i')).color,
  supRow: vis(q('.sup')).display,
  supReading: q('.sup i').getAttribute('data-v'),
  combTicks: q('.mag').children.length,
  combLit: [...q('.mag').children].filter((s) => s.getAttribute('data-v') === '1').length,
  ammo: txt('.amo b'),
  reserve: txt('.amo u'),
  mode: txt('.wmd'),
  stance: [...UI.root.querySelectorAll('.stn u')].find((u) => u.getAttribute('data-v') === '1')?.getAttribute('data-k'),
};
// Bottom-right corner check: the plate's right and bottom edges must sit on the
// viewfinder inset, not float in the middle of the frame.
const pb = q('.wpl').getBoundingClientRect();
out.weaponPlate.insetFromRight = Math.round(innerWidth - pb.right);
out.weaponPlate.insetFromBottom = Math.round(innerHeight - pb.bottom);

// --- 2. the same widget with the REAL gameplay module ---------------------
UI.demo(false);
run(30);
out.realFeed = {
  describe: UI.describe(),
  plateOpacity: vis(q('.wpn')).o,
  name: txt('.wtop em'),
  combTicks: q('.mag').children.length,
  ammo: txt('.amo b'),
  reserve: txt('.amo u'),
};

// --- 3. detection readability ---------------------------------------------
UI.demo(true);
run(120);
out.detection = [...UI.root.querySelectorAll('.mk')].map((m) => ({
  tier: m.getAttribute('data-s'),
  urgent: m.getAttribute('data-urgent'),
  bearingDeg: +(/rotate\(([-\d.]+)deg\)/.exec(m.style.transform)?.[1] ?? NaN),
  counterRot: m.firstChild.style.getPropertyValue('--nr'),
  meter: m.style.getPropertyValue('--a'),
  range: m.querySelector('u').textContent,
  reason: m.querySelector('em').textContent,
  colour: vis(m).color,
  onScreen: (() => { const b = m.querySelector('.mkl').getBoundingClientRect(); return b.x > 0 && b.y > 0 && b.right < innerWidth && b.bottom < innerHeight; })(),
}));

// --- 4. damage -------------------------------------------------------------
const shooter = { x: eng.camera.position.x + 40, z: eng.camera.position.z - 40 };
UI.damage(shooter, 'hit');
run(2);
const frameCol = () => getComputedStyle(q('.fr .e-t')).backgroundColor;
out.damage = {
  wedges: [...UI.root.querySelectorAll('.dw')].map((w) => ({ on: w.classList.contains('on'), t: w.style.transform, kind: w.getAttribute('data-k') })),
  hpAttr: UI.root.getAttribute('data-hp'),
  alertAttr: UI.root.getAttribute('data-alert'),
  vignette: q('.dmg').style.getPropertyValue('--hurt'),
  frameColour: frameCol(),
};
// Drive the stand-in's health down to critical and read the frame. Alert is
// forced back to calm first: the alert colour deliberately outranks the wound
// colour on the frame, so this is the only way to see the wound rule at all.
UI.setAlert('calm');
const p = UI.hud.src.playerObject();
p.health = 0.2;
run(4);
out.damageCritical = { hpAttr: UI.root.getAttribute('data-hp'), vignette: q('.dmg').style.getPropertyValue('--hurt'), frameColour: frameCol() };
UI.hud._syncHealth(0.5, 1 / 30);
run(1);
out.damageHurt = { hpAttr: UI.root.getAttribute('data-hp'), frameColour: frameCol() };
// The recovery cue, driven straight at the HUD: the stand-in's health climbs
// too slowly to cross 0.999 inside a probe, and the cue is what is under test.
UI.hud._syncHealth(1, 1 / 30);
out.damageRecovered = { hpAttr: UI.root.getAttribute('data-hp'), healPlaying: q('.dmg').classList.contains('heal') };

// --- 5. mission flow -------------------------------------------------------
UI.endMission('failed', 'killed in action');
run(4);
out.missionFailed = {
  card: q('.cin').getAttribute('data-card'),
  title: txt('.ct'),
  meta: [...UI.root.querySelectorAll('.cm > span')].map((s) => s.textContent),
  prompts: [...UI.root.querySelectorAll('.cp > span')].map((s) => s.textContent),
  // The beat, measured rather than asserted: every animation on the card and
  // how long each waits before it starts.
  delays: document.getAnimations().filter((a) => a.effect?.target?.closest?.('.cin')).map((a) => `${a.effect.target.className}:${a.effect.getTiming().delay}ms`),
  // The beat: the plate is opaque immediately, the type is not.
  plateOpacity: +(+getComputedStyle(q('.cin .plate')).opacity).toFixed(2),
  titleOpacityAtCut: +(+getComputedStyle(q('.ct')).opacity).toFixed(2),
  result: UI.mission.result,
};
await new Promise((r) => setTimeout(r, 2600));
out.missionFailedAfterBeat = {
  titleOpacity: +(+getComputedStyle(q('.ct')).opacity).toFixed(2),
  promptOpacity: +(+getComputedStyle(q('.cp')).opacity).toFixed(2),
};

// The restart path, driven exactly as ENTER drives it.
UI.restart();
await new Promise((r) => requestAnimationFrame(r));
run(4);
out.afterRestart = { mode: W.gameState.mode, card: q('.cin').getAttribute('data-card'), result: UI.mission.result, running: UI.mission.running };

// --- 6. the harness guard still holds --------------------------------------
g.applyShot('vista');
run(2);
out.harness = { rootHidden: UI.root.hidden, mode: W.gameState.mode };

return out;
