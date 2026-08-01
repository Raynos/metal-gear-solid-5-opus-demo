// Mean display luminance per shot; target 0.42-0.55 for daylight (ARCHITECTURE.md).
const g = window.__GAME;
const out = {};
for (const n of ['vista', 'gameplay', 'outpost', 'ridge', 'night']) {
  g.applyShot(n);
  g.settle(10);
  const p = g.probeLuminance();
  out[n] = { mean: p.mean, clippedPct: p.clippedPct };
}
return out;
