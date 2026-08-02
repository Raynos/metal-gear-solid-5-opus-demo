/** Whole-frame exposure per shot. Runs against any build, modified or not. */
const g = window.__GAME;
const out = [];
for (const name of ['ground', 'vista', 'outpost', 'gameplay', 'ridge', 'dawn', 'night']) {
  await g.applyShot(name);
  await g.settle(16);
  const l = g.probeLuminance();
  out.push(`${name.padEnd(9)} mean ${l.mean.toFixed(3)}  clipped ${l.clippedPct.toFixed(2)}%`);
}
return out.join('\n');
