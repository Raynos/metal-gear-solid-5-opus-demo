/**
 * OUTPOST LAMP POOLS — ablated in place.
 *
 * `setLampAblate(true)` zeroes the baked pool field on every outpost surface and
 * changes nothing else, so "do the lamps light anything" is a diff of two frames
 * of the same build rather than a comparison against a previous round.
 *
 * The daylight shot is the control: the pool gain is driven off sun elevation
 * and is exactly zero in the afternoon, so whatever `outpost` reports is this
 * harness's own TAA/grain noise floor and every night number has to beat it.
 */
g.setFreeFly(false);
const engine = g.engine, pipeline = engine.pipeline, gl = engine.renderer.getContext();
const W = pipeline.width, H = pipeline.height;
const op = g.world.registry.outpostGround;
const grab = () => {
  const p = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, p);
  return p;
};
const out = {};
for (const shot of ['night', 'outpost']) {
  g.applyShot(shot); g.settle(12);
  op.setLampAblate(false); g.settle(10); const on = grab();
  op.setLampAblate(true); g.settle(10); const off = grab();
  op.setLampAblate(false); g.settle(4);
  let changed = 0, big = 0, maxd = 0, sOn = 0, sOff = 0;
  for (let i = 0; i < W * H; i++) {
    const a = 0.2126 * on[i * 4] + 0.7152 * on[i * 4 + 1] + 0.0722 * on[i * 4 + 2];
    const b = 0.2126 * off[i * 4] + 0.7152 * off[i * 4 + 1] + 0.0722 * off[i * 4 + 2];
    sOn += a; sOff += b;
    const d = a - b;
    if (d > maxd) maxd = d;
    if (Math.abs(d) > 2) changed++;
    if (Math.abs(d) > 10) big++;
  }
  out[shot] = {
    meanOn: +(sOn / (W * H)).toFixed(2), meanOff: +(sOff / (W * H)).toFixed(2),
    pctChanged: +((100 * changed) / (W * H)).toFixed(2),
    pctOver10Codes: +((100 * big) / (W * H)).toFixed(2),
    maxDelta: +maxd.toFixed(0),
  };
}
return out;
