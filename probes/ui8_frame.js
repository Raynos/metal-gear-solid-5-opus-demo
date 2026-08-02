/**
 * ui8_frame.js — the viewfinder frame's colour, and a measurement trap.
 *
 * This exists because "the frame does not recolour on alert" was measured three
 * times and was wrong all three. `.fr i` transitions `background` over 260 ms,
 * and a `getComputedStyle` read on the same tick returns the START of that
 * transition. Worse, the frame-stepping every probe in this repo uses
 * (`engine.step` + `engine.render` in a loop) does NOT advance the CSS
 * animation clock in headless chromium — no frames are being produced — so
 * running a thousand simulated frames leaves a 260 ms transition at 0%.
 *
 * The fix, and the rule for anything reading animated CSS from a probe: wait
 * REAL time with `await new Promise(r => setTimeout(r, ms))`, not simulated
 * frames. Compare `alertImmediate` against `alertSettled` below — same DOM,
 * same rules, different answer.
 */
const g = window.__GAME;
const UI = window.__UI;
const root = UI.root;
const fr = root.querySelector('.fr');
const et = root.querySelector('.fr .e-t');
const out = {};

g.applyShot('gameplay');
g.settle(2);
g.world.engine.deterministic = false;
UI.show();
g.world.gameState.setMode('play');

const read = (tag) => ({
  tag,
  dataAlert: root.getAttribute('data-alert'),
  dataHp: root.getAttribute('data-hp'),
  frVar: getComputedStyle(fr).getPropertyValue('--fr-col'),
  etBg: getComputedStyle(et).backgroundColor,
  etVar: getComputedStyle(et).getPropertyValue('--fr-col'),
});

out.calm = read('calm');
UI.setAlert('alert');
// `background` is transitioned over 260 ms, so a read on the same tick returns
// the START of the transition, not the target. Every "the frame did not
// recolour" reading in this round was this, not a broken rule.
out.alertImmediate = read('alert +0ms');
await new Promise((r) => setTimeout(r, 500));
out.alertSettled = read('alert +500ms');

UI.setAlert('calm');
UI.hud._syncHealth(0.5, 1 / 30);
await new Promise((r) => setTimeout(r, 500));
out.hurt = read('calm + hurt');
UI.hud._syncHealth(0.2, 1 / 30);
await new Promise((r) => setTimeout(r, 500));
out.critical = read('critical');

// Is the rule even in the sheet?
const sheet = [...document.styleSheets].find((s) => s.ownerNode?.id === 'ui-style');
out.rulesTotal = sheet ? sheet.cssRules.length : -1;
out.frRules = sheet
  ? [...sheet.cssRules].filter((r) => r.selectorText && r.selectorText.includes('.fr')).map((r) => `${r.selectorText} { ${r.style.cssText.slice(0, 90)} }`)
  : [];
out.matched = [...sheet.cssRules].filter((r) => r.selectorText && fr.matches(r.selectorText)).map((r) => r.selectorText);
return out;
