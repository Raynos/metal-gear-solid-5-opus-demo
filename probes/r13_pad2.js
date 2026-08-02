/**
 * r13_pad2.js — which term inside the AO pass paints the black polygons.
 *
 * r13_pad puts it beyond doubt that the pass is `ssao`: band/control 0.189
 * shipped, 0.920 with the pass off, against a 0.188 null control, while the
 * shadow term, the palette and the wear field all leave it where it was. The
 * pass has three terms with independent switches, so split them.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const canvas = eng.renderer.domElement;

g.applyShot('ground');
if (window.__pinDeterminism) window.__pinDeterminism();
g.settle(24);
eng.deterministic = true;
eng.stop();

const BAND = [1150, 775];
const CTRL = [1100, 930];
const c2 = document.createElement('canvas');
c2.width = canvas.width; c2.height = canvas.height;
const ctx = c2.getContext('2d', { willReadFrequently: true });
const sx = canvas.width / 1920, sy = canvas.height / 1080;
function sample(px, py) {
  const d = ctx.getImageData(Math.round(px * sx), Math.round(py * sy), 5, 5).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
  return s / (d.length / 4);
}
const rows = [];
function grab(name) {
  for (let i = 0; i < 8; i++) eng.render();
  ctx.drawImage(canvas, 0, 0);
  const band = sample(BAND[0], BAND[1]);
  const ctrl = sample(CTRL[0], CTRL[1]);
  rows.push({ cfg: name, band: +band.toFixed(1), ctrl: +ctrl.toFixed(1), ratio: +(band / ctrl).toFixed(3) });
}

const E = pipe.enabled;
const save = { ssao: E.ssao, microAO: E.microAO, contactShadows: E.contactShadows };
const set = (o) => Object.assign(E, save, o);

grab('base');
set({ microAO: false });          grab('microAO=off');
set({ contactShadows: false });   grab('contact=off');
set({ microAO: false, contactShadows: false }); grab('micro+contact=off');
set({ ssao: false });             grab('whole pass=off');
set({});                          grab('base(null control)');

// Uniforms the pass exposes, so the next step has something to turn.
const ao = pipe.ssaoMaterial ?? pipe.aoMaterial ?? pipe._ssao ?? null;
return {
  rows,
  aoUniformKeys: ao?.uniforms ? Object.keys(ao.uniforms) : null,
  pipeKeys: Object.keys(pipe).filter((k) => /ao|ssao|occl/i.test(k)),
};
