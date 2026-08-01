// Frame-level acceptance: exposure mean, clipping and highlight range per shot,
// after the round-7 bedrock albedo cut. The rendering contract is mean 0.42-0.55
// and clipped < 0.6% on daylight shots.
g.setFreeFly(false);
const out = {};
for (const shot of ['vista', 'ridge', 'ground', 'outpost', 'gameplay', 'dawn', 'night']) {
  g.applyShot(shot);
  g.settle(6);
  const p = g.probeLuminance();
  out[shot] = { mean: p.mean, clippedPct: p.clippedPct, top3bins: p.hist.slice(13) };
}
out.stats = g.stats();
return out;
