import * as THREE from 'three';

/**
 * The humanoid rig.
 *
 * Bind pose is a relaxed A-pose (arms ~30 deg off vertical) — the standard
 * compromise that keeps the armpit and the deltoid from collapsing when the arm
 * is either raised to aim or dropped to the side.
 *
 * Every bone is authored with an identity rotation and a pure translation, which
 * means each bone's "aim axis" is simply the normalised offset of its primary
 * child. The IK solver leans on that heavily.
 *
 * Proportions: 1.83 m tall, head 0.245 m => 7.47 heads. Real human canon.
 */

// name, parent, bind position in character space (feet on y = 0, facing -Z)
const SPEC = [
  ['root', null, [0, 0.985, 0]],
  ['spine1', 'root', [0, 1.1, -0.006]],
  ['spine2', 'spine1', [0, 1.235, -0.014]],
  ['chest', 'spine2', [0, 1.375, -0.012]],
  ['neck', 'chest', [0, 1.522, 0.004]],
  ['head', 'neck', [0, 1.6, -0.008]],
  ['headTip', 'head', [0, 1.79, -0.02]],

  // ROUND 6 — the glenohumeral joints move out 14 mm each (0.176 -> 0.190) and
  // the whole limb translates with them, so every bone LENGTH is unchanged and
  // nothing downstream of the IK has to be re-tuned.
  //
  // This is an anatomy fix, not a metric fix. The torso's own acromion measures
  // 0.4225 m across (`probes/r7c/headwidth.js`), and a shoulder joint centre
  // sits about 20-25 mm inboard of the acromion — so the joints belonged near
  // +/-0.190, not +/-0.176, which put them 35 mm inboard and hung both arms off
  // the middle of the ribcage. The visible consequence was that the deltoid
  // never cleared the chest rig, so the arm and the torso read as one mass.
  ['clavR', 'chest', [0.050, 1.472, -0.024]],
  ['armR', 'clavR', [0.190, 1.452, -0.014]],
  ['forearmR', 'armR', [0.350, 1.192, -0.02]],
  ['handR', 'forearmR', [0.485, 0.962, -0.014]],
  ['handTipR', 'handR', [0.538, 0.872, -0.008]],

  ['clavL', 'chest', [-0.050, 1.472, -0.024]],
  ['armL', 'clavL', [-0.190, 1.452, -0.014]],
  ['forearmL', 'armL', [-0.350, 1.192, -0.02]],
  ['handL', 'forearmL', [-0.485, 0.962, -0.014]],
  ['handTipL', 'handL', [-0.538, 0.872, -0.008]],

  ['upLegR', 'root', [0.094, 0.942, -0.004]],
  ['lowLegR', 'upLegR', [0.099, 0.508, 0.008]],
  ['footR', 'lowLegR', [0.102, 0.082, 0.026]],
  ['toeR', 'footR', [0.102, 0.028, -0.108]],

  ['upLegL', 'root', [-0.094, 0.942, -0.004]],
  ['lowLegL', 'upLegL', [-0.099, 0.508, 0.008]],
  ['footL', 'lowLegL', [-0.102, 0.082, 0.026]],
  ['toeL', 'footL', [-0.102, 0.028, -0.108]],
];

/**
 * Which bones may influence which body part. Restricting the candidate set per
 * part is what stops the classic auto-skinning failure where the left hand,
 * passing near the hip in bind pose, gets weighted to the pelvis and tears when
 * the arm swings.
 */
export const BONE_GROUPS = {
  torso: ['root', 'spine1', 'spine2', 'chest', 'neck', 'clavR', 'clavL', 'armR', 'armL'],
  hips: ['root', 'spine1', 'upLegR', 'upLegL'],
  head: ['neck', 'head', 'headTip'],
  neck: ['chest', 'neck', 'head'],
  armR: ['clavR', 'armR', 'forearmR', 'handR', 'chest'],
  armL: ['clavL', 'armL', 'forearmL', 'handL', 'chest'],
  handR: ['forearmR', 'handR', 'handTipR'],
  handL: ['forearmL', 'handL', 'handTipL'],
  legR: ['root', 'upLegR', 'lowLegR', 'footR'],
  legL: ['root', 'upLegL', 'lowLegL', 'footL'],
  footR: ['lowLegR', 'footR', 'toeR'],
  footL: ['lowLegL', 'footL', 'toeL'],
  // Rigid attachments: kit welded to a single bone so it never shears.
  rigidChest: ['chest'],
  rigidSpine: ['spine2'],
  rigidRoot: ['root'],
  rigidHead: ['head'],
  rigidHandR: ['handR'],
  rigidHandL: ['handL'],
  rigidLegR: ['upLegR'],
  rigidLegL: ['upLegL'],
  kneeR: ['lowLegR'],
  kneeL: ['lowLegL'],
};

/** Falloff radius per bone, in metres. Tuned so joints blend over ~1 limb width. */
const RADIUS = {
  root: 0.34,
  spine1: 0.3,
  spine2: 0.3,
  chest: 0.34,
  neck: 0.16,
  head: 0.26,
  headTip: 0.16,
  clavR: 0.14,
  clavL: 0.14,
  armR: 0.19,
  armL: 0.19,
  forearmR: 0.16,
  forearmL: 0.16,
  handR: 0.11,
  handL: 0.11,
  handTipR: 0.08,
  handTipL: 0.08,
  upLegR: 0.24,
  upLegL: 0.24,
  lowLegR: 0.21,
  lowLegL: 0.21,
  footR: 0.13,
  footL: 0.13,
  toeR: 0.09,
  toeL: 0.09,
};

export function createRig() {
  const bones = [];
  const byName = new Map();
  const bindWorld = new Map();
  let rootBone = null;

  for (const [name, parent, p] of SPEC) {
    const b = new THREE.Bone();
    b.name = name;
    bindWorld.set(name, new THREE.Vector3(...p));
    if (parent) {
      const pb = byName.get(parent);
      const pp = bindWorld.get(parent);
      b.position.set(p[0] - pp.x, p[1] - pp.y, p[2] - pp.z);
      pb.add(b);
    } else {
      b.position.set(...p);
      rootBone = b;
    }
    b.userData.rest = b.position.clone();
    byName.set(name, b);
    bones.push(b);
  }

  rootBone.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);

  // Aim axis + length toward the primary child, in bone-local space. Because
  // bind rotations are identity this is just the child's rest translation.
  for (const b of bones) {
    const child = b.children.find((c) => c.isBone);
    if (child) {
      b.userData.axis = child.position.clone().normalize();
      b.userData.len = child.position.length();
    } else {
      b.userData.axis = new THREE.Vector3(0, -1, 0);
      b.userData.len = 0.06;
    }
  }

  const segments = bones.map((b) => {
    const w = bindWorld.get(b.name);
    const child = b.children.find((c) => c.isBone);
    const tip = child ? bindWorld.get(child.name) : w.clone().addScaledVector(b.userData.axis, b.userData.len);
    return { name: b.name, a: w.clone(), b: tip.clone(), r: RADIUS[b.name] ?? 0.16, index: bones.indexOf(b) };
  });

  return { bones, byName, bindWorld, skeleton, rootBone, segments };
}

/** Squared distance from p to segment ab. */
export function distToSegment(px, py, pz, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const apx = px - a.x;
  const apy = py - a.y;
  const apz = pz - a.z;
  const denom = abx * abx + aby * aby + abz * abz;
  let t = denom > 1e-9 ? (apx * abx + apy * aby + apz * abz) / denom : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  const dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
