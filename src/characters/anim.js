import * as THREE from 'three';
import { Locomotion } from './locomotion.js';
import { ActionLayer } from './actions.js';

/**
 * Procedural animation.
 *
 * There are no keyframes. Every pose is computed each frame from a small set of
 * signals — the locomotion blend space, the upper-body action layer, aim, a
 * decaying hit impulse — and then resolved against the world with IK:
 *
 *  - Feet are placed by a gait function in character space, *planted* on
 *    `terrain.heightAt()`, and then LATCHED for the duration of the stance
 *    phase. The analytic gait already travels the stance foot backward at
 *    exactly body speed, which is slide-free at constant velocity; the latch is
 *    what keeps it slide-free while accelerating, decelerating and turning,
 *    which is most of the time in a game.
 *  - The hips solve against the feet: if a foot ends up further from its hip
 *    than the leg is long — a step, a slope, a kerb — the pelvis drops until it
 *    is reachable, instead of the leg silently snapping straight and the foot
 *    hovering.
 *  - The weapon has its own authored transform per state. Both arms are then
 *    solved to it — firing hand to the pistol grip, support hand to the
 *    handguard — so the rifle is locked in the hands in every state, including
 *    mid-stagger. The action layer can pull the support hand off the weapon
 *    (mag change, CQC grab, throw) by overriding that one IK target.
 *  - The upper body tracks the aim direction: the yaw between the character's
 *    facing and its aim point is distributed up the spine and into the neck,
 *    so a soldier covering an angle he is not walking toward reads correctly.
 *  - Secondary motion (breathing, idle weight shift, head look-at split across
 *    neck and head, spring-damped weapon sway, torso counter-rotation against
 *    the hips) is layered on top.
 *
 * `update(dt, ik)` takes an IK level from the LOD scheduler: 2 full, 1 without
 * the per-foot ground-normal query, 0 with the legs on pure FK. See lod.js.
 */

const clamp = THREE.MathUtils.clamp;
const smoothstep = THREE.MathUtils.smoothstep;
const lerp = THREE.MathUtils.lerp;

// -------------------------------------------------------------------------
// Rig utilities. Each uses its own scratch so nested calls cannot alias.
// -------------------------------------------------------------------------

const _swq = new THREE.Quaternion();
function setWorldQuaternion(bone, q) {
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_swq);
    bone.quaternion.copy(_swq.invert()).multiply(q);
  } else {
    bone.quaternion.copy(q);
  }
  // Bones run with `matrixAutoUpdate = false` (see Character), so the local
  // matrix has to be composed by hand before the world update can use it.
  bone.updateMatrix();
  bone.updateMatrixWorld(true);
}

const _abq = new THREE.Quaternion();
const _abd = new THREE.Quaternion();
const _abv = new THREE.Vector3();
const _abt = new THREE.Vector3();
/** Rotate `bone` so its child axis points along `dirWorld`, preserving twist. */
function aimBone(bone, dirWorld) {
  bone.getWorldQuaternion(_abq);
  _abv.copy(bone.userData.axis).applyQuaternion(_abq);
  _abt.copy(dirWorld).normalize();
  _abd.setFromUnitVectors(_abv, _abt);
  setWorldQuaternion(bone, _abd.multiply(_abq));
}

const _A = new THREE.Vector3();
const _u = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _knee = new THREE.Vector3();
const _ikd = new THREE.Vector3();
/** Analytic two-bone IK; `pole` chooses which way the joint bends. */
export function twoBoneIK(root, mid, target, pole, l1, l2) {
  root.getWorldPosition(_A);
  _u.subVectors(target, _A);
  let D = _u.length();
  if (D < 1e-5) return;
  _u.divideScalar(D);
  D = clamp(D, Math.abs(l1 - l2) + 0.02, l1 + l2 - 0.004);
  const cosA = clamp((l1 * l1 + D * D - l2 * l2) / (2 * l1 * D), -1, 1);
  const a = Math.acos(cosA);

  _pv.subVectors(pole, _A);
  _pv.addScaledVector(_u, -_pv.dot(_u));
  if (_pv.lengthSq() < 1e-8) _pv.set(0, 1, 0).addScaledVector(_u, -_u.y);
  _pv.normalize();

  _knee.copy(_A).addScaledVector(_u, l1 * Math.cos(a)).addScaledVector(_pv, l1 * Math.sin(a));
  aimBone(root, _ikd.subVectors(_knee, _A));
  mid.getWorldPosition(_A);
  aimBone(mid, _ikd.subVectors(target, _A));
}

const _fa1 = new THREE.Vector3();
const _fa2 = new THREE.Vector3();
const _fa3 = new THREE.Vector3();
const _fb1 = new THREE.Vector3();
const _fb2 = new THREE.Vector3();
const _fb3 = new THREE.Vector3();
const _ma = new THREE.Matrix4();
const _mb = new THREE.Matrix4();
/** Quaternion taking the axis pair (a1,a2) onto (b1,b2). */
export function quatFromAxisPair(a1, a2, b1, b2, out) {
  _fa1.copy(a1).normalize();
  _fa2.copy(a2).addScaledVector(_fa1, -a2.dot(_fa1)).normalize();
  _fa3.crossVectors(_fa1, _fa2);
  _fb1.copy(b1).normalize();
  _fb2.copy(b2).addScaledVector(_fb1, -b2.dot(_fb1)).normalize();
  _fb3.crossVectors(_fb1, _fb2);
  _ma.makeBasis(_fa1, _fa2, _fa3).transpose();
  _mb.makeBasis(_fb1, _fb2, _fb3);
  return out.setFromRotationMatrix(_mb.multiply(_ma));
}

// -------------------------------------------------------------------------
// Weapon poses, authored in character space (feet at origin, facing -Z).
// -------------------------------------------------------------------------

function weaponPose(pos, dir) {
  return { pos: new THREE.Vector3(...pos), dir: new THREE.Vector3(...dir).normalize() };
}

const WEAPON_POSES = {
  // Low ready.
  //
  // ROUND 6. Round 5 carried the grip at [0.105, 1.305, -0.225], which is
  // 0.27 m from the right shoulder ball against a 0.57 m arm — 47% extension,
  // i.e. both elbows fully folded and crushed against the ribs. Measured on the
  // shipped gameplay frame with a flat-mask silhouette render: NEITHER ARM
  // APPEARED IN THE OUTLINE AT ALL. The body was one unbroken blob from the
  // skull to the knees with a rifle apparently glued to the side of it, and
  // that — not absent geometry, the arms have been modelled since round 2 — is
  // what every critic has been reading as "no arms".
  //
  // A real low ready holds the grip about two thirds of reach out from the
  // shoulder, muzzle depressed ~25 degrees, so the forearms make a visible
  // triangle with the weapon. 0.39 m here, i.e. 68% extension.
  //
  // The second half of the same fix is WHICH WAY the arm points. Extending the
  // arm is not enough if it extends along the view axis: measured with a
  // limb-presentation probe (screen length / true length at that depth) the
  // first pass at this pose gave upper arm 1.01 but forearm 0.48 — the firing
  // hand ended up 239 mm further from the lens than the elbow, so a 272 mm
  // forearm drew as an 82 px stub. Pulling the grip toward the character's
  // right and back rotates that segment into the image plane without
  // shortening the reach, because on this camera the character's own "right"
  // runs almost straight back at the lens (dot -0.83 with the view direction).
    //
  // Carried at 1.15 m, not 1.25. At chest height the firing upper arm has to
  // swing FORWARD and UP to reach the grip, which on a figure seen from behind
  // lays it diagonally across the chest rig — it covers the kit, it hides the
  // weapon directly behind itself, and because it is then pointing partly at
  // the lens it draws as one fat featureless tube with no elbow in it. Dropped
  // to waist height the upper arm hangs close to vertical alongside the ribs,
  // which is both what a real low ready looks like from behind and the pose
  // that puts the longest, best-presented segment of the limb into the
  // silhouette. It also drops the receiver and magazine clear of the arm, so
  // the weapon is visible instead of eclipsed.
  ready: weaponPose([0.178, 1.148, -0.292], [-0.36, -0.46, -0.81]),
  // Shouldered.
  //
  // ROUND 12. This was [0.115, 1.4, -0.3], and on the over-the-shoulder camera
  // it put nearly all of the weapon behind the man holding it. `probes/
  // r12_ads.js` traces the lens to eleven points along the grip-to-muzzle line:
  // NINE OF ELEVEN were behind his own body, the first blocker being his right
  // deltoid at char (0.17, 1.42, 0.13), 0.37 m in front of the barrel. What the
  // player could see of his weapon was the magazine and the top of the receiver
  // over the shoulder — "the gun is not very visible", exactly.
  //
  // THAT FIGURE STARTED OUT AS ELEVEN OF ELEVEN AND THAT NUMBER WAS WRONG.
  // The rifle is welded into the character's own skinned geometry, so the naive
  // ray-to-the-muzzle test hits the SUPPRESSOR on the way in and calls every
  // sample occluded no matter where the weapon is. The probe now classifies by
  // how far in front of the sample the blocker sits. The same caveat applies to
  // the map below, which is drawn with the same skin: it can tell "his body is
  // in the way here" from "nothing is", but a cell it marks blocked may be
  // blocked by the weapon itself.
  //
  // `probes/r12_clear.js` maps where the weapon is allowed to be. From this
  // lens the clear region starts at y = 1.55 for anything inboard of x = 0.20,
  // and at chest height (y = 1.35-1.45) nothing inboard of x = 0.30 is visible
  // at all. The old pose sat at (0.115, 1.40) — dead in the blocked band. With
  // the pose below and the round-12 camera the same eleven-point trace comes
  // back 0 of 11.
  //
  // 1.545 is also the anatomically correct height and the old one was not: the
  // pose origin is on the BORE, and a shouldered weapon puts the bore an inch
  // or two under the aiming eye, not level with the sternum. At 1.40 the butt
  // pad measured 0.076 m from the shoulder ball — technically shouldered — with
  // the whole weapon slung below the shoulder line like a hip carry with the
  // stock touching. 0.145 m up and 0.05 m outboard is a cheek weld.
  aim: weaponPose([0.166, 1.545, -0.28], [-0.03, -0.02, -1.0]),
  // AIMED FROM A CROUCH, and AIMED FROM PRONE.
  //
  // There was one aim pose and it was the standing one. `_weaponTargetPose`
  // scales every stance carry by `base = 1 - aim`, so at full aim the stance
  // term is multiplied by zero and this single pose is all that survives —
  // whatever the man's body is doing. Reported as "the gun is floating in the
  // air at standing position and the hands dangle way up overhead", which is
  // exactly what it is. Measured, in root space, with the stance blend at 1:
  //
  //   stance        shoulder   head    BORE     hand
  //   stand+aim       1.487    1.617   1.545    1.544   <- correct
  //   crouch+aim      1.141    1.263   1.545    1.539   <- 0.28 above his head
  //   prone+aim       0.481    0.604   1.545    1.067   <- 1.06 above the shoulder
  //
  // What makes the standing pose read as a cheek weld is where it sits BETWEEN
  // those two bones: 0.058 above the shoulder and 0.072 under the head. Both
  // poses below hold that same relationship against the shoulder and head the
  // stance actually produces, which is why they are these numbers and not
  // rounder ones.
  //
  // The arms are two-bone-IK'd to this matrix, so getting the height wrong does
  // not merely look wrong, it drags the hands off the body — 1.539 is a crouched
  // man's hand above his own skull.
  //
  // z: a crouched shooter holds much the same extension as a standing one, so
  // -0.27 against the standing -0.28. Prone goes further forward (-0.42, near
  // the prone carry's -0.4) because the elbows are down and the weapon is out
  // over them, and inboard in x because a prone shooter is square behind it
  // rather than bladed.
  aimCrouch: weaponPose([0.166, 1.195, -0.27], [-0.03, -0.02, -1.0]),
  aimProne: weaponPose([0.140, 0.535, -0.42], [-0.03, 0.00, -1.0]),
  // Crouched carry sits lower and tighter to the body.
  crouch: weaponPose([0.13, 1.09, -0.19], [-0.4, -0.42, -0.82]),
  // Prone: weapon on the ground ahead, elbows down.
  prone: weaponPose([0.1, 0.33, -0.4], [-0.05, 0.04, -1.0]),
  // Sprint: carried diagonally across the chest, muzzle down-left.
  sprint: weaponPose([0.115, 1.13, -0.2], [-0.5, -0.52, -0.69]),
};

/**
 * Elbow poles in character space: +x outboard, +z behind, y up.
 *
 * The z term is the one that has to be measured rather than reasoned about. On
 * the gameplay camera the world direction that maps to screen-RIGHT is
 * (0.81, 0, -0.57); the character's own "backward" maps onto it at -0.83, so
 * every centimetre the firing elbow goes BACK is 0.8 cm further behind the
 * torso in screen space. A first pass at this used +0.26 (an anatomically
 * reasonable chicken-wing) and tucked the elbow straight back behind the ribs
 * where it contributed nothing to the outline. Near-neutral in z and hard
 * outboard in x is what puts it against open background.
 */
const _POLE_R = new THREE.Vector3(0.50, -0.16, 0.02);
const _POLE_L = new THREE.Vector3(0.36, -0.20, -0.02);

/**
 * Deterministic per-instance phase offsets.
 *
 * This used to be `Math.random()`, which meant the idle weight shift, the
 * breathing phase and the head sweep of every character in the scene were a
 * different number on every page load — so the "byte-reproducible screenshot"
 * the harness is built around was never actually byte-reproducible for anything
 * with a person in it, and A/B comparisons of character work were being read
 * through that noise. A counter-based hash keyed on construction order gives
 * the same spread with none of that.
 */
let _instanceSeq = 0;
function instanceNoise() {
  const n = ++_instanceSeq;
  let h = (n * 2654435761) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return [(h & 0xffff) / 65536, ((h >>> 16) & 0xffff) / 65536];
}

// -------------------------------------------------------------------------
// Animator
// -------------------------------------------------------------------------

export class Animator {
  constructor(ch, terrain) {
    this.ch = ch;
    this.terrain = terrain;
    this.rig = ch.rig;
    this.b = Object.fromEntries(ch.rig.bones.map((b) => [b.name, b]));

    const [r0, r1] = instanceNoise();
    this.loco = new Locomotion(this);
    this.actions = new ActionLayer(this);
    this.loco.phase = r0;
    this.t = r1 * 40;
    this.breath = r0 * 10;

    /** 0..1 weapon-shouldered blend. Assign directly, or drive via `aimGoal`. */
    this.aim = 0;
    this.aimGoal = null;
    /** `aim` after the action layer has pulled the weapon out of the shoulder. */
    this._aimEff = 0;
    this.aimTarget = new THREE.Vector3();
    this.aimActive = false;
    this.lookTarget = null;
    this.lookBlend = new THREE.Vector2();
    this.torsoAim = new THREE.Vector2(); // smoothed (yaw, pitch) toward the aim point
    this.bobY = 0;
    this.hipDrop = 0;
    this.lungeZ = 0;
    // Ground-normal LOD. `_placeRoot` and `_solveFeet` between them ask the
    // terrain for FIFTEEN heights per character per frame, and eleven of those
    // are the four-tap finite-difference normals behind two facts that stop
    // being visible almost immediately: which way the whole figure tilts on the
    // slope, and how each sole conforms to the ground under it.
    //
    // Measured against the pixel: a 1.86 m soldier standing on a 15-degree
    // slope tilts his crown 0.11 m out of vertical at full strength; at 25 m
    // that is 3.6 px and at 60 m it is 1.5 px, and the sole conform term is a
    // quarter of that. Set by the LOD band in index.js; when it is on, both are
    // dropped and the root sits level, which costs 11 of the 15 terrain
    // queries per character per frame.
    this.coarse = false;
    this.weaponSway = new THREE.Vector3();
    this.weaponSwayVel = new THREE.Vector3();
    /**
     * The carry sway, as an ANGLE triple (pitch, yaw, roll) about the chest
     * rather than a translation of the grip. See `_solveWeapon` for why it is
     * expressed that way; the short version is that a rotation about the chest
     * costs the arms nothing, and a translation of the grip costs them all of
     * it.
     */
    this.carryAng = new THREE.Vector3();
    this.carryAngVel = new THREE.Vector3();
    /** Accumulated gait rotation at the chest, written by `_poseBody`. */
    this._gaitYaw = 0;
    this._gaitRoll = 0;
    /**
     * Locomotion's own wrist override, parallel to the action layer's. The
     * action layer wins where the two overlap — a magazine change during a
     * sprint is still a magazine change.
     */
    this.locoHand = { L: { w: 0, pos: new THREE.Vector3() }, R: { w: 0, pos: new THREE.Vector3() } };

    const bw = ch.rig.bindWorld;
    this.armLen = { upper: bw.get('armR').distanceTo(bw.get('forearmR')), lower: bw.get('forearmR').distanceTo(bw.get('handR')) };
    this.legLen = { upper: bw.get('upLegR').distanceTo(bw.get('lowLegR')), lower: bw.get('lowLegR').distanceTo(bw.get('footR')) };
    this.legReach = this.legLen.upper + this.legLen.lower;

    this.footTargets = {
      R: { pos: new THREE.Vector3(), lock: new THREE.Vector3(), planted: false, ground: 0 },
      L: { pos: new THREE.Vector3(), lock: new THREE.Vector3(), planted: false, ground: 0 },
    };
    this._lastPos = new THREE.Vector3(NaN, NaN, NaN);
    this._weaponM = new THREE.Matrix4();
    this._basisM = new THREE.Matrix4();
    this._chestM = new THREE.Matrix4();
    /** root * chest — the frame the weapon pose is authored in, in world. */
    this._parentM = new THREE.Matrix4();
    this._invM = new THREE.Matrix4();
    this._gripW = new THREE.Vector3();
    /**
     * THE BORE IS NOT THE POSE AXIS, and assuming it was cost 7.0 degrees.
     *
     * A weapon pose's `dir` is where the rifle's local +x points, and the line
     * the round leaves on is grip-centre to muzzle — which on this model is
     * (0.663, 0.087, 0), i.e. 7.5 degrees ABOVE local +x, because the grip
     * hangs below the barrel. Pointing `dir` straight at the target therefore
     * left the barrel 7.0 degrees high, which is most of what was left of the
     * misalignment after the yaw was fixed (0.4 deg flat, 7.0 deg in pitch).
     * Measured off the model's own anchors so it follows the next weapon.
     */
    this._borePitch = 0;
    this._boreYaw = 0;
    {
      const rf = ch.rifle;
      if (rf?.muzzle && rf?.gripCenter) {
        const v = rf.muzzle.clone().sub(rf.gripCenter);
        this._borePitch = Math.atan2(v.y, Math.hypot(v.x, v.z));
        this._boreYaw = Math.atan2(-v.z, v.x);
      }
    }
    /** Chest joint centre in character space — the pivot the carry hangs off. */
    this._chestPivot = ch.rig.bindWorld.get('chest').clone();
    this._eul = new THREE.Euler(0, 0, 0, 'YXZ');
    this._qc = new THREE.Quaternion();
    this._vc = new THREE.Vector3();

    // Per-instance scratch (an Animator is only ever ticked from one place).
    this._p = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._t1 = new THREE.Vector3();
    this._t2 = new THREE.Vector3();
    this._t3 = new THREE.Vector3();
    this._t4 = new THREE.Vector3();
    this._t5 = new THREE.Vector3();
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  // --- compatibility surface ---------------------------------------------
  // Locomotion owns the gait state now, but `anim.speed` / `anim.stance` were
  // the public handles for three rounds and the outpost/gameplay code still
  // uses them. Forward rather than break callers.
  get speed() { return this.loco.velocity.length(); }
  set speed(v) {
    const y = this.ch.yaw;
    this.loco.velocity.set(-Math.sin(y) * v, 0, -Math.cos(y) * v);
  }
  get smoothSpeed() { return this.loco.smoothSpeed; }
  get stance() { return this.loco.stance; }
  set stance(s) { this.loco.setStance(s); }
  get stanceBlend() { return this.loco.stanceBlend; }
  get proneBlend() { return this.loco.proneBlend; }
  get downBlend() { return this.loco.downBlend; }
  get phase() { return this.loco.phase; }
  get gaitCycle() { return this.loco.cycle; }
  get action() { return this.actions.action; }
  /**
   * INTEGRATION SEAM. `src/gameplay` writes `anim.action` every frame as one of
   * its declared animation channels ('none'|'takedown'|'grab'|'drag'|'cover'),
   * while this class had only a getter — and assigning to a getter-only accessor
   * throws in a module's strict mode. It threw inside Stealth.pose(), which runs
   * BEFORE PlayerController.update() in the same system callback, so the throw
   * took the controller with it: 2021 exceptions in one session and a player who
   * could aim and fire but could not walk, crouch or go prone.
   *
   * The two `action` namespaces are genuinely different — this one is the action
   * LAYER's clip state ('fire', 'reload', 'hit'), gameplay's is a verb intent —
   * so the setter records the intent and deliberately does NOT poke
   * `actions.action`, which would corrupt a running clip. gameplay's contract
   * says the channel is additive and nothing needs to read it back, so parking
   * it here costs nothing and keeps the getter honest.
   */
  set action(v) { this.intentAction = v; }

  /**
   * The weapon's world transform — rifle space to world.
   *
   * PUBLISHED, because the alternative was worse. `_weaponM` has existed since
   * round 6 and was private, so gameplay had no way to ask where the barrel
   * was: `Stealth.muzzlePoint` took the right hand's bone and pushed a derived
   * reach down the line the DART is on, which is not the line the barrel is on
   * and does not start where the barrel starts. Measured on the aimed pose that
   * landed the flash 0.112 m from the model's own muzzle — 40-60 px on screen
   * at this range, i.e. the flash visibly came out of the wrong place.
   *
   * Read-only by contract: it is rebuilt from scratch every `_solveWeapon`, so
   * writing to it is silently discarded on the next frame.
   */
  get weaponMatrix() {
    return this._weaponM;
  }

  /**
   * Where the barrel actually ends, in world space. `null` if this character
   * publishes no weapon anchors, so callers can keep their own fallback.
   */
  muzzleWorld(out) {
    const m = this.ch.rifle?.muzzle;
    if (!m) return null;
    return out.copy(m).applyMatrix4(this._weaponM);
  }

  /** World-space impulse direction (pointing away from the shooter). */
  hit(dir) {
    this._t1.copy(dir ?? this._up).setY(0);
    if (this._t1.lengthSq() < 1e-6) this._t1.set(0, 0, 1);
    this._t1.normalize().applyAxisAngle(this._up, -this.ch.yaw);
    this.actions.play('hit', { dir: this._t1.clone() });
  }

  play(name, opts) {
    return this.actions.play(name, opts);
  }

  update(dt, ik = 2) {
    if (dt > 0.25) dt = 0.25; // a long LOD gap must not launch the gait forward
    this.t += dt;
    this.breath += dt;

    this.actions.update(dt);
    this.loco.forcedDown = this.actions.downT;
    this.loco.update(dt);

    if (this.aimGoal !== null) this.aim += (this.aimGoal - this.aim) * Math.min(1, dt * 7);
    // Reload, CQC and a throw take the weapon out of the shoulder whatever the
    // caller asked for; `aim` itself is left alone so it springs back after.
    const aimEff = this.aim * (1 - this.actions.weaponBlend);
    this._aimEff = aimEff;
    this.lungeZ += (this.actions.stepZ - this.lungeZ) * Math.min(1, dt * 10);

    // A teleport (spawn, respawn, a gameplay warp) must not drag the planted
    // feet across the map behind the body.
    if (!(Math.abs(this.ch.position.x - this._lastPos.x) < 1.6 && Math.abs(this.ch.position.z - this._lastPos.z) < 1.6)) {
      this.footTargets.R.planted = false;
      this.footTargets.L.planted = false;
      this.hipDrop = 0;
    }
    this._lastPos.copy(this.ch.position);

    const grounded = this.loco.downBlend < 0.55 && this.loco.proneBlend < 0.7;
    const legIK = ik > 0 && grounded;

    this._resetPose();
    this._poseBody();
    if (!legIK) this._fkLegs(grounded);
    this._placeRoot(dt);
    this._composeAll();
    this.ch.root.updateMatrixWorld(true);
    if (legIK) this._solveFeet(ik, dt);
    this._solveWeapon(dt);
    this._headLook(dt, ik);
    // Tell the gated Skeleton.update() that the bone texture is stale. Frames
    // on which the LOD scheduler skipped this character never raise it, so its
    // 27 bone matrices are not rebuilt and re-uploaded for a pose that did not
    // move. See gateSkeleton() in lod.js.
    this.rig.skeleton.poseDirty = true;
  }

  _resetPose() {
    for (const b of this.rig.bones) {
      b.quaternion.identity();
      b.position.copy(b.userData.rest);
    }
  }

  /** Compose every local matrix once, after all FK writes and before the
   *  single world update. Replaces the renderer doing it every frame. */
  _composeAll() {
    this.ch.root.updateMatrix();
    for (const b of this.rig.bones) b.updateMatrix();
  }

  // --- body FK -----------------------------------------------------------
  _poseBody() {
    const b = this.b;
    const L = this.loco;
    const A = this.actions.bone;
    const ph = L.phase * Math.PI * 2;
    const moving = L.moving;
    const run = L.run01;
    const crouch = L.stanceBlend;
    const prone = L.proneBlend;
    const down = L.downBlend;
    const aim = this._aimEff ?? this.aim;

    const breathRate = lerp(0.26, 0.8, run);
    const br = Math.sin(this.breath * Math.PI * 2 * breathRate);
    const breathAmp = lerp(0.012, 0.032, run) * (1 - moving * 0.35);

    const shift = Math.sin(this.t * 0.9) * (1 - moving) * (1 - prone);
    const shift2 = Math.sin(this.t * 0.62 + 1.1) * (1 - moving) * (1 - prone);

    const hipYaw = Math.sin(ph) * lerp(0.1, 0.19, run) * moving;
    const hipRoll = Math.cos(ph) * lerp(0.045, 0.075, run) * moving + shift * 0.035;
    const lean = lerp(0.03, 0.22, run) * moving + crouch * 0.17 + aim * 0.05 + L.sprint01 * 0.1;

    b.root.rotation.set(lean * 0.25 + A.rootX, hipYaw + shift2 * 0.03 + A.rootY - L.turnLead * 0.25, hipRoll + A.rootZ);

    const chestYaw = -Math.sin(ph) * lerp(0.13, 0.24, run) * moving;
    const bladed = -0.5 * aim;
    // Upper body tracks the aim direction: the yaw between where the feet point
    // and where the weapon points is spread up the spine, weighted toward the
    // chest, and the shoulders finish the job. This is the whole difference
    // between a soldier covering a corner and a soldier facing a corner.
    const ty = this.torsoAim.x;
    const tp = this.torsoAim.y;
    b.spine1.rotation.set(
      lean * 0.3 + breathAmp * br * 0.2 + tp * 0.14 + A.spine1X,
      hipYaw * -0.25 + chestYaw * 0.3 + bladed * 0.2 - shift * 0.02 + ty * 0.2 + L.turnLead * 0.3 + A.spine1Y,
      -hipRoll * 0.25 + A.spine1Z,
    );
    b.spine2.rotation.set(
      lean * 0.3 + breathAmp * br * 0.4 + tp * 0.2 + A.spine2X,
      chestYaw * 0.35 + bladed * 0.35 + ty * 0.28 + L.turnLead * 0.35 + A.spine2Y,
      -hipRoll * 0.3 + A.spine2Z,
    );
    b.chest.rotation.set(
      lean * 0.2 - breathAmp * br * 0.7 + crouch * 0.06 + tp * 0.22 + A.chestX,
      chestYaw * 0.35 + bladed * 0.45 + ty * 0.32 + L.turnLead * 0.35 + A.chestY,
      -hipRoll * 0.3 + shift2 * 0.02 + A.chestZ,
    );

    // How much of the GAIT has arrived at the chest by the time the chain gets
    // there. Summed here, from the same four writes above, so there is exactly
    // one definition of it: root(1.0) + spine1(-0.25) for the hip term, and
    // spine1(0.30) + spine2(0.35) + chest(0.35) for the contralateral term.
    //
    // `_solveWeapon` hangs the rifle off this. Only the gait is collected — not
    // `bladed`, not `torsoAim`, not `turnLead`. Anchoring the weapon to
    // `b.chest.matrixWorld` outright is the obvious move and it is wrong: at
    // full aim `bladed` alone is -0.5 rad of shoulder blading spread across the
    // spine, so a weapon parented to the chest would swing 28 degrees off the
    // aim point the moment the player shoulders it.
    this._gaitYaw = hipYaw * 0.75 + chestYaw;
    this._gaitRoll = hipRoll * 0.15;

    b.clavR.rotation.set(-breathAmp * br * 0.5, -aim * 0.14, -aim * 0.1 - breathAmp * br * 0.3 + A.clavRZ);
    b.clavL.rotation.set(-breathAmp * br * 0.5, aim * 0.24, aim * 0.1 + breathAmp * br * 0.3 + A.clavLZ);

    b.neck.rotation.set(-lean * 0.5 - crouch * 0.08 - aim * 0.06 + A.neckX, 0, 0);
    b.head.rotation.set(-lean * 0.35 + aim * 0.12 + A.headX, A.headY, A.headZ);

    if (prone > 0.001) this._poseProne(prone);
    if (down > 0.001) this._poseDown(down);
  }

  _poseProne(w) {
    const b = this.b;
    b.root.rotation.x += -1.42 * w;
    b.spine1.rotation.x += 0.12 * w;
    b.spine2.rotation.x += 0.24 * w;
    b.chest.rotation.x += 0.3 * w;
    b.neck.rotation.x += 0.55 * w;
    b.head.rotation.x += 0.5 * w;
    const ph = this.loco.phase * Math.PI * 2;
    const crawl = smoothstep(this.loco.smoothSpeed, 0.05, 0.6);
    b.upLegR.rotation.z += (0.24 + Math.sin(ph) * 0.3 * crawl) * w;
    b.upLegL.rotation.z += (-0.24 - Math.sin(ph) * 0.3 * crawl) * w;
    b.lowLegR.rotation.x += (-0.4 - Math.max(0, Math.sin(ph)) * 0.9 * crawl) * w;
    b.lowLegL.rotation.x += (-0.4 - Math.max(0, -Math.sin(ph)) * 0.9 * crawl) * w;
  }

  /**
   * The tranquillised heap. `downBlend` carries the collapse over ~1.7 s
   * (driven by the tranq action) and then holds; the legs fold under, the spine
   * curls and the whole figure ends up on its side. No solver: a canned fold is
   * deterministic, costs four rotation writes, and does not require a physics
   * step in a game that has none.
   */
  _poseDown(w) {
    const b = this.b;
    const roll = this.actions.downRoll || 1;
    b.root.rotation.x += -1.35 * w;
    b.root.rotation.z += roll * 0.55 * w;
    b.spine1.rotation.x += 0.2 * w;
    b.spine2.rotation.x += 0.3 * w;
    b.chest.rotation.x += 0.22 * w;
    b.neck.rotation.x += 0.4 * w;
    b.head.rotation.x += 0.35 * w;
    b.upLegR.rotation.x += 0.55 * w;
    b.upLegL.rotation.x += 0.34 * w;
    b.lowLegR.rotation.x += -1.15 * w;
    b.lowLegL.rotation.x += -0.75 * w;
    b.upLegR.rotation.z += 0.18 * w;
    b.upLegL.rotation.z += -0.1 * w;
  }

  // --- root placement ----------------------------------------------------
  _placeRoot(dt) {
    const ch = this.ch;
    const t = this.terrain;
    const L = this.loco;
    const ph = L.phase * Math.PI * 2;
    const run = L.run01;

    const bob = -Math.abs(Math.cos(ph)) * lerp(0.022, 0.055, run) * L.moving;
    this.bobY += (bob - this.bobY) * Math.min(1, dt * 18);

    // A CQC lunge moves the whole rig forward without moving the actor's
    // logical position — gameplay's idea of where this soldier stands must not
    // be perturbed by an animation.
    const lz = this.lungeZ;
    const px = ch.position.x - Math.sin(ch.yaw) * lz;
    const pz = ch.position.z - Math.cos(ch.yaw) * lz;
    const groundY = t ? t.heightAt(px, pz) : 0;
    ch.groundY = groundY;
    ch.root.position.set(px, groundY, pz);
    ch.root.rotation.set(0, ch.yaw, 0);

    const stanceDrop = L.stanceBlend * 0.34 + L.proneBlend * 0.72 + L.downBlend * 0.86;
    this.b.root.position.y = this.b.root.userData.rest.y - stanceDrop + this.bobY - this.hipDrop;
    // Contrapposto while idle: the pelvis drops toward the unweighted leg.
    const idleW = 1 - L.moving;
    this.b.root.position.y -= idleW * 0.012 * (0.5 + 0.5 * Math.sin(this.t * 0.9));
    if (L.proneBlend > 0.001) this.b.root.position.z += L.proneBlend * 0.07;

    if (t && !this.coarse) {
      const n = t.normalAt(px, pz, 0.9);
      const fx = -Math.sin(ch.yaw);
      const fz = -Math.cos(ch.yaw);
      ch.root.rotation.x = Math.asin(clamp(-(n.x * fx + n.z * fz), -0.5, 0.5)) * 0.75;
      ch.root.rotation.z = Math.asin(clamp(n.x * fz - n.z * fx, -0.5, 0.5)) * 0.75;
    }
  }

  // --- feet --------------------------------------------------------------
  /**
   * Plant both feet and solve the legs.
   *
   * `ik` 2 samples the ground normal under each foot so the sole rolls with the
   * slope; `ik` 1 skips that (four extra height queries per foot per frame that
   * are worth nothing past ~30 m) and keeps everything else.
   */
  _solveFeet(ik, dt) {
    const ch = this.ch;
    const t = this.terrain;
    const L = this.loco;
    const moving = L.moving;
    const cycle = L.cycle;
    const duty = L.duty;
    const stride = L.stride;
    const lift = L.lift * moving;
    const stanceWidth = lerp(0.098, 0.086, L.run01) + L.stanceBlend * 0.03 + L.proneBlend * 0.1;

    const cosY = Math.cos(ch.yaw);
    const sinY = Math.sin(ch.yaw);
    const scale = ch.root.scale.x || 1;
    let need = 0;

    for (const side of ['R', 'L']) {
      const sgn = side === 'R' ? 1 : -1;
      const ft = this.footTargets[side];
      const p = (L.phase + (side === 'L' ? 0.5 : 0)) % 1;

      let fwd = 0;
      let up = 0;
      let toeLift = 0;
      const stancePhase = p < duty;
      if (stancePhase) {
        fwd = stride * (0.5 - p / duty);
        const u = p / duty;
        toeLift = -0.38 * smoothstep(u, 0.55, 1.0) + 0.2 * (1 - smoothstep(u, 0.0, 0.3));
      } else {
        const u = (p - duty) / (1 - duty);
        fwd = stride * (-0.5 + smoothstep(u, 0, 1));
        up = Math.sin(u * Math.PI) * lift;
        toeLift = Math.sin(u * Math.PI) * 0.45 - 0.2;
      }
      fwd *= moving;
      toeLift *= moving;

      // A turn-in-place pivot step lifts one foot clear and lets it re-plant at
      // the new stance position under the rotated body.
      const pivot = L.pivotLift(side);
      if (pivot > 0) {
        up += pivot * 0.055;
        toeLift += pivot * 0.25;
      }

      // Idle stance is deliberately ASYMMETRIC: one foot forward, weight on the
      // other, both toes turned out, and a slow drift between them. Two feet
      // planted square is the single loudest "this is a mannequin" cue there is.
      const idle = 1 - moving;
      const drift = Math.sin(this.t * 0.55 + (side === 'R' ? 0 : 1.7));
      const idleShift = idle * Math.sin(this.t * 0.9) * 0.012 * sgn;
      const lx = sgn * stanceWidth + idleShift;
      const lzo = -fwd + L.proneBlend * 0.34 + idle * (sgn > 0 ? -0.075 : 0.085) + idle * drift * 0.012 + this.lungeZ;
      let wx = ch.position.x + lx * cosY + lzo * sinY;
      let wz = ch.position.z - lx * sinY + lzo * cosY;

      // --- the plant latch -------------------------------------------------
      // The analytic stance path above travels backward at exactly body speed,
      // which is slide-free only while that speed is constant. Latching the
      // world position at touchdown makes it slide-free unconditionally: under
      // acceleration the body runs ahead of the planted foot (which is what a
      // push-off IS), and under a turn the foot stays where it was put instead
      // of being dragged around the pivot. Released over the last sixth of the
      // stance so the foot is already moving when it leaves the ground.
      if (stancePhase && moving > 0.02 && pivot === 0) {
        if (!ft.planted) {
          ft.planted = true;
          ft.lock.set(wx, 0, wz);
        }
        const rel = smoothstep(p / duty, 0.82, 1.0);
        wx = lerp(ft.lock.x, wx, rel);
        wz = lerp(ft.lock.z, wz, rel);
      } else {
        ft.planted = false;
      }

      const g = t ? t.heightAt(wx, wz) : 0;
      ft.pos.set(wx, g + 0.082 * scale + up, wz);
      ft.ground = g;

      const hip = this.b[side === 'R' ? 'upLegR' : 'upLegL'];
      const knee = this.b[side === 'R' ? 'lowLegR' : 'lowLegL'];
      const foot = this.b[side === 'R' ? 'footR' : 'footL'];

      // How far BELOW the body's own ground plane did this foot end up? That
      // — not the raw hip-to-foot distance — is what the pelvis owes.
      //
      // A first pass measured "distance from hip to foot, minus leg length" and
      // it was wrong in a way worth recording: at a jog the stride is 1.2 m, so
      // at each end of the stance the foot is 0.6 m fore or aft of the hip and
      // the straight-line distance exceeds the 0.86 m leg by 19 cm through
      // GEOMETRY ALONE, on dead flat ground. The pelvis would then have bobbed
      // 19 cm twice per stride: a running squat. Stride extension is the gait's
      // business and the IK's reach clamp already absorbs it. The pelvis is
      // only responsible for TERRAIN — a step, a kerb, a side slope — which is
      // exactly the vertical difference between where a foot had to be planted
      // and where flat ground under the body would have put it.
      //
      // Measured here and applied on the NEXT frame: one frame of lag on a
      // quantity that changes at walking pace is invisible, and solving it in
      // place would need a second full matrix update of the character.
      if (stancePhase || moving < 0.05) {
        const below = (ch.groundY - ft.ground) / scale;
        if (below > need) need = below;
      }

      hip.getWorldPosition(this._t1);
      const poleF = 0.95 + L.stanceBlend * 0.35;
      this._t2.set(
        this._t1.x - sinY * poleF + sgn * 0.14 * L.stanceBlend,
        this._t1.y - 0.28,
        this._t1.z - cosY * poleF,
      );
      twoBoneIK(hip, knee, ft.pos, this._t2, this.legLen.upper * scale, this.legLen.lower * scale);

      // Sole follows the ground plane while planted, rolls through the swing.
      // Toe-out: about 12 degrees each way when standing, closing up at speed.
      const toeOut = (sgn * (0.21 * (1 - moving) + 0.05)) * (1 - L.proneBlend);
      const ca = Math.cos(ch.yaw + toeOut);
      const sa = Math.sin(ch.yaw + toeOut);
      const axis = foot.userData.axis;
      this._t3.set(axis.x * ca + axis.z * sa, axis.y, -axis.x * sa + axis.z * ca);
      if (t && ik >= 2 && stancePhase && !this.coarse) {
        const n = t.normalAt(ft.pos.x, ft.pos.z, 0.6);
        this._qa.setFromUnitVectors(this._up, n);
        this._t3.applyQuaternion(this._qa);
      }
      this._t3.y += toeLift;
      aimBone(foot, this._t3);
    }

    // --- hip adjustment ----------------------------------------------------
    // A 15 mm deadband keeps the micro-relief in the heightfield out of it: on
    // flat ground the bind pose is already within a centimetre of full leg
    // extension, and reacting to every 5 mm ripple would give every character a
    // permanent, faintly seasick squat.
    const want = Math.max(0, need - 0.015);
    // Fall into the drop faster than you climb out of it: a foot that cannot
    // reach the ground is a visible error, a pelvis 2 cm low is not.
    const rate = want > this.hipDrop ? 12 : 5;
    this.hipDrop += (Math.min(want, 0.3) - this.hipDrop) * Math.min(1, dt * rate);
    void cycle;
  }

  /**
   * Legs on pure FK — no terrain queries, no IK, no plant latch. Used past
   * ~34 m, where a soldier is under 40 px tall and the only thing that reads is
   * that the legs are moving in time with the body, and by the prone/down poses
   * which drive the legs themselves.
   */
  _fkLegs(grounded) {
    if (!grounded) return;
    const L = this.loco;
    const m = L.moving;
    if (m < 0.01) return;
    const b = this.b;
    const amp = lerp(0.3, 0.62, L.run01) * m;
    for (const side of ['R', 'L']) {
      const p = ((L.phase + (side === 'L' ? 0.5 : 0)) % 1) * Math.PI * 2;
      const s = Math.sin(p);
      const hip = b[side === 'R' ? 'upLegR' : 'upLegL'];
      const knee = b[side === 'R' ? 'lowLegR' : 'lowLegL'];
      hip.rotation.x += s * amp;
      knee.rotation.x -= (0.1 + 0.75 * Math.max(0, -s)) * m;
    }
  }

  // --- weapon + arms -----------------------------------------------------
  _weaponTargetPose() {
    const L = this.loco;
    const aim = this._aimEff ?? this.aim;
    const prone = L.proneBlend;
    const crouch = L.stanceBlend;
    // How far the carry is tucked in toward the body. This used to be
    // `L.sprint01`, which does not leave the floor until the gait axis passes
    // 2.1 — so everything from a walk to a full run held the weapon at arm's
    // length in the low-ready pose. A man running brings it IN, and here that
    // is load-bearing rather than cosmetic: the low-ready support grip is at
    // the very end of the left arm's reach (measured 1.01 of it before the
    // foregrip moved), and pulling the weapon 9 cm closer is what buys the
    // reach the carry sway needs to swing through.
    const run = smoothstep(L.smoothG, 1.3, 2.6);

    const pos = this._p.set(0, 0, 0);
    const dir = this._d.set(0, 0, 0);
    let total = 0;
    const add = (pose, w) => {
      if (w <= 0.0005) return;
      pos.addScaledVector(pose.pos, w);
      dir.addScaledVector(pose.dir, w);
      total += w;
    };
    const base = 1 - aim;
    add(WEAPON_POSES.prone, prone * base);
    add(WEAPON_POSES.crouch, crouch * (1 - prone) * base);
    add(WEAPON_POSES.sprint, run * (1 - crouch) * (1 - prone) * base);
    add(WEAPON_POSES.ready, (1 - run) * (1 - crouch) * (1 - prone) * base);
    // The aim half is split by stance the same way the carry half is. It used
    // to be one unconditional `add(WEAPON_POSES.aim, aim)`, which is why
    // aiming from a crouch or from prone put the weapon at standing bore
    // height with the arms stretched up to reach it.
    add(WEAPON_POSES.aimProne, aim * prone);
    add(WEAPON_POSES.aimCrouch, aim * crouch * (1 - prone));
    add(WEAPON_POSES.aim, aim * (1 - crouch) * (1 - prone));
    if (total < 1e-4) {
      add(WEAPON_POSES.ready, 1);
    }
    pos.divideScalar(total);
    dir.divideScalar(total).normalize();
  }

  _solveWeapon(dt) {
    const ch = this.ch;
    const L = this.loco;
    const act = this.actions;
    this._weaponTargetPose();
    const ph = L.phase * Math.PI * 2;
    const run = L.run01;
    const moving = L.moving;

    const aim = this._aimEff ?? this.aim;
    // A shouldered weapon is braced against the shoulder and the cheek; it is
    // meant to be the steady thing in the frame. Everything below is the CARRY,
    // and it fades out as the weapon comes up.
    const brace = 1 - 0.82 * aim;

    // --- the carry sway ----------------------------------------------------
    //
    // This used to be a translation of the grip in character space, with a
    // peak-to-peak of 68-84 mm at a run, and it was the whole reason the upper
    // body read as a rigid passenger: both arms are two-bone-IK'd to the weapon
    // matrix, so 8 cm was all the hands could ever inherit from a gait that was
    // producing 0.24 rad of contralateral chest yaw two joints above them.
    //
    // Two things changed. The sway is now an ANGLE about the chest joint, and
    // its yaw/roll terms are the gait's own accumulated chest rotation
    // (`_gaitYaw`, `_gaitRoll`) rather than an independent oscillator.
    //
    // WHY AN ANGLE. The support arm is the binding constraint here: measured,
    // it sat on the two-bone solver's own reach clamp in the low-ready carry —
    // 0.993 of full extension, i.e. dead straight, with the hand already 8 mm
    // short of the handguard it is holding. Translating the grip 7 cm forward
    // puts it 8% beyond reach and the hand visibly leaves the weapon, which is
    // an animation bug the player would name. A rotation does not: shoulder and grip
    // both hang off that pivot, so to first order the shoulder-to-grip distance
    // is INVARIANT under it — d.(dgrip - dshoulder) works out to
    // 0.0711*theta*(1 - gain), which is zero at unity gain and only 2.4 cm at
    // the gain used here. Amplitude is cheap in rotation and ruinous in
    // translation, which is why the old term could never have been tuned up.
    //
    // WHY THE PITCH TERM IS AT STRIDE FREQUENCY. The old vertical was
    // `-|cos(phase)| * bobAmp` — the same waveform, the same sign and the same
    // frequency as the pelvis bob in `_placeRoot`. That is why a reviewer
    // measuring this rig found hand height tracking head height at r = 0.99:
    // the hands carried the body's bob and nothing else. |cos(phase)| has
    // period pi; sin(phase + c) has period 2pi and integrates to zero against
    // it for ANY offset c, so a stride-frequency term decorrelates the two by
    // construction rather than by tuning.
    const swayT = this._t3.set(
      Math.sin(ph + 2.1) * lerp(0.025, 0.26, run) * moving,         // pitch: muzzle rise/fall
      this._gaitYaw * lerp(1.5, 3.8, run),                          // yaw: rides the chest
      this._gaitRoll * lerp(1.5, 3.0, run) + Math.sin(ph) * lerp(0.012, 0.075, run) * moving,
    ).multiplyScalar(brace);
    // Spring-damped so the weapon lags the body rather than being welded to it.
    this.carryAngVel.addScaledVector(this._t2.subVectors(swayT, this.carryAng), Math.min(1, dt * 40));
    this.carryAngVel.multiplyScalar(Math.max(0, 1 - dt * 9));
    this.carryAng.addScaledVector(this.carryAngVel, Math.min(1, dt * 12));

    // What is left in translation is breathing, which has no business being a
    // rotation, plus a small lateral shove so the swing is an arc and not a
    // pure hinge.
    const target = this._t1.set(
      Math.sin(ph) * lerp(0.004, 0.020, run) * moving * brace + Math.sin(this.breath * 1.1) * 0.006 * (1 - moving),
      Math.sin(this.breath * 1.9) * 0.005 * (1 - moving),
      Math.cos(ph * 2) * lerp(0.004, 0.016, run) * moving * brace,
    );
    this.weaponSwayVel.addScaledVector(this._t2.subVectors(target, this.weaponSway), Math.min(1, dt * 40));
    this.weaponSwayVel.multiplyScalar(Math.max(0, 1 - dt * 9));
    this.weaponSway.addScaledVector(this.weaponSwayVel, Math.min(1, dt * 12));

    // The chest frame: a rotation about the chest joint by the carry sway,
    // plus the pelvis bob the chest is standing on. `bobY` used to be absent
    // from the weapon entirely and approximated by the old translational term,
    // which meant the arms were acting as suspension for 5.5 cm of body bob
    // every cycle. Riding it costs the arms nothing and buys back that reach.
    //
    // SOLVED BEFORE THE WEAPON DIRECTION NOW, and the order is the whole point:
    // the direction below is derived from where the grip ends up in the WORLD,
    // and the grip's world position is this matrix times the pose offset.
    this._eul.set(this.carryAng.x, this.carryAng.y, this.carryAng.z);
    this._qc.setFromEuler(this._eul);
    this._chestM.makeRotationFromQuaternion(this._qc);
    const c = this._chestPivot;
    this._vc.copy(c).applyQuaternion(this._qc);
    this._chestM.setPosition(c.x - this._vc.x, c.y - this._vc.y + this.bobY, c.z - this._vc.z);
    this._parentM.multiplyMatrices(ch.root.matrixWorld, this._chestM);

    const wpos = this._t1.copy(this._p).add(this.weaponSway).add(act.weaponPos);
    const dir = this._d;

    let pitch = this.torsoAim.y * 0.45;
    if (aim > 0.01 && this.aimActive) {
      this._t2.subVectors(this.aimTarget, ch.root.position);
      pitch = clamp(Math.atan2(this._t2.y - 1.4, Math.hypot(this._t2.x, this._t2.z)), -0.5, 0.5) * aim;
    }
    if (pitch !== 0) dir.applyAxisAngle(this._t3.set(1, 0, 0), pitch).normalize();

    // --- POINT THE WEAPON AT THE TARGET ------------------------------------
    //
    // Everything above is a POSE — an authored direction in the character's own
    // frame, nudged by a pitch estimated from the root. That is fine for a
    // carry and it is not good enough for aiming, and the gap was measured:
    // with `anim.aimTarget` only 0.00-0.23 deg off the line the dart actually
    // flies, the barrel came out 8.4-10.9 deg off it — 4.6 deg flat and 9.9 deg
    // in pitch on the canonical gameplay pose (`probes/r12_ads.js`). Gameplay's
    // half of the contract was correct and the rig simply did not reach the
    // target it was handed. A weapon that visibly points ten degrees away from
    // where the round goes is most of "its not very aligned".
    //
    // Why the old estimate could never have been tuned into place:
    //
    //   - it had NO YAW TERM AT ALL. The weapon's heading was the character's
    //     heading plus a fixed 1.7 deg from the authored pose, so every degree
    //     the body was off the sight line went straight into the barrel.
    //   - its pitch was measured from the ROOT (feet) at a hardcoded 1.4 m, not
    //     from the grip, and the grip is neither at 1.4 m nor above the feet.
    //   - neither term knew about the chest carry rotation applied above it,
    //     which is still 18% of its amplitude at full aim.
    //
    // Solving it exactly costs one matrix inverse on an aiming character. The
    // barrel is aimed from the GRIP rather than the muzzle deliberately: the
    // muzzle then lies on the grip-to-target line, so the axis is the line, and
    // aiming from the muzzle would need the direction it is trying to compute.
    if (aim > 0.01 && this.aimActive) {
      this._gripW.copy(wpos).applyMatrix4(this._parentM);
      this._t4.subVectors(this.aimTarget, this._gripW);
      if (this._t4.lengthSq() > 1e-6) {
        this._invM.copy(this._parentM).invert();
        this._t4.transformDirection(this._invM);
        // Clamp into a forward cone before blending. A caller that publishes a
        // stale or wild aimTarget must not be able to rotate the weapon through
        // the body — the arms are two-bone-IK'd to this matrix, so a bad target
        // does not produce a bad aim, it produces a dislocated shoulder.
        // Take the bore offset off the wanted direction rather than off `dir`
        // afterwards: `up` is world-up projected perpendicular to `dir`, so the
        // frame has no roll and rotating the wanted BORE direction down by the
        // bore pitch lands the pose axis exactly where it has to be for the
        // barrel to end up on the line. Only valid while the frame is roll-free,
        // which is why act.weaponRoll is applied after this and not before.
        const y = clamp(Math.atan2(-this._t4.x, -this._t4.z) - this._boreYaw, -1.05, 1.05);
        const p = clamp(Math.atan2(this._t4.y, Math.hypot(this._t4.x, this._t4.z)) - this._borePitch, -0.85, 0.85);
        const cp = Math.cos(p);
        this._t4.set(-Math.sin(y) * cp, Math.sin(p), -Math.cos(y) * cp);
        dir.lerp(this._t4, aim).normalize();
      }
    }

    // The action layer's own kick rides ON TOP of the solve, not instead of it:
    // the round leaves along the line above, and then the weapon moves.
    if (act.weaponPitch !== 0) dir.applyAxisAngle(this._t3.set(1, 0, 0), act.weaponPitch).normalize();
    if (act.weaponYaw !== 0) dir.applyAxisAngle(this._up, act.weaponYaw).normalize();

    const up = this._t2.set(0, 1, 0).addScaledVector(dir, -dir.y).normalize();
    if (act.weaponRoll !== 0) up.applyAxisAngle(dir, act.weaponRoll).normalize();
    const right = this._t3.crossVectors(dir, up);
    this._basisM.makeBasis(dir, up, right).setPosition(wpos);

    this._weaponM.multiplyMatrices(this._parentM, this._basisM);

    this._supportSwing();
    this._solveArm('R');
    this._solveArm('L');
  }

  /**
   * Sprint carry: the support hand comes off the weapon and the left arm pumps.
   *
   * A soldier at 6 m/s does not hold a carbine in two hands, and the two-handed
   * carry is also the thing that caps how much the upper body can move — every
   * centimetre the weapon swings has to be absorbed by an arm that is already
   * on its reach clamp. Letting go is what makes a genuinely large arm swing
   * available at all: measured at the sprint knot this path gives the left
   * wrist 44.3 cm of fore-aft travel, against 20.1 cm for the right hand, which
   * is still on the weapon and can only go where the weapon goes.
   *
   * Contralateral, like every other limb here: the left arm is forward when the
   * left leg is back, and `_solveFeet` puts the RIGHT foot forward at phase 0,
   * so cos(phase) is the correct signal and sin(phase) is a quarter cycle late.
   */
  _supportSwing() {
    const L = this.loco;
    const h = this.locoHand.L;
    // Not while aiming, not on the ground, not from a crouch — all three are
    // poses where both hands are on the weapon by definition.
    const w = L.sprint01 * (1 - (this._aimEff ?? this.aim)) * (1 - L.proneBlend) * (1 - L.stanceBlend) * L.moving;
    h.w = w;
    if (w <= 0.001) return;
    const s = Math.cos(L.phase * Math.PI * 2);
    // Authored against the rig: the left shoulder is at (-0.190, 1.452) with
    // 0.572 m of reach, and these two extremes sit at 72% and 81% of it.
    h.pos.set(-0.20 + 0.04 * s, 1.11 + 0.09 * Math.abs(s), -0.10 - 0.24 * s);
  }

  _solveArm(side) {
    const ch = this.ch;
    const a = ch.attach[side];
    if (!a) return;
    const W = this._weaponM;

    const grip = this._t1.copy(a.gripLocal).applyMatrix4(W);
    const ax1 = this._t2.copy(a.weaponAxis1).transformDirection(W);
    const ax2 = this._t3.copy(a.weaponAxis2).transformDirection(W);
    const q = quatFromAxisPair(a.handAxis1, a.handAxis2, ax1, ax2, this._qa);

    const wrist = this._t4.copy(a.wristToGrip).applyQuaternion(q).negate().add(grip);

    // The action layer can take this hand off the weapon — a magazine change, a
    // CQC grab, a thrown decoy. The override is authored in character space, so
    // it goes through the character's own matrix, not the weapon's.
    const ov = this.actions.hand[side];
    const lv = this.locoHand[side];
    // Locomotion can take the hand off too (the sprint arm pump), and the two
    // overlap: sprinting into a magazine change is legal. The action wins by
    // the amount it is asserting, so the arm never gets two destinations.
    if (lv.w > 0.001) {
      this._t5.copy(lv.pos).applyMatrix4(ch.root.matrixWorld);
      wrist.lerp(this._t5, lv.w * (1 - ov.w));
    }
    if (ov.w > 0.001) {
      this._t5.copy(ov.pos).applyMatrix4(ch.root.matrixWorld);
      wrist.lerp(this._t5, ov.w);
    }

    const shoulder = side === 'R' ? this.b.armR : this.b.armL;
    const elbow = side === 'R' ? this.b.forearmR : this.b.forearmL;
    const hand = side === 'R' ? this.b.handR : this.b.handL;
    const sgn = side === 'R' ? 1 : -1;

    shoulder.getWorldPosition(this._t2);
    const cosY = Math.cos(ch.yaw);
    const sinY = Math.sin(ch.yaw);
    // Elbow pole is anchored to the MIDPOINT of the shoulder-to-wrist line, not
    // to the shoulder. A shoulder-anchored pole flips the whole arm inside out
    // when the support hand crosses the body (sprint carry, weapon transitions)
    // — the pole ends up nearly parallel to the limb axis and the bend plane is
    // undefined.
    //
    // Elbows OUT, not tucked: a low-ready carry drives both elbows away from
    // the ribs, and the triangle that makes between the forearms and the
    // weapon is the single clearest silhouette cue that a figure is holding
    // something. Round 3 dropped the pole 0.55 m below the limb midpoint with
    // only a small lateral bias, which folded both arms flat against the torso
    // and read as hanging. The support arm gets the wider bias — it is the one
    // that has to reach across the body to the handguard.
    //
    // ROUND 6. The pole is now authored as a vector in CHARACTER space
    // (+x right, +z behind, y up) and rotated into the world, which is what the
    // old cosY/sinY expression was doing by hand with one shared lateral term
    // and a fixed 0.26 m drop. The drop dominated: with the shoulder-to-wrist
    // line already short the elbows ended up hanging almost straight down and
    // 8 cm out, i.e. inside the torso silhouette.
    //
    // Firing side gets the classic chicken-wing — out and BACK — because on the
    // over-the-shoulder camera that is the elbow nearest the lens, and it is
    // the one break in the outline that says "this figure has arms" from 40 px.
    // The support elbow goes out and slightly DOWN and forward, under the
    // handguard, which is both correct and keeps it clear of the ribs.
    const pole = side === 'R' ? _POLE_R : _POLE_L;
    const lx = pole.x * sgn;
    this._t3.set(
      (this._t2.x + wrist.x) * 0.5 + cosY * lx + sinY * pole.z,
      (this._t2.y + wrist.y) * 0.5 + pole.y,
      (this._t2.z + wrist.z) * 0.5 - sinY * lx + cosY * pole.z,
    );
    const scale = ch.root.scale.x || 1;
    twoBoneIK(shoulder, elbow, wrist, this._t3, this.armLen.upper * scale, this.armLen.lower * scale);
    setWorldQuaternion(hand, q);
  }

  // --- head --------------------------------------------------------------
  _headLook(dt, ik) {
    const ch = this.ch;
    const L = this.loco;
    let yaw = 0;
    let pitch = 0;
    const aim = this._aimEff ?? this.aim;

    // Torso aim tracking runs off the same target as the head, so the two never
    // disagree about which way the character is looking.
    let ty = 0;
    let tp = 0;
    if (this.aimActive) {
      this._t2.subVectors(this.aimTarget, ch.root.position).applyAxisAngle(this._up, -ch.yaw);
      ty = clamp(Math.atan2(-this._t2.x, -this._t2.z), -1.15, 1.15) * aim;
      tp = clamp(Math.atan2(this._t2.y - 1.4, Math.hypot(this._t2.x, this._t2.z)), -0.45, 0.4) * aim;
    }
    this.torsoAim.x += (ty - this.torsoAim.x) * Math.min(1, dt * 6);
    this.torsoAim.y += (tp - this.torsoAim.y) * Math.min(1, dt * 6);

    const look = this.lookTarget ?? (this.aimActive ? this.aimTarget : null);
    if (look) {
      this.b.head.getWorldPosition(this._t1);
      this._t2.subVectors(look, this._t1).applyAxisAngle(this._up, -ch.yaw);
      yaw = clamp(Math.atan2(-this._t2.x, -this._t2.z), -0.95, 0.95);
      pitch = clamp(Math.atan2(this._t2.y, Math.hypot(this._t2.x, this._t2.z)), -0.5, 0.45);
      // The torso already carried part of the turn; the head only owes the rest.
      yaw -= this.torsoAim.x * 0.8;
    } else {
      yaw = Math.sin(this.t * 0.31) * 0.28 + Math.sin(this.t * 0.11 + 2.0) * 0.22;
      pitch = Math.sin(this.t * 0.19 + 1.0) * 0.06;
    }
    yaw *= 1 - aim * 0.5;
    pitch = pitch * (1 - aim * 0.8) - aim * 0.12;
    yaw = clamp(yaw, -1.0, 1.0);
    this.lookBlend.x += (yaw - this.lookBlend.x) * Math.min(1, dt * 3.2);
    this.lookBlend.y += (pitch - this.lookBlend.y) * Math.min(1, dt * 3.2);

    const neck = this.b.neck;
    const head = this.b.head;
    neck.rotation.order = 'YXZ';
    head.rotation.order = 'YXZ';
    neck.rotation.x -= this.lookBlend.y * 0.4;
    neck.rotation.y += this.lookBlend.x * 0.38;
    head.rotation.x -= this.lookBlend.y * 0.6;
    head.rotation.y += this.lookBlend.x * 0.62;
    head.rotation.z -= this.lookBlend.x * 0.1;
    neck.updateMatrix();
    head.updateMatrix();
    neck.updateMatrixWorld(true);
    void ik;
    void L;
  }
}

export { WEAPON_POSES };
