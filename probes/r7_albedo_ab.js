// Ablation of the round-7 bedrock albedo cut alone: restore the round-6 values
// through the uniforms and re-measure, so the exposure claim is A/B on one term.
g.setFreeFly(false);
const U = g.world.terrain.uniforms;
const R6 = { uRockLight: [0.318, 0.294, 0.266], uRockDark: [0.198, 0.178, 0.160], uRockRed: [0.352, 0.262, 0.222], uVarnish: [0.150, 0.126, 0.116] };
const R7 = {};
for (const k of Object.keys(R6)) R7[k] = U[k].value.toArray();
const out = {};
for (const shot of ['vista', 'outpost', 'ridge', 'ground']) {
  g.applyShot(shot);
  g.settle(6);
  const a = g.probeLuminance();
  for (const k of Object.keys(R6)) U[k].value.setRGB(...R6[k]);
  g.settle(6);
  const b = g.probeLuminance();
  for (const k of Object.keys(R6)) U[k].value.setRGB(...R7[k]);
  out[shot] = {
    r7: { mean: a.mean, clipped: a.clippedPct },
    r6rock: { mean: b.mean, clipped: b.clippedPct },
    deltaMean: +(a.mean - b.mean).toFixed(4),
  };
}
return out;
