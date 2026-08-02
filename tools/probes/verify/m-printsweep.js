/**
 * (m) ROUND 8 PRINT SWEEP — the imagestats.py metrics, measured in-page.
 *
 * `imagestats.py` is the acceptance ruler this round is judged with, and a full
 * seven-shot 1920x1080 run costs minutes. This computes the SAME statistics
 * (same 5%/5%/5%/10% crop, same every-7th-pixel decimation, same definitions)
 * off the presented framebuffer, so a candidate print costs one settle instead
 * of one screenshot run. Verified against imagestats.py on the shipped frames.
 *
 * ARGV is a JSON array of {label, grade:{...}, aerial:{strength,ambient}}.
 * With no ARGV it just measures the current build.
 */
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer, pipeline = engine.pipeline;
const gl = renderer.getContext();
const W = pipeline.width, H = pipeline.height;
const px = new Uint8Array(W * H * 4);

// imagestats crops (5%, 5%) to (95%, 90%) of a top-left-origin image; the GL
// framebuffer is bottom-up, so the y band flips to 10%..95%.
const X0 = Math.floor(W * 0.05), X1 = Math.floor(W * 0.95);
const Y0 = Math.floor(H * 0.10), Y1 = Math.floor(H * 0.95);

const s2l = (c) => (c <= 0.04045 * 255 ? c / 255 / 12.92 : Math.pow((c / 255 + 0.055) / 1.055, 2.4));

function stats() {
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  // imagestats walks the cropped image row-major and keeps every 7th pixel.
  const lum = [], ylin = [];
  let sr = 0, sg = 0, sb = 0, sat = 0, hi = 0, clip = 0, n = 0, k = 0;
  for (let y = Y1 - 1; y >= Y0; y--) {
    for (let x = X0; x < X1; x++) {
      if (k++ % 7) continue;
      const i = (y * W + x) * 4;
      const r = px[i], gc = px[i + 1], b = px[i + 2];
      sr += r; sg += gc; sb += b;
      const mx = Math.max(r, gc, b), mn = Math.min(r, gc, b);
      sat += (mx - mn) / Math.max(mx, 1);
      if (mx >= 230) hi++;
      if (mx >= 254) clip++;
      lum.push(0.2126 * r + 0.7152 * gc + 0.0722 * b);
      ylin.push(0.2126 * s2l(r) + 0.7152 * s2l(gc) + 0.0722 * s2l(b));
      n++;
    }
  }
  lum.sort((a, b) => a - b);
  ylin.sort((a, b) => a - b);
  const q = (v) => lum[Math.floor(n * v)];
  const ql = (v) => Math.max(ylin[Math.floor(n * v)], 1e-6);
  return {
    RmB: +((sr - sb) / n).toFixed(1),
    meanL: +(lum.reduce((a, b) => a + b, 0) / n).toFixed(1),
    blk: lum[0],
    p01: +q(0.001).toFixed(1),
    p50: +q(0.5).toFixed(1),
    p999: +q(0.999).toFixed(1),
    hi230: +(100 * hi / n).toFixed(2),
    clip: +(100 * clip / n).toFixed(2),
    sat: +(100 * sat / n).toFixed(1),
    stops: +Math.log2(ql(0.999) / ql(0.001)).toFixed(2),
  };
}

// EDIT THESE. The harness has no argv passthrough for `eval`, and this file is
// read from disk on every call, so editing it costs nothing (an edit under
// src/ would cost a world rebuild).
const SHOTS = ['vista', 'ground', 'gameplay', 'outpost', 'ridge', 'dawn', 'night'];
const CASES = [
  { label: 'r8-shipped' },
  { label: 'r8-acesCurve', grade: { toneCurve: 'aces' } },
  { label: 'r7-print', print: 'r7' },
];

const base = JSON.parse(JSON.stringify(pipeline.grade));
const baseAerial = {
  strength: pipeline.prepMat.uniforms.uApStrength.value,
  ambient: pipeline.prepMat.uniforms.uApAmbient.value,
};

const out = {};
for (const c of CASES) out[c.label] = {};

for (const shot of SHOTS) {
  g.applyShot(shot);
  g.settle(10);
  for (const c of CASES) {
    if (c.print) {
      // Whole-print ablation: restores the previous round bit for bit,
      // including its aerial-perspective gain.
      pipeline.setPrint(c.print);
    } else {
      pipeline.setPrint('r8');
      Object.assign(pipeline.grade, base, c.grade || {});
      const a = { ...baseAerial, ...(c.aerial || {}) };
      pipeline.prepMat.uniforms.uApStrength.value = a.strength;
      pipeline.prepMat.uniforms.uApAmbient.value = a.ambient;
      pipeline.refreshGrade();
    }
    g.settle(3);
    out[c.label][shot] = stats();
  }
}

pipeline.setPrint('r8');
Object.assign(pipeline.grade, base);
pipeline.prepMat.uniforms.uApStrength.value = baseAerial.strength;
pipeline.prepMat.uniforms.uApAmbient.value = baseAerial.ambient;
pipeline.refreshGrade();

const KEYS = ['RmB', 'meanL', 'blk', 'p01', 'p50', 'p999', 'hi230', 'clip', 'sat', 'stops'];
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };
const summary = {};
for (const c of CASES) {
  const rows = SHOTS.map((s) => out[c.label][s]);
  summary[c.label] = Object.fromEntries(KEYS.map((k) => [k, +median(rows.map((r) => r[k])).toFixed(2)]));
}
return { MGSV: { RmB: 25.8, meanL: 127.6, blk: 8.2, p01: 18.4, p50: 111.1, p999: 254, hi230: 9.74, clip: 1.32, sat: 21.7, stops: 7.31 }, median: summary, perShot: out };
