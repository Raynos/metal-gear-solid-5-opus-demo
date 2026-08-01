/**
 * OUTPOST MATERIAL JUNCTIONS — ablated in place.
 *
 * `wearCtl.z = 1` restores the round-5 junction on the outpost pad: the raw
 * vertex-interpolated grade/hardstanding masks (a 4-5 m ramp once the 1.95 m
 * lattice has interpolated a 2.6 m authored edge), the weaker fbm edge break,
 * and no verge material. `wearCtl.z = 0` is what ships: masks re-contrasted
 * about their own half value so the boundary is ~1.4 m wide, a 0.4 m octave big
 * enough relative to that width to break it into fingers, and a genuine third
 * material — the kicked, swept, half-buried toe of a bladed surface — carried
 * on 4k(1-k), which is 1 in the transition band and 0 either side of it.
 *
 * The change is deliberately local: the frame MEAN must not move (it is a
 * junction, not an exposure change), and the evidence is the fraction of the
 * frame that changes and by how much.
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
for (const shot of ['ground', 'gameplay', 'outpost']) {
  g.applyShot(shot); g.settle(12);
  op.wearCtl.z = 0; g.settle(10); const a = grab();
  op.wearCtl.z = 1; g.settle(10); const b = grab();
  op.wearCtl.z = 0; g.settle(4);
  let ch = 0, big = 0, maxd = 0, sa = 0, sb = 0;
  for (let i = 0; i < W * H; i++) {
    const la = 0.2126 * a[i * 4] + 0.7152 * a[i * 4 + 1] + 0.0722 * a[i * 4 + 2];
    const lb = 0.2126 * b[i * 4] + 0.7152 * b[i * 4 + 1] + 0.0722 * b[i * 4 + 2];
    sa += la; sb += lb;
    const d = Math.abs(la - lb);
    if (d > maxd) maxd = d;
    if (d > 2) ch++;
    if (d > 8) big++;
  }
  out[shot] = {
    meanShipped: +(sa / (W * H)).toFixed(2), meanAblated: +(sb / (W * H)).toFixed(2),
    pctChanged: +((100 * ch) / (W * H)).toFixed(2), pctOver8Codes: +((100 * big) / (W * H)).toFixed(2),
    maxDelta: +maxd.toFixed(0),
  };
}
return out;
