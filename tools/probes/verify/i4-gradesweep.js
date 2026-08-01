/**
 * (i4) INTEGRATOR, round 7 — the two grade levers the tone-curve rebuild moved,
 * swept against every criterion they can break at once.
 *
 * Rebuilding the toe walked every shadow in the game 15-25 codes UP the display
 * range. Two guards are keyed to where shadows land and both moved with them:
 *
 *   dusk cool   ridge pixels with B > R+4, target >= 12%.  13.79 -> 10.81.
 *               The split tone's cool half is selected on display luminance
 *               through `bandWarp`, so re-registration is supposed to be free —
 *               but the warp is a monotone remap of the WHOLE range and the
 *               dusk frame's shadows crossed the band edge anyway.
 *   daylight R-B mean R - mean B, target +8..+18. gameplay 3.5 -> 4.5, still
 *               a third of the floor, because the gameplay frame is mostly
 *               shadow and shadow is the one band the grade cools on purpose.
 *
 * They pull against each other through `splitShadowEdge` — widening the cool
 * band buys dusk cool and spends daylight red — so sweeping either alone picks
 * a winner by breaking the other. This sweeps the pair.
 */
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer, pipeline = engine.pipeline;
const gl = renderer.getContext();
const W = pipeline.width, H = pipeline.height;
const px = new Uint8Array(W * H * 4);

function stats() {
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const n = W * H;
  let sr = 0, sb = 0, cool = 0, hi = 0;
  const mins = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const j = i * 4, r = px[j], g2 = px[j + 1], b = px[j + 2];
    sr += r; sb += b;
    if (b > r + 4) cool++;
    if (Math.max(r, g2, b) >= 230) hi++;
    mins[Math.min(r, Math.min(g2, b))]++;
  }
  let c = 0, blk = 0;
  for (let v = 0; v < 256; v++) { c += mins[v]; if (c >= 0.0001 * n) { blk = v; break; } }
  return { rb: +((sr - sb) / n).toFixed(1), cool: +(100 * cool / n).toFixed(2), hi230: +(100 * hi / n).toFixed(2), black: blk };
}

const SHOTS = ['vista', 'ground', 'outpost', 'gameplay', 'ridge', 'dawn'];
const base = { edge: pipeline.grade.splitShadowEdge ?? 0.58, mid: pipeline.grade.midTint.slice(), warm: pipeline.grade.warmth.slice() };
const out = [];
const cases = [];
for (const edge of [0.58, 0.66, 0.74])
  for (const dRB of [0, 0.020, 0.040]) cases.push({ edge, dRB });

for (const c of cases) {
  pipeline.grade.splitShadowEdge = c.edge;
  // Extra red-over-blue is put on the MID band, which is where a desert frame
  // lives; the shadow tint is the sky and must stay cool, the highlight tint is
  // the sun and must stay near-white.
  pipeline.grade.midTint = [base.mid[0] + c.dRB, base.mid[1], base.mid[2] - c.dRB];
  pipeline.refreshGrade();
  const row = { edge: c.edge, dRB: c.dRB };
  for (const s of SHOTS) { g.applyShot(s); g.settle(5); row[s] = stats(); }
  out.push(row);
}
pipeline.grade.splitShadowEdge = base.edge;
pipeline.grade.midTint = base.mid;
pipeline.grade.warmth = base.warm;
pipeline.refreshGrade();
g.settle(4);
return out;
