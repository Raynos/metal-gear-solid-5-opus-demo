/**
 * (j) REGRESSION GUARDS — AO still present, and the exposure spread across the
 * three afternoon shots.
 *
 * AO is ablated (`pipeline.enabled.ssao`) and the lower half of the PRESENTED
 * frame is diffed, which is exactly the round-5 ground-truth rig: mean ratio
 * AO-on/AO-off, and the fraction of pixels darkened by more than 5%. Reported
 * per shot so nobody can average a strong effect away against a sky.
 *
 * Exposure is read from `pipeline.exposureInfo.ev`, the solved stop, not
 * inferred from frame brightness — two shots of different scenes at the same
 * hour are supposed to differ in brightness and not in exposure.
 */
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer, pipeline = engine.pipeline;
const gl = renderer.getContext();
const W = pipeline.width, H = pipeline.height;
const a = new Uint8Array(W * H * 4), b = new Uint8Array(W * H * 4);
const srgb = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const lum = (buf, i) => 0.2126 * srgb(buf[i] / 255) + 0.7152 * srgb(buf[i + 1] / 255) + 0.0722 * srgb(buf[i + 2] / 255);

const out = { shots: {} };
for (const name of ['vista', 'ground', 'gameplay', 'outpost', 'ridge', 'night', 'dawn']) {
  g.applyShot(name);
  g.settle(12);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, a); // AO on
  const ev = pipeline.exposureInfo.ev, tod = pipeline.exposureInfo;
  pipeline.enabled.ssao = false;
  g.settle(12);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b); // AO off
  pipeline.enabled.ssao = true;
  g.settle(4);

  // Lower half of the frame only: readPixels is bottom-up, so rows 0..H/2.
  let ratio = 0, n = 0, dark = 0, strongest = 1;
  for (let y = 0; y < H / 2; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const on = lum(a, i), off = lum(b, i);
    if (off < 1e-4) continue;
    const r = on / off;
    ratio += r; n++;
    if (r < 0.95) dark++;
    if (r < strongest) strongest = r;
  }
  out.shots[name] = {
    aoMeanRatio: +(ratio / n).toFixed(4),
    aoPctDarkenedOver5: +((dark / n) * 100).toFixed(2),
    aoStrongest: +strongest.toFixed(4),
    exposureEV: +ev.toFixed(4),
    keyE: +tod.keyE.toFixed(4), skyE: +tod.skyE.toFixed(4), sceneL: +tod.sceneL.toFixed(4),
  };
}
const aft = ['vista', 'gameplay', 'outpost'].map((k) => out.shots[k].exposureEV);
out.afternoonExposureSpreadStops = +(Math.max(...aft) - Math.min(...aft)).toFixed(4);
out.afternoonEV = aft;
return out;
