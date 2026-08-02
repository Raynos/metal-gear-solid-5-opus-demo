import * as THREE from 'three';
import { createRig } from './rig.js';
import { assemble } from './skinning.js';
import { makeMaterialSet, Z, SZ, MZ } from './materials.js';
import { frameMatrix, setDetail } from './geometry.js';
import {
  buildTorso, buildHips, buildNeck, buildCollar, buildHead, buildHair, buildPonytail, buildEyes, buildEar, buildArm, buildHand, buildLeg, buildBoot, ARM, armPoint, headTransform,
} from './body.js';
import {
  buildChestRig, buildBelt, buildHolster, buildBackpack, buildHelmet, buildCap, buildBoonie,
  buildBandana, buildEyepatch, buildProstheticArm, buildRifle, buildKneepads, buildPockets,
  buildSlungWeapon, buildPeakedCap, buildCommandCoat,
} from './gear.js';
import { Animator } from './anim.js';
import { gateSkeleton } from './lod.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const HAND_GRIP_LOCAL = V(0, 0.088, 0.032);

/**
 * Assemble a complete character from a loadout, and wire up the attachment
 * frames the animator needs to keep the weapon locked in both hands.
 *
 * `opts.detail` < 1 builds the same character at a coarser tessellation for the
 * distance LOD — same parts, same material list, same skeleton, fewer rings.
 * The global is restored on the way out (including on a throw) so one coarse
 * build can never leak into the next full one.
 */
export function buildCharacterGeometry(loadout, opts = {}) {
  const prevDetail = setDetail(opts.detail ?? 1);
  try {
    return buildCharacterGeometryImpl(loadout);
  } finally {
    setDetail(prevDetail);
  }
}

function buildCharacterGeometryImpl(loadout) {
  const rig = createRig();
  const parts = [];
  // A part may name its own bone group; `group` here is only the default. Kit
  // that spans two bones (the command coat's skirt on the pelvis, its shoulder
  // boards on the chest) needs the override or one half of it shears.
  const add = (list, group) => {
    for (const p of list) parts.push({ surface: p.surface, mat: p.mat, group: p.group ?? group });
  };
  const one = (surface, mat, group) => parts.push({ surface, mat, group });

  const bulk = loadout.bulk ?? 1;

  // Everything that lives on the skull — the skull, the hair shell, the eyes,
  // the ears, and every piece of headgear in `gear.js` — is authored against
  // absolute world-space y and then passed through this ONE matrix. See
  // `headTransform` in body.js for why it is a matrix and not thirty edits.
  const HEAD_M = headTransform();
  const onHead = (surface) => surface.transform(HEAD_M);
  const addHead = (list, group) => {
    for (const p of list) parts.push({ surface: onHead(p.surface), mat: p.mat, group });
  };

  // --- body ---------------------------------------------------------------
  one(buildTorso({ bulk }), 'cloth', 'torso');
  one(buildHips({ bulk }), 'cloth', 'hips');
  one(buildNeck(), 'skin', 'neck');
  // The collar rides the chest, not the neck: a collar that follows the skull
  // swings with every head turn and detaches from the shoulders.
  add(buildCollar({ bulk }), 'rigidChest');
  one(onHead(buildHead(loadout.head ?? {})), 'skin', 'head');
  one(onHead(buildEyes()), 'skin', 'rigidHead');
  one(onHead(buildEar(1)), 'skin', 'head');
  one(onHead(buildEar(-1)), 'skin', 'head');
  // Skinned to the same bones as the skull, NOT welded rigidly to the head
  // bone. The face blends across neck/head/headTip, so a rigid hair shell
  // drifts relative to it the moment the head turns — which is how round 1
  // ended up with the hair cap punched through the cheeks and the entire
  // lower face rendering as a dark mask.
  if (loadout.hair !== false) one(onHead(buildHair({ backOnly: loadout.hairBack ?? false })), 'cloth', 'head');
  // The tail is skinned to the same bones as the skull, like the hair shell, so
  // it swings with a head turn instead of hanging off a rigid head bone.
  if (loadout.ponytail) addHead(buildPonytail(), 'head');

  const legR = buildLeg({ bulk });
  one(legR, 'cloth', 'legR');
  one(legR.mirrored(), 'cloth', 'legL');
  for (const p of buildBoot()) {
    one(p.surface, p.mat, 'footR');
    one(p.surface.mirrored(), p.mat, 'footL');
  }

  // --- arms ---------------------------------------------------------------
  const armParts = buildArm({ bulk, sleeve: loadout.sleeves ?? 'full' });
  add(armParts, 'armR');
  if (loadout.prosthetic === 'left') {
    // Built on the right and mirrored, so the two arms share one spine definition.
    for (const p of buildProstheticArm(armPoint, ARM.wrist)) one(p.surface.mirrored(), p.mat, 'armL');
  } else {
    for (const p of armParts) one(p.surface.mirrored(), p.mat, 'armL');
  }

  // --- hands --------------------------------------------------------------
  const wristR = rig.bindWorld.get('handR').clone();
  const tipR = rig.bindWorld.get('handTipR').clone();
  const Mr = frameMatrix(wristR, tipR.clone().sub(wristR), V(0, 0, -1));

  const handRParts = buildHand({
    zone: loadout.gloves === false ? SZ.HAND : Z.GLOVE,
    mat: loadout.gloves === false ? 'skin' : 'cloth',
    fingerZone: loadout.fingerless ? SZ.HAND : loadout.gloves === false ? SZ.HAND : Z.GLOVE,
    fingerMat: loadout.fingerless ? 'skin' : loadout.gloves === false ? 'skin' : 'cloth',
  });
  for (const p of handRParts) one(p.surface.transform(Mr), p.mat, 'handR');

  const handLParts =
    loadout.prosthetic === 'left'
      ? buildHand({ zone: MZ.PROSTHETIC, mat: 'metal', fingerZone: MZ.GUNMETAL, fingerMat: 'metal' })
      : buildHand({
          zone: loadout.gloves === false ? SZ.HAND : Z.GLOVE,
          mat: loadout.gloves === false ? 'skin' : 'cloth',
          fingerZone: loadout.fingerless ? SZ.HAND : loadout.gloves === false ? SZ.HAND : Z.GLOVE,
          fingerMat: loadout.fingerless ? 'skin' : loadout.gloves === false ? 'skin' : 'cloth',
        });
  for (const p of handLParts) one(p.surface.transform(Mr).mirrored(), p.mat, 'handL');

  // --- kit ----------------------------------------------------------------
  if (loadout.vest !== false) add(buildChestRig({ bulk, heavy: loadout.grenades !== false }), 'rigidChest');
  add(buildBelt({ pouches: loadout.beltPouches }), 'rigidRoot');
  if (loadout.backpack) add(buildBackpack(), 'rigidChest');
  // Lies on the pack and rides the ribcage, so it does not shear when the spine
  // twists through the gait.
  if (loadout.slung) add(buildSlungWeapon({ sling: loadout.slung !== 'bare' }), 'rigidChest');
  if (loadout.coat) add(buildCommandCoat(), 'rigidRoot');
  if (loadout.holster) add(buildHolster(1), 'rigidLegR');
  {
    const pk = buildPockets({ cargo: loadout.cargoPockets !== false });
    // Thigh pockets ride the upper leg; the rest hang off the torso/hips.
    for (const p of pk) {
      const cx = p.surface.pos[0];
      const isThigh = Math.abs(cx) > 0.06 && p.surface.pos[1] < 0.95;
      one(p.surface, p.mat, isThigh ? (cx > 0 ? 'rigidLegR' : 'rigidLegL') : 'rigidRoot');
    }
  }
  if (loadout.kneepads) {
    const kp = buildKneepads();
    parts.push({ surface: kp[0].surface, mat: kp[0].mat, group: 'kneeL' });
    parts.push({ surface: kp[1].surface, mat: kp[1].mat, group: 'kneeR' });
  }

  switch (loadout.headgear) {
    case 'helmet':
      addHead(buildHelmet(), 'rigidHead');
      break;
    case 'cap':
      addHead(buildCap(), 'rigidHead');
      break;
    case 'boonie':
      addHead(buildBoonie(), 'rigidHead');
      break;
    case 'bandana':
      addHead(buildBandana(), 'rigidHead');
      break;
    case 'peaked':
      addHead(buildPeakedCap(), 'rigidHead');
      break;
    default:
      break;
  }
  if (loadout.eyepatch) addHead(buildEyepatch(), 'rigidHead');

  // --- weapon, welded into the firing hand --------------------------------
  const rifle = buildRifle({ optic: loadout.optic !== false });
  const gripUp = rifle.gripUp.clone().normalize();
  const gripFront = V(1, 0, 0).addScaledVector(gripUp, -gripUp.x).normalize();
  // Rifle space -> hand space: the grip's "up" becomes the hand's thumb axis and
  // the front of the grip becomes the direction the fingers close in.
  const Rhr = new THREE.Matrix4().makeRotationFromQuaternion(
    quatPair(gripUp, gripFront, V(1, 0, 0), V(0, 0, 1)),
  );
  const t = HAND_GRIP_LOCAL.clone().sub(rifle.gripCenter.clone().applyMatrix4(Rhr));
  const Mhr = Rhr.clone().setPosition(t);
  const rifleBind = new THREE.Matrix4().multiplyMatrices(Mr, Mhr);
  for (const p of rifle.parts) one(p.surface.transform(rifleBind), p.mat, 'rigidHandR');

  const gripBindR = HAND_GRIP_LOCAL.clone().applyMatrix4(Mr);
  const rot = new THREE.Matrix4().extractRotation(Mr);
  const thumbAxis = V(1, 0, 0).applyMatrix4(rot);
  const palmAxis = V(0, 0, 1).applyMatrix4(rot);
  const mirrorX = (v) => V(-v.x, v.y, v.z);
  const wristToGrip = gripBindR.clone().sub(wristR);

  const attach = {
    R: {
      gripLocal: rifle.gripCenter.clone(),
      weaponAxis1: gripUp,
      weaponAxis2: gripFront,
      handAxis1: thumbAxis,
      handAxis2: palmAxis,
      wristToGrip,
    },
    L: {
      gripLocal: rifle.foregrip.clone(),
      weaponAxis1: V(1, 0, 0),
      weaponAxis2: V(0, 1, 0),
      handAxis1: mirrorX(thumbAxis),
      handAxis2: mirrorX(palmAxis),
      wristToGrip: mirrorX(wristToGrip),
    },
  };

  const { geometry, materials } = assemble(parts, rig);
  return { geometry, materialNames: materials, rig, attach, rifle };
}

const _qp = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _t3 = new THREE.Vector3();
function quatPair(a1, a2, b1, b2) {
  _t1.copy(a1).normalize();
  _t2.copy(a2).addScaledVector(_t1, -a2.dot(_t1)).normalize();
  _t3.crossVectors(_t1, _t2);
  _m1.makeBasis(_t1, _t2, _t3).transpose();
  _t1.copy(b1).normalize();
  _t2.copy(b2).addScaledVector(_t1, -b2.dot(_t1)).normalize();
  _t3.crossVectors(_t1, _t2);
  _m2.makeBasis(_t1, _t2, _t3);
  return _qp.setFromRotationMatrix(_m2.multiply(_m1)).clone();
}

// -------------------------------------------------------------------------

export class Character {
  constructor(built, opts = {}) {
    this.name = opts.name ?? 'soldier';
    // Geometry is shared between instances of the same variant, but every
    // character needs its own bones — the skin indices are identical because
    // every rig is created from the same spec in the same order.
    this.rig = createRig();
    this.attach = built.attach;
    this.rifle = built.rifle;

    const mats = makeMaterialSet(opts.materials ?? {});
    this.materials = mats;
    const list = built.materialNames.map((n) => mats[n]);

    // Distance geometry: identical parts at a coarser tessellation. Only
    // adopted if its material list matches exactly, because the mesh's material
    // array is indexed by group and a mismatch would repaint the man.
    const low = opts.low;
    this.geoHigh = built.geometry;
    this.geoLow =
      low && low.materialNames.join() === built.materialNames.join() ? low.geometry : null;
    this.detailLow = false;

    this.mesh = new THREE.SkinnedMesh(built.geometry, list);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = `char-${this.name}`;
    this.mesh.add(this.rig.rootBone);
    this.mesh.bind(this.rig.skeleton, new THREE.Matrix4());

    this.root = new THREE.Group();
    this.root.name = `character:${this.name}`;
    this.root.rotation.order = 'YXZ';
    this.root.add(this.mesh);
    this.root.scale.setScalar(opts.scale ?? 1);

    this.position = new THREE.Vector3(...(opts.position ?? [0, 0, 0]));
    this.yaw = opts.yaw ?? 0;
    this.desiredYaw = this.yaw;
    this.groundY = 0;
    this.velocity = new THREE.Vector3();
    this.controlled = false;
    /** Turn rate in rad/s. Faster when stationary; a running man turns slowly. */
    this.turnRate = 6.0;

    this.anim = new Animator(this, opts.terrain ?? null);
    this.anim.stance = opts.stance ?? 'stand';
    // Gate the bone-texture rebuild behind a dirty flag; see lod.js.
    gateSkeleton(this.rig.skeleton);

    // Take the bones off automatic matrix maintenance.
    //
    // `WebGLRenderer.render` calls `scene.updateMatrixWorld()` every frame.
    // With `matrixAutoUpdate` on, that re-composes the local matrix of every
    // one of 27 bones per character — and `updateMatrix()` sets
    // `matrixWorldNeedsUpdate`, so it then also re-multiplies all 27 world
    // matrices, whether or not a single joint moved. Across a 15-man garrison
    // that is ~800 matrix operations per frame duplicating work the animator
    // already did, and it is paid in full for characters the LOD scheduler
    // deliberately skipped. The animator composes explicitly instead
    // (`_composeAll`), so the renderer's walk becomes a pure traversal.
    for (const b of this.rig.bones) b.matrixAutoUpdate = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.root.matrixAutoUpdate = false;

    this._moveDir = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this._tmp = new THREE.Vector3();
  }

  /**
   * Swap between the authored geometry and the distance geometry. A pointer
   * write — the skeleton binding, the material array and the bounding sphere
   * are all identical between the two.
   */
  setDetailLow(on) {
    if (!this.geoLow || on === this.detailLow) return;
    this.detailLow = on;
    this.mesh.geometry = on ? this.geoLow : this.geoHigh;
  }

  /** Head/eye world position — handy for AI line-of-sight and camera framing. */
  eyePosition(out = new THREE.Vector3()) {
    this.rig.byName.get('head').getWorldPosition(out);
    return out;
  }

  // --- the public actor API ------------------------------------------------
  // These four names are the contract the gameplay and AI modules build
  // against. `characters.setStance` and friends in index.js are thin wrappers
  // that resolve an actor handle and call straight through to here.

  /** 'stand' | 'crouch' | 'prone' | 'down'. */
  setStance(s) {
    return this.anim.loco.setStance(s);
  }

  /**
   * Desired world velocity in m/s. Magnitude picks the gait; direction is the
   * direction of travel, which does NOT have to be the facing — a soldier
   * backing away from a threat keeps the weapon on it. Position is integrated
   * from the *smoothed* speed in `update()`, so the stride and the ground
   * always agree and the feet never slide.
   */
  setLocomotion(v) {
    this.anim.loco.setVelocity(v);
    return this;
  }

  /** Where the body should be pointing. Yaw is approached at `turnRate`. */
  setFacing(yaw) {
    if (Number.isFinite(yaw)) this.desiredYaw = yaw;
    return this;
  }

  /**
   * Aim at a world point, or `null` to lower the weapon. Sets the shoulder
   * blend as well as the target, so a caller only ever needs this one call.
   */
  setAimTarget(p) {
    const a = this.anim;
    if (!p) {
      a.aimActive = false;
      a.aimGoal = 0;
      return this;
    }
    a.aimActive = true;
    a.aimTarget.copy(p);
    if (a.aimGoal === null || a.aimGoal < 0.05) a.aimGoal = 1;
    return this;
  }

  /** Fine control over how shouldered the weapon is, 0 (slung) .. 1 (cheek weld). */
  setAimWeight(w) {
    this.anim.aimGoal = THREE.MathUtils.clamp(w, 0, 1);
    return this;
  }

  /** 'fire' | 'reload' | 'cqc' | 'takedown' | 'throw' | 'hit' | 'tranq' | 'wake' | 'checkWatch'. */
  playAction(name, opts) {
    if (name === 'hit' && opts?.dir) {
      this.anim.hit(opts.dir);
      return true;
    }
    const ok = this.anim.play(name, opts);
    // A man who has just been put to sleep is not patrolling. Keep the
    // behaviour layer in step so it does not try to walk a body around.
    if (ok && this.behaviour) {
      if (name === 'tranq') {
        this.setLocomotion(null);
        this.setAimTarget(null);
        this.setLookTarget(null);
        this.behaviour.setState('downed');
      } else if (name === 'wake') {
        this.behaviour.setState('post', { yaw: this.yaw });
      }
    }
    return ok;
  }

  /** Look at a world point, or `null` to return to the animator's own idle sweep. */
  setLookTarget(v) {
    this.anim.lookTarget = v ? (this.anim.lookTarget ?? new THREE.Vector3()).copy(v) : null;
    return this;
  }

  /** Drop the actor exactly here without dragging its planted feet along. */
  warp(x, z, yaw) {
    this.position.x = x;
    this.position.z = z;
    if (yaw !== undefined) {
      this.yaw = yaw;
      this.desiredYaw = yaw;
    }
    this.anim.footTargets.R.planted = false;
    this.anim.footTargets.L.planted = false;
    this.anim._lastPos.set(NaN, NaN, NaN);
    return this;
  }

  get busy() {
    return this.anim.actions.busy;
  }

  get downed() {
    return this.anim.actions.downT > 0.5;
  }

  /** One word describing what the body is currently doing. */
  get locomotionState() {
    return this.anim.loco.label;
  }

  // --- back-compat ---------------------------------------------------------
  setAim(on, target) {
    if (target) this.anim.aimTarget.copy(target);
    this.anim.aimActive = !!(on && (target || this.anim.aimActive));
    this.anim.aimGoal = on ? 1 : 0;
  }

  lookAt(v) {
    return this.setLookTarget(v);
  }

  takeHit(dirWorld) {
    this.anim.hit(dirWorld ?? new THREE.Vector3(0, 0, 1));
  }

  /** Move at `speed` m/s toward `yaw`. Kept for callers written before the
   *  velocity API existed; it just fills in the same inputs. */
  drive(dt, speed, yaw) {
    if (yaw !== undefined) this.desiredYaw = yaw;
    const y = yaw !== undefined ? yaw : this.yaw;
    this._tmp.set(-Math.sin(y) * speed, 0, -Math.cos(y) * speed);
    this.setLocomotion(this._tmp);
    void dt;
  }

  /**
   * `ik` comes from the LOD scheduler: 2 full, 1 reduced, 0 legs on FK.
   * Position is integrated here rather than by the caller so that translation
   * and the gait cycle are computed from the same smoothed speed.
   */
  update(dt, ik = 2) {
    const L = this.anim.loco;
    const locked = this.anim.actions.lockLoco;

    // Facing. A stationary man pivots quickly; a running one leans into it.
    let d = this.desiredYaw - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const rate = this.turnRate * (1 - 0.55 * Math.min(1, L.smoothSpeed / 4));
    const step = d * Math.min(1, dt * rate);
    this.yaw += step;
    L.yawRate = dt > 0 ? step / dt : 0;

    if (locked) L.setVelocity(null);
    else if (L.velocity.lengthSq() > 1e-6) this._moveDir.copy(L.velocity).setY(0).normalize();

    this.anim.update(dt, ik);

    if (!locked && L.smoothSpeed > 0.005) {
      this.position.addScaledVector(this._moveDir, L.smoothSpeed * dt);
    }
  }

  dispose() {
    // Geometry is shared between every instance of a variant; only the
    // per-instance materials belong to this character.
    for (const m of Object.values(this.materials)) m.dispose();
  }
}
