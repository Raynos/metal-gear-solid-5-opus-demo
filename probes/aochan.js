/**
 * aochan.js — read the occlusion buffer's three channels directly, per shot.
 *
 *   probes/run.sh probes/aochan.js
 *
 * Measuring the terms off the composited frame conflates them with the grade,
 * the exposure solve and the aerial pass. This reads `pipeline.aoRT` itself:
 *   .r broad AO   .b micro AO   .a contact shadow
 * so "how much of the frame does each term actually touch, and how deep does it
 * go" is answered as a number rather than inferred from a crop.
 */

const g = window.__GAME;
const eng = g.world.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;

const out = {};
for (const shot of ['ground', 'outpost', 'ridge', 'gameplay', 'night', 'vista']) {
  if (!g.shots[shot]) continue;
  g.applyShot(shot);
  g.settle(8);
  const rt = pipe.aoRT;
  const w = Math.min(rt.width, 960);
  const h = Math.min(rt.height, 540);
  const x0 = ((rt.width - w) / 2) | 0;
  const y0 = ((rt.height - h) / 2) | 0;
  // The AO target is HalfFloatType. readRenderTargetPixels does NOT convert:
  // hand it a Float32Array and every sample comes back 0, silently, which is
  // exactly the shape of a probe that reports "the term does nothing".
  const raw = new Uint16Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, x0, y0, w, h, raw);
  const buf = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    const s = b >> 15 ? -1 : 1;
    const e = (b >> 10) & 0x1f;
    const f = b & 0x3ff;
    buf[i] = e === 0 ? s * 6.103515625e-5 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + f / 1024);
  }

  const stat = (o) => {
    let sum = 0;
    let n = 0;
    let touched = 0;
    let deep = 0;
    let lo = 1;
    for (let i = o; i < buf.length; i += 4) {
      const v = buf[i];
      if (!isFinite(v)) continue;
      sum += v;
      n++;
      if (v < 0.9) touched++;
      if (v < 0.6) deep++;
      if (v < lo) lo = v;
    }
    return {
      mean: +(sum / Math.max(n, 1)).toFixed(4),
      fracUnder0_9: +(touched / Math.max(n, 1)).toFixed(4),
      fracUnder0_6: +(deep / Math.max(n, 1)).toFixed(4),
      min: +lo.toFixed(4),
    };
  };
  out[shot] = { broad: stat(0), micro: stat(2), contact: stat(3) };
}
g.applyShot('ground');
return out;
