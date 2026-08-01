/**
 * (f) GROUND WEAR EXISTS — ablated, not eyeballed.
 *
 * The outpost author left an in-place kill switch (`uWearCtl.x`, 0 = no
 * authored wear at all), so the whole layer can be removed with nothing else
 * different: same exposure, same TAA phase, same shadows. Diffing the two
 * frames answers "is there a record of traffic on this ground" without any
 * argument about whether a smudge is a path.
 *
 * Reported per shot: how much of the frame the wear touches, how deep it goes,
 * and how much of it survives ONLY where the ground is (`uWearCtl.y = 1` paints
 * the fields as false colour so the footprint can be located, and a debug frame
 * is saved for the record).
 */
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer, pipeline = engine.pipeline;
const gl = renderer.getContext();
const outpost = g.world.registry?.outpost;
const ctl = outpost?.wearCtl;
if (!ctl) return { error: 'no outpost.wearCtl handle' };

const W = pipeline.width, H = pipeline.height;
const a = new Uint8Array(W * H * 4), b = new Uint8Array(W * H * 4);
const srgb = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const lum = (buf, i) => 0.2126 * srgb(buf[i] / 255) + 0.7152 * srgb(buf[i + 1] / 255) + 0.0722 * srgb(buf[i + 2] / 255);

const out = {};
for (const name of ['outpost', 'ground', 'gameplay']) {
  g.applyShot(name);
  ctl.x = 1; g.settle(12);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, a);
  ctl.x = 0; g.settle(12);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b);
  ctl.x = 1; g.settle(4);

  let touched = 0, deep = 0, sum = 0, n = 0, minR = 1, maxR = 1;
  // codes, not ratios, for the "can a viewer see it" question
  let over4 = 0, over12 = 0;
  for (let i = 0; i < W * H; i++) {
    const j = i * 4;
    const on = lum(a, j), off = lum(b, j);
    const dCode = Math.max(Math.abs(a[j] - b[j]), Math.abs(a[j + 1] - b[j + 1]), Math.abs(a[j + 2] - b[j + 2]));
    if (dCode > 1) { touched++; }
    if (dCode > 4) over4++;
    if (dCode > 12) over12++;
    if (off > 1e-4 && dCode > 1) {
      const r = on / off; sum += r; n++;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
  }
  out[name] = {
    pctFrameTouched: +((touched / (W * H)) * 100).toFixed(2),
    pctOver4codes: +((over4 / (W * H)) * 100).toFixed(2),
    pctOver12codes: +((over12 / (W * H)) * 100).toFixed(2),
    meanRatioWhereTouched: +(sum / Math.max(n, 1)).toFixed(4),
    darkest: +minR.toFixed(3), lightest: +maxR.toFixed(3),
  };
}
// leave a false-colour frame of the wear fields for the record
g.applyShot('outpost');
ctl.y = 1; g.settle(8);
g.snap?.('wear-fields');
ctl.y = 0; g.settle(4);
return out;
