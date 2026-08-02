/**
 * r11_lumcheck.js — the exposure gate from ARCHITECTURE.md, for every shot.
 *
 * "Calibrated so a sunlit sand surface lands near 0.5 mean display luminance...
 * target mean 0.42-0.55, clipped < 0.6% for daylight shots." Any change to the
 * key:fill ratio lifts the shaded population and therefore the frame mean, so
 * this is the gate that says whether AMBIENT.dayKeyFill went too far.
 */
const g = window.__GAME;
const out = {};
for (const name of ['ground', 'gameplay', 'outpost', 'ridge', 'night']) {
  g.applyShot(name);
  if (window.__pinDeterminism) window.__pinDeterminism();
  for (let i = 0; i < 32; i++) { g.engine.step(1 / 60); g.engine.render(); }
  const l = g.probeLuminance ? g.probeLuminance() : null;
  out[name] = l && typeof l === 'object'
    ? Object.fromEntries(Object.entries(l).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(4) : v]))
    : l;
}
return out;
