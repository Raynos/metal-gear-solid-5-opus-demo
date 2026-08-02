/**
 * r11_muzzle.js — which way is the rifle actually pointing?
 *
 * The suppressor is new and it is the first part of the weapon long enough to
 * be identified in a gameplay frame, which raised an obvious question the
 * screenshot could not settle: is that ringed tube by the right hand the
 * muzzle or the butt? Read the weapon matrix directly and say where each end
 * lands relative to the character's own facing.
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const api = W.registry.characters;
api.setAmbient(false);
api.setLodBias(false);
const a = api.player;
a.controlled = true;
a.setLocomotion(null);
for (let i = 0; i < 120; i++) W.engine.step(1 / 60);

const inv = new THREE.Matrix4().copy(a.root.matrixWorld).invert();
const at = (v) => {
  const p = new THREE.Vector3(...v).applyMatrix4(a.anim._weaponM).applyMatrix4(inv);
  return [p.x, p.y, p.z].map((q) => +q.toFixed(3));
};
// Weapon space: +X muzzle, +Y up, +Z shooter's right.
return {
  note: 'character space: +X right, +Y up, -Z FORWARD (the way he faces)',
  muzzleTip: at([0.585, 0.012, 0]),
  suppressorRear: at([0.372, 0.012, 0]),
  gripCenter: at([-0.078, -0.075, 0]),
  buttPad: at([-0.3, -0.006, 0]),
  optic: at([0.01, 0.086, 0]),
  handRworld: a.anim.b.handR.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv).toArray().map((q) => +q.toFixed(3)),
  // What Stealth.muzzlePoint() would produce: handR + 0.46 along the aim dir.
  muzzleTipDistanceFromHandR: +new THREE.Vector3(0.585, 0.012, 0)
    .applyMatrix4(a.anim._weaponM)
    .distanceTo(a.anim.b.handR.getWorldPosition(new THREE.Vector3()))
    .toFixed(3),
};
