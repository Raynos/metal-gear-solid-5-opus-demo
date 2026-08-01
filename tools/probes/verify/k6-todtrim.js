/**
 * (k6) WHERE EACH HOUR LANDS after the toe rebuild, and the per-hour trim that
 * puts it back.
 *
 * The tone curve below its anchor now returns 3-6x what it used to. Daylight
 * does not care — the afternoon's reference surface sits at tonemap input
 * 0.449 against an anchor of 0.457, so its print is unchanged to within 0.2% —
 * but dusk, dawn and night live entirely inside the rebuilt region and come out
 * measurably brighter. That is not the curve being wrong; it is
 * `TIME_OF_DAY[x].exposure` having been authored by eye against a curve that
 * crushed those frames. The trims are in `src/config/ArtDirection.js`, which
 * this pass does not own, so this probe measures the answer instead of guessing
 * at it.
 *
 * `trimForSamePrint` is the trim that puts each hour's REFERENCE SURFACE (the
 * illuminant-derived sunlit/moonlit sand the exposure is metered against) back
 * on exactly the display value it had under the raw ACES curve. It is solved,
 * not fitted: v_new = displayNew^-1(displayOld(v_old)).
 *
 * Every hour is then re-rendered with that trim applied so the consequence is
 * measured rather than promised.
 */
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer, pipeline = engine.pipeline;
const gl = renderer.getContext();
const W = pipeline.width, H = pipeline.height;
const buf = new Uint8Array(W * H * 4);
const srgb = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

// The raw ACES print, for the migration solve only.
function displayOld(v) {
  const Wp = pipeline.grade.whitePoint ?? 5.2;
  const knee = Wp * (pipeline.grade.shoulder ?? 0.3);
  const span = Math.max(Wp - knee, 1e-3);
  const x = Math.max(v - knee, 0) / span;
  const f = Math.min(v, knee) + span * (x / (1 + x));
  const fit = (u) => (u * (u + 0.0245786) - 0.000090537) / (u * (0.983729 * u + 0.432951) + 0.238081);
  return Math.min(1, Math.max(0, fit(f) * pipeline._whiteScale));
}

// Boxes in PRESENTED-frame coordinates (readPixels is bottom-up).
const box = (x0, x1, y0, y1) => {
  let r = 0, g2 = 0, b = 0, y = 0, n = 0;
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
    const i = (yy * W + xx) * 4;
    r += buf[i]; g2 += buf[i + 1]; b += buf[i + 2];
    y += 0.2126 * srgb(buf[i] / 255) + 0.7152 * srgb(buf[i + 1] / 255) + 0.0722 * srgb(buf[i + 2] / 255);
    n++;
  }
  return { R: +(r / n).toFixed(1), B: +(b / n).toFixed(1), BR: +((b - r) / n).toFixed(1), Y: +(y / n).toFixed(4) };
};

function stats() {
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const n = W * H;
  const maxH = new Float64Array(256), minH = new Float64Array(256);
  let ge = 0, cool = 0, sr = 0, sg = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    const j = i * 4, r = buf[j], g2 = buf[j + 1], b = buf[j + 2];
    maxH[Math.max(r, g2, b)]++; minH[Math.min(r, g2, b)]++;
    if (Math.max(r, g2, b) >= 230) ge++;
    if (b > r + 4) cool++;
    sr += r; sg += g2; sb += b;
  }
  const q = (h, t) => { let c = 0; for (let v = 0; v < 256; v++) { c += h[v]; if (c >= t * n) return v; } return 255; };
  const sx0 = Math.floor(W * 0.44), sx1 = Math.floor(W * 0.60);
  return {
    meanY: +((sr + sg + sb) / (3 * n)).toFixed(1),
    hi230Pct: +((ge / n) * 100).toFixed(3), p9999: q(maxH, 0.9999), blackP001: q(minH, 0.0001),
    meanRB: +((sr - sb) / n).toFixed(1), coolPct: +((cool / n) * 100).toFixed(2),
    // open ground low-centre vs clear sky high-centre, same columns
    ground: box(sx0, sx1, Math.floor(H * 0.06), Math.floor(H * 0.17)),
    sky: box(sx0, sx1, Math.floor(H * 0.84), Math.floor(H * 0.95)),
  };
}

const out = {};
for (const name of ['vista', 'ridge', 'dawn', 'night']) {
  g.applyShot(name);
  const trim0 = pipeline.exposure;

  pipeline.setToneToe(false);
  g.settle(14);
  const off = stats();

  pipeline.setToneToe(true);
  g.settle(14);
  const on = stats();

  // Solve the trim that reproduces the old print of the reference surface.
  const info = pipeline.exposureInfo;
  const vOld = info.final * info.sceneL;
  const trimNew = trim0 * (pipeline._displayInv(displayOld(vOld)) / vOld);

  pipeline.exposure = trimNew;
  g.settle(14);
  const retrimmed = stats();
  pipeline.exposure = trim0;
  g.settle(3);

  out[name] = {
    trimNow: +trim0.toFixed(4),
    trimForSamePrint: +trimNew.toFixed(4),
    stopsDown: +Math.log2(trim0 / trimNew).toFixed(3),
    off, on, retrimmed,
  };
}
return out;
