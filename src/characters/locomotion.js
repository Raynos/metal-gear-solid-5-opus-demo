import * as THREE from 'three';

/**
 * Locomotion state — a blend space, not a clip switcher.
 *
 * Everything downstream (gait phase, stride length, foot lift, torso lean,
 * weapon carry) reads a small set of continuous parameters computed here.
 * There are no discrete "walk clip" / "run clip" objects to cross-fade,
 * because there are no clips: the pose is a function of these numbers, so a
 * character accelerating from idle to sprint is literally one continuous
 * motion rather than three animations dissolved into each other.
 *
 * The parameter space is two axes plus a turn signal:
 *
 *   GAIT AXIS `g` in [0, 3]   0 idle, 1 walk, 2 run, 3 sprint.
 *     Mapped from planar speed by a piecewise-linear curve whose knots are the
 *     speeds a soldier actually moves at. Everything speed-dependent
 *     (cycle length, duty factor, stride, foot lift, torso lean, arm swing,
 *     breathing rate) is a function of `g`, not of raw m/s — which is what
 *     makes crouch-walk and stand-walk share one curve while running at
 *     different absolute speeds.
 *
 *   STANCE AXIS   stand / crouch / prone / down, as three blend weights that
 *     are integrated toward their target with per-transition rates. Standing
 *     up from prone is slower than dropping to a knee, and being tranquillised
 *     is slower still on the way out.
 *
 *   TURN          signed yaw rate, plus a pivot-step generator for
 *     turn-in-place. Below walking speed a character that rotates has to
 *     actually shuffle its feet; sliding the whole body around its own axis is
 *     the second most obvious animation tell after foot sliding.
 *
 * Stance also *caps* speed: a crouched soldier cannot sprint and a prone one
 * cannot walk, so the gait axis is evaluated against a stance-scaled speed.
 * That cap is what stops a caller that sets crouch and 6 m/s from producing a
 * sprint cycle at knee height.
 */

const clamp = THREE.MathUtils.clamp;
const smoothstep = THREE.MathUtils.smoothstep;
const lerp = THREE.MathUtils.lerp;

/** Speeds (m/s) at gait-axis knots 1, 2, 3 while standing. */
export const GAIT_SPEEDS = { walk: 1.45, run: 3.4, sprint: 6.2 };

/** Top speed reachable in each stance, as a fraction of the sprint knot. */
const STANCE_CAP = { stand: 1.0, crouch: 0.36, prone: 0.13, down: 0 };

/** Blend rate (1/s) toward each stance. Asymmetric: down is fast, up is slow. */
const STANCE_RATE = {
  stand: { crouch: 6.0, prone: 3.2, down: 3.4 },
  crouch: { stand: 4.4, prone: 3.6, down: 3.4 },
  prone: { stand: 2.1, crouch: 2.6, down: 3.0 },
  down: { stand: 1.1, crouch: 1.2, prone: 1.4 },
};

/** Cycle length in seconds at each gait knot. */
const CYCLE = [1.30, 1.02, 0.70, 0.54];
/** Stance (both-feet-or-one-foot-down) fraction of the cycle at each knot. */
const DUTY = [0.62, 0.60, 0.46, 0.38];
/** Peak swing-foot clearance in metres at each knot. */
const LIFT = [0.0, 0.062, 0.135, 0.20];

/** Sample a 4-knot curve at gait axis position g. */
function knot(curve, g) {
  const i = Math.min(2, Math.floor(g));
  return lerp(curve[i], curve[i + 1], clamp(g - i, 0, 1));
}

/** Planar speed -> gait axis, piecewise linear through the three knots. */
function speedToGait(s) {
  const { walk, run, sprint } = GAIT_SPEEDS;
  if (s <= 0) return 0;
  if (s < walk) return s / walk;
  if (s < run) return 1 + (s - walk) / (run - walk);
  if (s < sprint) return 2 + (s - run) / (sprint - run);
  return 3;
}

export class Locomotion {
  constructor(anim) {
    this.anim = anim;

    // --- inputs ----------------------------------------------------------
    /** Desired stance: 'stand' | 'crouch' | 'prone' | 'down'. */
    this.stance = 'stand';
    /** World-space velocity the owner wants; magnitude drives the gait axis. */
    this.velocity = new THREE.Vector3();
    /** Set by whoever owns movement; the animator reads it for hip/torso yaw. */
    this.yawRate = 0;

    // --- integrated state -------------------------------------------------
    this.speed = 0;
    this.smoothSpeed = 0;
    this.g = 0;
    this.smoothG = 0;
    this.phase = 0;
    this.stanceBlend = 0; // crouch
    this.proneBlend = 0;
    this.downBlend = 0;
    this._downStance = 0;
    /**
     * Collapse driven by the action layer rather than by a stance request —
     * being tranquillised is something that happens TO a character, on the
     * action layer's timeline, not a stance he asks for. The two paths are
     * max()ed so either can put him on the deck.
     */
    this.forcedDown = 0;
    this.turn = 0;

    // Weights over the four gait poles. Tent functions over `g`, so at most two
    // are non-zero and they always sum to 1 — the property that makes this a
    // blend space rather than an ad-hoc set of independent multipliers.
    this.w = { idle: 1, walk: 0, run: 0, sprint: 0 };

    // Derived per-frame, read by the animator.
    this.cycle = CYCLE[0];
    this.duty = DUTY[0];
    this.stride = 0;
    this.lift = 0;
    this.moving = 0;
    this.run01 = 0;
    this.sprint01 = 0;

    // Turn-in-place pivot stepping.
    this.turnAccum = 0;
    this.pivot = null; // { side, t, dur, fromYaw }
    this.turnLead = 0;
  }

  setStance(s) {
    if (s === 'stand' || s === 'crouch' || s === 'prone' || s === 'down') this.stance = s;
    return this.stance;
  }

  /** Accepts a Vector3, an array, or {x,z}. y is ignored — gait is planar. */
  setVelocity(v) {
    if (!v) {
      this.velocity.set(0, 0, 0);
      return;
    }
    if (Array.isArray(v)) this.velocity.set(v[0] ?? 0, 0, v[2] ?? 0);
    else this.velocity.set(v.x ?? 0, 0, v.z ?? 0);
  }

  /** Top speed the current stance blend allows, in m/s. */
  get speedCap() {
    const cap = lerp(
      lerp(STANCE_CAP.stand, STANCE_CAP.crouch, this.stanceBlend),
      STANCE_CAP.prone,
      this.proneBlend,
    );
    return GAIT_SPEEDS.sprint * lerp(cap, 0, this.downBlend);
  }

  update(dt) {
    // --- stance integration ----------------------------------------------
    const target = this.stance;
    const rateFrom = (cur) => STANCE_RATE[cur]?.[target] ?? 4.0;
    const crouchT = target === 'crouch' ? 1 : 0;
    const proneT = target === 'prone' ? 1 : 0;
    const downT = target === 'down' ? 1 : 0;
    // Rate is chosen by the stance currently dominant, so a prone->stand blend
    // uses the slow "push up off the deck" rate for its whole duration.
    const cur = this.downBlend > 0.5 ? 'down' : this.proneBlend > 0.5 ? 'prone' : this.stanceBlend > 0.5 ? 'crouch' : 'stand';
    const r = Math.min(1, dt * rateFrom(cur));
    this.stanceBlend += (crouchT - this.stanceBlend) * r;
    this.proneBlend += (proneT - this.proneBlend) * r;
    this._downStance += (downT - this._downStance) * r;
    this.downBlend = Math.max(this._downStance, this.forcedDown);

    // --- gait axis ---------------------------------------------------------
    const raw = Math.hypot(this.velocity.x, this.velocity.z);
    this.speed = Math.min(raw, this.speedCap);
    // Acceleration is asymmetric on purpose: mass takes longer to get going
    // than to stop, and a symmetric filter makes every start read as a glide.
    const accel = this.speed > this.smoothSpeed ? 5.5 : 9.0;
    this.smoothSpeed += (this.speed - this.smoothSpeed) * Math.min(1, dt * accel);
    this.g = speedToGait(this.smoothSpeed);
    this.smoothG += (this.g - this.smoothG) * Math.min(1, dt * 9);
    const g = this.smoothG;

    // Tent weights over the four poles.
    const w = this.w;
    w.idle = clamp(1 - g, 0, 1);
    w.walk = clamp(1 - Math.abs(g - 1), 0, 1);
    w.run = clamp(1 - Math.abs(g - 2), 0, 1);
    w.sprint = clamp(g - 2, 0, 1);

    this.cycle = knot(CYCLE, g);
    this.duty = knot(DUTY, g);
    this.lift = knot(LIFT, g);
    this.run01 = smoothstep(g, 1.15, 2.05);
    this.sprint01 = smoothstep(g, 2.1, 2.9);
    this.moving = smoothstep(this.smoothSpeed, 0.06, 0.62);
    this.stride = this.smoothSpeed * this.cycle * this.duty;

    if (this.moving > 0.01 && this.downBlend < 0.5) {
      this.phase = (this.phase + (dt / this.cycle) * this.moving) % 1;
    }

    this._turn(dt);
  }

  /**
   * Turn-in-place. A standing soldier who rotates without stepping is a
   * turntable, and it is very obvious from a third-person camera because the
   * planted foot is the one thing on screen that cannot lie. Accumulate turned
   * angle while stationary; every ~35 degrees, hand one foot to the animator as
   * a pivot step, alternating sides.
   */
  _turn(dt) {
    if (dt <= 0) return;
    this.turn += (this.yawRate - this.turn) * Math.min(1, dt * 8);
    // Shoulders lead the hips into a turn — the anticipation cue that reads as
    // "decided to turn" instead of "was rotated".
    this.turnLead += (clamp(this.turn * 0.35, -0.4, 0.4) - this.turnLead) * Math.min(1, dt * 6);

    const stationary = 1 - this.moving;
    if (this.pivot) {
      this.pivot.t += dt;
      if (this.pivot.t >= this.pivot.dur) this.pivot = null;
      return;
    }
    if (stationary < 0.5 || this.downBlend > 0.3) {
      this.turnAccum *= Math.max(0, 1 - dt * 3);
      return;
    }
    this.turnAccum += this.yawRate * dt;
    if (Math.abs(this.turnAccum) > 0.6) {
      // Lead with the inside foot: turning left pivots on the left.
      const side = this.turnAccum > 0 ? 'L' : 'R';
      this.pivot = { side, t: 0, dur: lerp(0.42, 0.3, this.proneBlend) };
      this.turnAccum -= Math.sign(this.turnAccum) * 0.6;
    }
  }

  /** 0..1 lift for `side` if it is mid pivot step, else 0. */
  pivotLift(side) {
    if (!this.pivot || this.pivot.side !== side) return 0;
    return Math.sin((this.pivot.t / this.pivot.dur) * Math.PI);
  }

  /** Debug/telemetry: the single word a human would call the current gait. */
  get label() {
    if (this.downBlend > 0.5) return 'down';
    const s = this.proneBlend > 0.5 ? 'prone' : this.stanceBlend > 0.5 ? 'crouch' : '';
    const g = this.smoothG;
    const m = g < 0.15 ? 'idle' : g < 1.5 ? 'walk' : g < 2.5 ? 'run' : 'sprint';
    if (!s) return m;
    if (m === 'idle') return `${s}-idle`;
    return s === 'prone' ? 'prone-crawl' : `${s}-${m}`;
  }
}
