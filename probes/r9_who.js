/** Minimal: did the garrison install, where is the commander, any page errors. */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const ai = W.registry.ai;
if (!ai) return { error: 'no ai module', errors: g.errors.slice(0, 6) };

const out = { errors: g.errors.length, first: g.errors.slice(0, 4) };
out.roster = {};
for (const gd of ai.guards) out.roster[gd.role] = (out.roster[gd.role] ?? 0) + 1;
out.characters = W.registry.characters?.characters?.length ?? 0;
out.bake = ai.navGrid.stats;

const cmd = ai.commander;
const outpost = W.registry.outpost;
if (cmd) {
  const zc = cmd.character.materials?.cloth?.userData?.uniforms?.uZoneColor?.value;
  const grunt = ai.guards.find((x) => x.role === 'sentry' || x.role === 'patrol' || x.role === 'tower');
  const gz = grunt?.ch?.materials?.cloth?.userData?.uniforms?.uZoneColor?.value;
  out.commander = {
    at: [+cmd.position.x.toFixed(1), +cmd.position.y.toFixed(1), +cmd.position.z.toFixed(1)],
    fromGate: outpost?.gate ? +cmd.position.distanceTo(outpost.gate).toFixed(1) : null,
    inside: outpost?.isInside ? outpost.isInside(cmd.position.x, cmd.position.z) : null,
    jacket: zc ? +zc[0].x.toFixed(3) : null,
    gruntJacket: gz ? +gz[0].x.toFixed(3) : null,
    hat: zc ? +zc[15].x.toFixed(3) : null,
    hatOverBody: zc ? +(zc[15].x / zc[0].x).toFixed(2) : null,
    gruntOverCmdBody: zc && gz ? +(gz[0].x / zc[0].x).toFixed(2) : null,
  };
}
out.reserve = ai.reserve;
out.reserveAt = ai.guards.filter((x) => x.role === 'reserve')
  .map((x) => [+x.ch.position.x.toFixed(0), +x.ch.position.z.toFixed(0)]);

// Can each man actually see out of the compound he is standing in?
//
// Two numbers per guard, because the instantaneous eyeline is the wrong
// question — a sentry sweeps, so what matters is the arc he covers over the
// sweep, not the one bearing he happens to be on at the instant of the probe.
//
//   arc   how far his best bearing inside the ARC HE SWEEPS reaches
//   open  the fraction of 24 bearings all round him that reach 15 m or more
const grid = ai.navGrid;
const eye = new THREE.Vector3();
function reachAlong(gd, a) {
  let reach = 0;
  for (let r = 4; r <= 60; r += 2) {
    const x = gd.ch.position.x - Math.sin(a) * r;
    const z = gd.ch.position.z - Math.cos(a) * r;
    if (!grid.losClear(eye.x, eye.y, eye.z, x, grid.heightAt(x, z) + 1.3, z)) break;
    reach = r;
  }
  return reach;
}
out.eyes = ai.guards.map((gd) => {
  ai.eyeOf(gd.ch, eye);
  return `${gd.role} at ${gd.ch.position.x.toFixed(0)},${gd.ch.position.z.toFixed(0)} `
    + `ground ${(gd.ch.groundY ?? 0).toFixed(1)} eye ${eye.x.toFixed(0)},${eye.y.toFixed(1)},${eye.z.toFixed(0)} `
    + `gridGround ${grid.heightAt(gd.ch.position.x, gd.ch.position.z).toFixed(1)} `
    + `walkable ${grid.walkable(gd.ch.position.x, gd.ch.position.z)}`;
});
out.sightlines = ai.guards.map((gd) => {
  ai.eyeOf(gd.ch, eye);
  const arcHalf = gd.role === 'tower' ? 1.7 : 0.85;
  let arc = 0;
  for (let k = -4; k <= 4; k++) arc = Math.max(arc, reachAlong(gd, gd.homeYaw + (k / 4) * arcHalf));
  let open = 0;
  for (let k = 0; k < 24; k++) if (reachAlong(gd, (k / 24) * Math.PI * 2) >= 15) open++;
  return `${gd.role}: arc ${arc}m, open ${Math.round((100 * open) / 24)}%`;
});
return out;
