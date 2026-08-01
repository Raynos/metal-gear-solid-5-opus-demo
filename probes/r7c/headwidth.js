// What is actually setting the head's bounding width? a4-proportions reports a
// single number off the head/headTip bones; this decomposes it by material
// group and by |x| band so the widest CONTRIBUTOR is named rather than guessed.
g.setFreeFly(false);
const player = g.world.registry.characters.player;
const geo = player.mesh.geometry;
const pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
const zone = geo.attributes.aZone;
const bone = player.rig.skeleton.bones.map((b) => b.name);
const dom = new Int32Array(pos.count);
for (let i = 0; i < pos.count; i++) {
  let bb = 0, best = 0;
  for (let c = 0; c < 4; c++) { const w = sw.array[i * 4 + c]; if (w > bb) { bb = w; best = si.array[i * 4 + c]; } }
  dom[i] = best;
}
// material index per vertex, via the geometry groups
const matOf = new Int32Array(pos.count).fill(-1);
const idx = geo.index.array;
for (const gr of geo.groups) for (let t = gr.start; t < gr.start + gr.count; t++) matOf[idx[t]] = gr.materialIndex;
const matName = player.mesh.material.map((m) => m.name);

const buckets = new Map();
let maxAll = 0, argmax = null;
for (let i = 0; i < pos.count; i++) {
  const b = bone[dom[i]];
  if (b !== 'head' && b !== 'headTip') continue;
  const x = Math.abs(pos.getX(i)), y = pos.getY(i), z = pos.getZ(i);
  const key = `${matName[matOf[i]] || '?'}/z${zone ? zone.getX(i) : -1}`;
  const e = buckets.get(key) || { n: 0, maxX: 0, at: null };
  e.n++;
  if (x > e.maxX) { e.maxX = x; e.at = [+x.toFixed(4), +y.toFixed(3), +z.toFixed(3)]; }
  buckets.set(key, e);
  if (x > maxAll) { maxAll = x; argmax = [key, +x.toFixed(4), +y.toFixed(3), +z.toFixed(3)]; }
}
const rows = [...buckets.entries()]
  .map(([k, v]) => ({ part: k, n: v.n, halfWidth: +v.maxX.toFixed(4), at: v.at }))
  .sort((a, b) => b.halfWidth - a.halfWidth);

// Shoulder spans, three definitions, so the ratio can be quoted unambiguously.
const gh = player.rig.bindWorld.get('armR').x - player.rig.bindWorld.get('armL').x;
let acr = 0, delt = 0;
for (let i = 0; i < pos.count; i++) {
  const b = bone[dom[i]];
  const y = pos.getY(i), x = Math.abs(pos.getX(i));
  if ((b === 'chest' || b === 'clavR' || b === 'clavL') && y > 1.36 && y < 1.45) acr = Math.max(acr, x);
  if (/^(arm|clav)/.test(b) && y > 1.30 && y < 1.50) delt = Math.max(delt, x);
}
return {
  headHalfWidth: +maxAll.toFixed(4),
  headWidth: +(maxAll * 2).toFixed(4),
  widest: argmax,
  parts: rows.slice(0, 10),
  spans: { glenohumeral: +gh.toFixed(4), biacromial: +(acr * 2).toFixed(4), outerDeltoid: +(delt * 2).toFixed(4) },
  ratios: {
    overGlenohumeral: +((maxAll * 2) / gh).toFixed(3),
    overBiacromial: +((maxAll * 2) / (acr * 2)).toFixed(3),
    overOuterDeltoid: +((maxAll * 2) / (delt * 2)).toFixed(3),
  },
};
