import * as THREE from 'three';

/**
 * The stealth verbs — the things that make this MGSV rather than a walk cycle.
 *
 *   aim          hold, shoulders the weapon and slows the body
 *   steady       hold while aiming, kills the sway until the breath runs out
 *   fire         a tranquilliser dart: slow, silent, and it DROPS
 *   cqc          tap behind an unaware guard to put him down, hold to grab him
 *   drag         pick a downed body up and move it
 *   stow         drop a body out of sight next to cover
 *   cover        press flat against a wall, then aim to peek round it
 *
 * Every one of them has three parts, and all three are required for the verb to
 * exist as far as the rest of the game is concerned: an input, an animation
 * state the characters module can read off the character, and an effect the AI
 * can see. A takedown that only plays an animation is a cutscene.
 *
 * The AI contract is deliberately data on the character object, not a callback:
 *   ch.downed        true once he is out; senses and patrol must stop
 *   ch.tranquillised the dart did it (he wakes up); vs a CQC choke
 *   ch.held          the player has him in a CQC hold
 *   ch.hidden        stowed out of sight; a searching guard must not find him
 *   ch.controlled    already used by src/characters to mean "somebody else
 *                    drives this one" — set alongside the above so the idle
 *                    patrol lets go.
 */

const DART_SPEED = 62;        // m/s. A tranquilliser dart is slow and it drops.
const DART_GRAVITY = 9.81;
const DART_LIFE = 1.6;        // seconds of flight before it is spent

/**
 * Cyclic rate, seconds per round. WAS 0.42, and that single number made both
 * fire modes feel broken: measured with the trigger held for 2.0 s,
 * `probes/r12_aim.js` reported SEMI 1 round and AUTO 5, i.e. 150 RPM. AUTO at
 * 150 RPM is not automatic fire — it is SEMI with the clicking done for you —
 * and because 0.42 s is also exactly the recoil settle time, a burst never
 * accumulated any muzzle rise at all (peak kick over 3 s of continuous fire:
 * 1.00x a single shot). The same cap also throttled SEMI, so a player clicking
 * faster than 2.4 Hz had rounds silently swallowed with no cue of any kind.
 *
 * 0.15 s is 400 RPM. SEMI still needs a fresh press per round, so its real
 * cadence is the player's click rate with a mechanical ceiling; AUTO is now
 * fast enough that the kick stacks about three deep before the spring catches
 * up, which is the entire point of having automatic fire.
 */
const FIRE_INTERVAL = 0.15;

/**
 * Recoil impulse, radians/second into the camera's kick spring.
 *
 * The old value was 0.30 with a comment claiming "about 1.8 degrees of muzzle
 * rise". IT WAS 0.81 DEGREES — measured off `PlayerCamera._kick` frame by frame
 * in `probes/r12_aim.js`, peak 0.81 deg at t=0.117 s. The comment derived the
 * figure from amplitude x omega, which is the peak VELOCITY, not the peak
 * angle. So the kick was less than half what its author believed he had
 * written, on a camera whose aimed half-height is 16.5 degrees: 0.81 degrees is
 * 26 px of a 1080 px frame, under a reticle that was itself moving further than
 * that from sway alone.
 *
 * The lateral term is new. A kick that is pure pitch is the same gesture every
 * single round and the eye reads it as the camera bobbing rather than as a
 * weapon moving; alternating the sign per round is what makes a burst draw a
 * shape instead of a line.
 */
const RECOIL_PITCH = 0.62;
const RECOIL_YAW = 0.30;

/** Nothing is under the sight: converge the aim on a point this far out. */
const CONVERGE_FAR = 180;
/** Seconds of smoothing on the convergence range. See `_solveConverge`. */
const CONVERGE_TAU = 0.07;

/**
 * The weapon.
 *
 * A magazine of 6 reads as a revolver, and it is the number the HUD would have
 * put on screen. This is a suppressed tranquilliser CARBINE — MGSV's own
 * starting non-lethal weapon is a rifle — so it carries a rifle magazine and a
 * reserve, and both are published so the HUD's `ammo / reserve` block has
 * something to say. The ballistics below are unchanged: it still fires a slow
 * dart that drops, which is what makes range a decision.
 */
const WEAPON = {
  name: 'AM MRS-4 TRQ',
  mag: 20,
  reserve: 100,
  // 2.40 s, and that number is not a feel choice: it is the authored length of
  // the `reload` clip in src/characters/actions.js. The two used to be
  // independent — a 2.35 s timer against a 2.40 s animation — so the magazine
  // refilled while the character was still seating it, and a player mashing
  // fire on the refill saw the weapon fire out of the reload pose. The timer
  // now IS the animation, and `reload()` starts both from this one value.
  reloadTime: 2.40,
  modes: ['SEMI', 'AUTO'],
  suppressed: true,
};

/**
 * Hand bone to muzzle, in metres, for a character that publishes no weapon
 * anchors at all. See `muzzleReach()` — the real figure is read off the model.
 */
const MUZZLE_FALLBACK = 0.46;

const CQC_RANGE = 1.85;
const CQC_HOLD = 0.25;        // hold longer than this and it is a grab, not a takedown
const DRAG_RANGE = 1.6;
const STOW_RANGE = 2.6;

const BREATH_DRAIN = 1 / 4.2;   // a full lungful lasts 4.2 s
const BREATH_RECOVER = 1 / 3.0;

/**
 * Base sway half-angle by stance, radians. These are the numbers that were
 * already here; what changed is everything that scales them.
 */
const SWAY_STANCE = { stand: 0.0105, crouch: 0.006, prone: 0.0035 };
/** Sway multiplier added per metre/second of travel. A 5.4 m/s run doubles it. */
const SWAY_PER_SPEED = 0.185;
/** Sway multiplier one round adds, and how fast it bleeds off. */
const SWAY_PER_SHOT = 0.85;
const SWAY_BLOOM_TAU = 0.30;
/** However many rounds go downrange, the cone stops opening here. */
const SWAY_BLOOM_MAX = 2.6;

export class StealthActions {
  constructor({ controller, camera, characters, obstacles, ground, coverPoints, events, ai }) {
    this.ctl = controller;
    this.cam = camera;
    this.characters = characters;      // every character, player included
    this.player = controller.ch;
    /** src/ai, when it is installed. Every verb degrades cleanly without it. */
    this.ai = ai ?? null;
    this.obstacles = obstacles;
    this.ground = ground;
    this.coverPoints = coverPoints ?? [];
    this.events = events;

    this.isAiming = false;
    this.aimAmount = 0;
    this.breath = 1;
    this.breathLocked = false;
    this.ammo = WEAPON.mag;
    this.reserve = WEAPON.reserve;
    this.magSize = WEAPON.mag;
    this.reloading = 0;
    /** Seconds the current reload started from — the HUD wants the fraction. */
    this.reloadTime = WEAPON.reloadTime;
    this.fireMode = WEAPON.modes[0];
    this._fireCooldown = 0;
    this._cqcHeld = 0;
    /** Cached trace for the reticle: {dist, character, point} or null. */
    this.aimHit = null;
    this._predictT = 0;

    /** 'none' | 'takedown' | 'grab' | 'drag' | 'cover' */
    this.action = 'none';
    this.actionTimer = 0;
    this.grabbed = null;
    this.dragging = null;
    this.inCover = false;
    this.coverNormal = new THREE.Vector2();
    this.coverTangent = new THREE.Vector2();
    this.lean = 0;

    this.aimPoint = new THREE.Vector3();
    this.aimSway = new THREE.Vector2();
    this._swayT = Math.random() * 20;
    /** Current sway half-angle in radians — what the reticle draws. */
    this.swayAngle = SWAY_STANCE.stand;
    /** Firing bloom, in multiples of the stance amplitude. Decays. */
    this.bloom = 0;
    /** Range the aim ray is convergent on, metres. See `_solveConverge`. */
    this.convergeRange = CONVERGE_FAR;
    /** Where the reticle goes: the round's position at `convergeRange`. */
    this.sightPoint = new THREE.Vector3();
    this._hasL = false;
    this._recoilSide = 1;
    this._v = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._ao = new THREE.Vector3();
    this._ad = new THREE.Vector3();
    this._mz = new THREE.Vector3();
    this._lk = new THREE.Vector3();
    this._lp = new THREE.Vector3();
    this._rt = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._cand = [];
    this._n = new THREE.Vector2();
  }

  // -------------------------------------------------------------- per frame --

  /**
   * Returns the movement constraints the controller has to honour this frame.
   * Actions own the body during a takedown; locomotion does not get a vote.
   */
  update(dt, input, camYaw) {
    this._swayT += dt;
    this._fireCooldown = Math.max(0, this._fireCooldown - dt);
    this.bloom *= Math.exp(-dt / SWAY_BLOOM_TAU);
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) this._finishReload();
    }

    const cmd = { frozen: false, lockAxis: null, faceYaw: undefined, aiming: false };

    // --- committed actions run to completion -------------------------------
    if (this.actionTimer > 0) {
      this.actionTimer -= dt;
      cmd.frozen = true;
      if (this.actionTimer <= 0 && this.action === 'takedown') this.action = 'none';
      this._writeAnim();
      return cmd;
    }

    // --- cover --------------------------------------------------------------
    this._updateCover(dt, input, camYaw, cmd);

    // --- aim ----------------------------------------------------------------
    const canAim = !this.grabbed && !this.dragging && this.reloading <= 0.0;
    this.isAiming = canAim && input.down('aim');
    if (this.isAiming) {
      cmd.aiming = true;
      if (this.inCover) {
        // Peeking: lean out of cover so the muzzle clears it. Which way is the
        // player's own choice — the lateral stick — defaulting to the side the
        // camera is already over.
        this.lean = Math.abs(input.move.x) > 0.25 ? Math.sign(input.move.x) : this.cam.shoulder;
      }
    } else if (this.inCover) {
      this.lean = 0;
    }
    this.aimAmount += ((this.isAiming ? 1 : 0) - this.aimAmount) * (1 - Math.exp(-dt / 0.10));
    // Where the optical axis actually lands, before anything reads the aim ray
    // this frame. Every consumer — the trace, the reticle, the animation
    // channels — has to agree on one convergence or they draw three answers.
    // Only while the weapon is up: the march is 45 us and there is nothing on a
    // hip frame that reads it (`_writeAnim` uses the free-look path below 0.01).
    if (this.aimAmount > 0.01) this._solveConverge(dt);
    else this._hadConverge = false;

    // --- breath -------------------------------------------------------------
    const holding = this.isAiming && input.down('steady') && !this.breathLocked && this.breath > 0;
    if (holding) {
      this.breath = Math.max(0, this.breath - BREATH_DRAIN * dt);
      if (this.breath === 0) this.breathLocked = true;
    } else {
      this.breath = Math.min(1, this.breath + BREATH_RECOVER * dt);
      if (this.breath > 0.55) this.breathLocked = false;
    }
    this.holdingBreath = holding;

    // --- weapon -------------------------------------------------------------
    if (input.pressed('reload')) this.reload();
    if (input.pressed('fireMode')) this.cycleFireMode();
    // SEMI needs a fresh press per round; AUTO runs off the held key. The old
    // code only ever read `down`, so the weapon was permanently automatic and
    // the published fire mode would have been a lie.
    const trigger = this.fireMode === 'AUTO' ? input.down('fire') : input.pressed('fire');
    if (this.isAiming && trigger && this._fireCooldown <= 0) this.fire();
    this._predict(dt);

    // --- CQC ----------------------------------------------------------------
    this._updateCqc(dt, input, cmd);

    // --- bodies -------------------------------------------------------------
    this._updateDrag(dt, input, cmd);

    this._writeAnim();
    return cmd;
  }

  // ------------------------------------------------------------------ cover --

  _updateCover(dt, input, camYaw, cmd) {
    const p = this.ctl.position;
    if (this.inCover) {
      cmd.lockAxis = { x: this.coverTangent.x, z: this.coverTangent.y };
      // Back to the wall when still. Moving, the body turns up to 49 degrees
      // into the direction of travel — the animator's gait always walks along
      // the character's own -Z, so a pure sidestep is a pure foot slide, and
      // splitting the difference halves it while still reading as cover.
      let face = Math.atan2(-this.coverNormal.x, -this.coverNormal.y);
      if (this.ctl.speed > 0.3) {
        const travel = Math.atan2(-this.ctl.velocity.x, -this.ctl.velocity.z);
        let d = travel - face;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        face += THREE.MathUtils.clamp(d, -0.85, 0.85);
      }
      cmd.faceYaw = face;
      // Push away from the wall, or press the key again, and cover releases.
      const wx = input.move.x * Math.cos(camYaw) - input.move.y * Math.sin(camYaw);
      const wz = -input.move.x * Math.sin(camYaw) - input.move.y * Math.cos(camYaw);
      const out = wx * this.coverNormal.x + wz * this.coverNormal.y;
      if (input.pressed('cover') || out > 0.72 || this.ctl.stance === 'prone') this._leaveCover();
      return;
    }
    if (!input.pressed('cover') || !this.obstacles?.ok) return;
    const n = this.obstacles.wallNormal(p.x, p.z, this.ctl.footY + 0.7, 1.0, this._n);
    if (!n) return;
    this.inCover = true;
    this.coverNormal.copy(n);
    this.coverTangent.set(-n.y, n.x);
    // Snap flat against it. Pressing cover from a metre out and staying there
    // is the difference between "in cover" and "standing near a wall", and the
    // player can see the gap.
    const y = this.ctl.footY + 0.7;
    for (let d = 0.2; d < 1.6; d += 0.1) {
      const wx = p.x - n.x * d;
      const wz = p.z - n.y * d;
      if (this.obstacles.heightAt(wx, wz) > y) {
        const back = Math.max(0, d - 0.42);
        p.x -= n.x * back;
        p.z -= n.y * back;
        break;
      }
    }
    this.action = 'cover';
    this.emit({ type: 'cover', on: true });
  }

  _leaveCover() {
    this.inCover = false;
    this.lean = 0;
    if (this.action === 'cover') this.action = 'none';
    this.emit({ type: 'cover', on: false });
  }

  // -------------------------------------------------------------------- CQC --

  /**
   * Nearest entry of `list` to the player within `range` metres, horizontally.
   * Every reach the player has — CQC, picking a body up, finding somewhere to
   * hide it — is the same query with a different filter.
   */
  _nearest(list, range, accept) {
    const p = this.ctl.position;
    let best = null;
    let bd = range;
    for (const item of list) {
      const q = item.position;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d >= bd || !accept(item, q.x - p.x, q.z - p.z, d)) continue;
      best = item;
      bd = d;
    }
    return best;
  }

  /** Nearest live character in front of the player, or null. */
  nearestTarget(range = CQC_RANGE) {
    return this._nearest(this.characters, range, (ch, dx, dz, d) => {
      if (ch === this.player || ch.downed || ch.held) return false;
      // Must be roughly in front of the player, not behind his own back.
      return -Math.sin(this.ctl.yaw) * dx - Math.cos(this.ctl.yaw) * dz >= d * 0.25;
    });
  }

  /** True when the player is behind `ch` and `ch` has not seen him. */
  isBehind(ch) {
    const p = this.ctl.position;
    const fx = -Math.sin(ch.yaw);
    const fz = -Math.cos(ch.yaw);
    const dx = p.x - ch.position.x;
    const dz = p.z - ch.position.z;
    const len = Math.hypot(dx, dz) || 1;
    return (fx * dx + fz * dz) / len < -0.15;
  }

  _updateCqc(dt, input, cmd) {
    if (this.grabbed) {
      // Held: he walks where the player walks, one pace ahead as a shield.
      const g = this.grabbed;
      const p = this.ctl.position;
      g.position.x = p.x - Math.sin(this.ctl.yaw) * 0.62;
      g.position.z = p.z - Math.cos(this.ctl.yaw) * 0.62;
      g.yaw = this.ctl.yaw;
      g.anim.speed = Math.min(this.ctl.speed, 1.0);
      cmd.maxSpeed = 1.25;
      if (input.pressed('cqc')) return this.cqcChoke();
      if (input.pressed('fire')) return this.interrogate();
      if (input.pressed('drag') || input.pressed('cover')) return this.releaseGrab();
      return;
    }

    // Tap to take him down, hold to take hold of him. The two share a key, so
    // the hold has to be *consumed* explicitly — deciding on the release
    // instead would mean every grab also fired a takedown when the key came up.
    if (input.pressed('cqc')) {
      this._cqcHeld = 0;
      this._cqcConsumed = false;
    }
    if (input.down('cqc')) {
      this._cqcHeld += dt;
      if (!this._cqcConsumed && this._cqcHeld > CQC_HOLD) {
        const t = this.nearestTarget();
        if (t && this.isBehind(t) && !t.alerted) {
          this._cqcConsumed = true;
          this.grab(t);
        }
      }
    }
    if (input.released('cqc')) {
      if (!this._cqcConsumed) this.cqc();
      this._cqcConsumed = false;
      this._cqcHeld = 0;
    }
  }

  /** Tap CQC: choke out from behind, throw from anywhere else. */
  cqc() {
    const t = this.nearestTarget();
    if (!t) return false;
    const silent = this.isBehind(t) && !t.alerted;
    this.action = 'takedown';
    this.actionTimer = silent ? 0.75 : 1.05;
    // THE PLAYER TAKES PART IN HIS OWN TAKEDOWN. The clip is authored and the
    // victim has been animating for two rounds; nothing ever played it on the
    // player, so the grab, the throw and the choke all happened to a man
    // standing perfectly still. Same mechanism as `reload()`, and for the same
    // reason: hand it the timer this state actually runs on, so the gesture
    // ends when the freeze ends.
    //
    // The clip is 1.60 s and these are 0.75 / 1.05, i.e. it plays compressed —
    // deliberately. The freeze length is the mechanic (how long you are a
    // stationary target after a takedown) and it has been tuned; the animation
    // is the depiction of it. src/characters measured all three durations
    // playing the whole gesture, wrist travel 0.508-0.542 m against 0.568 m at
    // full length, which is the compression being paid for and it is small.
    this.player.playAction?.('takedown', { duration: this.actionTimer });
    // Face him, and close the last half metre so the two bodies are not a
    // metre apart during the animation the characters module will play.
    this.ctl.yaw = Math.atan2(t.position.x - this.ctl.position.x, t.position.z - this.ctl.position.z) + Math.PI;
    this._putDown(t, silent ? 'choke' : 'throw');
    this.ctl.addNoise(silent ? 0.16 : 0.5);
    this.emit({ type: 'takedown', target: t, silent });
    return true;
  }

  grab(t) {
    this.grabbed = t;
    t.held = true;
    t.controlled = true;
    t.setStance('stand');
    this.action = 'grab';
    this.emit({ type: 'grab', target: t });
  }

  releaseGrab() {
    const t = this.grabbed;
    if (!t) return;
    t.held = false;
    t.controlled = false;
    // Being let go is not being unaware: he turns round.
    t.alerted = true;
    this.grabbed = null;
    this.action = 'none';
    this.ctl.addNoise(0.35);
    this.emit({ type: 'release', target: t });
  }

  cqcChoke() {
    const t = this.grabbed;
    if (!t) return;
    this.grabbed = null;
    this.action = 'takedown';
    this.actionTimer = 0.9;
    // See cqc(): the player animates his own takedown, at the length of the
    // freeze rather than the length of the clip.
    this.player.playAction?.('takedown', { duration: this.actionTimer });
    this._putDown(t, 'choke');
    this.ctl.addNoise(0.12);
    this.emit({ type: 'takedown', target: t, silent: true });
  }

  /** Question a held guard. The AI module decides what he gives up. */
  interrogate() {
    const t = this.grabbed;
    if (!t) return;
    t.interrogated = true;
    this.emit({ type: 'interrogate', target: t });
  }

  /**
   * Put a man out of the fight.
   *
   * THIS USED TO THROW. `Character.downed` is a GETTER — it reports the
   * animator's own down timer — and the first line of this method assigned to
   * it. Module code is strict mode, so assigning to a getter-only property is a
   * TypeError, and it was raised inside `fire()` before the dart's hit had been
   * announced to anyone: every tranquilliser shot that connected, and every CQC
   * takedown, threw and aborted mid-way. The whole non-lethal toolkit was dead
   * and the exception was swallowed by the event bus's try/catch at the call
   * site above it.
   *
   * The right answer was never to write that flag anyway. Two owners have to
   * agree that a man is down: src/ai owns whether he still patrols and senses,
   * src/characters owns whether he is lying on the ground. So tell each of them
   * in its own language and let `ch.downed` report itself.
   */
  _putDown(t, how) {
    t.held = false;
    t.alerted = false;
    t.tranquillised = how === 'dart';
    this._v.set(t.position.x - this.ctl.position.x, 0, t.position.z - this.ctl.position.z);
    const dir = this._v.lengthSq() > 1e-6 ? this._v.normalize() : this._v.set(0, 0, 1);

    // The garrison owns its men: `tranquillise` sets the guard's own `down`,
    // clears his goal and makes him a body the others can find. It returns null
    // for anyone the AI does not drive, which is when we do it by hand.
    const handled = this.ai?.tranquillise ? this.ai.tranquillise(t, how === 'dart' ? 'tranq' : how) : null;
    if (!handled) {
      t.controlled = true;
      t.setStance('prone');
      t.anim.speed = 0;
      t.anim.aim = 0;
    }
    // Either way the BODY has to play going down; that action is what drives
    // `Character.downed`, which is what everything else in the game reads.
    if (!t.playAction('tranq')) t.takeHit(dir);
  }

  // ----------------------------------------------------------------- bodies --

  _updateDrag(dt, input, cmd) {
    if (this.dragging) {
      const b = this.dragging;
      const p = this.ctl.position;
      // Dragged behind, feet first, at a fixed distance rather than by physics:
      // a rope simulation on a ragdoll that has no ragdoll is theatre nobody
      // asked for, and this reads correctly from the gameplay camera.
      b.position.x = p.x + Math.sin(this.ctl.yaw) * 0.95;
      b.position.z = p.z + Math.cos(this.ctl.yaw) * 0.95;
      b.yaw = this.ctl.yaw;
      cmd.maxSpeed = 1.5;
      if (input.pressed('drag')) return this.dropBody();
      if (input.pressed('stow')) return this.stowBody();
      return;
    }
    if (!input.pressed('drag')) return;
    const b = this._nearestBody(DRAG_RANGE);
    if (b) {
      this.dragging = b;
      this.action = 'drag';
      this.emit({ type: 'drag', target: b, on: true });
    }
  }

  _nearestBody(range) {
    return this._nearest(this.characters, range, (ch) => ch.downed && !ch.hidden);
  }

  dropBody() {
    const b = this.dragging;
    if (!b) return;
    this.dragging = null;
    this.action = 'none';
    this.ctl.addNoise(0.2);
    this.emit({ type: 'drag', target: b, on: false });
  }

  /**
   * Stow the body out of sight. Only works next to something to hide it behind
   * — the outpost publishes exactly that list as `coverPoints` — so "hide the
   * body" is a place you have to reach, not a button you press where you stand.
   */
  stowBody() {
    const b = this.dragging;
    if (!b) return false;
    const near = this._nearest(this.coverPoints, STOW_RANGE, () => true);
    if (!near) {
      this.emit({ type: 'stowFailed' });
      return false;
    }
    this.dragging = null;
    this.action = 'none';
    b.hidden = true;
    b.root.visible = false;
    this.emit({ type: 'stow', target: b, at: near });
    return true;
  }

  // ----------------------------------------------------------------- weapon --

  /**
   * The current sway cone as a multiple of a standing, rested, motionless one.
   * 1.0 is "as good as standing up gets"; the reticle draws this directly, so
   * the sight finally says something about how precise the weapon is instead of
   * having exactly two sizes.
   */
  get swayScale() {
    return this.swayAngle / (SWAY_STANCE.stand * 0.6);
  }

  /** Eye height for the current stance, world Y. */
  get eyeY() {
    const s = this.ctl.stance;
    return this.ctl.position.y + (s === 'prone' ? 0.32 : s === 'crouch' ? 1.10 : 1.42);
  }

  /**
   * The optical axis with the sway on it: the line the MIDDLE OF THE SCREEN is
   * on, as a unit vector. Not the line the dart flies down — see `aimRay`.
   *
   * THE SWAY IS IN CAMERA SPACE NOW, and that is a bug fix rather than tidying.
   * It used to be `outDir.x += sx; outDir.y += sy` on a WORLD-space direction,
   * so the lateral term was whatever fraction of world X happened to be
   * perpendicular to the heading. Measured over 900 samples per heading in
   * `probes/r12_aim.js`: 5.11 mrad rms of lateral sway facing north, 3.73 at 45
   * degrees, and **0.00 facing east**. Half the aiming difficulty in this game
   * was a function of which way the player was pointed, and along one axis it
   * did not exist at all.
   */
  _lookDir(out) {
    const f = this.cam.forward(out);
    const steady = this.holdingBreath ? 0.22 : 1;
    const speed = this.ctl.speed ?? 0;
    // Stance is the floor; the breath, the legs and the last few rounds are
    // what the player can trade against it.
    const amp = (SWAY_STANCE[this.ctl.stance] ?? SWAY_STANCE.stand)
      * steady
      * (0.6 + 0.4 * (1 - this.breath))
      * (1 + speed * SWAY_PER_SPEED)
      * (1 + Math.min(SWAY_BLOOM_MAX, this.bloom));
    this.swayAngle = amp;
    const sx = (Math.sin(this._swayT * 1.7) + 0.6 * Math.sin(this._swayT * 0.61 + 1.3)) * amp;
    const sy = (Math.sin(this._swayT * 1.31 + 2.1) + 0.5 * Math.sin(this._swayT * 0.83)) * amp;
    this.aimSway.set(sx, sy);
    const yaw = this.cam.viewYaw ?? this.cam.yaw;
    const rt = this._rt.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const up = this._up.crossVectors(rt, f).normalize();
    f.addScaledVector(rt, sx).addScaledVector(up, sy);
    return f.normalize();
  }

  /**
   * How far out the aim ray has to converge on the optical axis.
   *
   * THIS IS THE FIX FOR THE THING THE PLAYER ACTUALLY FELT. The old `aimRay`
   * fired from the player's eye along the CAMERA's forward vector, and called
   * that "the camera's line so that what is under the reticle is what is hit".
   * It is not the camera's line. The over-the-shoulder rig puts the lens 0.412 m
   * to the right of that origin, 0.167 m above it and 1.801 m behind it, so the
   * two lines are PARALLEL and never meet — measured, `probes/r12_aim.js`. The
   * consequences, all measured on the shipped build:
   *
   *   - a round aimed with the centre of the screen landed 1.87 m off at 10 m,
   *     1.89 m at 20 m and 1.94 m at 40 m. Constant, because parallel.
   *   - the reticle, which honestly projects the impact point, therefore sat
   *     176 px from the centre of the frame at 3 m, 79 px at 10 m and 22 px at
   *     80 m — it SLID across the screen as the range under it changed.
   *
   * Converging fixes both at once: the ray still leaves the shooter, but it is
   * aimed at the point the middle of the screen is on, so the reticle comes
   * home to the centre and "what is under it is what is hit" becomes true.
   *
   * The range is smoothed over 70 ms because the depth under the sight is
   * discontinuous at every silhouette edge — a guard at 14 m in front of a
   * ridge at 90 m is a 29 mrad step in the launch angle, which unsmoothed is
   * the round snapping 0.41 m sideways as the sight crosses his shoulder.
   */
  _solveConverge(dt) {
    const cam = this.cam.camera;
    // Before the first camera update there is no optical axis to converge on.
    if (!cam || (cam.position.x === 0 && cam.position.y === 0 && cam.position.z === 0)) return;
    const dir = this._lookDir(this._lk);
    const d = this._lookMarch(cam.position, dir);
    // Snap rather than ease on the frame the weapon comes up: the last value is
    // from whatever the player was looking at before he raised it, which is not
    // a pose to interpolate out of.
    const k = this._hadConverge ? 1 - Math.exp(-dt / CONVERGE_TAU) : 1;
    this._hadConverge = true;
    this.convergeRange += (d - this.convergeRange) * k;
  }

  /**
   * First thing the optical axis meets, in metres. Straight line, no ballistics
   * — this answers "what is the player looking at", not "where does the dart
   * land". Coarse on purpose: it feeds a convergence correction whose whole
   * magnitude is 0.4 m of lateral, so a 0.35 m sampling step is three orders
   * more precision than the term needs.
   */
  _lookMarch(org, dir) {
    let best = CONVERGE_FAR;
    // Characters, analytically against a vertical capsule. Cheaper and exact,
    // and they are the one thing whose depth the player cares about to a metre.
    const hl = Math.hypot(dir.x, dir.z) || 1e-6;
    const hx = dir.x / hl;
    const hz = dir.z / hl;
    for (const ch of this.characters) {
      if (ch === this.player || ch.hidden) continue;
      const dx = ch.position.x - org.x;
      const dz = ch.position.z - org.z;
      const along = dx * hx + dz * hz;
      if (along <= 0.5 || along >= best) continue;
      if (Math.abs(dx * hz - dz * hx) > 0.36) continue;
      const y = org.y + dir.y * (along / hl);
      const base = ch.groundY ?? 0;
      const top = base + (ch.anim?.stance === 'prone' ? 0.55 : ch.anim?.stance === 'crouch' ? 1.35 : 1.82);
      if (y > base && y < top) best = along / hl;
    }
    // Terrain and structures: march, then bisect the bracket.
    //
    // THE STEP SIZE IS A CORRECTNESS PROBLEM BEFORE IT IS A BUDGET ONE, and I
    // got that the wrong way round once already. At 0.35 m this cost 593 us a
    // frame — 3.5% of a 60 Hz frame for a term whose whole magnitude is 0.4 m
    // of lateral aim — so I took it to 2.0 m on the argument that being 2 m
    // wrong about the RANGE is 2.2 mrad, which is 4 cm at the target. That
    // argument is sound and the step was still wrong, because a 2 m step does
    // not mis-measure a wall, it STEPS OVER IT: `probes/r12_jump.js` caught the
    // convergence reading 17.4 m one frame and 117.3 m four frames later on a
    // camera that had moved half a degree, because the coarse samples fell
    // either side of a compound wall. The obstacle field is a 0.25 m grid; a
    // sampler that walks it eight texels at a time cannot see anything thin.
    //
    // 0.5 m near, coarsening past 40 m where the correction is already under
    // 10 mrad and no structure is thin compared to the step. ~128 samples worst
    // case, and it terminates on the first solid thing in almost every pose.
    const solid = (t) => {
      const x = org.x + dir.x * t;
      const y = org.y + dir.y * t;
      const z = org.z + dir.z * t;
      if (this.ground.heightAt(x, z) > y) return true;
      return !!(this.obstacles?.ok && this.obstacles.heightAt(x, z) > y);
    };
    let lo = 1.0;
    let t = lo;
    while (t < best) {
      if (solid(t)) {
        for (let i = 0; i < 4; i++) {
          const mid = (lo + t) * 0.5;
          if (solid(mid)) t = mid; else lo = mid;
        }
        return t;
      }
      lo = t;
      t += t < 40 ? 0.5 : t < 90 ? 1.5 : 6.0;
    }
    return best;
  }

  /**
   * Where the dart will actually go. `outOrigin` leaves the shooter,
   * `outDir` is aimed at the point the middle of the screen is on.
   *
   * Published so the HUD can put a reticle on the same point instead of
   * guessing one in the middle of the screen — the reticle still draws the
   * BALLISTIC impact, so the drop stays visible and stays the mechanic it was
   * written to be. What it no longer draws is a lateral parallax error.
   */
  aimRay(outOrigin, outDir) {
    const p = this.ctl.position;
    const look = this._lookDir(outDir);
    const cam = this.cam.camera;
    outOrigin.set(p.x, this.eyeY, p.z).addScaledVector(look, 0.35);
    this._hasL = !!cam && (cam.position.x !== 0 || cam.position.y !== 0 || cam.position.z !== 0);
    if (this._hasL) {
      const L = this._lp.copy(cam.position).addScaledVector(look, this.convergeRange);
      // `look` is `outDir`; overwrite it in place now that the target is built.
      outDir.copy(L).sub(outOrigin).normalize();
    }
    return outDir;
  }

  /**
   * The weapon as the HUD wants it. Field names are the ones src/ui/state.js
   * probes for, so the widget lights up with no adapter work at either end:
   *   { name, ammo, reserve, mode, suppressed }
   * plus `reloading` (0..1 progress) and `magSize`, which the adapter ignores
   * and anything else is free to use.
   */
  get weapon() {
    return {
      name: WEAPON.name,
      ammo: this.ammo,
      reserve: this.reserve,
      magSize: this.magSize,
      mode: this.fireMode,
      suppressed: WEAPON.suppressed,
      reloading: this.reloading > 0 ? 1 - this.reloading / this.reloadTime : 0,
    };
  }

  /** Full magazine, full reserve, nothing mid-reload. Called on mission start. */
  rearm() {
    this.ammo = this.magSize;
    this.reserve = WEAPON.reserve;
    this.reloading = 0;
    this._fireCooldown = 0;
    this.bloom = 0;
    this.aimHit = null;
  }

  cycleFireMode() {
    const i = WEAPON.modes.indexOf(this.fireMode);
    this.fireMode = WEAPON.modes[(i + 1) % WEAPON.modes.length];
    this.emit({ type: 'fireMode', mode: this.fireMode });
    return this.fireMode;
  }

  /**
   * Start a reload. Returns false when there is nothing to do, which is the
   * case the shipped build got wrong twice over: it refused silently when the
   * magazine was full, and it never told anyone it had started, so pressing R
   * one second after firing looked identical to pressing nothing at all — the
   * ammo count does not move until the 2.35 s are up.
   */
  reload() {
    if (this.reloading > 0) return false;
    if (this.ammo >= this.magSize || this.reserve <= 0) {
      this.emit({ type: 'reloadRefused', full: this.ammo >= this.magSize });
      return false;
    }
    this.reloading = this.reloadTime;
    // THE ANIMATION IS THE RELOAD. Before this line the magazine refilled after
    // a timer and the character did not move: the player pressed R, nothing
    // happened for 2.4 s, and then the counter jumped. `playAction` drives the
    // authored clip — weapon out of the shoulder, magazine out, head down to
    // the well, the seating slap, the charging handle — and it is handed the
    // SAME duration the timer runs on, so the count comes back on the frame
    // the bolt goes home rather than at some unrelated moment.
    this.player.playAction?.('reload', { duration: this.reloadTime });
    // Cover and CQC are fine mid-reload; aiming is not, and `canAim` already
    // reads `reloading`, so the weapon comes down on its own.
    this.emit({ type: 'reload', duration: this.reloadTime });
    return true;
  }

  _finishReload() {
    this.reloading = 0;
    // A partial magazine keeps its round in the chamber, so a reload at 7/20
    // with 100 in reserve costs 13 and not 20.
    const want = Math.min(this.magSize - this.ammo, this.reserve);
    this.ammo += want;
    this.reserve -= want;
    this.emit({ type: 'reloaded', ammo: this.ammo, reserve: this.reserve });
  }

  /**
   * Keep `aimHit` current for the reticle: what the dart would hit, and how far
   * away it is.
   *
   * THIS USED TO RUN AT 20 Hz, and the reticle is drawn at the point it
   * produces, so the sight only knew its own depth every third rendered frame.
   * Measured over a slow 150-frame pan in `probes/r12_aim.js`: the reticle
   * travelled 1301 px across a sweep whose true angular motion is about 1030 px,
   * in per-frame steps of 5.7 px median and 34.3 px worst — a sight that
   * staircased sideways while the world under it moved smoothly. It is now
   * every frame, which cost nothing measurable once `_trace` stopped testing
   * all thirteen characters at all 288 integration steps (`_traceCandidates`).
   */
  _predict(dt) {
    if (this.aimAmount < 0.04) { this.aimHit = null; return; }
    const org = this._ao;
    const dir = this._ad;
    this.aimRay(org, dir);
    // WHERE THE SIGHT IS DRAWN — and it is NOT the impact point any more.
    //
    // Drawing the reticle at the traced impact is the obvious choice and it
    // strobes. The impact RANGE is discontinuous at every silhouette: hold the
    // sight on a guard's shoulder at 18 m with open ground 40 m behind him and
    // the trace alternates between the two, so the drop the reticle draws
    // alternates with it. Filmed, `probes/r12_film.mjs` caught the box stepping
    // between y = +35 px and y = +110 px on consecutive frames while the player
    // held still — 75 px of strobe on the one element he is trying to aim with.
    // It is in the pre-fix build too; it is not something convergence caused.
    //
    // So draw the round's position at the range the sight is CONVERGENT on.
    // That range is smoothed and is by definition the depth of whatever is
    // under the middle of the screen, so the box sits on the optical axis
    // laterally and hangs below it by exactly the drop at that range — smooth,
    // monotone in range, and still the honest ballistic answer for the thing
    // the player is actually looking at. `aimHit` keeps the true impact for the
    // range readout and the target highlight.
    const s = this._hasL ? Math.max(1, this._lp.distanceTo(org)) : 22;
    const tof = s / DART_SPEED;
    this.sightPoint.copy(org).addScaledVector(dir, s);
    this.sightPoint.y -= 0.5 * DART_GRAVITY * tof * tof;
    const hit = this._trace(org, dir);
    this.aimHit = hit
      ? {
        character: hit.character ?? null,
        point: hit.point,
        dist: Math.hypot(hit.point.x - org.x, hit.point.y - org.y, hit.point.z - org.z),
      }
      : null;
  }

  /**
   * How far the muzzle is from the firing hand's bone — ASKED, not assumed.
   *
   * This was the constant 0.46, and it was wrong the moment the weapon changed:
   * src/characters fitted the suppressor the loadout has always claimed
   * (`WEAPON.suppressed` has been true since the weapon was written) and the
   * muzzle went past 0.7 m, so every flash, tracer origin and impact ray
   * started a quarter of a metre inside the barrel. A hardcoded length is a
   * copy of somebody else's model that nothing keeps in sync.
   *
   * `characters` publishes everything needed to derive it. `ch.rifle` carries
   * the weapon's own anchors in weapon space, and `ch.attach.R` carries both
   * the wrist-to-grip offset and the two axis pairs that define weapon space
   * against hand space — which is exactly the rotation that turns the
   * grip-to-muzzle vector into the hand's frame. The result is a length, so it
   * is invariant under everything the animator does to the arm, and it follows
   * the model the next time somebody fits a longer can.
   */
  muzzleReach() {
    if (this._reach !== undefined) return this._reach;
    this._reach = null;
    const rifle = this.player?.rifle;
    const a = this.player?.attach?.R;
    if (rifle?.muzzle && rifle?.gripCenter && a?.wristToGrip && a.weaponAxis1 && a.handAxis1) {
      // Orthonormal basis from a pair of axes, exactly as Character.js builds
      // the bind: first axis kept, second one made perpendicular to it.
      const basis = (a1, a2, m) => {
        const x = a1.clone().normalize();
        const y = a2.clone().addScaledVector(x, -a2.clone().normalize().dot(x)).normalize();
        return m.makeBasis(x, y, new THREE.Vector3().crossVectors(x, y));
      };
      const Bw = basis(a.weaponAxis1, a.weaponAxis2, new THREE.Matrix4());
      const Bh = basis(a.handAxis1, a.handAxis2, new THREE.Matrix4());
      const R = Bh.multiply(Bw.transpose());
      this._reach = new THREE.Vector3()
        .subVectors(rifle.muzzle, rifle.gripCenter)
        .applyMatrix4(R)
        .add(a.wristToGrip)
        .length();
    }
    return this._reach;
  }

  /**
   * Where the flash and the case come from.
   *
   * The rifle is skinned into the right hand rather than parented to a node, so
   * there is no muzzle transform to read; the hand bone is the closest thing
   * that exists and it moves with the recoil the animator just played. Take its
   * world position and push the weapon's own barrel length down the line the
   * dart is on.
   */
  muzzlePoint(out, dir) {
    const hand = this.player?.rig?.byName?.get?.('handR');
    if (hand) {
      hand.getWorldPosition(out);
      // MUZZLE_FALLBACK only for a character that publishes no weapon anchors;
      // it is the old hardcoded figure and it is known to be short.
      return out.addScaledVector(dir, this.muzzleReach() ?? MUZZLE_FALLBACK);
    }
    const p = this.ctl.position;
    const eye = p.y + (this.ctl.stance === 'prone' ? 0.32 : this.ctl.stance === 'crouch' ? 1.10 : 1.42);
    return out.set(p.x, eye - 0.12, p.z).addScaledVector(dir, 0.55);
  }

  fire() {
    if (this.ammo <= 0) {
      if (this.reloading <= 0 && this.reserve > 0) this.reload();
      else this.emit({ type: 'dryFire' });
      return null;
    }
    this.ammo--;
    this._fireCooldown = FIRE_INTERVAL;
    const origin = this._ao;
    const dir = this._ad;
    // Before the kick, deliberately: the round that is leaving now goes where
    // the weapon was pointed when the trigger broke. It still eats the residual
    // of the previous round, which is what makes a burst walk.
    this.aimRay(origin, dir);
    // Up, and to one side or the other. See RECOIL_PITCH for what the old
    // single 0.30 actually measured versus what its comment claimed.
    this._recoilSide = -this._recoilSide;
    // A burst climbs. The bloom is already a count of how many rounds have gone
    // downrange in the last third of a second, so tying the impulse to it costs
    // nothing and keeps one notion of "still shooting" rather than two: with a
    // flat impulse and a spring that settles in 0.27 s, 3 s of automatic fire
    // peaked at 1.14x a single round, which a player cannot feel.
    const burst = 1 + 0.30 * Math.min(SWAY_BLOOM_MAX, this.bloom);
    this.cam.recoil(
      RECOIL_PITCH * burst * (0.85 + 0.3 * Math.random()),
      RECOIL_YAW * burst * this._recoilSide * (0.5 + 0.8 * Math.random()),
    );
    // The cone opens on every round and closes over ~0.3 s. Nothing about the
    // weapon responded to being fired before this: a player could hold the
    // trigger down and the sight told him the twentieth round was as precise as
    // the first.
    this.bloom = Math.min(SWAY_BLOOM_MAX, this.bloom + SWAY_PER_SHOT);
    // The BODY takes the shot too. `fire` is an authored clip in
    // src/characters/actions.js — a decaying oscillator through the weapon, the
    // clavicle, the chest and the head — and nothing had ever asked for it, so
    // every round the player fired moved a counter and not a single vertex.
    this.player.playAction?.('fire');
    // Suppressed, but not silent: a pistol shot is still a 12 m event.
    this.ctl.addNoise(0.22);

    // Published for the muzzle flash, the shell and the report. Built here
    // rather than in the listener because this is the frame the weapon is on.
    const muzzle = this.muzzlePoint(this._mz, dir);
    this.emit({
      type: 'muzzle',
      point: muzzle.clone(),
      dir: { x: dir.x, y: dir.y, z: dir.z },
      suppressed: WEAPON.suppressed,
      shooter: this.player,
    });

    const hit = this._trace(origin, dir);
    if (hit?.character) {
      this._putDown(hit.character, 'dart');
      hit.character.tranquillised = true;
      // `headshot` was computed by `_trace` from the first commit and read by
      // nobody, so the one piece of information the trace knew that the player
      // could not see never left this file.
      this.emit({
        type: 'tranq', target: hit.character, point: hit.point, surface: 'body',
        headshot: !!hit.headshot, dir,
      });
    } else {
      this.emit({ type: 'shot', point: hit?.point ?? null, surface: hit?.surface ?? null, dir });
    }
    return hit;
  }

  /**
   * Integrate the dart. Ballistic drop is the point — at 62 m/s a 30 m shot
   * falls 1.2 m, which is the difference between a head and a boot, and it is
   * why the tranquilliser pistol is a stealth weapon and not a rifle.
   */
  /**
   * The characters the dart could possibly touch, hoisted out of the
   * integration loop. Gravity acts on Y alone, so the flight is a STRAIGHT LINE
   * in plan — a horizontal perpendicular test is exact, not an approximation,
   * and it turns 288x13 capsule tests into 13 plus 288x(usually zero).
   */
  _traceCandidates(origin, dir) {
    const list = this._cand;
    list.length = 0;
    const hl = Math.hypot(dir.x, dir.z);
    if (hl < 1e-6) return list;
    const hx = dir.x / hl;
    const hz = dir.z / hl;
    const reach = DART_SPEED * DART_LIFE * hl + 1;
    for (const ch of this.characters) {
      if (ch === this.player || ch.downed || ch.hidden) continue;
      const dx = ch.position.x - origin.x;
      const dz = ch.position.z - origin.z;
      const along = dx * hx + dz * hz;
      if (along < -0.4 || along > reach) continue;
      if (Math.abs(dx * hz - dz * hx) > 0.42) continue;
      list.push(ch);
    }
    return list;
  }

  _trace(origin, dir) {
    const step = 1 / 180;
    let x = origin.x;
    let y = origin.y;
    let z = origin.z;
    let vx = dir.x * DART_SPEED;
    let vy = dir.y * DART_SPEED;
    let vz = dir.z * DART_SPEED;
    const cand = this._traceCandidates(origin, dir);

    for (let t = 0; t < DART_LIFE; t += step) {
      const nx = x + vx * step;
      const ny = y + vy * step;
      const nz = z + vz * step;
      vy -= DART_GRAVITY * step;

      for (const ch of cand) {
        const dx = nx - ch.position.x;
        const dz = nz - ch.position.z;
        if (dx * dx + dz * dz > 0.13) continue;   // 0.36 m capsule radius
        // `groundY` is what the animator actually seated the root at this
        // frame; `position.y` is 0 for every AI-driven character in the scene.
        const base = ch.groundY ?? 0;
        const top = base + (ch.anim?.stance === 'prone' ? 0.55 : ch.anim?.stance === 'crouch' ? 1.35 : 1.82);
        if (ny > base + 0.05 && ny < top) {
          return { character: ch, point: new THREE.Vector3(nx, ny, nz), headshot: ny > top - 0.28 };
        }
      }

      // WHAT was hit, not just where. The impact effect is the difference
      // between a dust puff and a spark, and only the trace knows which surface
      // stopped the dart: `ground` is the terrain/graded platform, `structure`
      // is anything in the obstacle field, i.e. every man-made thing there is.
      if (this.ground.heightAt(nx, nz) > ny) {
        return { point: new THREE.Vector3(nx, ny, nz), surface: 'ground' };
      }
      if (this.obstacles?.ok && this.obstacles.heightAt(nx, nz) > ny) {
        return { point: new THREE.Vector3(nx, ny, nz), surface: 'structure' };
      }
      x = nx;
      y = ny;
      z = nz;
    }
    return null;
  }

  // ------------------------------------------------------------- animation --

  /**
   * Drive the character's animation channels. These four are the whole contract
   * with src/characters; see the module's exported `ANIM_CHANNELS`.
   */
  _writeAnim() {
    const ch = this.player;
    const a = ch.anim;
    a.aim = this.aimAmount;
    if (this.aimAmount > 0.01) {
      const dir = this._ad;
      const org = this._ao;
      this.aimRay(org, dir);
      this.aimPoint.copy(org).addScaledVector(dir, 22);
      a.aimTarget.copy(this.aimPoint);
      ch.lookAt(this.aimPoint);
    } else if (this.grabbed) {
      ch.lookAt(this.grabbed.eyePosition(this.aimPoint));
    } else {
      // Free look: the head leads the camera by a beat, which is what makes a
      // running figure read as a person looking where he is going.
      const f = this.cam.forward(this._d);
      this.aimPoint.set(
        ch.position.x + f.x * 14,
        (this.ctl.footY ?? 0) + 1.6 + f.y * 14,
        ch.position.z + f.z * 14,
      );
      ch.lookAt(this.aimPoint);
    }
    // Extra channels the characters module can grow poses for without a new
    // wiring pass. Unknown values must be ignored, never asserted on.
    a.action = this.action;
    a.actionTime = this.actionTimer;
    a.inCover = this.inCover;
    a.lean = this.lean;
  }

  emit(e) {
    this.events?.emit(e);
  }
}
