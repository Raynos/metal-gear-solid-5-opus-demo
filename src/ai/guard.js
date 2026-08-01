import * as THREE from 'three';
import { AWARE, eyeOf, targetPoint } from './perception.js';

/**
 * One enemy soldier.
 *
 * The guard does not own a mesh — `characters` builds and animates those, and
 * this drives one by setting `controlled = true` on it and calling `drive()`,
 * `setStance()` and `lookAt()`. Everything here is the decision, never the
 * geometry.
 *
 * Two things separate this from the usual "walk at the player" AI:
 *
 *  - the head and the body point at different things. `lookYaw` is what the
 *    perception cone is built from and what `lookAt()` drives, and it sweeps
 *    independently of the direction the man is walking. A patrol that scans
 *    reads as a patrol; a patrol that stares down its own path reads as a
 *    conveyor belt.
 *  - nobody ever knows where the player is. They know where the SQUAD last saw
 *    him, which is a stale position on a blackboard, and they search around it.
 */

const SPEED = { patrol: 1.32, investigate: 2.55, alert: 3.55, search: 2.35, sprint: 4.6 };
const TURN = { walk: 3.2, alert: 6.0 };
/** Head/eye slew, rad/s. Deliberately slow — a snapping head is a turret. */
const LOOK_SLEW = 2.3;

const _v = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _tp = new THREE.Vector3();

let NEXT_ID = 1;

export class Guard {
  constructor(ch, opts = {}) {
    this.id = NEXT_ID++;
    this.ch = ch;
    this.role = opts.role ?? 'sentry';
    this.home = opts.home ? opts.home.clone() : ch.position.clone();
    this.homeYaw = opts.yaw ?? ch.yaw;
    this.route = opts.route ?? null;
    this.routeIndex = opts.routeIndex ?? 0;
    this.routeDir = 1;
    this.postStance = opts.stance ?? 'stand';

    this.state = 'hold';
    this.stateT = 0;
    this.down = false;
    this.awareness = 0;
    this.awareHold = 0;
    this.alerted = false;
    this.vis = { visible: false, rate: 0, dist: Infinity };
    this.lastSeenAt = new THREE.Vector3();
    this.senseAcc = 0;

    /** Fixed per-man offset so eight sentries do not sweep in lockstep. */
    this.phase = (this.id * 2.399963) % (Math.PI * 2);
    this.snapYaw = false;
    this.lookYaw = this.homeYaw;
    this.lookGoal = this.homeYaw;
    this.lookTimer = 0;
    this.scanTimer = 0;

    this.path = null;
    this.pathI = 0;
    this.pathAge = 0;
    this.goal = null;
    this.goalKind = null;
    this.pathPending = false;
    this.stuck = 0;
    this._prevX = ch.position.x;
    this._prevZ = ch.position.z;

    this.partner = null;
    this.talkTimer = 0;
    this.radioTimer = 0;
    this.fireTimer = 0;
    this.repathT = 0;
    this.burst = 0;
    this.coverCrouch = false;
    this.desiredSpeed = 0;
    this.bodyYawGoal = this.homeYaw;
    this.scanFor = 4;
    this.nextState = 'hold';
    this.aimBlend = 0;
    this.speedNow = 0;
    this.bodySeen = new Set();
  }

  get position() { return this.ch.position; }

  // -------------------------------------------------------------- goals ----

  setGoal(kind, point, ctx) {
    this.goalKind = kind;
    this.goal = point ? point.clone() : null;
    this.path = null;
    this.pathI = 0;
    if (this.goal) ctx.requestPath(this);
  }

  clearGoal() {
    this.goal = null;
    this.goalKind = null;
    this.path = null;
    this.pathI = 0;
  }

  /** Distance to the current goal in the XZ plane, or Infinity. */
  goalDist() {
    if (!this.goal) return Infinity;
    return Math.hypot(this.goal.x - this.ch.position.x, this.goal.z - this.ch.position.z);
  }

  // ------------------------------------------------------------- damage ----

  /**
   * Put a man down and keep him down. A tranquillised guard is a body other
   * guards can find, which is why `down` is checked by everyone else's senses.
   */
  drop(kind = 'tranq') {
    if (this.down) return;
    this.down = true;
    this.downKind = kind;
    this.state = 'down';
    this.clearGoal();
    this.ch.setStance('prone');
    this.ch.anim.aim = 0;
    this.ch.anim.lookTarget = null;
    this.awareness = 0;
  }

  // -------------------------------------------------------------- think ----

  think(dt, ctx) {
    this.stateT += dt;
    if (this.down) return;

    const squad = ctx.squad;
    this.alerted = squad.level === 'ALERT' || squad.level === 'EVASION';

    // Positive ID. The meter is full; tell everyone and start shooting.
    if (this.awareness >= AWARE.DETECT && ctx.target) {
      targetPoint(ctx.target.ch, _tp);
      if (this.vis.visible) {
        squad.refresh(_tp, ctx.target.heading);
        if (squad.level !== 'ALERT') {
          squad.report('sight', _tp, this);
          this.radioTimer = 0.9;
        }
      }
    }

    switch (squad.level) {
      case 'ALERT':
        if (this.state !== 'combat' && this.state !== 'radio') this.enter('combat', ctx);
        break;
      case 'EVASION':
        if (this.state !== 'search' && this.state !== 'radio') this.enter('search', ctx);
        break;
      case 'CAUTION':
        if (this.state === 'combat' || this.state === 'search') this.enter('return', ctx);
        break;
      default:
        if (this.state === 'combat' || this.state === 'search') this.enter('return', ctx);
        break;
    }

    // A personal suspicion, below the squad's threshold: go and look, alone.
    if (
      this.awareness >= AWARE.SUSPECT
      && (this.state === 'hold' || this.state === 'patrol' || this.state === 'converse')
    ) {
      this.enter('investigate', ctx, this.lastSeenAt);
      squad.report('notice', this.lastSeenAt, this);
    }

    switch (this.state) {
      case 'hold': this.tickHold(dt, ctx); break;
      case 'patrol': this.tickPatrol(dt, ctx); break;
      case 'converse': this.tickConverse(dt, ctx); break;
      case 'investigate': this.tickInvestigate(dt, ctx); break;
      case 'scan': this.tickScan(dt, ctx); break;
      case 'return': this.tickReturn(dt, ctx); break;
      case 'combat': this.tickCombat(dt, ctx); break;
      case 'search': this.tickSearch(dt, ctx); break;
      case 'radio': this.tickRadio(dt, ctx); break;
      default: this.enter('hold', ctx); break;
    }
  }

  enter(state, ctx, point) {
    if (this.down) return;
    this.state = state;
    this.stateT = 0;
    this.burst = 0;
    switch (state) {
      case 'investigate':
        this.setGoal('investigate', point ?? this.lastSeenAt, ctx);
        this.ch.setStance('stand');
        break;
      case 'scan':
        this.clearGoal();
        this.scanTimer = 0;
        break;
      case 'return':
        this.setGoal('return', this.role === 'patrol' ? this.routePoint() : this.home, ctx);
        break;
      case 'combat':
        this.clearGoal();
        this.ch.setStance('stand');
        break;
      case 'search':
        this.clearGoal();
        break;
      case 'hold':
        this.clearGoal();
        this.ch.setStance(this.postStance);
        break;
      default:
        break;
    }
  }

  routePoint() {
    if (!this.route || !this.route.length) return this.home;
    return this.route[this.routeIndex % this.route.length];
  }

  // --- calm ---------------------------------------------------------------

  /** Standing a post: sweep the arc, shift weight, occasionally chat. */
  tickHold(dt, ctx) {
    this.desiredSpeed = 0;

    if (!ctx.live) {
      // Backdrop mode: menu, and godmode — which is what the screenshot harness
      // drives. Guards hold their posts and never translate, so a shot taken
      // after ten minutes of warm world frames the compound exactly as a shot
      // taken at boot does.
      //
      // The head is a slow two-rate sweep, but ONLY while the engine is running
      // free. `engine.deterministic` is set by `__GAME.settle()` and never
      // cleared, so under the harness the sweep collapses to dead ahead and a
      // sentry's pose stops being a function of how many frames have gone by.
      // A sweeping head would otherwise reintroduce exactly the drift round 6
      // spent a day removing from the post stack.
      const arc = this.role === 'tower' ? 1.15 : 0.62;
      const s = ctx.frozen ? 0
        : Math.sin(ctx.elapsed * 0.21 + this.phase) * 0.68
          + Math.sin(ctx.elapsed * 0.083 + this.phase * 2.3) * 0.32;
      this.lookGoal = this.homeYaw + s * arc;
      this.bodyYawGoal = this.homeYaw + s * arc * 0.3;
      this.snapYaw = true;
      return;
    }

    // A posted sentry turns his head far more than his body.
    this.bodyYawGoal = this.homeYaw + (this.lookGoal - this.homeYaw) * 0.35;
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      // Sentries watch an arc centred on the way they were posted, not a circle.
      const arc = this.role === 'tower' ? 1.7 : 0.85;
      this.lookGoal = this.homeYaw + (ctx.rand() * 2 - 1) * arc;
      this.lookTimer = 1.6 + ctx.rand() * 3.4;
    }
    if (this.role === 'patrol' && this.route) this.enter('patrol', ctx);
    this.maybeConverse(ctx);
  }

  /**
   * Two men who end up near each other with nothing to do will stand and talk.
   * It costs nothing and it is most of what makes a compound read as occupied
   * rather than as eight statues facing outward.
   */
  maybeConverse(ctx) {
    if (ctx.squad.level !== 'CALM' || this.partner || this.talkTimer > 0) return;
    if (ctx.rand() > 0.004) return;
    for (const other of ctx.guards) {
      if (other === this || other.down || other.partner) continue;
      if (other.state !== 'hold' && other.state !== 'patrol') continue;
      const d = Math.hypot(other.ch.position.x - this.ch.position.x, other.ch.position.z - this.ch.position.z);
      if (d > 5.5 || d < 0.8) continue;
      this.partner = other;
      other.partner = this;
      this.enter('converse', ctx);
      other.enter('converse', ctx);
      this.talkTimer = other.talkTimer = 7 + ctx.rand() * 9;
      return;
    }
  }

  tickConverse(dt, ctx) {
    this.desiredSpeed = 0;
    this.talkTimer -= dt;
    const p = this.partner;
    if (!p || p.down || this.talkTimer <= 0 || ctx.squad.level !== 'CALM') {
      if (p) { p.partner = null; if (p.state === 'converse') p.enter('hold', ctx); }
      this.partner = null;
      this.talkTimer = 4 + ctx.rand() * 8; // cooldown before the next chat
      this.enter(this.role === 'patrol' ? 'patrol' : 'hold', ctx);
      return;
    }
    const yaw = Math.atan2(-(p.ch.position.x - this.ch.position.x), -(p.ch.position.z - this.ch.position.z));
    this.bodyYawGoal = yaw;
    // Not a staring contest: the eyeline wanders off and comes back.
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookGoal = yaw + (ctx.rand() * 2 - 1) * 0.7;
      this.lookTimer = 0.8 + ctx.rand() * 2.2;
    }
  }

  tickPatrol(dt, ctx) {
    if (!ctx.live || !this.route) { this.enter('hold', ctx); return; }
    if (!this.goal || this.goalKind !== 'patrol') this.setGoal('patrol', this.routePoint(), ctx);
    this.desiredSpeed = SPEED.patrol;
    // Look ahead, but sweep across the line of march.
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookGoal = this.ch.yaw + (ctx.rand() * 2 - 1) * 1.25;
      this.lookTimer = 1.4 + ctx.rand() * 2.6;
    }
    if (this.goalDist() < 2.0) {
      this.routeIndex = (this.routeIndex + 1) % this.route.length;
      // Stop and scan at roughly every third waypoint: a patrol that never
      // stops is a train, and a stopping patrol is what makes timing matter.
      if (ctx.rand() < 0.34) {
        this.enter('scan', ctx);
        this.scanFor = 3 + ctx.rand() * 4;
        this.nextState = 'patrol';
      } else {
        this.setGoal('patrol', this.routePoint(), ctx);
      }
    }
    if (ctx.live) this.maybeConverse(ctx);
  }

  tickScan(dt, ctx) {
    this.desiredSpeed = 0;
    this.scanTimer += dt;
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      // A scan at the end of an investigation is a full 360; a scan at a patrol
      // waypoint is a glance up and down the wall line.
      const wide = this.nextState === 'patrol' ? 1.5 : 2.6;
      this.lookGoal = this.ch.yaw + (ctx.rand() * 2 - 1) * wide;
      this.lookTimer = 0.9 + ctx.rand() * 1.6;
    }
    this.bodyYawGoal = this.lookGoal * 0.35 + this.ch.yaw * 0.65;
    if (this.scanTimer > (this.scanFor ?? 4)) {
      this.enter(this.nextState ?? (this.role === 'patrol' ? 'patrol' : 'return'), ctx);
    }
  }

  tickReturn(dt, ctx) {
    this.desiredSpeed = SPEED.patrol * 1.15;
    if (!this.goal) {
      this.enter(this.role === 'patrol' && ctx.live ? 'patrol' : 'hold', ctx);
      return;
    }
    if (this.goalDist() < 1.6 || this.stateT > 40) {
      this.clearGoal();
      this.enter(this.role === 'patrol' && ctx.live ? 'patrol' : 'hold', ctx);
    }
  }

  // --- suspicion ----------------------------------------------------------

  tickInvestigate(dt, ctx) {
    this.desiredSpeed = SPEED.investigate;
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookGoal = this.ch.yaw + (ctx.rand() * 2 - 1) * 0.9;
      this.lookTimer = 0.7 + ctx.rand() * 1.3;
    }
    if (!this.goal || this.goalDist() < 2.2 || this.stateT > 26) {
      this.enter('scan', ctx);
      this.scanFor = 4.5 + ctx.rand() * 3.5;
      this.nextState = 'return';
    }
  }

  // --- combat -------------------------------------------------------------

  tickCombat(dt, ctx) {
    const squad = ctx.squad;
    const seen = this.vis.visible && ctx.target && !ctx.target.down;
    this.ch.setStance(this.coverCrouch ? 'crouch' : 'stand');
    this.repathT -= dt;

    if (seen) {
      targetPoint(ctx.target.ch, _tp);
      this.bodyYawGoal = Math.atan2(-(_tp.x - this.ch.position.x), -(_tp.z - this.ch.position.z));
      this.lookGoal = this.bodyYawGoal;
      this.aimWant = 1;
      this.aimAt = _tp.clone();
      const d = Math.hypot(_tp.x - this.ch.position.x, _tp.z - this.ch.position.z);
      if (d > 30) {
        // Too far to shoot usefully: close, re-pathing as the target moves.
        this.desiredSpeed = SPEED.alert;
        if (!this.goal || this.goalKind !== 'push' || this.repathT <= 0) {
          this.setGoal('push', _tp, ctx);
          this.repathT = 1.4;
        }
      } else if (this.goalKind !== 'cover') {
        // In range. Get behind something rather than standing in the open.
        const cov = this.pickCover(ctx, _tp);
        if (cov) {
          this.setGoal('cover', cov, ctx);
          this.desiredSpeed = SPEED.alert;
        } else {
          this.desiredSpeed = 0;
          this.clearGoal();
          this.coverCrouch = d < 20;
        }
      } else if (this.goalDist() < 1.4) {
        this.desiredSpeed = 0;
        this.coverCrouch = true;
      } else {
        this.desiredSpeed = SPEED.alert;
      }
      this.fire(dt, ctx, _tp, d);
      return;
    }

    // No eyes on. Converge on where the squad last had him.
    this.aimWant = 0.55;
    this.coverCrouch = false;
    this.desiredSpeed = SPEED.alert;
    if (squad.hasLastKnown) {
      if (!this.goal || this.goalKind !== 'converge' || this.repathT <= 0) {
        this.setGoal('converge', squad.lastKnown, ctx);
        this.repathT = 2.5;
      }
      if (this.goalDist() < 3.5) this.enter('search', ctx);
    } else {
      this.desiredSpeed = 0;
      this.lookTimer -= dt;
      if (this.lookTimer <= 0) {
        this.lookGoal = this.ch.yaw + (ctx.rand() * 2 - 1) * 2.4;
        this.lookTimer = 0.6 + ctx.rand() * 1.2;
      }
    }
  }

  /**
   * Nearest published cover point that is (a) close enough to be worth walking
   * to, (b) not further from the enemy than we already are, and (c) actually
   * between us and him. Without (c) a guard cheerfully takes cover on the wrong
   * side of a container.
   */
  pickCover(ctx, toward) {
    const pts = ctx.coverPoints;
    if (!pts || !pts.length) return null;
    const px = this.ch.position.x;
    const pz = this.ch.position.z;
    let best = null;
    let bestScore = -Infinity;
    const tdx = toward.x - px;
    const tdz = toward.z - pz;
    const tlen = Math.hypot(tdx, tdz) || 1;
    for (const c of pts) {
      const p = c.position;
      const dx = p.x - px;
      const dz = p.z - pz;
      const d = Math.hypot(dx, dz);
      if (d > 15 || d < 1.2) continue;
      const forward = (dx * tdx + dz * tdz) / (tlen * d);
      if (forward < -0.2) continue;
      const dEnemy = Math.hypot(p.x - toward.x, p.z - toward.z);
      if (dEnemy < 7) continue;
      const score = forward * 6 - d * 0.4 + Math.min(c.radius ?? 1, 3);
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (!best) return null;
    // Stand on the far side of it from the enemy, not on top of it.
    const ox = (best.x - toward.x) / (Math.hypot(best.x - toward.x, best.z - toward.z) || 1);
    const oz = (best.z - toward.z) / (Math.hypot(best.x - toward.x, best.z - toward.z) || 1);
    const gx = best.x + ox * 1.1;
    const gz = best.z + oz * 1.1;
    if (!ctx.grid.walkable(gx, gz)) return best.clone();
    return new THREE.Vector3(gx, ctx.grid.heightAt(gx, gz), gz);
  }

  fire(dt, ctx, at, dist) {
    this.fireTimer -= dt;
    if (this.aimBlend < 0.85) return;
    if (this.fireTimer > 0) return;
    if (this.burst > 0) {
      this.burst--;
      this.fireTimer = 0.11;
      ctx.onFire(this, at, dist);
    } else {
      this.burst = 2 + Math.floor(ctx.rand() * 3);
      this.fireTimer = 0.7 + ctx.rand() * 1.4;
    }
  }

  tickSearch(dt, ctx) {
    this.desiredSpeed = SPEED.search;
    this.aimWant = 0.45;
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookGoal = this.ch.yaw + (ctx.rand() * 2 - 1) * 1.7;
      this.lookTimer = 0.6 + ctx.rand() * 1.4;
    }
    if (!this.goal || this.goalDist() < 2.4 || this.stateT > 22) {
      const p = ctx.squad.claimSearchPoint(ctx.grid, this);
      if (p) {
        this.setGoal('search', p, ctx);
        this.stateT = 0;
      } else {
        this.desiredSpeed = 0;
      }
    }
  }

  tickRadio(dt, ctx) {
    this.desiredSpeed = 0;
    this.radioTimer -= dt;
    if (this.radioTimer <= 0) this.enter(ctx.squad.level === 'ALERT' ? 'combat' : 'return', ctx);
  }

  // -------------------------------------------------------------- apply ----

  /**
   * Turn the decision into character input. Steering follows the path corner by
   * corner with a look-ahead; there is no raycast-steering anywhere, which is
   * why the guards walk lines instead of bouncing off walls.
   */
  apply(dt, ctx) {
    const ch = this.ch;
    if (this.down) {
      ch.anim.speed = 0;
      return;
    }

    let speed = this.desiredSpeed ?? 0;
    let yaw = this.bodyYawGoal ?? ch.yaw;

    if (this.goal) {
      const node = this.pathNode();
      if (node) {
        _v.set(node.x - ch.position.x, 0, node.z - ch.position.z);
        const d = _v.length();
        if (d < 1.1 && this.path && this.pathI < this.path.length - 1) {
          this.pathI++;
        } else if (d > 0.05) {
          yaw = Math.atan2(-_v.x, -_v.z);
          // Ease off on the last metre so an arrival is not a hard stop.
          speed = Math.min(speed, Math.max(0.35, d * 1.6));
        }
      }
      // Stuck detection: a guard who has not moved while trying to is on a
      // corner the string-pull cut too close. Re-path rather than grind.
      // `speedNow` is last frame's applied speed, which is the one that should
      // have produced the movement being measured — using this frame's desired
      // speed instead counts every turn-in-place as being stuck.
      const moved = Math.hypot(ch.position.x - this._prevX, ch.position.z - this._prevZ);
      if (this.speedNow > 0.4 && moved < 0.004) this.stuck += dt;
      else this.stuck = Math.max(0, this.stuck - dt);
      if (this.stuck > 0.7) { this.stuck = 0; ctx.requestPath(this); }
    }
    this._prevX = ch.position.x;
    this._prevZ = ch.position.z;

    // Separation. Cheap, O(neighbours) and only against guards already near.
    if (speed > 0.05 || ctx.squad.level !== 'CALM') {
      for (const o of ctx.guards) {
        if (o === this || o.down) continue;
        const dx = ch.position.x - o.ch.position.x;
        const dz = ch.position.z - o.ch.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 1.44 || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (1.2 - d) * dt * 1.6;
        ch.position.x += (dx / d) * push;
        ch.position.z += (dz / d) * push;
      }
    }

    if (this.snapYaw) {
      // Backdrop mode: assign rather than filter, so the pose is a function of
      // the clock alone and carries no state across frames. See tickHold.
      this.snapYaw = false;
      ch.yaw = yaw;
      this.lookYaw = this.lookGoal;
      this.speedNow = 0;
      ch.drive(dt, 0, undefined);
    } else {
      const turn = ctx.squad.level === 'CALM' ? TURN.walk : TURN.alert;
      let dy = yaw - ch.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      // Do not walk sideways: a guard turns first, then moves off.
      const facing = 1 - THREE.MathUtils.clamp(Math.abs(dy) / 1.4, 0, 1) * 0.85;
      ch.yaw += dy * Math.min(1, dt * turn);
      this.speedNow = speed * facing;
      ch.drive(dt, this.speedNow, undefined);

      // Head. `lookYaw` is what perception uses, so this slew is not cosmetic:
      // it is why a guard who has just turned away cannot see behind himself.
      let dl = this.lookGoal - this.lookYaw;
      dl = Math.atan2(Math.sin(dl), Math.cos(dl));
      this.lookYaw += dl * Math.min(1, dt * LOOK_SLEW);
    }
    eyeOf(ch, _eye);
    ch.anim.lookTarget = (ch.anim.lookTarget ?? new THREE.Vector3()).set(
      _eye.x - Math.sin(this.lookYaw) * 14,
      _eye.y - (this.state === 'combat' ? 0.1 : 0),
      _eye.z - Math.cos(this.lookYaw) * 14,
    );

    const want = this.aimWant ?? (this.awareness > AWARE.NOTICE ? 0.35 : 0.1);
    if (ctx.live) this.aimBlend += (want - this.aimBlend) * Math.min(1, dt * 3.2);
    else this.aimBlend = want;
    ch.anim.aim = this.aimBlend;
    if (this.aimAt) ch.anim.aimTarget.copy(this.aimAt);
    else {
      ch.anim.aimTarget.set(
        ch.position.x - Math.sin(this.lookYaw) * 20,
        (ch.anim.groundY ?? ch.position.y) + 1.4,
        ch.position.z - Math.cos(this.lookYaw) * 20,
      );
    }
    this.aimWant = undefined;
    this.aimAt = null;
  }

  pathNode() {
    if (this.path && this.pathI < this.path.length) return this.path[this.pathI];
    return this.goal;
  }
}

export { SPEED };
