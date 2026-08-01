/**
 * (k5) Sweep the rebuilt toe's log-log slope against everything it trades.
 *
 * `grade.toeSlope` is the only free parameter in the round-6 curve that is not
 * pinned by an anchor. 1.0 is a straight line in stops — one stop of scene is
 * one stop of display, so the curve neither manufactures nor destroys chroma.
 * Under 1.0 spends scene range to buy display codes, which is what a film's
 * straight-line section does, and is the difference between a shadow that
 * merely exists and one that reads.
 *
 * What it trades, all measured here rather than reasoned about:
 *   c02 / c005  where scene linear 0.02 / 0.005 print
 *   slope       worst codes-per-stop between scene linear 0.006 and 0.06
 *   coolPct     B > R+4 on the dusk ridge (target >= 12) — a per-channel curve
 *               with slope != 1 moves chroma as (B/R)^slope, and the old ACES
 *               toe's slope of 1.6-5.5 was MANUFACTURING the dusk frame's cool
 *   hi230/black the two ends of the range
 */
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer, pipeline = engine.pipeline;
const gl = renderer.getContext();
const W = pipeline.width, H = pipeline.height;
const buf = new Uint8Array(W * H * 4);

function frame() {
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const n = W * H;
  const maxH = new Float64Array(256), minH = new Float64Array(256);
  let ge230 = 0, cool = 0, sr = 0, sg = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    const j = i * 4, r = buf[j], g2 = buf[j + 1], b = buf[j + 2];
    maxH[Math.max(r, g2, b)]++; minH[Math.min(r, g2, b)]++;
    if (Math.max(r, g2, b) >= 230) ge230++;
    if (b > r + 4) cool++;
    sr += r; sg += g2; sb += b;
  }
  const q = (h, t) => { let c = 0; for (let v = 0; v < 256; v++) { c += h[v]; if (c >= t * n) return v; } return 255; };
  return {
    hi230Pct: +((ge230 / n) * 100).toFixed(3), p9999: q(maxH, 0.9999),
    blackP001: q(minH, 0.0001), meanY: +((sr + sg + sb) / (3 * n)).toFixed(1),
    meanRB: +((sr - sb) / n).toFixed(1), coolPct: +((cool / n) * 100).toFixed(2),
  };
}

// The curve, read straight off the pipeline's own CPU mirror so this cannot
// drift from what the shader does.
function curveRow(slope) {
  const E = pipeline._finalExposure;
  const out = {};
  for (const lin of [0.005, 0.01, 0.02, 0.05]) out['c' + lin] = +pipeline._display(lin * E).toFixed(6);
  return out;
}

const SLOPES = [1.0, 0.96, 0.92, 0.88];
const out = { note: 'toe off = round-5 print', shots: {} };
for (const name of ['vista', 'ridge', 'ground', 'night']) {
  g.applyShot(name);
  out.shots[name] = {};
  pipeline.setToneToe(false);
  g.settle(14);
  out.shots[name].off = frame();
  pipeline.setToneToe(true);
  for (const s of SLOPES) {
    pipeline.grade.toeSlope = s;
    pipeline.refreshGrade();
    g.settle(14);
    out.shots[name]['slope' + s] = { ...frame(), ...curveRow(s) };
  }
  pipeline.grade.toeSlope = 0.92;
  pipeline.refreshGrade();
  g.settle(4);
}
return out;
