const g = window.__GAME;
const out = {};
for (const s of ['vista', 'outpost', 'ground']) {
  g.applyShot(s); g.settle(10);
  const l = g.probeLuminance();
  out[s] = { mean: l.mean, clippedPct: l.clippedPct };
}
return out;
