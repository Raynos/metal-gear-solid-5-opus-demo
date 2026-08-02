import * as THREE from 'three';
import { bakeNavGrid } from './nav.js';
import { Squad } from './squad.js';
import { Guard, SPEED } from './guard.js';
import { AIDebug } from './debug.js';
import { AWARE, SIGHT, senseVision, senseNoise, eyeOf, targetPoint } from './perception.js';
import { BALLISTICS, hitChance, impactPoint, suppressNear } from './combat.js';
import { RESERVE_N, pickPost, pickStaging, markCommander } from './commander.js';
// Read-only: the cloth zone enum, so the commander's kit can be re-toned
// through the per-instance uniforms `characters` publishes for exactly this.
import { Z } from '../characters/materials.js';

/**
 * ai module — the garrison.
 *
 * Drives the enemy soldiers published by `characters` (this module builds no
 * geometry at all) with a vision/hearing model, MGSV's alert ladder, and grid
 * pathfinding baked over the outpost at install.
 *
 * Published for everyone else:
 *
 *   { guards, commander, alertLevel, onAlertChange(fn) -> unsubscribe,
 *     contacts(), detection(), debugDraw(on) }
 *
 * plus the hooks gameplay needs to push events in: `hearNoise`, `tranquillise`,
 * `shotAt`, `suppress`, and `onEvent` for audio.
 *
 * ROUND 9 added three things the game could not be played without:
 *
 *   THE COMMANDER. The objective has read NEUTRALISE THE COMMANDER since round
 *   1 against a garrison of interchangeable sentries. There is one now, with a
 *   post chosen from the nav bake, officer kit, and behaviour that is different
 *   in kind rather than in degree — see commander.js.
 *
 *   GUARDS THAT CAN HURT YOU. `onGuardFire` used to publish a cone half-angle
 *   and leave the outcome to a listener that did not exist, so ALERT was a
 *   light show. Rounds now resolve: see combat.js for the model and `onFire`
 *   below for the seam into whatever health the player module publishes.
 *
 *   READABLE DETECTION. Per-guard awareness AND the reason for it are published
 *   every frame in a shape the HUD can draw without knowing anything about this
 *   module — `contacts()` — plus a one-line `detection()` summary.
 *
 * Cost control, because "dozens of guards" has to stay near 1 ms:
 *
 *   - senses run on a rotating schedule, SENSE_PER_FRAME men per frame, each
 *     integrating the wall time since HIS last tick rather than the frame's dt.
 *     Detection speed is therefore independent of how many guards are alive.
 *   - one A* per frame, globally, from a queue.
 *   - line of sight is a heightfield march (see nav.js), never a Raycaster.
 *   - the shadow test for the player is one ray for the whole squad, refreshed
 *     five times a second, not one per guard.
 *
 * Mode gating: full behaviour runs in `play`. In `menu` and `godmode` — which
 * is what the screenshot harness drives — guards hold their posts and scan, but
 * do not patrol and do not perceive the player. That is deliberate: patrol
 * translation makes guard positions a function of how long the warm world has
 * been running, which would make every canonical shot in the project
 * irreproducible. Press `H` (or call `setLive(true)`) to run the full AI in
 * godmode when you want to watch it.
 */

/** Guards whose senses are integrated per frame. */
const SENSE_PER_FRAME = 3;
/** Path requests served per frame, across the whole garrison. */
const PATHS_PER_FRAME = 1;
/** A body is noticed inside this radius, in view, with line of sight. */
const BODY_RADIUS = 15;
/** Hearing alone never crosses AWARE.DETECT — see senseOne. */
const EAR_CAP = 0.88;

const NOISE = {
  /** Radius in metres of a unit noise level. */
  scale: 34,
  gunshot: 120,
  body: 22,
  /** Anything quieter than this is not worth waking the squad for. */
  floor: 0.06,
};

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _v = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _tp = new THREE.Vector3();

export async function install(world) {
  const { engine, scene, terrain } = world;
  const reg = world.registry ?? {};
  const chars = reg.characters ?? null;
  const outpost = reg.outpost ?? reg.outpostGround ?? null;
  // Seedable so a bench can run the SAME scenario several times and report a
  // mean. A firefight is a sequence of coin flips; one trial of it is an
  // anecdote, and this project has been burned by single-sample measurements
  // more than once.
  const rand = mulberry32(world.aiSeed ?? 0x9e3779b9);

  if (!chars || !Array.isArray(chars.characters)) {
    console.warn('ai: no characters module; garrison not installed');
    return null;
  }

  // --- ground sampler ------------------------------------------------------
  // The outpost lays a graded platform over the terrain, so anything that walks
  // must query it, exactly as characters/index.js does.
  const groundAt = chars.ground?.heightAt
    ? chars.ground.heightAt
    : (x, z) => {
      const t = terrain ? terrain.heightAt(x, z) : 0;
      const h = outpost?.heightAt ? outpost.heightAt(x, z) : NaN;
      return Number.isFinite(h) ? Math.max(t, h) : t;
    };

  // --- navigation / visibility bake ---------------------------------------
  const region = new THREE.Box3();
  if (outpost?.bounds) {
    region.copy(outpost.bounds);
  } else {
    const p = chars.player?.position ?? new THREE.Vector3();
    region.set(new THREE.Vector3(p.x - 80, 0, p.z - 80), new THREE.Vector3(p.x + 80, 0, p.z + 80));
  }
  region.min.x -= 46; region.min.z -= 46;
  region.max.x += 46; region.max.z += 46;

  const roots = [outpost?.group, reg.rocks?.group].filter(Boolean);
  const grid = bakeNavGrid({ region, cell: 1.0, groundAt, roots });

  // --- the garrison --------------------------------------------------------
  const soldiers = chars.characters.filter((c) => c && !c.isPlayer);
  const routes = (outpost?.patrolWaypoints ?? []).filter((r) => Array.isArray(r) && r.length >= 3);
  const coverPoints = outpost?.coverPoints ?? [];

  const guards = [];
  const _home = new THREE.Vector3();
  for (const ch of soldiers) {
    ch.controlled = true; // characters/index.js leaves controlled men alone
    // Posts are cover: a sandbag horseshoe, a tower's legs, an emplacement.
    // The cell a man is posted in is therefore usually flagged unwalkable, and
    // a post you cannot path back to is a man who never goes home after an
    // investigation. Snap the HOME to standable ground; leave the character
    // exactly where `characters` put him, so no screenshot moves.
    _home.copy(ch.position);
    const snapped = grid.snap(_home.x, _home.z, 4);
    if (snapped >= 0) {
      const ix = snapped % grid.nx;
      const iz = (snapped - ix) / grid.nx;
      _home.set(grid.cx(ix), grid.ground[snapped], grid.cz(iz));
    }
    guards.push(new Guard(ch, {
      role: 'sentry',
      home: _home,
      yaw: ch.yaw,
      stance: ch.anim?.stance ?? 'stand',
    }));
  }

  // Give each patrol loop to the man standing nearest it. A route needs a body
  // that starts on it, otherwise the first thing the player sees at the gate is
  // three soldiers marching in from the far side of the compound.
  const claimed = new Set();
  routes.forEach((route, ri) => {
    let best = null;
    let bestD = Infinity;
    let bestI = 0;
    for (const g of guards) {
      if (claimed.has(g) || g.role !== 'sentry') continue;
      for (let i = 0; i < route.length; i++) {
        const d = route[i].distanceToSquared(g.ch.position);
        if (d < bestD) { bestD = d; best = g; bestI = i; }
      }
    }
    if (!best || bestD > 70 * 70) return;
    claimed.add(best);
    best.role = 'patrol';
    best.route = route;
    best.routeIndex = bestI;
    best.routeId = ri;
  });
  // A tower or roof post scans a much wider arc than a man at a gate.
  for (const g of guards) {
    const near = (outpost?.guardPosts ?? []).find(
      (p) => p.position && p.position.distanceToSquared(g.ch.position) < 9,
    );
    if (near && (near.kind === 'tower' || near.kind === 'roof')) g.role = 'tower';
  }

  /**
   * How much a sentry can actually see from his post along a given bearing.
   * Guard posts come from the outpost's `guardPosts` and the spawn yaw is
   * whatever `characters` chose; measured over the real compound, two of the
   * eight ended up facing a wall from a metre away — sightline 3% and 16% of
   * their surroundings, i.e. two men permanently blindfolded. A sentry posted
   * facing a blockhouse is a bug the player would never understand.
   */
  function sightScore(g, yaw) {
    const eye = eyeOf(g.ch, _eye);
    let clear = 0;
    let n = 0;
    for (let k = -2; k <= 2; k++) {
      const a = yaw + k * 0.35;
      for (const r of [10, 20, 30]) {
        const x = g.ch.position.x - Math.sin(a) * r;
        const z = g.ch.position.z - Math.cos(a) * r;
        n++;
        if (grid.losClear(eye.x, eye.y, eye.z, x, grid.heightAt(x, z) + 1.3, z)) clear++;
      }
    }
    return clear / n;
  }
  for (const g of guards) {
    const asPosted = sightScore(g, g.homeYaw);
    if (asPosted >= 0.3) continue;
    let bestYaw = g.homeYaw;
    let best = asPosted;
    for (let k = 0; k < 16; k++) {
      const yaw = g.homeYaw + (k / 16) * Math.PI * 2;
      const s = sightScore(g, yaw);
      if (s > best) { best = s; bestYaw = yaw; }
    }
    // Only turn him if it genuinely buys a field of view.
    if (best > asPosted + 0.25) {
      g.homeYaw = bestYaw;
      g.lookYaw = bestYaw;
      g.lookGoal = bestYaw;
      g.bodyYawGoal = bestYaw;
      g.repost = true;
    }
  }

  /**
   * How much of the ground around a point a man standing there can see: the
   * fraction of 12 bearings that reach 15 m. Turning a sentry cannot fix a
   * sentry who is INSIDE something.
   */
  function openness(x, z, y) {
    let open = 0;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const px = x - Math.sin(a) * 15;
      const pz = z - Math.cos(a) * 15;
      if (grid.losClear(x, y, z, px, grid.heightAt(px, pz) + 1.3, pz)) open++;
    }
    return open / 12;
  }

  /**
   * Some posts are blind, and no amount of turning helps.
   *
   * Measured in the real compound after the eyeline fix: three of the eight men
   * `characters` garrisons see almost nothing — two of them reach 15 m on ZERO
   * of twenty-four bearings, the third on 13%. One is standing inside a sandbag
   * emplacement deeper than the 2.6 m the LOS march forgives; one is standing
   * 1.2 m below the nav bake's idea of his own ground, so every ray he casts
   * goes straight into a hillside. Three of eight is well over a third of the
   * garrison contributing nothing at all to the stealth.
   *
   * Corrected, they measure 38%, 67% and 21%.
   *
   * The fix cannot be to move him, because where `characters` put him is what
   * every canonical screenshot has framed for three rounds. So: his post is
   * recorded as a nearby cell that can actually see, and he WALKS there the
   * first time the game goes live. Backdrop mode — menu, godmode, and the shot
   * harness — never runs this, so no shot moves by a pixel.
   */
  for (const g of guards) {
    eyeOf(g.ch, _eye);
    if (openness(g.ch.position.x, g.ch.position.z, _eye.y) >= 0.17) continue;
    let bestP = null;
    let bestOpen = 0;
    for (let k = 0; k < 24; k++) {
      const a = (k / 12) * Math.PI * 2;
      const r = k < 12 ? 3.5 : 6.5;
      const x = g.ch.position.x + Math.cos(a) * r;
      const z = g.ch.position.z + Math.sin(a) * r;
      if (!grid.walkable(x, z)) continue;
      const y = grid.heightAt(x, z) + 1.6;
      const o = openness(x, z, y);
      if (o > bestOpen) { bestOpen = o; bestP = new THREE.Vector3(x, y - 1.6, z); }
    }
    if (bestP && bestOpen >= 0.25) {
      g.home.copy(bestP);
      g.blindPost = true;
    }
  }

  // --- the commander -------------------------------------------------------
  //
  // A separate body, not a promoted sentry: the objective has to be somewhere
  // the player must actually go, and every post `characters` garrisons is on
  // the wire. `pickPost` reads the bake for the deepest defensible ground.
  let commander = null;
  const reserves = [];
  if (typeof chars.spawnSoldier === 'function') {
    const post = pickPost(grid, outpost);
    if (post) {
      const ch = chars.spawnSoldier([post.position.x, 0, post.position.z], {
        variant: 'officer',
        name: 'commander',
        yaw: post.yaw,
        // A hand taller than the tallest rifleman. Silhouette is the first thing
        // that survives distance, and it survives it before value does.
        scale: 1.07,
      });
      ch.controlled = true;
      // `materials.js` publishes the per-instance cloth uniforms specifically so
      // they can be driven from outside; `Z` is its own zone enum. Read-only use
      // of the characters module's published surface — nothing there is edited.
      markCommander(ch, Z);
      commander = new Guard(ch, {
        role: 'commander',
        home: post.position,
        yaw: post.yaw,
        stance: 'stand',
      });
      commander.name = 'commander';
      guards.push(commander);
    }

    // The reserve. Three riflemen on the access track outside the wire, close
    // enough to matter and far enough that they are a second problem rather
    // than part of the first. They see and hear like anyone else — a checkpoint
    // that ignores a man walking past it would be a worse bug than having no
    // reinforcements at all — they simply do not join the sweep until called.
    const stage = pickStaging(grid, outpost);
    if (stage) {
      for (let i = 0; i < RESERVE_N; i++) {
        const a = (i - (RESERVE_N - 1) / 2) * 2.6;
        const x = stage.position.x + stage.inward.z * a;
        const z = stage.position.z - stage.inward.x * a;
        if (!grid.walkable(x, z)) continue;
        const ch = chars.spawnSoldier([x, 0, z], {
          variant: i === 1 ? 'scout' : 'grunt',
          name: `reserve-${i}`,
          yaw: stage.yaw + (rand() - 0.5) * 0.8,
        });
        ch.controlled = true;
        const g = new Guard(ch, {
          role: 'reserve',
          home: new THREE.Vector3(x, grid.heightAt(x, z), z),
          yaw: stage.yaw + (rand() - 0.5) * 0.8,
          stance: 'stand',
        });
        reserves.push(g);
        guards.push(g);
      }
    }
  }

  // --- squad, debug --------------------------------------------------------
  const squad = new Squad(rand);
  const debug = new AIDebug(scene);

  /**
   * CAUTION has to be *visible* or it is not a rung on the ladder, it is a
   * variable. When the squad steps up to CAUTION, the nearest free man walks
   * over to the reported spot as well as whoever called it in — so the player
   * sees two soldiers converging on the noise he made, and gets the seconds of
   * warning that make CAUTION playable rather than a coin flip.
   */
  squad.onChange((ev) => {
    if (ev.to !== 'CAUTION' || !ev.position) return;
    const free = guards
      // Never the commander — sending the objective to the player is the exact
      // opposite of the behaviour he exists to have — and never a reserve who
      // has not been called, because that would empty the checkpoint for free.
      .filter((g) => !g.down && g.role !== 'commander'
        && !(g.role === 'reserve' && !g.committed)
        && g.state !== 'investigate' && g.state !== 'scan'
        && g.ch.position.distanceToSquared(ev.position) < 45 * 45)
      .sort((a, b) => a.ch.position.distanceToSquared(ev.position)
        - b.ch.position.distanceToSquared(ev.position));
    // Two men, not the garrison. A noise that empties every post is a bug the
    // player can farm; a noise that moves a pair is a lever he can use.
    for (const g of free.slice(0, 2)) g.enter('investigate', ctx, ev.position);
    // The order came from somewhere: if the commander is up, it came from him,
    // and he is visibly on the radio while he gives it.
    if (commander && !commander.down && free.length) {
      commander.radioTimer = 1.4;
      commander.enter('radio', ctx);
    }
  });

  // --- target resolution ---------------------------------------------------
  // The player may be driven by `gameplay` or may still be the idle character
  // `characters` spawned; read both defensively, every frame, because gameplay
  // installs after this module in some orderings and before it in others.
  const target = {
    ch: null,
    speed: 0,
    heading: new THREE.Vector3(0, 0, 1),
    inShadow: false,
    down: false,
    prev: new THREE.Vector3(),
    hasPrev: false,
  };

  /**
   * The player module publishes itself as `registry.player`, NOT
   * `registry.gameplay`.
   *
   * Every read of the player in this file went through `reg.gameplay`, which
   * has never existed, so three seams were silently dead: the continuous noise
   * the player makes while moving was never heard by anyone (`ambientNoise`
   * returned null on the first line), `playerDown` was never true, and the
   * stance/sprint state the accuracy model wants was unreachable. Sprinting
   * past a sentry was as quiet as crawling. Read both names, because the one
   * thing this seam has proven is that it moves.
   */
  function playerApi() {
    return reg.player ?? reg.gameplay ?? null;
  }

  function resolveTargetCharacter() {
    const gp = playerApi();
    const cand = gp?.playerCharacter ?? gp?.character ?? gp?.player?.ch ?? gp?.player ?? chars.player;
    if (cand && cand.position && typeof cand.position.x === 'number') return cand;
    return chars.player ?? null;
  }

  // --- noise ---------------------------------------------------------------
  /** Explicit, decaying noise events pushed in by gameplay or by the guards. */
  const noises = [];
  function hearNoise(position, radius = 20, kind = 'noise', life = 0.35) {
    if (!position) return;
    noises.push({
      position: position.isVector3 ? position.clone() : new THREE.Vector3(position[0], position[1] ?? 0, position[2]),
      radius,
      kind,
      life,
      // One event, one contribution per man. Without this the event is applied
      // once per sense tick for as long as it lives, which turned a single
      // dropped body into every guard on the map maxing his meter.
      heard: new Set(),
    });
    if (noises.length > 48) noises.shift();
  }

  /**
   * The continuous noise the player is making right now. `gameplay` publishes
   * `noiseLevel`; accept a scalar, an object, or a function, because the
   * contract on the other side of that seam is not written yet.
   */
  function ambientNoise() {
    const gp = playerApi();
    if (!gp || !target.ch) return null;
    // `player` publishes a radius in metres directly, which is exactly what the
    // hearing model wants; prefer it over re-deriving one from the 0..1 level.
    const r = gp.noiseRadius;
    if (typeof r === 'number') {
      if (r < NOISE.floor * NOISE.scale) return null;
      return { position: target.ch.position, radius: r, kind: 'noise' };
    }
    let n = gp.noiseLevel;
    if (typeof n === 'function') n = n();
    if (n == null) return null;
    if (typeof n === 'number') {
      if (n < NOISE.floor) return null;
      return { position: target.ch.position, radius: n * NOISE.scale, kind: 'noise' };
    }
    if (typeof n === 'object') {
      const lvl = n.level ?? n.value ?? 1;
      if (lvl < NOISE.floor) return null;
      return {
        position: n.position ?? target.ch.position,
        radius: n.radius ?? lvl * NOISE.scale,
        kind: n.kind ?? 'noise',
      };
    }
    return null;
  }

  // --- shadow test ---------------------------------------------------------
  // One ray for the whole squad. `inShadow` is worth a factor of three on the
  // detection rate, so it has to be real geometry, not a guess.
  let shadowTimer = 0;
  /**
   * Forces `inShadow` for measurement. Shadow is worth a factor of ~2.2 on the
   * detection rate and there is no other way to A/B it: you cannot hold a real
   * sun still, and moving the target into a real shadow also moves its range,
   * its angle off axis and its occlusion, so the measurement would be of four
   * things at once. null = use the real ray.
   */
  let shadowOverride = null;
  function updateShadow(dt) {
    shadowTimer -= dt;
    if (shadowOverride !== null) { target.inShadow = shadowOverride; return; }
    if (shadowTimer > 0 || !target.ch) return;
    shadowTimer = 0.2;
    const sun = world.lighting?.sunDirection;
    if (!sun) { target.inShadow = false; return; }
    targetPoint(target.ch, _tp);
    _tp.y += 0.3;
    if (sun.y <= 0.02) { target.inShadow = true; return; }
    const R = 70;
    target.inShadow = !grid.losClear(
      _tp.x, _tp.y, _tp.z,
      _tp.x + sun.x * R, _tp.y + sun.y * R, _tp.z + sun.z * R,
    );
  }

  // --- path queue ----------------------------------------------------------
  const pathQueue = [];
  function requestPath(guard) {
    if (guard.pathPending) return;
    guard.pathPending = true;
    pathQueue.push(guard);
    if (pathQueue.length > 64) {
      const dropped = pathQueue.shift();
      dropped.pathPending = false;
    }
  }
  function servePaths() {
    for (let k = 0; k < PATHS_PER_FRAME && pathQueue.length; k++) {
      const g = pathQueue.shift();
      g.pathPending = false;
      if (g.down || !g.goal) continue;
      // No route: keep the goal and steer at it directly. `apply()`'s stuck
      // timer will ask again, and the state machine times the whole attempt out
      // — better than a man who stops dead because the grid disagreed with him.
      g.path = grid.findPath(g.ch.position, g.goal);
      g.pathI = 0;
    }
  }

  // --- shooting ------------------------------------------------------------
  const fireListeners = new Set();
  const hitListeners = new Set();
  const _impact = new THREE.Vector3();
  /** Rolling tally so the model can be checked against the design, not guessed. */
  const gunfire = { shots: 0, hits: 0, damage: 0, kills: 0 };
  /** 0..1: how much fire the player is currently under. For the HUD and camera. */
  let playerSuppression = 0;

  /**
   * Deliver damage into whatever `player` publishes.
   *
   * The health seam is being built by another author this round, so this tries
   * the plausible names in order and stops at the first one that exists. If
   * none does, the round still resolves, is still reported on `onPlayerHit`,
   * and still counts in `gunfire` — so the model is measurable and correct on
   * the day the sink appears, instead of silently doing nothing the way
   * `onGuardFire` did for two rounds.
   */
  function applyDamage(amount, info) {
    const gp = playerApi();
    if (!gp) return false;
    // UNITS. `BALLISTICS.damage` is points on a HUNDRED-point player — that is
    // what combat.js's whole "nine rounds to kill" derivation is written in.
    // The sink that appeared is src/gameplay/Vitals.js and it runs 0..1. Eleven
    // went into `Math.max(0, health - amount)` and the FIRST round that landed
    // killed the player outright: measured in the round-9 play harness as
    // "health 1 -> 0" one sample after the alert went up, at 38 m, while
    // sprinting — a range and a stance the model says should almost never hit.
    // The sink publishes its own scale; ask it.
    const max = typeof gp.maxHealth === 'number' && gp.maxHealth > 0 ? gp.maxHealth : 100;
    const scaled = amount * (max / 100);
    for (const name of ['damage', 'takeDamage', 'hurt', 'applyDamage', 'onHit']) {
      if (typeof gp[name] !== 'function') continue;
      // `from` is a WORLD POSITION everywhere in this codebase. Handing the
      // whole info record over as the second argument put `undefined` into a
      // vector subtraction, so the direction the body plays being hit from was
      // NaN and the flinch pointed nowhere.
      try { gp[name](scaled, info?.from ?? null, 'gunfire', info); return true; } catch (e) { /* keep going */ }
    }
    return false;
  }

  function onFire(guard, at, dist, burstIndex) {
    eyeOf(guard.ch, _eye);
    hearNoise(guard.ch.position, NOISE.gunshot, 'gunshot', 0.2);
    squad.report('gunshot', squad.hasLastKnown ? squad.lastKnown : at, guard);

    const hit = ctx.target && !ctx.target.down
      && rand() < hitChance(guard, ctx.target, dist, burstIndex ?? 0);
    if (hit) _impact.copy(at);
    else impactPoint(at, dist, rand, _impact);

    guard.shotsFired++;
    gunfire.shots++;
    if (hit) {
      guard.hits++;
      gunfire.hits++;
      gunfire.damage += BALLISTICS.damage;
      const info = {
        guard, from: _eye.clone(), at: at.clone(), dist,
        damage: BALLISTICS.damage, kind: 'rifle',
      };
      applyDamage(BALLISTICS.damage, info);
      for (const fn of hitListeners) { try { fn(info); } catch (e) { /* ignore */ } }
    }

    // A near miss is not nothing: rounds cracking past pin the player the same
    // way his pin the guards, and the HUD needs to be able to show it.
    if (ctx.target?.ch) {
      const dm = Math.hypot(_impact.x - ctx.target.ch.position.x, _impact.z - ctx.target.ch.position.z);
      if (dm < BALLISTICS.nearMiss) {
        playerSuppression = Math.min(1, playerSuppression
          + BALLISTICS.playerPerRound * (1 - dm / BALLISTICS.nearMiss));
      }
    }

    const spread = THREE.MathUtils.clamp(0.02 + dist * 0.0016, 0.02, 0.12);
    const ev = {
      guard, from: _eye.clone(), at: at.clone(), impact: _impact.clone(),
      spread, dist, hit, damage: hit ? BALLISTICS.damage : 0,
      rounds: guard.rounds, reloading: guard.reloadT > 0,
    };
    for (const fn of fireListeners) { try { fn(ev); } catch (e) { /* ignore */ } }
    squad._emit({ type: 'gunshot', position: guard.ch.position.clone(), from: guard.id });
  }

  // --- reinforcements ------------------------------------------------------
  /**
   * The commander's radio call. Commits the reserve: they stop being a
   * checkpoint and become alert guards converging on the last known position.
   * Deliberately not a spawn — the bodies exist from install, so the call costs
   * nothing at the moment it happens and cannot hitch a firefight.
   */
  let reserveCalls = 0;
  function callReserve(from) {
    const fresh = reserves.filter((g) => !g.down && !g.committed);
    if (!fresh.length) return 0;
    reserveCalls++;
    for (const g of fresh) {
      g.committed = true;
      g.enter('combat', ctx);
    }
    squad._emit({
      type: 'reinforce',
      position: (from?.ch?.position ?? squad.lastKnown).clone(),
      from: from?.id ?? null,
      count: fresh.length,
    });
    return fresh.length;
  }

  // --- context -------------------------------------------------------------
  const ctx = {
    grid, squad, guards, rand, coverPoints, target: null, live: false,
    night: 0, elapsed: 0, frozen: false, requestPath, onFire, callReserve,
  };

  // --- mode ----------------------------------------------------------------
  let mode = world.gameState?.mode ?? 'godmode';
  let forceLive = false;
  const unsubMode = world.gameState?.onModeChange?.((m) => {
    mode = m;
    if (mode !== 'play') resetToCalm();
  }) ?? null;

  function resetToCalm() {
    squad.set('CALM', null, 'mode change');
    squad.hasLastKnown = false;
    squad.timer = 0;
    playerSuppression = 0;
    for (const g of guards) {
      g.awareness = 0;
      g.awareReason = null;
      g.suppression = 0;
      g.reloadT = 0;
      g.rounds = BALLISTICS.magazine;
      g.callT = 0;
      g.calls = 0;
      // The reserve goes back outside the wire, or leaving play mode and
      // re-entering it would find a compound that had already been reinforced.
      if (g.role === 'reserve') g.committed = false;
      if (!g.down) g.enter('hold', ctx);
    }
  }

  // --- senses --------------------------------------------------------------
  let senseCursor = 0;

  function senseOne(g, dt) {
    if (g.down) return;
    if (!ctx.live) {
      if (g.awareness > 0) g.awareness = Math.max(0, g.awareness - SIGHT.decay * dt);
      return;
    }
    // Bodies. A man down inside the cone with clear sight is not a suspicion,
    // it is proof, and it escalates the squad immediately.
    for (const other of guards) {
      if (!other.down || other === g || g.bodySeen.has(other.id)) continue;
      const d = Math.hypot(other.ch.position.x - g.ch.position.x, other.ch.position.z - g.ch.position.z);
      if (d > BODY_RADIUS) continue;
      const ax = -Math.sin(g.lookYaw);
      const az = -Math.cos(g.lookYaw);
      const nx = (other.ch.position.x - g.ch.position.x) / (d || 1);
      const nz = (other.ch.position.z - g.ch.position.z) / (d || 1);
      if (ax * nx + az * nz < 0.2) continue;
      eyeOf(g.ch, _eye);
      if (!grid.losClear(_eye.x, _eye.y, _eye.z,
        other.ch.position.x, (other.ch.groundY ?? 0) + 0.3, other.ch.position.z)) continue;
      g.bodySeen.add(other.id);
      g.awareReason = 'body';
      squad.report('body', other.ch.position, g);
      g.radioTimer = 1.5;
      g.enter('radio', ctx);
      return;
    }

    if (!ctx.target || ctx.target.down) {
      if (g.awareness > 0) g.awareness = Math.max(0, g.awareness - SIGHT.decay * dt);
      if (g.awareness < 0.02) g.awareReason = null;
      return;
    }

    const before = g.awareness;
    g.awareness = THREE.MathUtils.clamp(g.awareness + senseVision(g, ctx.target, ctx, dt), 0, 1.35);
    // A meter that has leaked back to nothing has no story to tell the HUD.
    if (g.awareness < 0.02 && before >= g.awareness) g.awareReason = null;

    // Hearing can make a man suspicious; it can never make him certain. The cap
    // is what keeps a gunshot from handing every guard on the map a positive ID
    // of the player's position — the meter is "I have eyes on an intruder", and
    // a noise behind a wall is not that. It escalates the SQUAD instead, which
    // is the correct channel.
    for (const n of noises) {
      if (n.heard.has(g.id)) continue;
      const heard = senseNoise(g, n, ctx);
      if (!heard) continue;
      n.heard.add(g.id);
      g.awareness = Math.min(EAR_CAP, g.awareness + (n.kind === 'gunshot' ? 0.5 : 0.34) * heard.strength);
      g.lastSeenAt.copy(heard.position);
      g.awareHold = 1.2;
      if (g.awareReason !== 'sight') g.awareReason = 'sound';
      // Report regardless of the meter: hearing something IS the radio call.
      // Who goes and looks is then the squad's decision, not four men's.
      squad.report('noise', heard.position, g);
    }
    const amb = ambientNoise();
    if (amb) {
      const heard = senseNoise(g, amb, ctx);
      if (heard) {
        g.awareness = Math.min(EAR_CAP, g.awareness + 0.9 * heard.strength * dt);
        g.lastSeenAt.copy(heard.position);
        g.awareHold = 1.0;
        if (g.awareReason !== 'sight') g.awareReason = 'sound';
        if (g.awareness >= AWARE.NOTICE) squad.report('noise', heard.position, g);
      }
    }
  }

  // --- per-frame -----------------------------------------------------------
  const stats = { ms: 0, msPeak: 0, sensed: 0, paths: 0, guards: guards.length };
  let emaMs = 0;

  const system = {
    order: 15, // before characters (20), so drive() lands in the same frame
    update(dt) {
      const t0 = performance.now();
      ctx.live = (mode === 'play' || forceLive) && !!chars;
      ctx.night = world.lighting?.night ?? 0;
      ctx.elapsed = engine.elapsed;
      // The harness latches `deterministic` in settle() and never clears it.
      ctx.frozen = engine.deterministic === true && !ctx.live;

      // Target bookkeeping.
      const pch = resolveTargetCharacter();
      if (pch !== target.ch) {
        target.ch = pch;
        target.hasPrev = false;
      }
      if (target.ch) {
        if (target.hasPrev && dt > 1e-5) {
          _v.set(target.ch.position.x - target.prev.x, 0, target.ch.position.z - target.prev.z);
          const d = _v.length();
          target.speed = d / dt;
          if (d > 1e-4) target.heading.copy(_v).multiplyScalar(1 / d);
        }
        target.prev.copy(target.ch.position);
        target.hasPrev = true;
        const gp = playerApi();
        target.down = !!(gp?.playerDown ?? gp?.down ?? gp?.dead ?? target.ch.downed);
      }
      ctx.target = ctx.live ? target : null;
      updateShadow(dt);
      if (playerSuppression > 0) {
        playerSuppression = Math.max(0, playerSuppression - BALLISTICS.suppressDecay * dt);
      }

      // Noise events age out.
      for (let i = noises.length - 1; i >= 0; i--) {
        noises[i].life -= dt;
        if (noises[i].life <= 0) noises.splice(i, 1);
      }

      if (ctx.live) squad.update(dt);

      // Senses: a rotating slice, each man integrating his own elapsed time.
      for (const g of guards) g.senseAcc += dt;
      const slice = guards.length ? Math.min(SENSE_PER_FRAME, guards.length) : 0;
      for (let k = 0; k < slice; k++) {
        const g = guards[senseCursor % guards.length];
        senseCursor++;
        senseOne(g, g.senseAcc);
        g.senseAcc = 0;
      }
      stats.sensed = slice;

      for (const g of guards) {
        g.think(dt, ctx);
        g.apply(dt, ctx);
      }

      servePaths();
      stats.paths = pathQueue.length;
      stats.guards = guards.length;

      debug.update(guards, squad, engine.camera, grid);

      const ms = performance.now() - t0;
      emaMs += (ms - emaMs) * 0.05;
      stats.ms = +emaMs.toFixed(3);
      if (ms > stats.msPeak) stats.msPeak = +ms.toFixed(3);
    },
  };
  engine.addSystem(system);

  // --- input ---------------------------------------------------------------
  const onKey = (e) => {
    if (e.code === 'KeyG') debug.toggle();
    else if (e.code === 'KeyH') forceLive = !forceLive;
  };
  // Guarded so the module can be driven headlessly by a test harness.
  if (typeof window !== 'undefined') window.addEventListener('keydown', onKey);

  // --- detection telemetry -------------------------------------------------
  //
  // The HUD cannot draw a suspicion meter it has to reverse-engineer from a
  // guard object. `contacts()` is the whole detection state in the flattest
  // shape a renderer could ask for, refilled into a persistent array so reading
  // it every frame allocates nothing.
  const _contacts = [];
  function contacts(out = _contacts) {
    out.length = 0;
    for (const g of guards) {
      const p = g.ch.position;
      out.push({
        id: g.id,
        role: g.role,
        state: g.state,
        down: g.down,
        x: p.x,
        y: (g.ch.groundY ?? p.y),
        z: p.z,
        /** 0..1, where 1 is a positive ID. This is the meter to draw. */
        awareness: THREE.MathUtils.clamp(g.awareness / AWARE.DETECT, 0, 1),
        /** 'sight' | 'sound' | 'body' | 'contact' | null — the label to draw. */
        reason: g.awareReason,
        /** True while he can literally see the player right now. */
        seeing: g.vis.visible,
        dist: Number.isFinite(g.vis.dist) ? g.vis.dist : null,
        suppressed: +g.suppression.toFixed(2),
        reloading: g.reloadT > 0,
        commander: g === commander,
      });
    }
    return out;
  }

  /** One line: the worst thing happening to the player right now. */
  function detection() {
    let peak = 0;
    let who = null;
    let seeing = 0;
    for (const g of guards) {
      if (g.down) continue;
      if (g.vis.visible) seeing++;
      const a = g.awareness;
      if (a > peak) { peak = a; who = g; }
    }
    return {
      level: squad.level,
      awareness: +THREE.MathUtils.clamp(peak / AWARE.DETECT, 0, 1).toFixed(3),
      reason: who?.awareReason ?? null,
      by: who?.id ?? null,
      dist: who && Number.isFinite(who.vis.dist) ? +who.vis.dist.toFixed(1) : null,
      seeing,
      suppression: +playerSuppression.toFixed(2),
    };
  }

  // --- API -----------------------------------------------------------------
  const api = {
    guards,
    /**
     * The mission objective, as an entity rather than a map coordinate.
     * `{ guard, character, position, down }`, or null if `characters` could not
     * spawn him. `position` is live — he does move, a little.
     */
    get commander() {
      if (!commander) return null;
      return {
        guard: commander,
        character: commander.ch,
        position: commander.ch.position,
        down: commander.down,
        state: commander.state,
        calls: commander.calls,
      };
    },
    get commanderDown() { return !!commander?.down; },
    /** Riflemen outside the wire, and whether the commander has called them. */
    get reserve() {
      return { total: reserves.length, committed: reserves.filter((g) => g.committed).length, calls: reserveCalls };
    },

    /** Per-guard detection state, flat, allocation-free. See above. */
    contacts,
    /** The one-line summary: how close the player is to being made, and why. */
    detection,
    /** 0..1 — how much incoming fire the player is under. */
    get suppression() { return playerSuppression; },
    /** Shots fired at the player, hits landed, damage dealt. */
    get gunfire() { return { ...gunfire }; },

    /** Live squad state: 'CALM' | 'CAUTION' | 'ALERT' | 'EVASION'. */
    get alertLevel() { return squad.level; },
    getAlertLevel: () => squad.level,
    /** fn({from, to, reason, position}) -> unsubscribe. */
    onAlertChange: (fn) => squad.onChange(fn),
    /** Everything the AI emits: alert, notice, noise, gunshot, body. For audio. */
    onEvent: (fn) => squad.onEvent(fn),
    /**
     * fn({guard, from, at, impact, spread, dist, hit, damage, rounds, reloading})
     * on every round a guard fires. `impact` is where it actually went, which
     * is what the tracer and the dust puff should be drawn to.
     */
    onGuardFire: (fn) => { fireListeners.add(fn); return () => fireListeners.delete(fn); },
    /** fn({guard, from, at, dist, damage, kind}) only when the player is hit. */
    onPlayerHit: (fn) => { hitListeners.add(fn); return () => hitListeners.delete(fn); },

    /** 0 = off, 1 = cones + meters + paths, 2 = also the navigation grid. */
    debugDraw: (on) => debug.set(on === true ? 1 : on === false ? 0 : on),

    /** Push a noise into the world: gunshots, a body landing, a sprint step. */
    hearNoise,
    /** Put a man down. He becomes a body other guards can find. */
    tranquillise(guardOrChar, kind = 'tranq') {
      const g = guards.find((x) => x === guardOrChar || x.ch === guardOrChar || x.id === guardOrChar);
      if (!g) return null;
      g.drop(kind);
      hearNoise(g.ch.position, NOISE.body, 'bodyfall', 0.3);
      if (g === commander) {
        gunfire.kills++;
        squad._emit({ type: 'commander', position: g.ch.position.clone(), from: g.id, kind });
      }
      return g;
    },
    /** Someone shot at the garrison from `position` — escalate immediately. */
    shotAt(position) {
      squad.report('contact', position ?? (target.ch ? target.ch.position : null));
      hearNoise(position ?? target.ch?.position, NOISE.gunshot, 'gunshot', 0.2);
    },
    /**
     * A player round passed through here. Everyone near it is suppressed: their
     * accuracy drops and they stay in cover. This is what makes shooting at a
     * guard you cannot hit worth the ammunition, and it is the lever that lets
     * the player win a firefight he is losing.
     */
    suppress(position, radius = 4.5, amount = BALLISTICS.suppressPerRound) {
      if (!position) return;
      suppressNear(guards, position, radius, amount);
    },
    /**
     * A round landed on this man. He flinches, the squad goes loud, and he
     * knows which way it came from — which is what makes shooting one guard in
     * a pair a real decision rather than a free kill.
     */
    hit(guardOrChar, fromPosition, lethal = false) {
      const g = guards.find((x) => x === guardOrChar || x.ch === guardOrChar || x.id === guardOrChar);
      if (!g) return null;
      if (fromPosition) {
        _v.subVectors(g.ch.position, fromPosition).normalize();
        g.ch.takeHit(_v);
        g.lastSeenAt.copy(fromPosition);
        g.awareness = 1;
        g.awareReason = 'contact';
      }
      // Taking a round is the most suppressing thing that can happen to a man.
      g.suppression = Math.min(1, g.suppression + 0.75);
      if (lethal) {
        g.drop('killed');
        hearNoise(g.ch.position, NOISE.body, 'bodyfall', 0.3);
        if (g === commander) {
          gunfire.kills++;
          squad._emit({ type: 'commander', position: g.ch.position.clone(), from: g.id, kind: 'killed' });
        }
      }
      squad.report('contact', fromPosition ?? g.ch.position, g);
      return g;
    },
    /** Force full AI regardless of game mode (also bound to the H key). */
    setLive(v) { forceLive = !!v; },
    /** Measurement hook: pin `inShadow` true/false, or null for the real ray. */
    setShadowOverride(v) { shadowOverride = v === null || v === undefined ? null : !!v; },
    get inShadow() { return target.inShadow; },
    get live() { return ctx.live; },

    squad,
    navGrid: grid,
    stats,
    /**
     * Where a man's eyes are, and where his visible mass is. Published because
     * every consumer that draws over a soldier — a HUD marker, a probe, an
     * audio emitter — needs one of them, and `position.y` is NOT the answer:
     * a Character's position.y is 0 and its ground is `groundY`.
     */
    eyeOf,
    targetPoint,
    /** Snapshot for probes and the HUD's debug readout. */
    report() {
      return {
        level: squad.level,
        live: ctx.live,
        timer: +squad.timer.toFixed(1),
        lastKnown: squad.hasLastKnown ? squad.lastKnown.toArray().map((v) => +v.toFixed(1)) : null,
        ms: stats.ms,
        msPeak: stats.msPeak,
        bake: grid.stats,
        detection: detection(),
        gunfire: { ...gunfire },
        commander: commander ? {
          id: commander.id,
          down: commander.down,
          state: commander.state,
          calls: commander.calls,
          at: [+commander.ch.position.x.toFixed(1), +commander.ch.position.z.toFixed(1)],
        } : null,
        reserve: { total: reserves.length, committed: reserves.filter((g) => g.committed).length },
        guards: guards.map((g) => ({
          id: g.id,
          role: g.role,
          state: g.state,
          down: g.down,
          aware: +g.awareness.toFixed(3),
          why: g.awareReason,
          sees: g.vis.visible,
          dist: Number.isFinite(g.vis.dist) ? +g.vis.dist.toFixed(1) : null,
          rate: +g.vis.rate.toFixed(3),
          at: [+g.ch.position.x.toFixed(1), +g.ch.position.z.toFixed(1)],
          path: g.path ? g.path.length : 0,
          rounds: g.rounds,
          sup: +g.suppression.toFixed(2),
        })),
      };
    },
    dispose() {
      if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey);
      if (unsubMode) unsubMode();
      debug.dispose();
      const i = engine.systems.indexOf(system);
      if (i >= 0) engine.systems.splice(i, 1);
    },
  };

  world.registry.ai = api;
  return api;
}

// Re-exported for the HUD and for probes: where a man's eyes are, and where his
// visible mass is, are both questions other modules ask; `bakeNavGrid` lets a
// probe rebuild the grid from a subset of the scene, which is how you find out
// WHICH mesh is walling the garrison in.
export { SPEED, AWARE, SIGHT, eyeOf, targetPoint };
export { bakeNavGrid, NavGrid } from './nav.js';
