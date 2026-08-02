/**
 * r11_fill.js — is the frame fill-bound, and how much of it is the post chain?
 *
 * probes/results/r11-post.json accounts for very little of the frame: the whole
 * ablatable post set resolves to ~2.5 ms (the occlusion pass) with everything
 * else at or under the block spread, and the scene into the HDR target is 6.8 ms
 * — against a 24 ms frame. The missing ~14 ms is in passes with no `enabled[]`
 * flag at all: the prep blit, the 6-level luminance chain, the adaptation blit,
 * the composite and the present/FXAA blit. No ablation can reach them, so no
 * ablation can price them.
 *
 * Resolution can. `setRenderScale` changes the internal buffer every one of
 * those passes runs over, without changing the scene's geometry, its draw calls
 * or its shadow maps. If the frame is dominated by per-pixel post, time should
 * fall with the pixel count; if it is dominated by geometry or CPU, it should
 * barely move. That is a measurement the flags cannot make.
 *
 * This is a DIAGNOSTIC. `renderScale` ships at 1.0 and stays there — the plan
 * for this round is 60 FPS at native resolution, not a smaller buffer.
 */
const g = window.__GAME;
const eng = g.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();

const WARM = 64;
const N = 40;
const REPS = 3;

const cam = eng.camera;
const start = cam.position.clone();
let t = 0;
function step() {
  t += 1 / 60;
  cam.position.set(start.x + Math.sin(t * 0.6) * 6, start.y, start.z + Math.cos(t * 0.6) * 6);
  cam.lookAt(0, 2, 0);
  eng.step(1 / 60);
  eng.render();
}
function block() {
  for (let i = 0; i < WARM; i++) step();
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) step();
  gl.finish();
  return +((performance.now() - t0) / N).toFixed(2);
}

const SCALES = [1.0, 0.85, 0.7, 0.55];
eng.deterministic = true;
eng.stop();
pipe.setRenderScale(1.0);
block();

const samples = {};
for (const s of SCALES) samples[s] = [];
for (let r = 0; r < REPS; r++) {
  for (const s of SCALES) {
    pipe.setRenderScale(s);
    samples[s].push(block());
  }
}
pipe.setRenderScale(1.0);

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const rows = SCALES.map((s) => ({
  scale: s,
  pixelFraction: +(s * s).toFixed(3),
  ms: med(samples[s]),
  runs: samples[s],
  spread: +(Math.max(...samples[s]) - Math.min(...samples[s])).toFixed(2),
}));

// Fit ms = fixed + perPixel * pixelFraction across the two extremes. `fixed` is
// everything that does not scale with the buffer: CPU systems, draw submission,
// shadow map rasterisation, geometry. `perPixel` is the full-resolution
// per-pixel work at scale 1.0 — the number the post chain is mostly made of.
const a = rows[0];
const b = rows[rows.length - 1];
const perPixel = +((a.ms - b.ms) / (a.pixelFraction - b.pixelFraction)).toFixed(2);
const fixed = +(a.ms - perPixel).toFixed(2);

return {
  resolution: `${renderer.domElement.width}x${renderer.domElement.height}`,
  rows,
  model: {
    fixedMs: fixed,
    perPixelMsAtNative: perPixel,
    reading:
      `of the ${a.ms} ms frame, ~${perPixel} ms scales with the pixel count and ` +
      `~${fixed} ms does not. 60 FPS at native needs the per-pixel half cut to ` +
      `${+(16.7 - fixed).toFixed(2)} ms.`,
  },
  worstSpreadMs: +Math.max(...rows.map((r) => r.spread)).toFixed(2),
  caveat: 'renderScale is a DIAGNOSTIC here and ships at 1.0. A linear fit over two points assumes the per-pixel work is uniform; the middle scales are printed so the assumption is checkable.',
};
