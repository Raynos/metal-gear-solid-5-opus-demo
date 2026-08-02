import * as THREE from 'three';

/**
 * The duty roster: who is standing which post, and when they change over.
 *
 * THE PROBLEM. The outpost publishes three patrol loops. `index.js` gives each
 * one to the nearest unclaimed sentry, and everybody else — eight or nine men
 * out of twelve — holds one post for the entire mission and never takes a step.
 * Measured on the shipped build over 20 s of live AI: 3 guards moved, 9 did
 * not, and the nine included every man inside the wire. A compound where only
 * the perimeter moves reads as a diorama with three animatronics in it, and it
 * also makes the stealth trivial: a static sentry is a fixed obstacle you solve
 * once.
 *
 * WHAT THIS IS NOT. It is not a second set of patrol routes. Fabricating routes
 * is how you get men walking through walls, and `src/world/outpost` is the only
 * module entitled to say where the paths are. Every position used here is a
 * post some man was already standing — snapped to walkable ground and sight-
 * corrected by index.js at install — so no coordinate is invented.
 *
 * WHAT IT IS. A relief. Two sentries whose posts are near each other and
 * mutually reachable over the nav bake swap them: each walks to where the other
 * was standing, takes over his arc, and stands it until the next changeover.
 * The garrison stays exactly as dense as `characters` laid it out, every post
 * stays covered, and the compound is never in the state a patrol route creates
 * where a whole side of the wire is empty because the man walking it is on the
 * far side.
 *
 * Three rules keep it honest:
 *
 *   PATHFOUND    the pair is rejected unless `grid.findPath` returns a route
 *                between the two posts. No path, no relief — that is what stops
 *                a changeover walking a man through a blockhouse.
 *   CALM ONLY    a relief in progress during a firefight is two men strolling
 *                across a contact. The squad's own states own the man the
 *                moment anything happens.
 *   NOT LIVE, NOT MOVING. Gated on `ctx.live` exactly like patrol, so every
 *                canonical screenshot still frames the compound as
 *                `characters` posted it. See index.js's mode note.
 */

/**
 * Posts further apart than this are two different jobs, not a relief.
 *
 * 32 m was the first guess and it produced ZERO changeovers on the built
 * compound: the static sentries left over once the three patrol loops are
 * claimed stand on opposite faces of an 80 m perimeter, and the closest pair of
 * them is further apart than that. Measured before changing it rather than
 * nudged until something happened.
 */
const SWAP_MAX = 62;
/** Closer than this and the changeover is a shuffle nobody would notice. */
const SWAP_MIN = 6;
/** Seconds between changeover attempts, across the whole garrison. */
const INTERVAL = [8, 14];
/**
 * A man who has just been relieved is left alone for this long.
 *
 * 55 s starved the rotation on the built compound: of five static posts, two
 * are on ground the pathfinder cannot leave (see `isolatedPosts` in index.js),
 * so the usable pool is three men — one changeover takes two of them and the
 * cooldown then blocked the third. Measured at 55 s: one changeover in ninety
 * seconds. At 32 s the same garrison runs a relief about every half minute,
 * which is what a duty roster looks like.
 */
const COOLDOWN = 32;
/** First changeover after going live. Short, so the compound reads alive early. */
const FIRST = 3;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class PostRoster {
  /**
   * @param {Guard[]} guards  the whole garrison; only static sentries rotate
   * @param {NavGrid} grid    the bake, for the reachability test
   */
  constructor(guards, grid) {
    this.grid = grid;
    // Towers are excluded in both directions: a tower post is a platform the
    // 2D nav bake cannot represent (the man stands above a blocked cell), so a
    // relief involving one would path to the foot of the ladder and stand
    // there. Patrol men have routes, the commander has a command post and the
    // reserve is outside the wire — none of those are duty posts to trade.
    this.pool = guards.filter((g) => g.role === 'sentry');
    for (const g of this.pool) g.reliefT = 0;
    this.timer = FIRST;
    /**
     * Changeovers completed, pairs rejected for want of a path, and — because
     * the first version of this silently did nothing — attempts that found no
     * usable pair at all, plus the closest pair of posts it considered.
     */
    this.stats = { swaps: 0, unreachable: 0, attempts: 0, nopair: 0, spread: null };
  }

  /** True while this man is standing his post with nothing else to do. */
  _eligible(g, ctx) {
    if (g.down || g.reliefT > 0) return false;
    if (g.state !== 'hold' || g.partner) return false;
    // He must actually BE on his post — a man still walking back from an
    // investigation has somewhere to be already.
    return Math.hypot(g.ch.position.x - g.home.x, g.ch.position.z - g.home.z) < 2.5;
  }

  update(dt, ctx) {
    // Runs on past zero deliberately: the value doubles as "seconds since this
    // man was last relieved", which is how `attempt` picks who goes next.
    for (const g of this.pool) g.reliefT -= dt;
    if (!ctx.live || ctx.squad.level !== 'CALM') {
      // Hold the clock rather than banking changeovers through a firefight: the
      // garrison should not perform six reliefs the instant it stands down.
      this.timer = Math.max(this.timer, INTERVAL[0] * 0.5);
      return;
    }
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = INTERVAL[0] + ctx.rand() * (INTERVAL[1] - INTERVAL[0]);
    this.attempt(ctx);
  }

  /** One changeover, or nothing. */
  attempt(ctx) {
    const free = this.pool.filter((g) => this._eligible(g, ctx));
    if (free.length < 2) return null;
    this.stats.attempts++;

    // Longest on post first, so the rotation covers the garrison instead of
    // ping-ponging one convenient pair. Then the next-longest, and the one
    // after that: on the built compound one post is in a pocket the pathfinder
    // cannot leave (see `isolatedPosts` in index.js) and its man is ALWAYS the
    // stalest, so a version of this that gave up after him produced one
    // changeover in ninety seconds while three men who could have traded stood
    // still. Bounded at three men and six route tests an attempt.
    const order = [...free].sort((p, q) => p.reliefT - q.reliefT);
    let tests = 0;
    for (const a of order.slice(0, 3)) {
      // Nearest eligible neighbour that is a real walk away and actually
      // reachable. Ordered by distance so the cheapest candidate goes first.
      const cands = free
        .filter((g) => g !== a)
        .map((g) => ({ g, d: Math.hypot(g.home.x - a.home.x, g.home.z - a.home.z) }))
        .filter((c) => c.d >= SWAP_MIN && c.d <= SWAP_MAX)
        .sort((x, y) => x.d - y.d);
      this.stats.spread = cands.length ? +cands[0].d.toFixed(1) : null;

      for (const c of cands) {
        if (tests++ >= 6) break;
        _a.copy(a.home);
        _b.copy(c.g.home);
        // Both men have to be able to complete the walk, and that is a
        // connectivity question, not a pathfinding one: `findPath` returns a
        // partial route when the goal is walled off and gives up after a budget
        // when it is merely far, so asking it gave a different answer at 2600
        // and 12000 expansions and a different answer again depending on which
        // end the search started. The nav bake labels its connected regions at
        // install; two posts in the same region are mutually reachable, full
        // stop, and the test is a comparison rather than an A*.
        if (!this.grid.connected(_a.x, _a.z, _b.x, _b.z)) {
          this.stats.unreachable++;
          continue;
        }
        this.swap(a, c.g, ctx);
        return c.g;
      }
      // Nobody he can trade with. Put him on the clock anyway rather than
      // testing the same dead pairs every changeover.
      a.reliefT = COOLDOWN * 0.6;
      if (tests >= 6) break;
    }
    this.stats.nopair++;
    return null;
  }

  /** Two men trade posts, arcs and stances, and walk. */
  swap(a, b, ctx) {
    const home = a.home.clone();
    const yaw = a.homeYaw;
    const stance = a.postStance;
    a.home.copy(b.home);
    a.homeYaw = b.homeYaw;
    a.postStance = b.postStance;
    b.home.copy(home);
    b.homeYaw = yaw;
    b.postStance = stance;
    // The corrected post travels with the position, not with the man: whether
    // a post is blind is a fact about the ground.
    const blind = a.blindPost;
    a.blindPost = b.blindPost;
    b.blindPost = blind;

    a.reliefT = COOLDOWN;
    b.reliefT = COOLDOWN;
    a.enter('return', ctx);
    b.enter('return', ctx);
    this.stats.swaps++;
  }

  /** For probes: who is where, and how long since each man was relieved. */
  report() {
    return {
      pool: this.pool.length,
      ...this.stats,
      posts: this.pool.map((g) => ({
        id: g.id,
        state: g.state,
        home: [+g.home.x.toFixed(1), +g.home.z.toFixed(1)],
        cooldown: +Math.max(0, g.reliefT).toFixed(1),
      })),
    };
  }
}
