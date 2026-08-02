/**
 * r13_aobuf.js — photograph the AO buffer itself over the black polygon.
 *
 * r13_pad2 splits the defect between the two horizon searches: band/control is
 * 0.189 shipped, 0.581 with micro off, 0.916 with the whole pass off. Contact
 * shadows contribute nothing. So both searches report near-total occlusion on
 * open flat ground, and the next question is what the buffer looks like there —
 * a shape that follows geometry, or one that follows the screen.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const r = eng.renderer;

g.applyShot('ground');
if (window.__pinDeterminism) window.__pinDeterminism();
g.settle(24);
eng.deterministic = true;
eng.stop();
for (let i = 0; i < 8; i++) eng.render();

function dump(rt, label, chan) {
  if (!rt) return null;
  const w = rt.width, h = rt.height;
  const buf = new Float32Array(w * h * 4);
  try {
    r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  } catch (e) {
    const b8 = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(rt, 0, 0, w, h, b8);
    for (let i = 0; i < b8.length; i++) buf[i] = b8[i] / 255;
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  let min = 1e9, max = -1e9, sum = 0;
  for (let i = 0; i < w * h; i++) {
    const v = buf[i * 4 + chan];
    min = Math.min(min, v); max = Math.max(max, v); sum += v;
    // readRenderTargetPixels is bottom-up; flip into image order.
    const x = i % w, y = h - 1 - ((i / w) | 0);
    const o = (y * w + x) * 4;
    const b = Math.max(0, Math.min(255, Math.round(v * 255)));
    img.data[o] = b; img.data[o + 1] = b; img.data[o + 2] = b; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { label, w, h, min: +min.toFixed(4), max: +max.toFixed(4), mean: +(sum / (w * h)).toFixed(4), png: c.toDataURL('image/png') };
}

const au = pipe.aoMat?.uniforms ?? {};
return {
  ao: dump(pipe.aoRT, 'aoRT.r', 0),
  aoG: dump(pipe.aoRT, 'aoRT.g(micro)', 1),
  aoSize: pipe.aoRT ? [pipe.aoRT.width, pipe.aoRT.height] : null,
  canvasSize: [r.domElement.width, r.domElement.height],
  uniforms: Object.fromEntries(Object.entries(au).map(([k, v]) => [
    k, typeof v.value === 'number' ? v.value : (v.value?.toArray ? v.value.toArray() : String(v.value?.constructor?.name ?? v.value)),
  ])),
};
