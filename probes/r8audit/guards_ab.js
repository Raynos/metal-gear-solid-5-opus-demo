/**
 * Are the delivered-frame guards (highlight range, black point, daylight R-B)
 * moved by the round-8 cascade cut, or is the shipped-PNG difference just the
 * capture clock?
 *
 * The shipped r7 and r8 vista differ in hi(>=230) by -0.54 pp, which matters
 * because 1.9-3.2% is an acceptance band and vista is the shot that sits in it.
 * But the two PNGs also differ on 99.3% of their pixels at 3.05 MAD, because
 * nothing pins the animation clock at capture — so that -0.54 pp is not
 * attributable to anything by itself.
 *
 * Here the clock is frozen (dt = 0) and ONLY the cascade configuration moves,
 * so whatever the guards do here is what round 8 did to them. A control arm
 * re-reads the same configuration to give the floor.
 *
 * ARGS: <shot>
 */
const g = window.__GAME;
const eng = g.engine, pipe = eng.pipeline, lighting = g.world.lighting;
const gl = eng.renderer.getContext();
g.setFreeFly(false);

const A = (typeof ARGS !== 'undefined' && ARGS) || [];
const shot = A[0] || 'vista';
g.applyShot(shot);
g.settle(24);
const W = pipe.width, H = pipe.height;
const buf = new Uint8Array(W * H * 4);

function guards() {
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const n = W * H;
  const maxH = new Float64Array(256), minH = new Float64Array(256), lumH = new Float64Array(256);
  let sr = 0, sb = 0, cool = 0, hi = 0, crushed = 0, clipped = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = buf[p], gg = buf[p + 1], b = buf[p + 2];
    sr += r; sb += b;
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
    maxH[mx]++; minH[mn]++;
    lumH[Math.round(0.2126 * r + 0.7152 * gg + 0.0722 * b)]++;
    if (mx >= 230) hi++;
    if (mx === 0) crushed++;
    if (mn === 255) clipped++;
    if (b > r + 4) cool++;
  }
  const q = (h, f) => { let a = 0; const t = f * n; for (let v = 0; v < 256; v++) { a += h[v]; if (a >= t) return v; } return 255; };
  return {
    hi230Pct: +((100 * hi) / n).toFixed(3),
    blackP001: q(minH, 0.0001),
    lumP001: q(lumH, 0.0001),
    p9999: q(maxH, 0.9999),
    crushedPct: +((100 * crushed) / n).toFixed(4),
    clippedPct: +((100 * clipped) / n).toFixed(4),
    meanRminusB: +((sr - sb) / n).toFixed(2),
    coolPct: +((100 * cool) / n).toFixed(2),
  };
}

const shipped = { sizes: lighting.cascades.map((l) => l.shadow.mapSize.x), int: lighting.refreshInterval.slice(), ph: lighting._refreshPhase.slice() };
function setC(sizes, interval, phase) {
  lighting.cascades.forEach((l, i) => {
    const s = sizes[Math.min(i, sizes.length - 1)];
    if (l.shadow.mapSize.x !== s) { l.shadow.mapSize.set(s, s); if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; } }
    l.shadow.needsUpdate = true;
  });
  lighting.refreshInterval = interval.slice(); lighting._refreshPhase = phase.slice();
}

g.settle(24, 0); const a_shipped = guards();
g.settle(24, 0); const a_control = guards();
setC([2048, 2048, 2048, 1024], [1, 2, 4, 8], [0, 0, 1, 3]);
g.settle(24, 0); const a_r7 = guards();
setC(shipped.sizes, shipped.int, shipped.ph);
g.settle(24, 0);

const delta = {};
for (const k of Object.keys(a_shipped)) delta[k] = +(a_shipped[k] - a_r7[k]).toFixed(4);
const floor = {};
for (const k of Object.keys(a_shipped)) floor[k] = +(a_shipped[k] - a_control[k]).toFixed(4);
return { shot, shippedCascades: shipped.sizes, r7Cascades: [2048, 2048, 2048], shipped: a_shipped, r7: a_r7, control: a_control, delta_shippedMinusR7: delta, noiseFloor_sameConfig: floor };
