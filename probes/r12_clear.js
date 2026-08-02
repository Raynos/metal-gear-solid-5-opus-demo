/**
 * r12_clear.js — WHERE can the aimed weapon go so the player can see it?
 *
 * `probes/r12_ads.js` says 11 of 11 points along grip->muzzle are behind the
 * player's own skin. That is a geometry question with a geometry answer, and
 * guessing at it from a screenshot is how the aim pose got here. This traces
 * camera->point against the player's own meshes over a grid of character-space
 * positions, for the CURRENT ADS rig and for candidate ones, and prints the
 * clear region directly.
 *
 * Character space: +x his right, +y up, -z his forward (feet at origin).
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const reg = W.registry;
const gp = reg.gameplay ?? reg.player;
const eng = W.engine;
const st = gp.stealth;
const out = [];

g.applyShot('gameplay');
g.setMode('play');
window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
for (let k = 0; k < 45; k++) eng.step(1 / 60);

const a = gp.player;
const ctl = gp.controller;
const yaw = gp.camera.yaw;
const cy = Math.cos(yaw); const sy = Math.sin(yaw);
// character space -> world. Through the character's OWN root matrix, which is
// the transform `_weaponM` is built on; hand-rolling it from a yaw got the sign
// of z backwards and reported the region BEHIND him as clear, which it is.
const toWorld = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(a.root.matrixWorld);
const skin = [];
a.root.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) skin.push(o); });
const rc = new THREE.Raycaster();
const clearFrom = (eye, p) => {
  const d = p.clone().sub(eye);
  const L = d.length();
  rc.set(eye, d.normalize());
  rc.far = L - 0.03;
  return rc.intersectObjects(skin, true).length === 0;
};

/** The lens for a candidate rig, in world space, on the current heading. */
const lensAt = (lat, up, back) => new THREE.Vector3(
  ctl.position.x + lat * cy + back * sy,
  ctl.position.y + up,
  ctl.position.z + -lat * sy + back * cy,
);

// The shipped ADS rig, read back rather than assumed.
const shipped = { lat: 0.410, eye: 1.665 + 0.245 - 1.665, back: 1.440 };
void shipped;
const CUR = eng.camera.position.clone();

out.push(`camera is at char-space right ${(() => {
  const d = CUR.clone().sub(ctl.position);
  return (d.x * cy - d.z * sy).toFixed(3);
})()}, up ${(CUR.y - ctl.position.y).toFixed(3)}, back ${(() => {
  const d = CUR.clone().sub(ctl.position);
  return (d.x * sy + d.z * cy).toFixed(3);
})()}  (from the FEET)`);
// Sanity check the mapping before trusting a grid drawn with it: the shipped
// aim pose's grip, pushed through toWorld, must land on the grip the animator
// actually solved.
{
  const truth = new THREE.Vector3(-0.078, -0.075, 0).applyMatrix4(a.anim._weaponM);
  const mine = toWorld(0.115, 1.4, -0.3);
  out.push(`mapping check: authored aim grip -> ${mine.distanceTo(truth).toFixed(3)} m from the solved grip `
    + `(sway + action offsets account for a few cm; a metre means the axes are wrong)`);
}
out.push('');

// --- 1. the clear region for the CURRENT rig -------------------------------
// A shouldered weapon lives between waist and eye height and between the chest
// and 0.9 m in front of it. Sweep that slab.
const XS = [-0.10, 0.00, 0.10, 0.20, 0.30, 0.40, 0.50];
const YS = [1.75, 1.65, 1.55, 1.45, 1.35, 1.25];
const ZS = [-0.30, -0.55, -0.80];
const grid = (eye, label) => {
  out.push(label);
  for (const z of ZS) {
    out.push(`  z = ${z.toFixed(2)} (m in front of him)      x:` + XS.map((x) => String(x.toFixed(2)).padStart(6)).join(''));
    for (const y of YS) {
      const row = XS.map((x) => (clearFrom(eye, toWorld(x, y, z)) ? '     .' : '     #')).join('');
      out.push(`    y ${y.toFixed(2)}                        ` + row);
    }
  }
  out.push('    ( . = the player can see this point, # = his own body is in the way )');
  out.push('');
};
grid(CUR, `1. CURRENT ADS RIG (fov ${eng.camera.fov.toFixed(0)})`);

// --- 2. candidate rigs -----------------------------------------------------
// Only the lateral and the height are swept: the boom length barely changes
// which of his own parts are between the lens and the weapon, because both
// move together along the same line.
for (const c of [
  { lat: 0.55, up: 1.72, back: 1.44 },
  { lat: 0.55, up: 1.62, back: 1.10 },
  { lat: 0.68, up: 1.62, back: 1.10 },
]) {
  grid(lensAt(c.lat, c.up, c.back), `2. CANDIDATE lat ${c.lat} up ${c.up} back ${c.back}`);
}

out.push(`page errors: ${g.errors.length ? g.errors.slice(0, 3).join(' | ') : 'none'}`);
return out.join('\n');
