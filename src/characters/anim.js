import * as THREE from 'three';

/**
 * Procedural animation.
 *
 * There are no keyframes. Every pose is computed each frame from a small set of
 * signals — gait phase, speed, stance, aim, a decaying hit impulse — and then
 * resolved against the world with IK:
 *
 *  - Feet are placed by a gait function in character space and then *planted* on
 *    `terrain.heightAt()`. During stance the foot travels backward at exactly
 *    body speed, so it never slides; a stride that lands on the actual ground is
 *    the single biggest tell between "animated" and "sliding decal".
 *  - The weapon has its own authored transform per state. Both arms are then
 *    solved to it — firing hand to the pistol grip, support hand to the
 *    handguard — so the rifle is locked in the hands in every state, including
 *    mid-stagger, which is where hand-authored rigs usually fall apart.
 *  - Secondary motion (breathing, idle weight shift, head look-at split across
 *    neck and head, spring-damped weapon sway, torso counter-rotation against
 *    the hips) is layered on top.
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
  aim: weaponPose([0.115, 1.4, -0.3], [-0.03, -0.02, -1.0]),
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

// -------------------------------------------------------------------------
// Animator
// -------------------------------------------------------------------------

export class Animator {
  constructor(ch, terrain) {
    this.ch = ch;
    this.terrain = terrain;
    this.rig = ch.rig;
    this.b = Object.fromEntries(ch.rig.bones.map((b) => [b.name, b]));

    this.phase = Math.random();
    this.t = Math.random() * 40;
    this.speed = 0;
    this.smoothSpeed = 0;
    this.stance = 'stand';
    this.stanceBlend = 0;
    this.proneBlend = 0;
    this.aim = 0;
    this.aimTarget = new THREE.Vector3();
    this.lookTarget = null;
    this.lookBlend = new THREE.Vector2();
    this.hitTime = 1e3;
    this.hitDir = new THREE.Vector3();
    this.bobY = 0;
    // Ground-normal LOD. `_placeRoot` and `_solveFeet` between them ask the
    // terrain for FIFTEEN heights per character per frame, and eleven of those
    // are the four-tap finite-difference normals behind two facts that stop
    // being visible almost immediately: which way the whole figure tilts on the
    // slope, and how each sole conforms to the ground under it.
    //
    // Measured against the pixel: a 1.86 m soldier standing on a 15-degree
    // slope tilts his crown 0.11 m out of vertical at full strength; at 25 m
    // that is 3.6 px and at 60 m it is 1.5 px, and the sole conform term is a
    // quarter of that. Beyond `coarseAbove` both are dropped and the root sits
    // level, which costs 11 of the 15 terrain queries.
    this.coarse = false;
    this.breath = Math.random() * 10;
    this.weaponSway = new THREE.Vector3();
    this.weaponSwayVel = new THREE.Vector3();

    const bw = ch.rig.bindWorld;
    this.armLen = { upper: bw.get('armR').distanceTo(bw.get('forearmR')), lower: bw.get('forearmR').distanceTo(bw.get('handR')) };
    this.legLen = { upper: bw.get('upLegR').distanceTo(bw.get('lowLegR')), lower: bw.get('lowLegR').distanceTo(bw.get('footR')) };

    this.footTargets = { R: { pos: new THREE.Vector3(), ground: 0 }, L: { pos: new THREE.Vector3(), ground: 0 } };
    this._weaponM = new THREE.Matrix4();
    this._basisM = new THREE.Matrix4();

    // Per-instance scratch (an Animator is only ever ticked from one place).
    this._p = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._t1 = new THREE.Vector3();
    this._t2 = new THREE.Vector3();
    this._t3 = new THREE.Vector3();
    this._t4 = new THREE.Vector3();
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  hit(dir) {
    this.hitTime = 0;
    this.hitDir.copy(dir).normalize();
  }

  get gaitCycle() {
    return lerp(1.06, 0.58, smoothstep(this.smoothSpeed, 1.0, 4.6));
  }

  update(dt) {
    this.t += dt;
    this.breath += dt;
    this.hitTime += dt;
    this.smoothSpeed += (this.speed - this.smoothSpeed) * Math.min(1, dt * 7);

    const crouchT = this.stance === 'crouch' ? 1 : 0;
    const proneT = this.stance === 'prone' ? 1 : 0;
    this.stanceBlend += (crouchT - this.stanceBlend) * Math.min(1, dt * 5);
    this.proneBlend += (proneT - this.proneBlend) * Math.min(1, dt * 4);

    const moving = smoothstep(this.smoothSpeed, 0.06, 0.7);
    if (moving > 0.01) this.phase = (this.phase + (dt / this.gaitCycle) * moving) % 1;

    this._resetPose();
    this._poseBody(moving);
    this._placeRoot(dt, moving);
    this.ch.root.updateMatrixWorld(true);
    this._solveFeet(moving);
    this._solveWeapon(dt, moving);
    this._headLook(dt);
  }

  _resetPose() {
    for (const b of this.rig.bones) {
      b.quaternion.identity();
      b.position.copy(b.userData.rest);
    }
  }

  // --- body FK -----------------------------------------------------------
  _poseBody(moving) {
    const b = this.b;
    const ph = this.phase * Math.PI * 2;
    const run = smoothstep(this.smoothSpeed, 1.6, 4.4);
    const crouch = this.stanceBlend;
    const prone = this.proneBlend;
    const aim = this.aim;

    const breathRate = lerp(0.26, 0.8, run);
    const br = Math.sin(this.breath * Math.PI * 2 * breathRate);
    const breathAmp = lerp(0.012, 0.032, run) * (1 - moving * 0.35);

    const shift = Math.sin(this.t * 0.9) * (1 - moving) * (1 - prone);
    const shift2 = Math.sin(this.t * 0.62 + 1.1) * (1 - moving) * (1 - prone);

    const hipYaw = Math.sin(ph) * lerp(0.1, 0.19, run) * moving;
    const hipRoll = Math.cos(ph) * lerp(0.045, 0.075, run) * moving + shift * 0.035;
    const lean = lerp(0.03, 0.22, run) * moving + crouch * 0.17 + aim * 0.05;

    b.root.rotation.set(lean * 0.25, hipYaw + shift2 * 0.03, hipRoll);

    const chestYaw = -Math.sin(ph) * lerp(0.13, 0.24, run) * moving;
    const bladed = -0.5 * aim;
    b.spine1.rotation.set(lean * 0.3 + breathAmp * br * 0.2, hipYaw * -0.25 + chestYaw * 0.3 + bladed * 0.2 - shift * 0.02, -hipRoll * 0.25);
    b.spine2.rotation.set(lean * 0.3 + breathAmp * br * 0.4, chestYaw * 0.35 + bladed * 0.35, -hipRoll * 0.3);
    b.chest.rotation.set(lean * 0.2 - breathAmp * br * 0.7 + crouch * 0.06, chestYaw * 0.35 + bladed * 0.45, -hipRoll * 0.3 + shift2 * 0.02);

    b.clavR.rotation.set(-breathAmp * br * 0.5, -aim * 0.14, -aim * 0.1 - breathAmp * br * 0.3);
    b.clavL.rotation.set(-breathAmp * br * 0.5, aim * 0.24, aim * 0.1 + breathAmp * br * 0.3);

    b.neck.rotation.set(-lean * 0.5 - crouch * 0.08 - aim * 0.06, 0, 0);
    b.head.rotation.set(-lean * 0.35 + aim * 0.12, 0, 0);

    if (prone > 0.001) this._poseProne(prone);

    if (this.hitTime < 1.0) {
      const u = this.hitTime;
      const env = Math.exp(-u * 5.5) * Math.sin(u * 22.0 + 0.6) * (1 - u);
      const local = this._t1.copy(this.hitDir).applyAxisAngle(this._up, -this.ch.yaw);
      const back = -local.z;
      const side = local.x;
      b.root.rotation.x += env * back * 0.5;
      b.root.rotation.z += env * side * 0.45;
      b.spine2.rotation.x += env * back * 0.7;
      b.spine2.rotation.z += env * side * 0.6;
      b.chest.rotation.x += env * back * 0.6;
      b.neck.rotation.x += env * back * 0.9;
      b.head.rotation.x += env * back * 0.7;
      b.head.rotation.z += env * side * 0.5;
    }
  }

  _poseProne(w) {
    const b = this.b;
    b.root.rotation.x += -1.42 * w;
    b.spine1.rotation.x += 0.12 * w;
    b.spine2.rotation.x += 0.24 * w;
    b.chest.rotation.x += 0.3 * w;
    b.neck.rotation.x += 0.55 * w;
    b.head.rotation.x += 0.5 * w;
    const ph = this.phase * Math.PI * 2;
    const crawl = smoothstep(this.smoothSpeed, 0.05, 0.6);
    b.upLegR.rotation.z += (0.24 + Math.sin(ph) * 0.3 * crawl) * w;
    b.upLegL.rotation.z += (-0.24 - Math.sin(ph) * 0.3 * crawl) * w;
    b.lowLegR.rotation.x += (-0.4 - Math.max(0, Math.sin(ph)) * 0.9 * crawl) * w;
    b.lowLegL.rotation.x += (-0.4 - Math.max(0, -Math.sin(ph)) * 0.9 * crawl) * w;
  }

  // --- root placement ----------------------------------------------------
  _placeRoot(dt, moving) {
    const ch = this.ch;
    const t = this.terrain;
    const ph = this.phase * Math.PI * 2;
    const run = smoothstep(this.smoothSpeed, 1.6, 4.4);

    const bob = -Math.abs(Math.cos(ph)) * lerp(0.022, 0.055, run) * moving;
    this.bobY += (bob - this.bobY) * Math.min(1, dt * 18);

    const groundY = t ? t.heightAt(ch.position.x, ch.position.z) : 0;
    ch.groundY = groundY;
    ch.root.position.set(ch.position.x, groundY, ch.position.z);
    ch.root.rotation.set(0, ch.yaw, 0);

    const stanceDrop = this.stanceBlend * 0.34 + this.proneBlend * 0.72;
    this.b.root.position.y = this.b.root.userData.rest.y - stanceDrop + this.bobY;
    // Contrapposto while idle: the pelvis drops toward the unweighted leg.
    const idleW = 1 - smoothstep(this.smoothSpeed, 0.06, 0.7);
    this.b.root.position.y -= idleW * 0.012 * (0.5 + 0.5 * Math.sin(this.t * 0.9));
    if (this.proneBlend > 0.001) this.b.root.position.z += this.proneBlend * 0.07;

    if (t && !this.coarse) {
      const n = t.normalAt(ch.position.x, ch.position.z, 0.9);
      const fx = -Math.sin(ch.yaw);
      const fz = -Math.cos(ch.yaw);
      ch.root.rotation.x = Math.asin(clamp(-(n.x * fx + n.z * fz), -0.5, 0.5)) * 0.75;
      ch.root.rotation.z = Math.asin(clamp(n.x * fz - n.z * fx, -0.5, 0.5)) * 0.75;
    }
  }

  // --- feet --------------------------------------------------------------
  _solveFeet(moving) {
    const ch = this.ch;
    const t = this.terrain;
    const run = smoothstep(this.smoothSpeed, 1.6, 4.4);
    const cycle = this.gaitCycle;
    const duty = lerp(0.62, 0.42, run);
    const stride = this.smoothSpeed * cycle * duty;
    const lift = lerp(0.055, 0.17, run) * moving;
    const stanceWidth = lerp(0.098, 0.086, run) + this.stanceBlend * 0.03 + this.proneBlend * 0.1;

    const cosY = Math.cos(ch.yaw);
    const sinY = Math.sin(ch.yaw);
    if (this.proneBlend > 0.7) return;

    for (const side of ['R', 'L']) {
      const sgn = side === 'R' ? 1 : -1;
      const ft = this.footTargets[side];
      const p = (this.phase + (side === 'L' ? 0.5 : 0)) % 1;

      let fwd = 0;
      let up = 0;
      let toeLift = 0;
      if (p < duty) {
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

      // Idle stance is deliberately ASYMMETRIC: one foot forward, weight on the
      // other, both toes turned out, and a slow drift between them. Two feet
      // planted square is the single loudest "this is a mannequin" cue there is.
      const idle = 1 - moving;
      const drift = Math.sin(this.t * 0.55 + (side === 'R' ? 0 : 1.7));
      const idleShift = idle * Math.sin(this.t * 0.9) * 0.012 * sgn;
      const lx = sgn * stanceWidth + idleShift;
      const lz = -fwd + this.proneBlend * 0.34 + idle * (sgn > 0 ? -0.075 : 0.085) + idle * drift * 0.012;
      const wx = ch.position.x + lx * cosY + lz * sinY;
      const wz = ch.position.z - lx * sinY + lz * cosY;
      const g = t ? t.heightAt(wx, wz) : 0;
      ft.pos.set(wx, g + 0.082 + up, wz);
      ft.ground = g;

      const hip = this.b[side === 'R' ? 'upLegR' : 'upLegL'];
      const knee = this.b[side === 'R' ? 'lowLegR' : 'lowLegL'];
      const foot = this.b[side === 'R' ? 'footR' : 'footL'];

      hip.getWorldPosition(this._t1);
      const poleF = 0.95 + this.stanceBlend * 0.35;
      this._t2.set(
        this._t1.x - sinY * poleF + sgn * 0.14 * this.stanceBlend,
        this._t1.y - 0.28,
        this._t1.z - cosY * poleF,
      );
      twoBoneIK(hip, knee, ft.pos, this._t2, this.legLen.upper, this.legLen.lower);

      // Sole follows the ground plane while planted, rolls through the swing.
      // Toe-out: about 12 degrees each way when standing, closing up at speed.
      const toeOut = (sgn * (0.21 * (1 - moving) + 0.05)) * (1 - this.proneBlend);
      const ca = Math.cos(ch.yaw + toeOut);
      const sa = Math.sin(ch.yaw + toeOut);
      const axis = foot.userData.axis;
      this._t3.set(axis.x * ca + axis.z * sa, axis.y, -axis.x * sa + axis.z * ca);
      if (t && p < duty && !this.coarse) {
        const n = t.normalAt(ft.pos.x, ft.pos.z, 0.6);
        this._qa.setFromUnitVectors(this._up, n);
        this._t3.applyQuaternion(this._qa);
      }
      this._t3.y += toeLift;
      aimBone(foot, this._t3);
    }
  }

  // --- weapon + arms -----------------------------------------------------
  _weaponTargetPose() {
    const aim = this.aim;
    const prone = this.proneBlend;
    const crouch = this.stanceBlend;
    const run = smoothstep(this.smoothSpeed, 2.8, 5.0);

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
    add(WEAPON_POSES.aim, aim);
    if (total < 1e-4) {
      add(WEAPON_POSES.ready, 1);
    }
    pos.divideScalar(total);
    dir.divideScalar(total).normalize();
  }

  _solveWeapon(dt, moving) {
    const ch = this.ch;
    this._weaponTargetPose();
    const ph = this.phase * Math.PI * 2;
    const run = smoothstep(this.smoothSpeed, 1.6, 4.4);

    const bobAmp = lerp(0.012, 0.042, run) * moving;
    const target = this._t1.set(
      Math.sin(ph) * bobAmp * 0.8 + Math.sin(this.breath * 1.1) * 0.006 * (1 - moving),
      -Math.abs(Math.cos(ph)) * bobAmp + Math.sin(this.breath * 1.9) * 0.005 * (1 - moving),
      Math.cos(ph * 2) * bobAmp * 0.4,
    );
    // Spring-damped so the weapon lags the body rather than being welded to it.
    this.weaponSwayVel.addScaledVector(this._t2.subVectors(target, this.weaponSway), Math.min(1, dt * 40));
    this.weaponSwayVel.multiplyScalar(Math.max(0, 1 - dt * 9));
    this.weaponSway.addScaledVector(this.weaponSwayVel, Math.min(1, dt * 12));

    let pitch = 0;
    if (this.aim > 0.01 && this.aimTarget.lengthSq() > 0) {
      this._t2.subVectors(this.aimTarget, ch.root.position);
      pitch = clamp(Math.atan2(this._t2.y - 1.4, Math.hypot(this._t2.x, this._t2.z)), -0.5, 0.5) * this.aim;
    }
    const dir = this._d;
    if (pitch !== 0) dir.applyAxisAngle(this._t3.set(1, 0, 0), pitch).normalize();
    if (this.hitTime < 1.0) {
      const env = Math.exp(-this.hitTime * 6.0) * Math.sin(this.hitTime * 24.0);
      dir.y += env * 0.3;
      dir.normalize();
    }

    const wpos = this._t1.copy(this._p).add(this.weaponSway);
    const up = this._t2.set(0, 1, 0).addScaledVector(dir, -dir.y).normalize();
    const right = this._t3.crossVectors(dir, up);
    this._basisM.makeBasis(dir, up, right).setPosition(wpos);
    this._weaponM.multiplyMatrices(ch.root.matrixWorld, this._basisM);

    this._solveArm('R');
    this._solveArm('L');
    void moving;
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
    twoBoneIK(shoulder, elbow, wrist, this._t3, this.armLen.upper, this.armLen.lower);
    setWorldQuaternion(hand, q);
  }

  // --- head --------------------------------------------------------------
  _headLook(dt) {
    const ch = this.ch;
    let yaw = 0;
    let pitch = 0;
    if (this.lookTarget) {
      this.b.head.getWorldPosition(this._t1);
      this._t2.subVectors(this.lookTarget, this._t1).applyAxisAngle(this._up, -ch.yaw);
      yaw = clamp(Math.atan2(-this._t2.x, -this._t2.z), -0.95, 0.95);
      pitch = clamp(Math.atan2(this._t2.y, Math.hypot(this._t2.x, this._t2.z)), -0.5, 0.45);
    } else {
      yaw = Math.sin(this.t * 0.31) * 0.28 + Math.sin(this.t * 0.11 + 2.0) * 0.22;
      pitch = Math.sin(this.t * 0.19 + 1.0) * 0.06;
    }
    yaw *= 1 - this.aim * 0.8;
    pitch = pitch * (1 - this.aim * 0.8) - this.aim * 0.12;
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
    neck.updateMatrixWorld(true);
  }
}

export { WEAPON_POSES };
