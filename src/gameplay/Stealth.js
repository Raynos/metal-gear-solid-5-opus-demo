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
const FIRE_INTERVAL = 0.42;

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
  reloadTime: 2.35,
  modes: ['SEMI', 'AUTO'],
  suppressed: true,
};

const CQC_RANGE = 1.85;
const CQC_HOLD = 0.25;        // hold longer than this and it is a grab, not a takedown
const DRAG_RANGE = 1.6;
const STOW_RANGE = 2.6;

const BREATH_DRAIN = 1 / 4.2;   // a full lungful lasts 4.2 s
const BREATH_RECOVER = 1 / 3.0;

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
    this._v = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._ao = new THREE.Vector3();
    this._ad = new THREE.Vector3();
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
   * Where the dart will actually go: down the camera's optical axis, offset by
   * the sway. Published so the HUD can put a reticle on the same point instead
   * of guessing one in the middle of the screen.
   */
  aimRay(outOrigin, outDir) {
    const p = this.ctl.position;
    const eye = p.y + (this.ctl.stance === 'prone' ? 0.32 : this.ctl.stance === 'crouch' ? 1.10 : 1.42);
    // Muzzle is at the weapon, but the SHOT comes from the camera's line so
    // that what is under the reticle is what is hit. Everything else is a
    // parallax bug the player experiences as the gun missing.
    this.cam.forward(outDir);
    const steady = this.holdingBreath ? 0.22 : 1;
    const amp = (this.ctl.stance === 'prone' ? 0.0035 : this.ctl.stance === 'crouch' ? 0.006 : 0.0105)
      * steady * (0.6 + 0.4 * (1 - this.breath));
    const sx = (Math.sin(this._swayT * 1.7) + 0.6 * Math.sin(this._swayT * 0.61 + 1.3)) * amp;
    const sy = (Math.sin(this._swayT * 1.31 + 2.1) + 0.5 * Math.sin(this._swayT * 0.83)) * amp;
    this.aimSway.set(sx, sy);
    outDir.x += sx;
    outDir.y += sy;
    outDir.normalize();
    outOrigin.set(p.x, eye, p.z).addScaledVector(outDir, 0.35);
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
   * away it is. Throttled to 20 Hz and only while the weapon is up — the trace
   * integrates 288 steps against every character and there is no reason to pay
   * for it on a frame where nothing reads it.
   */
  _predict(dt) {
    if (this.aimAmount < 0.05) { this.aimHit = null; return; }
    this._predictT -= dt;
    if (this._predictT > 0) return;
    this._predictT = 0.05;
    const org = this._ao;
    const dir = this._ad;
    this.aimRay(org, dir);
    const hit = this._trace(org, dir);
    this.aimHit = hit
      ? {
        character: hit.character ?? null,
        point: hit.point,
        dist: Math.hypot(hit.point.x - org.x, hit.point.y - org.y, hit.point.z - org.z),
      }
      : null;
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
    this.aimRay(origin, dir);
    // The spring runs at ~9.5 rad/s, so the impulse is amplitude x omega: 0.30
    // lands about 1.8 degrees of muzzle rise, which is a suppressed pistol.
    this.cam.recoil(0.30);
    // Suppressed, but not silent: a pistol shot is still a 12 m event.
    this.ctl.addNoise(0.22);

    const hit = this._trace(origin, dir);
    if (hit?.character) {
      this._putDown(hit.character, 'dart');
      hit.character.tranquillised = true;
      this.emit({ type: 'tranq', target: hit.character, point: hit.point });
    } else {
      this.emit({ type: 'shot', point: hit?.point ?? null });
    }
    return hit;
  }

  /**
   * Integrate the dart. Ballistic drop is the point — at 62 m/s a 30 m shot
   * falls 1.2 m, which is the difference between a head and a boot, and it is
   * why the tranquilliser pistol is a stealth weapon and not a rifle.
   */
  _trace(origin, dir) {
    const step = 1 / 180;
    let x = origin.x;
    let y = origin.y;
    let z = origin.z;
    let vx = dir.x * DART_SPEED;
    let vy = dir.y * DART_SPEED;
    let vz = dir.z * DART_SPEED;

    for (let t = 0; t < DART_LIFE; t += step) {
      const nx = x + vx * step;
      const ny = y + vy * step;
      const nz = z + vz * step;
      vy -= DART_GRAVITY * step;

      for (const ch of this.characters) {
        if (ch === this.player || ch.downed || ch.hidden) continue;
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

      if (this.ground.heightAt(nx, nz) > ny) return { point: new THREE.Vector3(nx, ny, nz) };
      if (this.obstacles?.ok && this.obstacles.heightAt(nx, nz) > ny) {
        return { point: new THREE.Vector3(nx, ny, nz) };
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
