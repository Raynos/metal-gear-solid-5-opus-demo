/**
 * ui8_fire.js — does the weapon block track the REAL gameplay module?
 *
 * No stand-in feed anywhere in here. It drives `registry.player.fire()` six
 * times, which is the whole magazine, then one more, which is what starts a
 * reload, and reads the comb and the count off the DOM after each. It also
 * reports the calm-state opacities, because "nearly invisible when calm" is a
 * number, not an opinion.
 */

const g = window.__GAME;
const W = g.world;
const eng = W.engine;
const UI = window.__UI;
const api = W.registry.player;
if (!UI || !api) return { ui: !!UI, gameplay: !!api };

g.applyShot('gameplay');
g.settle(2);
eng.deterministic = false;
UI.show();
W.gameState.setMode('play');
UI.demo(false);

const run = (n) => { for (let i = 0; i < n; i++) { eng.step(1 / 60); eng.render(); } };
const q = (s) => UI.root.querySelector(s);
const comb = () => [...q('.mag').children].map((s) => s.getAttribute('data-v')).join('');
const shot = (tag) => ({
  tag,
  apiAmmo: api.ammo,
  apiReloading: api.reloading,
  comb: comb(),
  count: q('.amo b').textContent,
  reserve: q('.amo u').textContent,
  reloadSweep: q('.mag').getAttribute('data-rl'),
  emptyFlag: q('.amo b').getAttribute('data-empty'),
});

run(30);
const out = { frames: [shot('start')] };

// The alert ladder is already lit in this scene, so force it back down: the
// calm opacities are the thing under test and they are gated on it.
// A genuinely calm reading is not reachable in this scene: the player spawns
// inside a patrol's cone and the squad is back at ALERT within a second, which
// is a gameplay problem, not a HUD one. So the FEED is stubbed empty — the HUD
// itself is untouched and is driven through its own update() 200 times, which
// is past the 5 s hot window on the weapon block.
UI.setAlert('calm');
const realSensors = UI.hud.src.sensors;
UI.hud.src.sensors = (o) => { o.length = 0; return o; };
for (let i = 0; i < 200; i++) UI.hud.update(1 / 30, eng);
await new Promise((r) => setTimeout(r, 700)); // let the CSS opacity transitions land
out.calm = {
  cmpVar: q('.cmp').style.getPropertyValue('--cmp-o'),
  wpnVar: q('.wpn').style.getPropertyValue('--wpn-o'),
  objVar: q('.obj').style.getPropertyValue('--obj-o'),
  markers: UI.root.querySelectorAll('.mk').length,
  alert: UI.root.getAttribute('data-alert'),
  compass: getComputedStyle(q('.cmp')).opacity,
  weapon: getComputedStyle(q('.wpn')).opacity,
  objective: getComputedStyle(q('.obj')).opacity,
  alertBlock: getComputedStyle(q('.alr')).opacity,
  hudVisibility: getComputedStyle(q('.hud')).visibility,
};
UI.hud.src.sensors = realSensors;

for (let i = 1; i <= 7; i++) {
  api.fire();
  run(20);
  out.frames.push(shot(`fire ${i}`));
}
// Let the reload finish. RELOAD_TIME is 2.1 s of simulated time.
run(150);
out.frames.push(shot('after reload'));

// Godmode must take the whole thing off screen.
W.gameState.setMode('godmode');
run(4);
// The HUD leaves on a 300 ms opacity fade with visibility switching at its end,
// so this has to wait real time, not frames.
await new Promise((r) => setTimeout(r, 700));
out.godmode = {
  hudVisibility: getComputedStyle(q('.hud')).visibility,
  hudOpacity: getComputedStyle(q('.hud')).opacity,
  mode: W.gameState.mode,
};
// And with the harness driving, the whole root is gone, not merely faded.
g.applyShot('vista');
out.underHarness = { rootHidden: UI.root.hidden, mode: W.gameState.mode };
return out;
