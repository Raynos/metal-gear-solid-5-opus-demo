/**
 * r11_reach.js — are the static posts actually mutually reachable, or is the
 * pathfinder just running out of budget on a long walk?
 *
 * Prints, for every pair of posts in the duty-roster pool: the straight-line
 * distance, whether the A* reaches at the frame budget (2600) and at a planning
 * budget (40000), and how far short the returned route stops.
 */
const g = window.__GAME;
const W = g.world;
const ai = W.registry.ai;
const grid = ai.navGrid;
const out = [];

const pool = ai.roster.pool;
const gap = (from, to, budget) => {
  const p = grid.findPath(from, to, budget);
  if (!p || !p.length) return null;
  const e = p[p.length - 1];
  return Math.hypot(e.x - to.x, e.z - to.z);
};

out.push(`grid ${grid.nx}x${grid.nz} @ ${grid.cell} m, bake ${JSON.stringify(grid.stats)}`);
for (let i = 0; i < pool.length; i++) {
  for (let j = i + 1; j < pool.length; j++) {
    const a = pool[i];
    const b = pool[j];
    const d = Math.hypot(a.home.x - b.home.x, a.home.z - b.home.z);
    const g1 = gap(a.home, b.home, 2600);
    const g2 = gap(a.home, b.home, 40000);
    out.push(`#${a.id}->#${b.id} ${d.toFixed(1).padStart(5)} m  short by `
      + `${g1 === null ? 'no path' : `${g1.toFixed(1)} m`} @2600, `
      + `${g2 === null ? 'no path' : `${g2.toFixed(1)} m`} @40000  `
      + `walkable(a)=${grid.walkable(a.home.x, a.home.z)} walkable(b)=${grid.walkable(b.home.x, b.home.z)}`);
  }
}
out.push(`isolated posts: ${JSON.stringify(ai.isolatedPosts)}`);
out.push(`page errors: ${g.errors.length ? g.errors.slice(0, 3).join(' | ') : 'none'}`);
return out.join('\n');
