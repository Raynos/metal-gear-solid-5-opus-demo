import * as THREE from 'three';

/**
 * Behaviour animation.
 *
 * This is NOT the AI. The AI module decides *what* a guard is doing —
 * patrolling this route, alerted to that noise, taking cover behind that wall —
 * and says so by calling `characters.setBehaviour(actor, state, opts)`. This
 * turns that one word into a body: where the feet go, where the eyes go, when
 * the head sweeps, when a bored man at a post shifts his weight or looks at his
 * watch. Until the AI takes over it also runs by itself, so nobody is ever a
 * statue.
 *
 * The states are deliberately few and the transitions are the AI's business.
 * What matters here is that each one has *texture*: a guard at a post is not
 * holding a single pose for forty seconds, and a guard walking a route stops,
 * looks, and moves off again rather than gliding around a polygon forever.
 *
 * Everything is driven from a per-character deterministic sequence rather than
 * `Math.random()`, so the same shot renders the same garrison every time.
 */

const clamp = THREE.MathUtils.clamp;

/** Per-character deterministic noise stream. */
function stream(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export const BEHAVIOURS = ['idle', 'post', 'patrol', 'scan', 'alert', 'cover', 'downed'];

/** Movement speeds, m/s. */
const SPEED = { patrol: 1.35, advance: 2.4, alert: 4.6, reposition: 3.2 };

export class Behaviour {
  constructor(ch, ground, seed = 1) {
    this.ch = ch;
    this.ground = ground;
    this.rand = stream(seed);
    this.state = 'post';
    this.t = 0;
    this.route = null;
    this.routeIndex = 0;
    this.target = new THREE.Vector3();
    this.hasTarget = false;
    this.homeYaw = ch.yaw;
    this.home = ch.position.clone();

    // Idle variation scheduler.
    this.nextTic = 2 + this.rand() * 5;
    this.tic = null;
    this.ticT = 0;
    this.look = new THREE.Vector3();
    this.lookHold = 0;
    this._turnOff = 0;
    this._lookYaw = ch.yaw;
    this._lookPitch = 0;
    this._resume = null;

    this._v = new THREE.Vector3();
  }

  setState(state, opts = {}) {
    if (!BEHAVIOURS.includes(state)) return this.state;
    if (state !== this.state) {
      this.t = 0;
      this.tic = null;
    }
    this.state = state;
    if (opts.route) {
      this.route = opts.route;
      this.routeIndex = opts.index ?? 0;
    }
    if (opts.target) {
      this.target.copy(opts.target);
      this.hasTarget = true;
    }
    if (opts.yaw !== undefined) this.homeYaw = opts.yaw;
    if (state === 'cover') this.ch.setStance(opts.stance ?? 'crouch');
    if (state === 'patrol' || state === 'alert') this.ch.setStance('stand');
    return this.state;
  }

  update(dt) {
    this.t += dt;
    const ch = this.ch;
    switch (this.state) {
      case 'post': this._post(dt); break;
      case 'patrol': this._patrol(dt); break;
      case 'scan': this._scan(dt); break;
      case 'alert': this._alert(dt); break;
      case 'cover': this._cover(dt); break;
      case 'downed': ch.setLocomotion(null); break;
      default: ch.setLocomotion(null); break;
    }
  }

  // --- states -------------------------------------------------------------

  /**
   * Standing a post. The whole job of this state is that the man is not a
   * statue: a slow head sweep with real holds at the ends, a weight shift, a
   * look at the watch, an occasional scan of his arc. Each tic is a short
   * scheduled event, and between them the animator's own breathing and
   * contrapposto carry the pose.
   */
  _post(dt) {
    const ch = this.ch;
    ch.setLocomotion(null);
    ch.setFacing(this.homeYaw + (this.tic === 'turn' ? this._turnOff : 0));
    this._idleTics(dt);
  }

  _idleTics(dt) {
    const ch = this.ch;
    this.nextTic -= dt;
    if (this.tic) {
      this.ticT -= dt;
      if (this.ticT <= 0) {
        if (this.tic === 'sweep' || this.tic === 'glance') ch.setLookTarget(null);
        this.tic = null;
      }
    } else if (this.nextTic <= 0) {
      const r = this.rand();
      // Weighted so the cheap, frequent ones dominate and the theatrical ones
      // are rare — the opposite reads as a nervous tic every three seconds.
      if (r < 0.34) {
        this.tic = 'glance';
        this.ticT = 1.6 + this.rand() * 1.8;
        this._lookAround(0.9);
      } else if (r < 0.62) {
        this.tic = 'sweep';
        this.ticT = 3.4 + this.rand() * 1.6;
        this._lookAround(1.5);
      } else if (r < 0.76) {
        this.tic = 'watch';
        this.ticT = 2.4;
        ch.playAction('checkWatch');
      } else if (r < 0.9) {
        this.tic = 'turn';
        this.ticT = 2.6 + this.rand() * 2;
        this._turnOff = (this.rand() - 0.5) * 1.5;
      } else {
        this.tic = 'shift';
        this.ticT = 2.0;
      }
      this.nextTic = 3.5 + this.rand() * 5.5;
    }

    // A sweep is a moving look target, not a fixed one: the head travels, which
    // is what makes it read as searching rather than as noticing something.
    if (this.tic === 'sweep') {
      const u = 1 - this.ticT / 5.0;
      const a = this._lookYaw + Math.sin(u * Math.PI * 2) * 1.0;
      this._aimLook(a, this._lookPitch);
    }
  }

  _lookAround(spread) {
    this._lookYaw = this.ch.yaw + (this.rand() - 0.5) * 2 * spread;
    this._lookPitch = (this.rand() - 0.35) * 0.18;
    this._aimLook(this._lookYaw, this._lookPitch);
  }

  _aimLook(yaw, pitch) {
    const ch = this.ch;
    const d = 14;
    this.look.set(
      ch.position.x - Math.sin(yaw) * d,
      (ch.groundY ?? 0) + 1.68 + Math.tan(pitch) * d,
      ch.position.z - Math.cos(yaw) * d,
    );
    ch.setLookTarget(this.look);
  }

  /** Walk the route; stop at each waypoint and scan before moving on. */
  _patrol(dt) {
    const ch = this.ch;
    const route = this.route;
    if (!route || route.length < 2) {
      this._post(dt);
      return;
    }
    const wp = route[this.routeIndex % route.length];
    this._v.set(wp.x - ch.position.x, 0, wp.z - ch.position.z);
    const d = this._v.length();
    if (d < 1.1) {
      // Arrived: hold, look around, then take the next leg.
      this.routeIndex++;
      const next = route[this.routeIndex % route.length];
      this.setState('scan', {});
      this._resume = { route, index: this.routeIndex };
      this._scanFacing = Math.atan2(-(next.x - ch.position.x), -(next.z - ch.position.z));
      this._scanFor = 2.4 + this.rand() * 3.2;
      return;
    }
    this._v.divideScalar(d);
    const yaw = Math.atan2(-this._v.x, -this._v.z);
    ch.setFacing(yaw);
    // Ease into the leg so a patrol starts walking rather than snapping to it.
    const s = SPEED.patrol * Math.min(1, this.t * 1.6) * Math.min(1, d / 1.6 + 0.35);
    ch.setLocomotion(this._v.multiplyScalar(s));
    this._idleTics(dt);
  }

  /** Stop and sweep. The beat that turns a patrol loop into a patrol. */
  _scan(dt) {
    const ch = this.ch;
    ch.setLocomotion(null);
    if (this._scanFacing !== undefined) ch.setFacing(this._scanFacing);
    const dur = this._scanFor ?? 3.0;
    // One full sweep across the arc with a hold at each end.
    const u = clamp(this.t / dur, 0, 1);
    const sweep = Math.sin(u * Math.PI * 2 - Math.PI / 2);
    this._aimLook((this._scanFacing ?? ch.yaw) + sweep * 1.05, -0.03);
    if (this.t >= dur) {
      ch.setLookTarget(null);
      if (this._resume) {
        this.setState('patrol', this._resume);
        this._resume = null;
      } else {
        this.setState('post');
      }
    }
    void dt;
  }

  /** Alerted: run to the target with the weapon up, then hold and search. */
  _alert(dt) {
    const ch = this.ch;
    ch.setStance('stand');
    if (!this.hasTarget) {
      this._post(dt);
      return;
    }
    this._v.set(this.target.x - ch.position.x, 0, this.target.z - ch.position.z);
    const d = this._v.length();
    const yaw = d > 0.3 ? Math.atan2(-this._v.x, -this._v.z) : ch.yaw;
    ch.setFacing(yaw);
    ch.setAimTarget(this.target);
    if (d < 2.0) {
      ch.setLocomotion(null);
      // Arrived and found nothing: sweep the area rather than freezing on the spot.
      this._aimLook(yaw + Math.sin(this.t * 0.9) * 1.1, -0.05);
      return;
    }
    // Weapon comes down for the run-in and back up for the last few metres —
    // nobody sprints with a rifle in their cheek.
    const close = clamp((12 - d) / 8, 0, 1);
    ch.setAimWeight(0.25 + close * 0.75);
    this._v.divideScalar(d).multiplyScalar(d > 9 ? SPEED.alert : SPEED.advance);
    ch.setLocomotion(this._v);
  }

  /** Behind cover: crouched, weapon ready, periodically leaning out to look. */
  _cover(dt) {
    const ch = this.ch;
    if (this.hasTarget) {
      const yaw = Math.atan2(-(this.target.x - ch.position.x), -(this.target.z - ch.position.z));
      // Move to the cover point first if we are not on it yet.
      this._v.set(this.home.x - ch.position.x, 0, this.home.z - ch.position.z);
      const d = this._v.length();
      if (d > 0.9) {
        ch.setStance('stand');
        ch.setFacing(Math.atan2(-this._v.x, -this._v.z));
        ch.setLocomotion(this._v.divideScalar(d).multiplyScalar(SPEED.reposition));
        return;
      }
      ch.setLocomotion(null);
      ch.setFacing(yaw);
      // Peek cycle: down behind cover, then up to look over it, then down.
      const cyc = (this.t % 6.5) / 6.5;
      const up = cyc > 0.45 && cyc < 0.78;
      ch.setStance(up ? 'stand' : 'crouch');
      ch.setAimTarget(this.target);
      ch.setAimWeight(up ? 1 : 0.35);
      return;
    }
    ch.setStance('crouch');
    ch.setLocomotion(null);
    this._idleTics(dt);
  }
}
