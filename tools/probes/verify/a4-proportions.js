/**
 * (a) part 4 — head/neck proportions off the bind-pose mesh, for both the
 * shipped build and as a like-for-like number the next round can re-run.
 * The rendered hero reads as long-necked at 1:1, so this checks it with the
 * canon (head height ~1/7.5 of stature; visible neck ~0.35 of head height).
 */
g.setFreeFly(false);
const player = g.world.registry.characters.player;
const geo = player.mesh.geometry;
const pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
const bone = player.rig.skeleton.bones.map((b) => b.name);
const dom = new Int32Array(pos.count);
for (let i = 0; i < pos.count; i++) { let bb = 0, best = 0; for (let c = 0; c < 4; c++) { const w = sw.array[i * 4 + c]; if (w > bb) { bb = w; best = si.array[i * 4 + c]; } } dom[i] = best; }

function box(pred) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], n = 0;
  for (let i = 0; i < pos.count; i++) {
    if (!pred(bone[dom[i]], pos.getX(i), pos.getY(i), pos.getZ(i))) continue;
    const p = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    n++;
  }
  return { size: hi.map((v, k) => +(v - lo[k]).toFixed(4)), lo: lo.map((v) => +v.toFixed(3)), hi: hi.map((v) => +v.toFixed(3)), n };
}
const all = box(() => true);
const head = box((b) => b === 'head' || b === 'headTip');
const neck = box((b) => b === 'neck');
const stature = all.size[1];
return {
  stature_m: +stature.toFixed(3),
  head: head, neck: neck,
  headHeight_m: head.size[1], headWidth_m: head.size[0], headDepth_m: head.size[2],
  headsInStature: +(stature / head.size[1]).toFixed(2),
  neckHeight_m: neck.size[1],
  neckOverHeadHeight: +(neck.size[1] / head.size[1]).toFixed(3),
  headWidthOverHeadHeight: +(head.size[0] / head.size[1]).toFixed(3),
};
