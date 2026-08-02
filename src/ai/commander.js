import * as THREE from 'three';

/**
 * The commander, and the reserve he can call on.
 *
 * The mission has said NEUTRALISE THE COMMANDER since round 1 and there has
 * never been a commander: the garrison was eight interchangeable men in two
 * roles, so the objective marker pointed at the middle of the compound and the
 * player's win condition was "walk to a coordinate". This designates one.
 *
 * He is not a stronger guard. He is a different KIND of unit, and the three
 * differences are the whole point:
 *
 *   he does not walk the perimeter  — he holds one post deep inside the wire,
 *                                     with an inspection beat of a few metres.
 *                                     You have to come to him.
 *   he retreats under fire          — when the shooting starts he backs into
 *                                     hard cover behind his post instead of
 *                                     pushing, so killing him is a problem of
 *                                     approach, not of aim.
 *   he calls reinforcements         — and there is a real detail on the access
 *                                     track to answer, which turns a firefight
 *                                     into a clock the player is losing.
 *
 * Kit is `characters`' own `commander` loadout — peaked cap, command coat,
 * shoulder boards, brassard, at 1.07 scale. ROUND 11: it used to be the
 * `officer` loadout with the cloth palette driven dark from `markCommander`
 * below, because nobody had asked for the variant that exists; the man wearing
 * actual rank was a sentry on the perimeter. `markCommander` is kept as the
 * fallback for a tree without the loadout — see the spawn in index.js.
 *
 * The legibility argument behind that loadout is worth repeating, because it is
 * why the objective is findable at all: at 60 m through this project's aerial
 * perspective the hue is gone and only VALUE and OUTLINE survive, so the read
 * has to be a dark block under a pale cap on a taller figure, not a colour.
 */

/** Reserve riflemen posted outside the wire, waiting to be called. */
export const RESERVE_N = 3;
/** Seconds of ALERT before he gets on the radio. */
export const CALL_DELAY = 5.5;
/** He will not do it more than this many times a mission. */
export const MAX_CALLS = 2;
/** Cover this far behind the post is where he goes when the shooting starts. */
export const FALLBACK_R = 16;

const _v = new THREE.Vector3();

/**
 * Every defensible command position in the compound, best first.
 *
 * One placer, used three times: to post him at install, to re-post him when the
 * compound goes loud, and by anything else that needs to know where a man would
 * stand. Round 11 pulled it out of `pickPost` rather than writing a second
 * scorer for the relocation, because two scorers is how the objective ends up
 * in a different kind of place depending on which code path put it there.
 *
 * The best post is the one a commander would actually take: deep inside, as far
 * from the gate as the compound allows, with something solid within arm's reach
 * to put his back to, and a clear view of the ground his men are standing on.
 */
export function rankPosts(grid, outpost) {
  const gate = outpost?.gate ?? null;
  const bounds = outpost?.bounds ?? null;
  if (!bounds) return [];
  const centre = bounds.getCenter(new THREE.Vector3());
  const gx = gate ? gate.x : centre.x;
  const gz = gate ? gate.z : centre.z;

  // Normalise depth against the compound's own size, so it competes with
  // overwatch instead of swamping it. Weighting raw metres put him in whichever
  // corner happened to be furthest from the gate — measured on the real
  // outpost, 97 m away in an empty corner with a 0 m sightline, which is a
  // hiding place, not a command post.
  const span = Math.max(20, Math.hypot(
    bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z,
  ));
  const cands = [];
  // A coarse stride: 3 m is finer than the decision needs and keeps this to a
  // few hundred candidates, i.e. a millisecond of install, not a budget item.
  const step = Math.max(1, Math.round(3 / grid.cell));
  for (let iz = 1; iz < grid.nz - 1; iz += step) {
    for (let ix = 1; ix < grid.nx - 1; ix += step) {
      const i = iz * grid.nx + ix;
      if (grid.blocked[i]) continue;
      const x = grid.cx(ix);
      const z = grid.cz(iz);
      if (outpost.isInside && !outpost.isInside(x, z)) continue;

      // Something solid within 4 m to stand against, but not boxed in.
      let walls = 0;
      let open = 0;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const px = x + Math.cos(a) * 4;
        const pz = z + Math.sin(a) * 4;
        if (grid.walkable(px, pz)) open++; else walls++;
      }
      if (open < 4 || walls < 1) continue;

      const y = grid.ground[i] + 1.65;
      // Overwatch: how much of the compound he can actually see from here.
      let clear = 0;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const px = x + Math.cos(a) * 22;
        const pz = z + Math.sin(a) * 22;
        if (grid.losClear(x, y, z, px, grid.heightAt(px, pz) + 1.3, pz)) clear++;
      }

      // Deep, with a view, with a wall at his back — and overwatch is worth as
      // much as depth, because a commander who can see nothing is a hostage.
      const depth = Math.min(1, Math.hypot(x - gx, z - gz) / span);
      const score = depth * 40 + clear * 5.5 + walls * 2.0;
      cands.push({ score, x, z, y: grid.ground[i], clear, walls });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  cands.gate = gate ?? new THREE.Vector3(gx, 0, gz);
  return cands;
}

/** A ranked candidate turned into a post: position, and the way he faces. */
function toPost(c, faceFrom) {
  const pos = new THREE.Vector3(c.x, c.y, c.z);
  return {
    position: pos,
    // Face the way the trouble comes from.
    yaw: Math.atan2(-(faceFrom.x - pos.x), -(faceFrom.z - pos.z)),
    overwatch: c.clear,
    score: c.score,
  };
}

/**
 * Choose the commander's post from the baked grid rather than from a hardcoded
 * coordinate, so it survives the outpost being relaid.
 */
export function pickPost(grid, outpost, cands = rankPosts(grid, outpost)) {
  if (!cands || !cands.length) return null;

  // The objective has to be REACHABLE. A post the player cannot walk to from
  // the gate is a mission that ends at a wall.
  //
  // Connectivity, not pathfinding: `findPath` hands back the partial route to
  // the nearest cell it could reach when the goal is walled off, so "a path
  // came back" was never the question this meant to ask. The bake labels its
  // connected regions — see NavGrid.labelComponents.
  const from = cands.gate;
  let best = null;
  for (const c of cands.slice(0, 8)) {
    if (grid.connected(from.x, from.z, c.x, c.z)) { best = c; break; }
  }
  return toPost(best ?? cands[0], from);
}

/**
 * WHERE HE GOES WHEN IT GOES LOUD.
 *
 * Being seen used to cost the player nothing: `alerts` was counted and printed
 * on the end card, and the objective stood exactly where he had been standing
 * since install, so the answer to a failed stealth approach was to shoot the
 * same man from the same angle a minute later. It costs something now — he
 * leaves the post the player has been watching and takes a second one, chosen
 * by the SAME scorer, biased away from wherever the shooting is coming from.
 *
 * Reachability is checked from where he is standing, not from the gate: this is
 * a man walking, not a designer placing a marker.
 *
 * @param {object} opts
 *   from    where he is now — the walk has to exist
 *   threat  the squad's last known contact, or null
 *   minMove metres; below this it is not a relocation, it is a fidget
 */
export function pickBastion(grid, cands, { from, threat = null, minMove = 10 } = {}) {
  if (!cands || !cands.length || !from) return null;
  const span = Math.max(20, minMove * 6);
  const scored = [];
  for (const c of cands) {
    const move = Math.hypot(c.x - from.x, c.z - from.z);
    if (move < minMove) continue;
    let bias = 0;
    if (threat) {
      const now = Math.hypot(from.x - threat.x, from.z - threat.z);
      const then = Math.hypot(c.x - threat.x, c.z - threat.z);
      // Retreating from the contact is worth as much as the post's own quality;
      // walking TOWARD it disqualifies the candidate outright.
      if (then < now - 2) continue;
      bias = Math.min(1, (then - now) / span) * 30;
    }
    // Cheap distance penalty: crossing the whole compound under fire is not
    // hardening, it is a target moving in the open.
    scored.push({ c, s: c.score + bias - move * 0.35 });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.s - a.s);
  for (const s of scored.slice(0, 6)) {
    if (grid.connected(from.x, from.z, s.c.x, s.c.z)) return toPost(s.c, threat ?? cands.gate);
  }
  return null;
}

/**
 * Where the reserve waits: down the access track outside the wire, far enough
 * that they are a reinforcement rather than part of the garrison, close enough
 * that the nav bake still covers them.
 */
export function pickStaging(grid, outpost) {
  const bounds = outpost?.bounds;
  const gate = outpost?.gate;
  if (!bounds || !gate) return null;
  const centre = bounds.getCenter(new THREE.Vector3());
  _v.set(gate.x - centre.x, 0, gate.z - centre.z);
  if (_v.lengthSq() < 1) return null;
  _v.normalize();
  // Walk outward from the gate until the grid runs out, then step back in.
  let out = null;
  for (let d = 44; d >= 20; d -= 3) {
    const x = gate.x + _v.x * d;
    const z = gate.z + _v.z * d;
    if (grid.inside(grid.ix(x), grid.iz(z)) && grid.walkable(x, z)) {
      out = new THREE.Vector3(x, grid.heightAt(x, z), z);
      break;
    }
  }
  if (!out) return null;
  return { position: out, yaw: Math.atan2(_v.x, _v.z), inward: _v.clone().multiplyScalar(-1) };
}

/**
 * Push the officer loadout further from a grunt than the variant alone does.
 * Reaches into the published per-instance cloth uniforms — `materials.js`
 * exposes `userData.uniforms` precisely so they can be driven from outside
 * without a rebuild — and changes nothing the characters module owns.
 */
export function markCommander(ch, Z) {
  const u = ch.materials?.cloth?.userData?.uniforms;
  if (!u || !u.uZoneColor) return false;
  const c = u.uZoneColor.value;
  const set = (zone, r, g, b) => { if (c[zone]) c[zone].set(r, g, b); };
  // Officer's serge: a darker, greener drab than the sun-bleached tan the
  // riflemen wear. Half the reflectance of a grunt's jacket.
  set(Z.JACKET, 0.118, 0.112, 0.072);
  set(Z.SLEEVE, 0.116, 0.110, 0.071);
  set(Z.TROUSER, 0.104, 0.099, 0.064);
  set(Z.COLLAR, 0.098, 0.094, 0.061);
  set(Z.SHIRT, 0.132, 0.126, 0.086);
  // ...under a pale, dusty boonie. This is the read at 60 m: the light thing
  // on top of the dark thing. Nearly 4x the body's reflectance.
  set(Z.CAP, 0.402, 0.368, 0.268);
  set(Z.HELMCOVER, 0.402, 0.368, 0.268);
  // He is not the one filling sandbags, so he is not the one covered in dust.
  if (u.uDust) u.uDust.value = Math.min(u.uDust.value, 0.22);
  return true;
}

/**
 * The commander's own behaviour. Called from `Guard.think` in place of the
 * ordinary state machine when `role === 'commander'`.
 *
 * Returns the state name he should be in, or null to let the normal machine
 * run (which is what happens while nothing is going on and he is simply
 * standing his post).
 */
export function commandThink(g, dt, ctx) {
  const squad = ctx.squad;
  const loud = squad.level === 'ALERT' || squad.level === 'EVASION';

  if (!loud) {
    g.callT = 0;
    // Stood down. He is available to be moved again by the NEXT alert — the
    // cost of being seen has to be payable more than once, or the second half
    // of a loud mission is free.
    g.hardened = false;
    // CALM/CAUTION: he holds. An inspection beat every half minute or so —
    // three steps to a corner of his own position and back — so he is not a
    // statue, but never the perimeter and never out of sight of his post.
    if (ctx.live && squad.level === 'CALM' && g.state === 'hold') {
      g.inspectT -= dt;
      if (g.inspectT <= 0) {
        g.inspectT = 24 + ctx.rand() * 26;
        const a = ctx.rand() * Math.PI * 2;
        const r = 4 + ctx.rand() * 7;
        const x = g.home.x + Math.cos(a) * r;
        const z = g.home.z + Math.sin(a) * r;
        if (ctx.grid.walkable(x, z)) {
          _v.set(x, ctx.grid.heightAt(x, z), z);
          g.enter('inspect', ctx, _v);
        }
      }
    }
    return null;
  }

  // Loud. He does not push and he does not sweep — both of those are jobs he
  // gives to other people. He gets behind something and he gets on the radio.
  //
  // First, once per escalation: he abandons the post the player has been
  // watching. `ctx.harden` is index.js's hook — it owns the ranked post list
  // and the bodyguards, both of which are garrison-wide facts this file has no
  // business holding. See pickBastion.
  if (!g.hardened) {
    g.hardened = true;
    ctx.harden?.(g);
  }
  g.callT += dt;
  if (g.callT > CALL_DELAY && g.calls < MAX_CALLS && ctx.callReserve) {
    g.calls++;
    g.callT = -22; // he will not chain-call; the next one is a minute away
    ctx.callReserve(g);
    g.radioTimer = 2.2;
    return 'radio';
  }
  return 'fallback';
}

/**
 * Retreat. The cover point behind the post — behind meaning on the far side
 * from wherever the squad believes the threat is — that he can actually reach.
 * Falls back to the post itself, crouched, which is still better than standing.
 */
export function fallbackPoint(g, ctx) {
  const threat = ctx.squad.hasLastKnown ? ctx.squad.lastKnown : null;
  const pts = ctx.coverPoints ?? [];
  let best = null;
  let bestScore = -Infinity;
  for (const c of pts) {
    const p = c.position;
    const dHome = Math.hypot(p.x - g.home.x, p.z - g.home.z);
    if (dHome > FALLBACK_R) continue;
    let away = 0;
    if (threat) {
      const dThreat = Math.hypot(p.x - threat.x, p.z - threat.z);
      const dHomeThreat = Math.hypot(g.home.x - threat.x, g.home.z - threat.z);
      away = dThreat - dHomeThreat;
      if (away < -1) continue; // that is toward the shooting, not away from it
    }
    const score = away * 1.6 - dHome * 0.5 + Math.min(c.radius ?? 1, 3) * 2;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  if (best) {
    // Stand on the sheltered side of it.
    if (threat) {
      _v.set(best.x - threat.x, 0, best.z - threat.z);
      if (_v.lengthSq() > 1e-4) {
        _v.normalize();
        const x = best.x + _v.x * 1.1;
        const z = best.z + _v.z * 1.1;
        if (ctx.grid.walkable(x, z)) return new THREE.Vector3(x, ctx.grid.heightAt(x, z), z);
      }
    }
    return best.clone();
  }
  // No published cover near the post: put the post's own solid neighbour
  // between him and the threat by stepping to the far side of his home cell.
  if (threat) {
    _v.set(g.home.x - threat.x, 0, g.home.z - threat.z);
    if (_v.lengthSq() > 1e-4) {
      _v.normalize();
      for (const d of [4, 2.5, 1.2]) {
        const x = g.home.x + _v.x * d;
        const z = g.home.z + _v.z * d;
        if (ctx.grid.walkable(x, z)) return new THREE.Vector3(x, ctx.grid.heightAt(x, z), z);
      }
    }
  }
  return g.home.clone();
}

/**
 * WHERE A BODYGUARD STANDS.
 *
 * The second half of what an alert costs the player. When the compound goes
 * loud the nearest men stop being part of the sweep and commit to the
 * commander: they take station a few metres off him, on the side the shooting
 * is coming from, and they do not leave to chase a last-known position. The
 * whole garrison converging on where you were last seen is the behaviour that
 * makes a loud approach EASIER than a quiet one — you pull every man off the
 * objective by making a noise on the far side of the compound, then walk in.
 *
 * They still fight normally the moment they can actually see the player; this
 * only replaces the "no eyes on, go and converge" branch.
 */
export function escortPoint(g, cmd, threat, ctx) {
  const c = cmd.ch.position;
  // Interposed if there is something to interpose against, otherwise fanned
  // out on his own bearing so two bodyguards do not stand in one spot.
  let dx;
  let dz;
  if (threat) {
    dx = threat.x - c.x;
    dz = threat.z - c.z;
  } else {
    dx = g.ch.position.x - c.x;
    dz = g.ch.position.z - c.z;
  }
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  // Fan: one man a third of a radian either side of the bearing, keyed off his
  // own id so the pair is stable frame to frame.
  const a = Math.atan2(dz, dx) + (g.id % 2 ? 0.55 : -0.55);
  for (const r of [4.0, 2.8, 5.5]) {
    const x = c.x + Math.cos(a) * r;
    const z = c.z + Math.sin(a) * r;
    if (ctx.grid.walkable(x, z)) return new THREE.Vector3(x, ctx.grid.heightAt(x, z), z);
  }
  return new THREE.Vector3(c.x, c.y, c.z);
}
