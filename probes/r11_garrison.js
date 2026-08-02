/**
 * r11_garrison.js — does the garrison move, and does being seen cost anything?
 *
 *   A  metres travelled and `guard.state` for EVERY man over 20 s of live AI,
 *      from a real play-mode start with the player standing still 118 m out
 *   B  the same 20 s read off `ch.behaviour.state` instead, which is the trap:
 *      that field is frozen at 'post' for every controlled man and tells you
 *      nothing
 *   C  going loud relocates the commander and commits bodyguards
 *
 * No AI state is written by hand. The alert in part C is raised through
 * `ai.shotAt`, which is the same entry point a player's rifle uses.
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const reg = W.registry;
const gp = reg.gameplay ?? reg.player;
const ai = reg.ai;
const eng = W.engine;
const out = [];
const run = (n) => { for (let i = 0; i < n; i++) eng.step(1 / 60); };

W.gameState.setMode('play');
run(2);
const site = reg.outpost.bounds.getCenter(new THREE.Vector3());
out.push(`player at ${Math.hypot(gp.position.x - site.x, gp.position.z - site.z).toFixed(0)} m, `
  + `${ai.guards.length} guards, live=${ai.live}, alert=${ai.alertLevel}`);

// ------------------------------------------------------------------ PART A --
const track = ai.guards.map((q) => ({
  q,
  id: q.id,
  role: q.role,
  moved: 0,
  x: q.ch.position.x,
  z: q.ch.position.z,
  states: new Set([q.state]),
}));
// 20 s is the window the brief asks for; 90 s is a mission-length one, because
// a changeover roster is a slow signal and a 20 s sample of it says as much
// about the phase of the timer as about the design.
const MARKS = [20, 90];
for (let s = 0; s < MARKS[MARKS.length - 1] * 60; s++) {
  eng.step(1 / 60);
  for (const t of track) {
    t.moved += Math.hypot(t.q.ch.position.x - t.x, t.q.ch.position.z - t.z);
    t.x = t.q.ch.position.x;
    t.z = t.q.ch.position.z;
    t.states.add(t.q.state);
  }
  if ((s + 1) % 60 === 0 && MARKS.includes((s + 1) / 60)) {
    for (const t of track) t[`at${(s + 1) / 60}`] = t.moved;
  }
}
for (const m of MARKS) {
  const movers = track.filter((t) => t[`at${m}`] > 1).length;
  out.push(`A after ${m} s live, alert=${ai.alertLevel} — ${movers} of ${track.length} guards had moved more than 1 m`);
}
for (const t of track) {
  out.push(`A   #${String(t.id).padStart(2)} ${t.role.padEnd(9)} moved ${t.at20.toFixed(1).padStart(6)} m @20s  `
    + `${t.at90.toFixed(1).padStart(6)} m @90s  state=${t.q.state}  seen=[${[...t.states].join(',')}]`);
}
out.push(`A roster: ${JSON.stringify(ai.roster.report())}`);
// How far apart the static posts actually are — the number SWAP_MAX has to
// clear, measured rather than assumed.
const pool = ai.roster.pool;
const pairs = [];
for (let i = 0; i < pool.length; i++) {
  for (let j = i + 1; j < pool.length; j++) {
    pairs.push(Math.hypot(pool[i].home.x - pool[j].home.x, pool[i].home.z - pool[j].home.z));
  }
}
pairs.sort((a, b) => a - b);
out.push(`A post spread (${pool.length} static posts, ${pairs.length} pairs): `
  + pairs.map((d) => d.toFixed(0)).join(', '));

// ------------------------------------------------------------------ PART B --
out.push('B ch.behaviour.state for the same men (the trap — frozen at install): '
  + [...new Set(ai.guards.map((q) => q.ch.behaviour?.state))].join(', '));

// ------------------------------------------------------------------ PART C --
const cmd = ai.commander.guard;
const before = { home: cmd.home.clone(), at: cmd.ch.position.clone() };
// A rifle goes off just inside the wire, 40 m from the commander's post.
const from = new THREE.Vector3(site.x, 0, site.z);
ai.shotAt(from);
run(6);
out.push(`C alert after a shot: ${ai.alertLevel}, commander state=${cmd.state}`);
run(4 * 60);
const h = ai.hardening;
out.push(`C hardening: ${JSON.stringify(h)}`);
out.push(`C commander post ${before.home.x.toFixed(1)},${before.home.z.toFixed(1)} -> `
  + `${cmd.home.x.toFixed(1)},${cmd.home.z.toFixed(1)}  `
  + `(${Math.hypot(cmd.home.x - before.home.x, cmd.home.z - before.home.z).toFixed(1)} m)`);
run(16 * 60);
const walked = Math.hypot(cmd.ch.position.x - before.at.x, cmd.ch.position.z - before.at.z);
const toNewHome = Math.hypot(cmd.ch.position.x - cmd.home.x, cmd.ch.position.z - cmd.home.z);
out.push(`C 20 s after the shot: commander state=${cmd.state}, walked ${walked.toFixed(1)} m, `
  + `${toNewHome.toFixed(1)} m from his new post, inside the wire=${reg.outpost.isInside(cmd.ch.position.x, cmd.ch.position.z)}`);
const bg = ai.guards.filter((q) => q.bodyguard);
out.push(`C bodyguards: ${bg.length} — ` + bg.map((q) => `#${q.id} ${q.state} `
  + `${Math.hypot(q.ch.position.x - cmd.ch.position.x, q.ch.position ? q.ch.position.z - cmd.ch.position.z : 0).toFixed(1)} m off him`).join('; '));
const others = ai.guards.filter((q) => !q.bodyguard && q.role === 'sentry' && !q.down);
out.push(`C everyone else: ${others.map((q) => q.state).join(',')}`);
out.push(`C squad now ${ai.alertLevel}; reserve ${JSON.stringify(ai.reserve)}`);

out.push(`page errors: ${g.errors.length ? g.errors.slice(0, 4).join(' | ') : 'none'}`);
return out.join('\n');
