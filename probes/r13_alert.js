/**
 * r13_alert.js — does being seen actually cost the player anything?
 *
 * TODO §4 says "alerts do nothing to the reserve or to patrol routes". The
 * source disagrees: `callReserve` is wired from commander.js and `harden`
 * relocates the objective. One of the two is stale, and the way to find out is
 * to raise the alarm in the live sim and read the garrison before and after.
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const reg = W.registry;
const ai = reg.ai;
const gp = reg.gameplay ?? reg.player;
const eng = W.engine;
const run = (n) => { for (let i = 0; i < n; i++) eng.step(1 / 60); };

W.gameState.setMode('play');
run(30);

const cmd = ai.guards.find((q) => q.role === 'commander' || q.name === 'commander') ?? null;
const snap = () => ({
  level: ai.alertLevel,
  committed: ai.guards.filter((q) => q.committed).length,
  inCombat: ai.guards.filter((q) => q.state === 'combat').length,
  states: ai.guards.reduce((a, q) => { a[q.state] = (a[q.state] ?? 0) + 1; return a; }, {}),
  moving: ai.guards.filter((q) => q.ch && (q.ch.speed ?? 0) > 0.15).length,
  cmdHome: cmd?.home ? [+cmd.home.x.toFixed(1), +cmd.home.z.toFixed(1)] : null,
  cmdPos: cmd?.ch ? [+cmd.ch.position.x.toFixed(1), +cmd.ch.position.z.toFixed(1)] : null,
});

const before = snap();

// Raise the alarm the way the game does: a confirmed sighting at the player's
// position. Going through squad rather than poking guards keeps the ladder,
// the timers and the listeners in the loop.
const p = gp.controller.position.clone();
ai.shotAt(p);
run(60);
const at1s = snap();
run(60 * 12);
const at13s = snap();

return {
  before, at1s, at13s,
  cmdMoved: before.cmdHome && at13s.cmdHome
    ? +Math.hypot(at13s.cmdHome[0] - before.cmdHome[0], at13s.cmdHome[1] - before.cmdHome[1]).toFixed(1)
    : null,
  reserveCount: ai.guards.filter((q) => /reserve/.test(q.ch?.name ?? q.id ?? '')).length,
  guardCount: ai.guards.length,
};
