/**
 * What the round-7 deck range costs. `g.settle()` returns the mean CPU frame
 * time over five timed frames, so this is the same number the harness prints.
 */
g.setFreeFly(false);
const pass = g.world.registry.volumetrics.pass;
const out = [];
for (const shot of ['vista', 'outpost']) {
  g.applyShot(shot);
  const keepFar = pass.params.cloudFar;
  g.settle(20);
  const a = g.settle(10);
  pass.params.cloudFar = 18000; g.settle(20);
  const b = g.settle(10);
  pass.params.cloudFar = keepFar;
  pass.ablate.clouds = true; g.settle(20);
  const c = g.settle(10);
  pass.ablate.clouds = false; g.settle(10);
  out.push({ shot, ms_shipped: +a.toFixed(2), ms_cloudFar18km: +b.toFixed(2), ms_noDeck: +c.toFixed(2) });
}
return out;
