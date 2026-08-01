/**
 * (k2) TONE CURVE REGRESSION GUARDS, by ablation.
 *
 * Every number the round-6 tone-curve rebuild is allowed to break, measured on
 * the presented frame with the rebuilt toe ON and again with it OFF
 * (`pipeline.setToneToe(false)` restores the round-5 print exactly — the raw
 * ACES toe AND the power-form grade contrast, which are two toes on the same
 * band and have to move together).
 *
 *   blackP001   p0.01 of the per-pixel MIN channel      target 10-12
 *   crushedPct  pixels with a zero channel              target 0
 *   clippedPct  pixels with a 255 channel
 *   hi230Pct    pixels with max-channel >= 230          target 1.9-3.2 (daylight)
 *   p9999       p99.99 of max-channel                   target 244-245
 *   meanRB      mean R - mean B                         target +8..+18 daylight
 *   coolPct     pixels with B > R + 4                   ridge: >= 12
 *   groundBR / skyBR / groundY / skyY                   night: ground darker,
 *                                                       ground B-R >= 18
 *
 * Ground and sky are split by the true horizon row rather than by a fixed
 * fraction; see horizon-rows.js for where that number comes from.
 */
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer, pipeline = engine.pipeline;
const gl = renderer.getContext();
const W = pipeline.width, H = pipeline.height;
const buf = new Uint8Array(W * H * 4);
const srgb = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

function frame() {
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const minHist = new Float64Array(256), maxHist = new Float64Array(256);
  let sr = 0, sg = 0, sb = 0, n = 0, crushed = 0, clipped = 0, cool = 0;
  // readPixels is bottom-up: rows 0..H/3 are the near ground, the top third sky.
  let gY = 0, gB = 0, gR = 0, gn = 0, kY = 0, kB = 0, kR = 0, kn = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = buf[i], gg = buf[i + 1], b = buf[i + 2];
      const mn = Math.min(r, gg, b), mx = Math.max(r, gg, b);
      minHist[mn]++; maxHist[mx]++;
      sr += r; sg += gg; sb += b; n++;
      if (mn === 0) crushed++;
      if (mx === 255) clipped++;
      if (b > r + 4) cool++;
      if (y < H * 0.33) {
        gY += 0.2126 * srgb(r / 255) + 0.7152 * srgb(gg / 255) + 0.0722 * srgb(b / 255);
        gR += r; gB += b; gn++;
      } else if (y > H * 0.72) {
        kY += 0.2126 * srgb(r / 255) + 0.7152 * srgb(gg / 255) + 0.0722 * srgb(b / 255);
        kR += r; kB += b; kn++;
      }
    }
  }
  const pct = (hist, q) => { let acc = 0; const t = n * q; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= t) return v; } return 255; };
  let hi230 = 0; for (let v = 230; v < 256; v++) hi230 += maxHist[v];
  return {
    blackP001: pct(minHist, 0.0001),
    crushedPct: +((crushed / n) * 100).toFixed(3),
    clippedPct: +((clipped / n) * 100).toFixed(3),
    hi230Pct: +((hi230 / n) * 100).toFixed(3),
    p9999: pct(maxHist, 0.9999),
    meanR: +(sr / n).toFixed(1), meanG: +(sg / n).toFixed(1), meanB: +(sb / n).toFixed(1),
    meanRB: +((sr - sb) / n).toFixed(1),
    coolPct: +((cool / n) * 100).toFixed(2),
    groundY: +(gY / gn).toFixed(4), skyY: +(kY / kn).toFixed(4),
    groundBR: +((gB - gR) / gn).toFixed(1), skyBR: +((kB - kR) / kn).toFixed(1),
  };
}

const out = { on: {}, off: {} };
const shots = ['vista', 'ground', 'gameplay', 'outpost', 'ridge', 'night', 'dawn'];
for (const name of shots) {
  g.applyShot(name);
  pipeline.setToneToe(true);
  g.settle(12);
  out.on[name] = frame();
  out.on[name].ev = +pipeline.exposureInfo.ev.toFixed(4);
  pipeline.setToneToe(false);
  g.settle(12);
  out.off[name] = frame();
  pipeline.setToneToe(true);
  g.settle(2);
}
const aft = ['vista', 'gameplay', 'outpost'].map((k) => out.on[k].ev);
out.afternoonSpreadStops = +(Math.max(...aft) - Math.min(...aft)).toFixed(4);
return out;
