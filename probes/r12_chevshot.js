/**
 * r12_chevshot.js — photograph the aimed mountain with the AO pass on and off.
 *
 * r12_chev2 says the herringbone is the AO pass: `ssao` off takes the vertical
 * peak from 0.281 to 0.142 codes and the band's high-pass RMS from 0.583 to
 * 0.252, and moves the peak period off 15.75 px entirely, while noMicroAO,
 * noContact, noAerial, noDof, noBloom, noVol and noFxaa all leave it within the
 * null control. `shot.mjs` has no switch for a post pass, so the frame is read
 * off the canvas here instead and returned as a data URL.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const canvas = eng.renderer.domElement;

g.applyShot('gameplay');
g.setMode('play');
window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
for (let k = 0; k < 45; k++) eng.step(1 / 60);
g.settle(32);
eng.deterministic = true;
eng.stop();

// Crop to the mountain, doubled, so the pattern is readable in the PNG.
const CX = 200, CY = 20, CW = 640, CH = 300;
function grab() {
  for (let i = 0; i < 12; i++) eng.render();
  const c = document.createElement('canvas');
  c.width = CW * 2; c.height = CH * 2;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, CX, CY, CW, CH, 0, 0, CW * 2, CH * 2);
  return c.toDataURL('image/png');
}
const on = grab();
pipe.enabled.ssao = false;
const off = grab();
pipe.enabled.ssao = true;
return { on, off };
