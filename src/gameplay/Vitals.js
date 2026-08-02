import * as THREE from 'three';

/**
 * Vitals — the player can be hurt, and the player can die.
 *
 * Before this the garrison could shoot at you all day: `registry.gameplay` had
 * no health field at all, so the HUD's damage vignette never fired, the AI's
 * `onGuardFire` had no subscriber, and the only way a run could end was the
 * player closing the tab.
 *
 * THE MODEL IS MGSV'S, which is regenerating health with no bar:
 *   - a rifle round costs ~16% and staggers; five or six put you down
 *   - nothing regenerates for REGEN_DELAY seconds after the last hit, and the
 *     delay is what makes breaking contact a decision rather than a formality
 *   - after that it comes back over ~7 s, so a fight you walk away from is
 *     survivable and a fight you stay in is not
 *   - the only feedback is at the edge of the frame; that is src/ui's job and
 *     it reads `health` off the registry, which is the entire contract here
 *
 * WHETHER A ROUND HITS is decided here and not in src/ai, deliberately: the AI
 * publishes where a man aimed and how badly (`{from, at, spread, dist}`) and
 * says in its own comment that "whether anything is hit is gameplay's
 * decision". So this samples that cone once per shot and intersects the result
 * with the player's capsule. The consequences fall out of the stealth model for
 * free — prone is a smaller target, distance widens the cone, and a guard
 * firing at a last-known position you have already left cannot hit you at all.
 */

const MAX = 1;
const REGEN_DELAY = 4.0;      // seconds of not being shot before it starts
const REGEN_RATE = 0.145;     // per second, i.e. ~7 s from nothing to full
const HIT_GRACE = 0.12;       // no two rounds may land inside this
const ROUND_DAMAGE = 0.16;

/** Torso radius by stance: what a rifle round has to be inside to count. */
const HIT_RADIUS = { stand: 0.42, crouch: 0.36, prone: 0.30 };
/** Where the centre of mass is above the feet, by stance. */
const HIT_HEIGHT = { stand: 1.12, crouch: 0.78, prone: 0.22 };

/** A shot aimed further than this from the player is suppressive fire. */
const MISS_BY_DESIGN = 9.0;

/** Below this landing speed a drop is free; above it, it hurts. */
const FALL_FLOOR = 13.0;
const FALL_SCALE = 0.055;

export class Vitals {
  /**
   * @param {object} opts
   *   controller  PlayerController — position, stance, landing speed
   *   character   the player Character, for the flinch
   *   events      the gameplay event bus
   *   rand        () => 0..1
   */
  constructor({ controller, character, events, rand }) {
    this.ctl = controller;
    this.ch = character;
    this.events = events;
    this.rand = rand ?? Math.random;

    this.health = MAX;
    this.maxHealth = MAX;
    this.dead = false;
    /** Seconds since the last time anything hurt. */
    this.sinceHit = 99;
    /** 0..1, decays over ~0.6 s. Drives the flinch and anything else that wants it. */
    this.shock = 0;
    /** How many rounds have landed this run. */
    this.hits = 0;

    this._grace = 0;
    this._dir = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._q = new THREE.Vector3();
  }

  reset() {
    this.health = MAX;
    this.dead = false;
    this.sinceHit = 99;
    this.shock = 0;
    this.hits = 0;
    this._grace = 0;
  }

  update(dt) {
    this.sinceHit += dt;
    this._grace = Math.max(0, this._grace - dt);
    this.shock = Math.max(0, this.shock - dt / 0.6);
    if (this.dead) return;

    if (this.sinceHit > REGEN_DELAY && this.health < MAX) {
      this.health = Math.min(MAX, this.health + REGEN_RATE * dt);
    }

    // A fall costs something. The threshold is well clear of a kerb or a
    // sandbag step; it is the drop off the tower walkway that hurts.
    const land = this.ctl.landingSpeed;
    if (land > 0) {
      this.ctl.landingSpeed = 0;
      if (land > FALL_FLOOR) this.damage((land - FALL_FLOOR) * FALL_SCALE, null, 'fall');
    }
  }

  /**
   * Apply damage. `from` is a world position, used for the flinch direction and
   * for anything that wants to know where it came from.
   */
  damage(amount, from = null, cause = 'gunfire') {
    if (this.dead || amount <= 0) return 0;
    if (cause === 'gunfire' && this._grace > 0) return 0;
    this._grace = HIT_GRACE;
    this.sinceHit = 0;
    this.shock = Math.min(1, this.shock + amount * 3.4);
    this.hits++;
    const before = this.health;
    this.health = Math.max(0, this.health - amount);

    if (from) {
      this._dir.set(this.ctl.position.x - from.x, 0, this.ctl.position.z - from.z);
      if (this._dir.lengthSq() > 1e-6) this._dir.normalize();
      else this._dir.set(0, 0, 1);
      this.ch.takeHit?.(this._dir);
    }
    this.events?.emit({ type: 'damage', amount: before - this.health, health: this.health, cause, from });

    if (this.health <= 0) {
      this.dead = true;
      this.events?.emit({ type: 'death', cause, from });
    }
    return before - this.health;
  }

  /**
   * Resolve one round fired by a guard: `{from, at, spread, dist}` exactly as
   * src/ai publishes it.
   *
   * The cone is sampled with two uniforms rather than a gaussian on purpose —
   * a gaussian tail means a man at 60 m occasionally lands a round he had no
   * business landing, and the player cannot tell that from a bug.
   */
  resolveShot(ev) {
    if (this.dead || !ev?.from || !ev?.at) return null;
    const stance = this.ctl.stance;
    const p = this._p.set(this.ctl.position.x, this.ctl.footY + HIT_HEIGHT[stance], this.ctl.position.z);

    // Firing at a last-known position the player has left is suppressive fire
    // and can never connect. This is the whole reward for breaking line of
    // sight, so it is checked before anything random happens.
    if (this._q.copy(ev.at).distanceTo(p) > MISS_BY_DESIGN) return null;

    // Aim direction, perturbed inside the cone the AI reported.
    this._dir.copy(ev.at).sub(ev.from);
    const dist = this._dir.length();
    if (dist < 1e-3) return null;
    this._dir.multiplyScalar(1 / dist);
    const a = this.rand() * Math.PI * 2;
    const r = Math.sqrt(this.rand()) * ev.spread;
    // Any two axes perpendicular to the shot line will do for the offset.
    const ux = -this._dir.z;
    const uz = this._dir.x;
    const ul = Math.hypot(ux, uz) || 1;
    this._dir.x += (ux / ul) * Math.cos(a) * r;
    this._dir.z += (uz / ul) * Math.cos(a) * r;
    this._dir.y += Math.sin(a) * r;
    this._dir.normalize();

    // Closest approach of that ray to the player's centre of mass.
    this._q.copy(p).sub(ev.from);
    const along = this._q.dot(this._dir);
    if (along <= 0) return null;
    const miss = Math.sqrt(Math.max(0, this._q.lengthSq() - along * along));
    if (miss > HIT_RADIUS[stance]) {
      this.events?.emit({ type: 'nearMiss', miss, from: ev.from });
      return null;
    }

    // A round through the edge of the silhouette does less than one through the
    // middle, which stops every exchange resolving in identical 16% steps.
    const solid = 1 - 0.45 * (miss / HIT_RADIUS[stance]);
    return this.damage(ROUND_DAMAGE * solid, ev.from, 'gunfire');
  }
}

export { REGEN_DELAY, ROUND_DAMAGE, HIT_RADIUS };
