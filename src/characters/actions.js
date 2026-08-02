import * as THREE from 'three';

/**
 * The upper-body action layer.
 *
 * Locomotion owns the whole body; this owns everything that happens *over* it —
 * firing, reloading, CQC, a hit reaction, checking a watch, and being
 * tranquillised. It never replaces the locomotion pose; it produces additive
 * bone offsets, a weapon-transform offset, and (for the two actions that need
 * the support hand off the weapon) an IK override for the left wrist. The
 * character keeps walking underneath.
 *
 * WHY THE OVERRIDES ARE ALL LEFT-HANDED. The rifle is skinned to `handR` —
 * it is welded into the firing hand at assembly time, so wherever the right
 * wrist goes the weapon goes. That makes the right hand unavailable for
 * anything that is not holding the weapon, and it makes the LEFT hand free for
 * everything else. This is also just correct: in MGSV the rifle stays in the
 * firing hand through a CQC grab and it is the other arm that does the work.
 * The mag change, the charging handle, the grab and the throw are all authored
 * as left-wrist paths for that reason.
 *
 * Positions are in CHARACTER space — feet at the origin, facing -Z, +X is the
 * character's own right — the same space `WEAPON_POSES` is authored in, so a
 * waypoint can be read off the rig without thinking about world transforms.
 */

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;

/** Smooth 0..1 ramp across [a,b], flat outside. */
function seg(t, a, b) {
  if (t <= a) return 0;
  if (t >= b) return 1;
  const u = (t - a) / (b - a);
  return u * u * (3 - 2 * u);
}
/** 0 -> 1 -> 0 bump across [a,b]. */
function bump(t, a, b) {
  if (t <= a || t >= b) return 0;
  return Math.sin(((t - a) / (b - a)) * Math.PI);
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/**
 * Left-wrist waypoint paths, in character space. Each entry is [time, x, y, z].
 * Sampled with a smoothstep between neighbours: a hand moving between two
 * points with an ease at both ends is indistinguishable from a hand-authored
 * curve at this scale, and it costs two lerps.
 */

/**
 * HOME is where the support wrist actually sits on the handguard in the low
 * ready, in character space. It is MEASURED, not guessed: a probe read the
 * world position of `handL` after the arm IK had settled and pushed it back
 * through the character's own matrix. The first guess at it was 90 mm out,
 * which is enough that the hand visibly jumped off the weapon the instant a
 * reload started. Every path below begins and ends here so the override ramps
 * in and out of the pose the arm solver was already holding.
 */
/**
 * ROUND 11 re-measure: [0.014, 1.055, -0.386] -> [0.065, 1.066, -0.344].
 * `buildRifle`'s foregrip moved 85 mm back along the handguard (it had the
 * support arm sitting on the solver's reach clamp, i.e. dead straight, with
 * the hand 8 mm off the gun), so the settled wrist moved with
 * it. Re-read the same way: `probes/r11_upper.js` steps the world to idle low
 * ready and pushes `handL`'s world position back through the character matrix.
 */
const HOME = [0.065, 1.066, -0.344];

const PATHS = {
  // Magazine change. The hand leaves the handguard, strips the empty, goes to
  // the belt, brings a fresh magazine up, seats it, works the charging handle,
  // and returns.
  reload: [
    [0.00, ...HOME],
    [0.32, 0.13, 1.00, -0.33],   // magazine well
    [0.52, 0.16, 0.90, -0.28],   // strip, drop it clear
    [0.78, -0.15, 0.97, -0.16],  // belt pouch
    [1.05, -0.13, 0.99, -0.18],  // grip the fresh one
    [1.42, 0.13, 0.99, -0.33],   // bring it up
    [1.58, 0.13, 1.04, -0.34],   // seat it
    [1.80, 0.21, 1.20, -0.30],   // charging handle
    [1.96, 0.23, 1.19, -0.19],   // yank back
    [2.12, 0.21, 1.20, -0.30],   // release
    [2.40, ...HOME],             // back on the handguard
  ],
  /**
   * The silent takedown, which until now borrowed the `cqc` path wholesale.
   *
   * They are not the same gesture. `cqc` is a throw: you meet a man who has
   * seen you, take him across your body and put him on the ground in front of
   * you, so the support hand's work is all lateral. A takedown is done to a man
   * who has NOT seen you: the arm goes out and AROUND, forward past his throat,
   * then everything comes BACK — he is pulled onto your own chest, not swept
   * across it — and you ride him down between your feet.
   *
   * That difference is the whole readability of the move from behind, which is
   * the only camera it is ever performed on. Borrowing the throw meant the one
   * beat a viewer needs to see, the arm reaching forward past the target's
   * head, did not exist: `cqc`'s furthest forward waypoint is -0.86 in z, and
   * measured from the left shoulder that is 0.71 m against a 0.58 m arm, so the
   * IK clamped it: the wrist never got there and the reach played as a shrug.
   *
   * Every waypoint here is checked against the left shoulder at
   * (-0.190, 1.452, -0.014) with 0.580 m of reach: 85%, 76%, 63%, 88%, and one
   * deliberate over-reach at the end, because an arm at full stretch pointing
   * down IS what setting a body on the deck looks like.
   */
  takedown: [
    [0.00, ...HOME],
    [0.24, -0.10, 1.41, -0.50],  // out and around, past the throat
    [0.40, -0.03, 1.35, -0.41],  // clamp, forearm across it
    [0.66, 0.06, 1.25, -0.19],   // haul him back onto your own chest
    [0.98, -0.02, 1.03, -0.29],  // his weight goes on your hip; ride him down
    [1.28, -0.16, 0.76, -0.38],  // set him on the deck
    [1.60, ...HOME],
  ],
  // CQC: step in, grab, haul the target across and put them down.
  cqc: [
    [0.00, ...HOME],
    [0.22, -0.08, 1.36, -0.86],  // reach
    [0.38, -0.06, 1.30, -0.78],  // contact
    [0.62, -0.26, 1.22, -0.40],  // haul across the body
    [0.92, -0.30, 0.72, -0.52],  // put them down
    [1.25, ...HOME],
  ],
  // Overhand throw — a magazine as a distraction, the classic stealth beat.
  throw: [
    [0.00, ...HOME],
    [0.18, -0.24, 1.02, -0.06],  // wind up, hand behind the hip
    [0.34, -0.26, 1.46, 0.10],   // cocked by the ear
    [0.48, -0.14, 1.52, -0.46],  // release
    [0.66, -0.06, 1.30, -0.58],  // follow through
    [0.95, ...HOME],
  ],
  // Idle variation: a look at the wrist. Small, slow, unmistakably human.
  checkWatch: [
    [0.00, ...HOME],
    [0.55, -0.10, 1.32, -0.30],
    [1.85, -0.10, 1.33, -0.30],
    [2.40, ...HOME],
  ],
};

for (const k of Object.keys(PATHS)) {
  PATHS[k] = PATHS[k].map(([t, x, y, z]) => ({ t, p: V(x, y, z) }));
}

const _sp = new THREE.Vector3();
function samplePath(path, t) {
  if (t <= path[0].t) return _sp.copy(path[0].p);
  for (let i = 1; i < path.length; i++) {
    if (t <= path[i].t) {
      const a = path[i - 1];
      const b = path[i];
      const u = (t - a.t) / Math.max(1e-4, b.t - a.t);
      return _sp.copy(a.p).lerp(b.p, u * u * (3 - 2 * u));
    }
  }
  return _sp.copy(path[path.length - 1].p);
}

/**
 * name -> { dur, prio, loco, weapon }
 *   prio    higher interrupts lower; equal restarts.
 *   loco    0 free to move, 1 movement is locked out for the duration.
 *   weapon  how much the action pulls the weapon out of its carry/aim pose.
 */
/**
 * THE TAKEDOWN IS NOT WIRED UP, AND THIS IS THE CALL THAT WIRES IT.
 *
 * `src/gameplay/Stealth.js` (not this module's file) has `cqc()` and
 * `cqcChoke()` set `this.action = 'takedown'` and an `actionTimer`, freeze the
 * player, put the victim down — and never ask the player's own body to do
 * anything. The victim animates, because `_putDown` calls `playAction('tranq')`
 * on him. The player stands still with a rifle in his hands while a man folds
 * up in front of him. `reload()` and `fire()` in the same file get this right;
 * these two were missed.
 *
 * Verified from this side with `probes/r11_upper.js`: `playAction('takedown')`
 * is accepted, runs 1.617 s measured against 1.60 s authored (one frame of
 * overshoot, which is just the last `t >= dur` step), drives the support wrist
 * 0.55 m off the weapon along the CQC path, lunges the rig 0.34 m forward
 * without moving the actor's logical position, and puts 0.30 rad of twist
 * through the spine. The receiving end works. Nothing calls it.
 *
 * What gameplay must add, in Stealth.js:
 *
 *   cqc()        this.player.playAction('takedown', { duration: this.actionTimer })
 *   cqcChoke()   this.player.playAction('takedown', { duration: this.actionTimer })
 *
 * `duration` and not the bare name, because `ACTIONS.takedown.dur` is 1.60 s
 * and those two methods freeze the player for 0.75 / 1.05 / 0.90 s. Left
 * alone, the clip would still be hauling a body across the chest for most of a
 * second after the player had control back. `play()` already takes
 * `opts.duration` and `_path` rescales the authored waypoints by
 * `dur / authoredDur`, so any of those three lengths plays the whole gesture,
 * just faster — exactly what `reload()` already does with `WEAPON.reloadTime`.
 *
 * The alternative is to make the freeze match the clip (`actionTimer = 1.60`),
 * which is the same fix from the other end and is a feel decision, so it is
 * gameplay's to make. `0.75 s` for a silent choke is quick for the gesture
 * authored here; 1.0-1.2 s would read better.
 */
export const ACTIONS = {
  fire: { dur: 0.34, prio: 2, loco: 0, weapon: 0 },
  reload: { dur: 2.40, prio: 4, loco: 0, weapon: 0.85 },
  cqc: { dur: 1.25, prio: 6, loco: 1, weapon: 0.7 },
  takedown: { dur: 1.60, prio: 6, loco: 1, weapon: 0.7 },
  throw: { dur: 0.95, prio: 4, loco: 0, weapon: 0.6 },
  hit: { dur: 1.00, prio: 5, loco: 0, weapon: 0 },
  tranq: { dur: 1.70, prio: 9, loco: 1, weapon: 1 },
  wake: { dur: 2.20, prio: 9, loco: 1, weapon: 1 },
  checkWatch: { dur: 2.40, prio: 1, loco: 0, weapon: 0.35 },
};

export class ActionLayer {
  constructor(anim) {
    this.anim = anim;
    this.current = null; // { name, t, dur, def, dir }
    this.queued = null;

    // Additive outputs, rewritten every update. The animator reads these and
    // adds them to whatever the locomotion pose produced.
    this.recoil = 0;
    this.weaponPos = new THREE.Vector3();
    this.weaponPitch = 0;
    this.weaponRoll = 0;
    this.weaponYaw = 0;
    this.weaponBlend = 0; // 1 = fully out of the carry pose
    this.hand = {
      L: { w: 0, pos: new THREE.Vector3() },
      R: { w: 0, pos: new THREE.Vector3() },
    };
    this.bone = {
      rootX: 0, rootY: 0, rootZ: 0,
      spine1X: 0, spine1Y: 0, spine1Z: 0,
      spine2X: 0, spine2Y: 0, spine2Z: 0,
      chestX: 0, chestY: 0, chestZ: 0,
      neckX: 0, headX: 0, headY: 0, headZ: 0,
      clavRZ: 0, clavLZ: 0,
    };
    /** Forward impulse in metres, character space -Z. Consumed by the animator. */
    this.stepZ = 0;
    this.lockLoco = false;
    /** 0..1: how far through the tranq collapse. 1 = on the ground. */
    this.downT = 0;
    this._hitDir = new THREE.Vector3(0, 0, 1);
    // Which shoulder a tranquillised man lands on. Alternates rather than
    // rolling dice: the screenshot harness needs the same garrison every run.
    this.downRoll = 1;
  }

  get busy() {
    return this.current !== null;
  }

  get action() {
    return this.current?.name ?? null;
  }

  /**
   * Start an action. Returns true if it took. Lower-priority requests are
   * dropped rather than queued, except that a request arriving in the last
   * 25% of a running action is queued — which is what lets a caller mash fire
   * and get a sustained rhythm instead of one shot and silence.
   */
  play(name, opts = {}) {
    const def = ACTIONS[name];
    if (!def) return false;
    const cur = this.current;
    if (cur) {
      const curDef = cur.def;
      if (def.prio < curDef.prio) {
        if (cur.t > cur.dur * 0.75 && def.prio >= curDef.prio - 2) this.queued = { name, opts };
        return false;
      }
      if (def.prio === curDef.prio && cur.t < cur.dur * 0.35 && name === cur.name) return false;
    }
    this.current = {
      name,
      def,
      t: 0,
      dur: opts.duration ?? def.dur,
      path: PATHS[def.path ?? name] ?? null,
      opts,
    };
    if (name === 'hit') this._hitDir.copy(opts.dir ?? this._hitDir).normalize();
    if (name === 'tranq') this.downRoll = opts.roll ?? -this.downRoll;
    this.queued = null;
    return true;
  }

  cancel() {
    this.current = null;
    this.queued = null;
  }

  update(dt) {
    const b = this.bone;
    for (const k in b) b[k] = 0;
    this.recoil = 0;
    this.weaponPos.set(0, 0, 0);
    this.weaponPitch = 0;
    this.weaponRoll = 0;
    this.weaponYaw = 0;
    this.weaponBlend = 0;
    this.hand.L.w = 0;
    this.hand.R.w = 0;
    this.stepZ = 0;
    this.lockLoco = false;

    const cur = this.current;
    if (!cur) {
      // The tranq pose persists after its action ends: a sleeping guard stays
      // asleep until something wakes him. Everything else returns to zero.
      if (this.downT > 0) this.lockLoco = true;
      return;
    }

    cur.t += dt;
    const t = cur.t;
    const u = clamp(t / cur.dur, 0, 1);
    if (cur.def.loco) this.lockLoco = true;

    switch (cur.name) {
      case 'fire': this._fire(t); break;
      case 'reload': this._path(cur, t, 2.40); this._reload(t); break;
      case 'cqc': this._path(cur, t, 1.25); this._cqc(t / cur.dur, 1); break;
      // Authored at 1.60 s and 25% stronger than the throw: a choke is a
      // whole-body commitment where a throw is mostly arms and a pivot.
      case 'takedown': this._path(cur, t, 1.60); this._cqc(t / cur.dur, 1.25); break;
      case 'throw': this._path(cur, t, 0.95); this._throw(t); break;
      case 'hit': this._hit(t); break;
      case 'tranq': this._tranq(u); break;
      case 'wake': this._wake(u); break;
      case 'checkWatch': this._path(cur, t, 2.40); this._checkWatch(u); break;
      default: break;
    }

    if (t >= cur.dur) {
      this.current = null;
      if (this.queued) {
        const q = this.queued;
        this.queued = null;
        this.play(q.name, q.opts);
      }
    }
  }

  /** Drive the left-wrist override from the action's authored path. */
  _path(cur, t, authoredDur) {
    if (!cur.path) return;
    const scale = cur.dur / authoredDur;
    const p = samplePath(cur.path, t / scale);
    const h = this.hand.L;
    h.pos.copy(p);
    // Ease the override in and out so the hand is never snatched off the
    // handguard — the first and last waypoints ARE the handguard, so a short
    // ramp is enough to hide the difference between the authored start point
    // and wherever the weapon actually is this frame.
    h.w = Math.min(seg(t, 0, 0.12 * scale), 1 - seg(t, cur.dur - 0.16 * scale, cur.dur));
    this.weaponBlend = Math.max(this.weaponBlend, h.w * (cur.def.weapon ?? 0));
  }

  // --- individual actions -------------------------------------------------

  /**
   * Firing recoil. A decaying oscillator, not a canned kick: the impulse is
   * sharp, the settle is springy, and the same envelope drives the weapon, the
   * shoulder and the head so they stay coherent instead of looking like three
   * separate wobbles.
   */
  _fire(t) {
    const env = Math.exp(-t * 16) * Math.cos(t * 44);
    const kick = Math.exp(-t * 26);
    this.recoil = Math.max(0, kick);
    this.weaponPos.z += kick * 0.052;      // straight back into the shoulder
    this.weaponPos.y += env * 0.014;
    this.weaponPitch += kick * 0.16 + env * 0.05;
    this.weaponRoll += env * 0.05;
    this.bone.chestX += env * 0.055;
    this.bone.spine2X += env * 0.035;
    this.bone.neckX += env * 0.03;
    this.bone.headX += env * 0.045;
    this.bone.clavRZ += -kick * 0.08;
    this.bone.rootX += env * 0.012;
  }

  _reload(t) {
    // Weapon comes in toward the body and rolls magazine-side up so the well is
    // reachable; the head drops to it and comes back.
    const inW = seg(t, 0.05, 0.3) * (1 - seg(t, 2.05, 2.35));
    this.weaponPos.z += inW * 0.075;
    this.weaponPos.y += inW * 0.045;
    this.weaponRoll += inW * 0.42;
    this.weaponPitch += inW * 0.1;
    this.bone.headX += inW * 0.2 * (1 - seg(t, 1.7, 2.0));
    this.bone.headY += inW * 0.16;
    this.bone.chestX += inW * 0.06;
    this.bone.spine2Y += inW * 0.09;
    // Seating the magazine is a physical event: the whole torso takes it.
    const slap = bump(t, 1.5, 1.64);
    this.bone.chestX += slap * 0.05;
    this.bone.rootX += slap * 0.02;
    // So is the charging handle.
    const yank = bump(t, 1.9, 2.0);
    this.bone.spine2Y -= yank * 0.07;
    this.bone.chestX += yank * 0.04;
  }

  _cqc(u, k = 1) {
    // Drive in, take the target across the body, put them down, recover.
    const drive = bump(u, 0.0, 0.5) * k;
    const twist = seg(u, 0.15, 0.55) * (1 - seg(u, 0.72, 1.0)) * k;
    const down = seg(u, 0.5, 0.78) * (1 - seg(u, 0.85, 1.0)) * k;
    this.stepZ += drive * 0.34;
    this.bone.rootX += drive * 0.18 + down * 0.2;
    this.bone.rootY += twist * 0.3;
    this.bone.spine1Y += twist * 0.24;
    this.bone.spine2Y += twist * 0.3;
    this.bone.spine2X += down * 0.28;
    this.bone.chestY += twist * 0.26;
    this.bone.chestX += down * 0.22;
    this.bone.headY += twist * 0.18;
    this.bone.headX += down * 0.16;
    this.bone.clavLZ += seg(u, 0.05, 0.25) * 0.25 * (1 - seg(u, 0.8, 1.0));
    this.weaponPos.z += twist * 0.05;
    this.weaponRoll += twist * 0.25;
  }

  _throw(t) {
    const wind = seg(t, 0.02, 0.3) * (1 - seg(t, 0.34, 0.5));
    const rel = bump(t, 0.3, 0.62);
    this.bone.rootY += -wind * 0.2 + rel * 0.16;
    this.bone.spine2Y += -wind * 0.26 + rel * 0.3;
    this.bone.chestY += -wind * 0.2 + rel * 0.26;
    this.bone.chestX += rel * 0.12;
    this.bone.clavLZ += wind * 0.3;
    this.bone.headY += rel * 0.1;
  }

  /**
   * Hit reaction. The impulse direction is world space; the animator rotates it
   * into character space before this runs, so `back` and `side` are already in
   * the character's own frame.
   */
  _hit(t) {
    const env = Math.exp(-t * 5.5) * Math.sin(t * 22.0 + 0.6) * Math.max(0, 1 - t);
    const d = this._hitDir;
    // `d` points the way the impulse travels, in character space. A round from
    // the front arrives with -z, and the torso must rock backward, so `back` is
    // its negation.
    const back = -d.z;
    const side = d.x;
    this.bone.rootX += env * back * 0.5;
    this.bone.rootZ += env * side * 0.45;
    this.bone.spine2X += env * back * 0.7;
    this.bone.spine2Z += env * side * 0.6;
    this.bone.chestX += env * back * 0.6;
    this.bone.neckX += env * back * 0.9;
    this.bone.headX += env * back * 0.7;
    this.bone.headZ += env * side * 0.5;
    this.weaponPitch += env * 0.3;
    this.weaponPos.y += env * 0.03;
  }

  /**
   * Tranquillised. A canned collapse rather than a ragdoll solver: it is
   * deterministic (the screenshot harness needs that), it costs nothing, and a
   * three-beat fold — knees go, torso follows, shoulder takes the ground —
   * reads better than most cheap ragdolls, which tend to look like a dropped
   * coat. `downT` persists after the action ends; `wake` runs it backwards.
   */
  /**
   * `downT` is the collapse progress; the resting shape itself lives in
   * `Animator._poseDown` so that the pose and the pelvis drop stay in one
   * place. What is authored here is the TIMING — knees first, then the fold,
   * then the shoulder — plus the accents that a straight interpolation to the
   * end pose cannot produce: the head lolling a beat behind the body and the
   * arms giving up before the spine does.
   */
  _tranq(u) {
    // Knees go early and the rest catches up, so the figure buckles rather than
    // deflating uniformly.
    this.downT = seg(u, 0.0, 0.86);
    this.lockLoco = true;
    const buckle = bump(u, 0.0, 0.45);
    const land = seg(u, 0.62, 1.0);
    const roll = this.downRoll;
    this.bone.rootX += buckle * 0.22;
    this.bone.neckX += seg(u, 0.3, 0.95) * 0.3;
    this.bone.headX += seg(u, 0.35, 1.0) * 0.22;
    this.bone.headZ += roll * land * 0.35;
    this.bone.clavRZ += -seg(u, 0.15, 0.6) * 0.22;
    this.bone.clavLZ += seg(u, 0.15, 0.6) * 0.22;
  }

  _wake(u) {
    this.downT = 1 - seg(u, 0.12, 0.9);
    this.lockLoco = u < 0.85;
    const push = bump(u, 0.1, 0.7);
    this.bone.rootX += push * 0.12;
    this.bone.headX += (1 - u) * 0.2;
    if (u >= 1) this.downT = 0;
  }

  _checkWatch(u) {
    const w = seg(u, 0.1, 0.28) * (1 - seg(u, 0.78, 0.96));
    this.bone.headX += w * 0.3;
    this.bone.headY += w * 0.22;
    this.bone.neckX += w * 0.16;
    this.bone.spine2Y += w * 0.08;
    this.bone.clavLZ += w * 0.14;
  }
}
