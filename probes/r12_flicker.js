/**
 * r12_flicker.js — with the camera STILL, what is still moving?
 *
 * Player report: "the shadows, blacks, and frame rate are still quite glitchy".
 * Glitchy is a temporal word. With a static camera and a pinned simulation,
 * consecutive frames ought to be identical; anything that is not is flicker,
 * and flicker is what "glitchy" means when it is about shadows and blacks.
 *
 * The hypothesis this is built to test: several passes dither with a
 * PER-PIXEL, PER-FRAME rotation on the explicit assumption that a temporal
 * resolve will average it out --
 *
 *   - PCSS shadows: a 20-tap Vogel disc rotated by ign(gl_FragCoord) each frame
 *   - GTAO: a temporal rotation keyed to frame % 64
 *   - the DOF gather: rot = ign(gl_FragCoord.xy + uFrame * 3.7)
 *   - film grain: seeded from the frame counter
 *
 * -- and TAA, which is what was supposed to resolve them, is OFF. It was turned
 * off deliberately (RenderPipeline: "reprojection fails whenever the camera
 * moves ... a sharp aliased frame beats a smeared stable one"), and FXAA, which
 * replaced it, is a single-frame edge filter that cannot average anything over
 * time. If that is right, every one of those passes is now emitting raw noise
 * that changes every frame, and the symptom would be exactly shadows and dark
 * areas crawling.
 *
 * Method: hold the camera and the sim absolutely still, render pairs of frames,
 * and difference them. Then ablate each suspect and see which one the flicker
 * follows. A pass that is innocent leaves the flicker unchanged.
 */
const g = window.__GAME;
const eng = g.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();

g.applyShot('ground');
eng.deterministic = true;
eng.stop();

const W = 640, H = 360;
const fw = renderer.domElement.width, fh = renderer.domElement.height;

function grab() {
  const px = new Uint8Array(fw * fh * 4);
  gl.readPixels(0, 0, fw, fh, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const sy = Math.floor((y / H) * fh);
    for (let x = 0; x < W; x++) {
      const sx = Math.floor((x / W) * fw);
      const s = (sy * fw + sx) * 4, d = (y * W + x) * 3;
      out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2];
    }
  }
  return out;
}

/**
 * Flicker split by how DARK the pixel is.
 *
 * "The blacks are glitchy" is a claim about a luminance band, not about the
 * frame mean. Grain is weighted 1 - |2*lum - 1|, which PEAKS at mid-grey and
 * falls to zero at black — so on paper it cannot be the blacks. But this round
 * lifted the shadows from near-black to about 2.4 stops down, which moves them
 * toward exactly where that weight peaks. This tests whether the lift walked
 * the shadows into the grain.
 */
function diffByBand(a, b) {
  const bands = [
    { name: 'deep shadow  L<0.10', lo: 0, hi: 0.10 },
    { name: 'shadow  0.10-0.25', lo: 0.10, hi: 0.25 },
    { name: 'midtone 0.25-0.60', lo: 0.25, hi: 0.60 },
    { name: 'highlight  L>0.60', lo: 0.60, hi: 1.01 },
  ].map((b2) => ({ ...b2, sum: 0, n: 0 }));
  for (let i = 0; i < a.length; i += 3) {
    const L = (0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2]) / 255;
    const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    for (const bd of bands) if (L >= bd.lo && L < bd.hi) { bd.sum += d; bd.n++; break; }
  }
  return bands.map((b2) => ({
    band: b2.name,
    pctOfFrame: +((b2.n / (a.length / 3)) * 100).toFixed(1),
    meanDelta: b2.n ? +(b2.sum / b2.n).toFixed(3) : null,
  }));
}

/** Mean absolute difference, and how much of the frame moved at all. */
function diff(a, b) {
  let sum = 0, moved = 0, worst = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    sum += d; if (d > 2) moved++; if (d > worst) worst = d;
  }
  const n = a.length / 3;
  return { mean: +(sum / n).toFixed(3), pctMoved: +((moved / n) * 100).toFixed(2), worst: +worst.toFixed(1) };
}

/**
 * Render N frames with NOTHING changing — no camera motion, dt = 0 so no
 * animation, no sim advance — and difference each against the last. dt = 0 is
 * the important part: it isolates per-frame RENDER dither from anything the
 * world is legitimately doing.
 */
function flicker(label, n = 6) {
  for (let i = 0; i < 24; i++) { eng.step(0); eng.render(); }   // settle
  let prev = grab();
  const ds = [];
  for (let i = 0; i < n; i++) {
    eng.step(0);
    eng.render();
    const cur = grab();
    ds.push(diff(prev, cur));
    prev = cur;
  }
  const mean = +(ds.reduce((a, d) => a + d.mean, 0) / ds.length).toFixed(3);
  const pct = +(ds.reduce((a, d) => a + d.pctMoved, 0) / ds.length).toFixed(2);
  return { label, meanDelta: mean, pctPixelsMoving: pct, worst: Math.max(...ds.map((d) => d.worst)) };
}

const E = pipe.enabled;
const base = { ssao: E.ssao, micro: E.microAO, cs: E.contactShadows, bloom: E.bloom, dof: E.dof, mb: E.motionBlur };
const grain0 = pipe.grade.grainAmount;
const shadowsWere = renderer.shadowMap.enabled;

// Banded read of the shipped configuration, which is the one being complained
// about. Done first, before anything is ablated.
for (let i = 0; i < 24; i++) { eng.step(0); eng.render(); }
const bandA = grab();
eng.step(0); eng.render();
const bandB = grab();
const bandedShipped = diffByBand(bandA, bandB);

const g0 = pipe.grade.grainAmount;
pipe.grade.grainAmount = 0;
for (let i = 0; i < 24; i++) { eng.step(0); eng.render(); }
const ngA = grab();
eng.step(0); eng.render();
const bandedNoGrain = diffByBand(ngA, grab());
pipe.grade.grainAmount = g0;

const out = [];
out.push(flicker('as shipped (TAA off, FXAA on)'));

pipe.grade.grainAmount = 0;
out.push(flicker('grain off'));

E.ssao = false;
out.push(flicker('grain off + occlusion pass off'));
E.ssao = base.ssao;

pipe.grade.grainAmount = grain0;
renderer.shadowMap.enabled = false;
out.push(flicker('shadow map off'));
renderer.shadowMap.enabled = shadowsWere;

E.dof = false; E.motionBlur = false;
out.push(flicker('DOF/motion-blur pass off'));
E.dof = base.dof; E.motionBlur = base.mb;

// And the control that matters: turn the temporal resolve back ON. If TAA
// removes the flicker, the dither is the cause and the question becomes what to
// do about a resolve that was disabled for smearing.
E.taa = true;
out.push(flicker('TAA ON (the resolve these passes assume)'));
E.taa = false;

pipe.grade.grainAmount = grain0;

const shipped = out[0].meanDelta;
return {
  bandedFlicker: { shipped: bandedShipped, grainOff: bandedNoGrain },
  note: 'camera static, dt = 0, so a perfectly stable renderer reads 0.000. Anything above that is per-frame dither with no temporal resolve.',
  results: out,
  reading: out.map((o) => `${o.label}: ${o.meanDelta} (${(100 * (1 - o.meanDelta / shipped)).toFixed(0)}% of shipped flicker removed)`),
};
