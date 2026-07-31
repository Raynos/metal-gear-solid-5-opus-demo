import * as THREE from 'three';
import { createRig } from './rig.js';
import { assemble } from './skinning.js';
import { makeMaterialSet, Z, SZ, MZ } from './materials.js';
import { frameMatrix } from './geometry.js';
import {
  buildTorso, buildHips, buildNeck, buildHead, buildHair, buildEyes, buildArm, buildHand, buildLeg, buildBoot, ARM, armPoint,
} from './body.js';
import {
  buildChestRig, buildBelt, buildHolster, buildBackpack, buildHelmet, buildCap, buildBoonie,
  buildBandana, buildEyepatch, buildProstheticArm, buildRifle, buildKneepads, buildPockets,
} from './gear.js';
import { Animator } from './anim.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const HAND_GRIP_LOCAL = V(0, 0.088, 0.032);

/**
 * Assemble a complete character from a loadout, and wire up the attachment
 * frames the animator needs to keep the weapon locked in both hands.
 */
export function buildCharacterGeometry(loadout) {
  const rig = createRig();
  const parts = [];
  const add = (list, group) => {
    for (const p of list) parts.push({ surface: p.surface, mat: p.mat, group });
  };
  const one = (surface, mat, group) => parts.push({ surface, mat, group });

  const bulk = loadout.bulk ?? 1;

  // --- body ---------------------------------------------------------------
  one(buildTorso({ bulk }), 'cloth', 'torso');
  one(buildHips({ bulk }), 'cloth', 'hips');
  one(buildNeck(), 'skin', 'neck');
  one(buildHead(loadout.head ?? {}), 'skin', 'head');
  one(buildEyes(), 'skin', 'rigidHead');
  if (loadout.hair !== false) one(buildHair({ backOnly: loadout.hairBack ?? false }), 'cloth', 'rigidHead');

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
      add(buildHelmet(), 'rigidHead');
      break;
    case 'cap':
      add(buildCap(), 'rigidHead');
      break;
    case 'boonie':
      add(buildBoonie(), 'rigidHead');
      break;
    case 'bandana':
      add(buildBandana(), 'rigidHead');
      break;
    default:
      break;
  }
  if (loadout.eyepatch) add(buildEyepatch(), 'rigidHead');

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
    this.groundY = 0;
    this.velocity = new THREE.Vector3();
    this.controlled = false;

    this.anim = new Animator(this, opts.terrain ?? null);
    this.anim.stance = opts.stance ?? 'stand';
  }

  /** Head/eye world position — handy for AI line-of-sight and camera framing. */
  eyePosition(out = new THREE.Vector3()) {
    this.rig.byName.get('head').getWorldPosition(out);
    return out;
  }

  setStance(s) {
    this.anim.stance = s;
  }

  setAim(on, target) {
    this.anim.aim = on ? 1 : 0;
    if (target) this.anim.aimTarget.copy(target);
  }

  lookAt(v) {
    this.anim.lookTarget = v ? (this.anim.lookTarget ?? new THREE.Vector3()).copy(v) : null;
  }

  takeHit(dirWorld) {
    this.anim.hit(dirWorld ?? new THREE.Vector3(0, 0, 1));
  }

  /** Move at `speed` m/s toward `yaw`; the gait follows automatically. */
  drive(dt, speed, yaw) {
    this.anim.speed = speed;
    if (yaw !== undefined) {
      let d = yaw - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * Math.min(1, dt * 5);
    }
    if (speed > 0.01) {
      this.position.x += -Math.sin(this.yaw) * speed * dt;
      this.position.z += -Math.cos(this.yaw) * speed * dt;
    }
  }

  update(dt) {
    this.anim.update(dt);
  }

  dispose() {
    this.mesh.geometry.dispose();
    for (const m of Object.values(this.materials)) m.dispose();
  }
}
