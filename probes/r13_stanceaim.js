/**
 * r13_stanceaim.js — where the weapon actually sits when you aim from a crouch
 * or from prone.
 *
 * Reported: "the gun is floating in the air at standing position and the hands
 * dangle way up overhead". `_weaponTargetPose` blends every stance carry by
 * `base = 1 - aim` and then adds a single WEAPON_POSES.aim on top, so at full
 * aim the stance term is multiplied by zero and one standing pose is all that
 * is left. This measures the gap rather than asserting it: bore height against
 * the character's own head and shoulder in each stance.
 *
 * Returns a photograph of each stance as well, because a number does not show
 * a dangling arm.
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const reg = W.registry;
const gp = reg.gameplay ?? reg.player;
const eng = W.engine;
const canvas = eng.renderer.domElement;

const held = new Set();
const key = (code, down) => {
  if (down) held.add(code); else held.delete(code);
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));
};
const run = (n) => { for (let i = 0; i < n; i++) eng.step(1 / 60); };

W.gameState.setMode('play');
run(30);

const ch = gp.player ?? gp.controller?.character ?? null;
if (!ch) {
  return { error: 'no player character', gpKeys: Object.keys(gp), charKeys: Object.keys(reg.characters ?? {}) };
}
const anim = ch.anim;
const bones = {};
ch.root.traverse((o) => { if (o.isBone && o.name) bones[o.name] = o; });

const wv = new THREE.Vector3();
const boneY = (name) => {
  const b = bones?.[name];
  if (!b) return null;
  b.getWorldPosition(wv);
  return +wv.y.toFixed(3);
};

// Grip in world space, exactly as _solveWeapon computes it.
function gripWorldY() {
  const wp = ch.weapon ?? ch.weaponRoot ?? null;
  if (wp) { wp.getWorldPosition(wv); return +wv.y.toFixed(3); }
  return null;
}

const shots = {};
const rows = [];

function sample(label) {
  run(90);                       // let the stance and aim blends converge
  for (let i = 0; i < 4; i++) eng.render();
  rows.push({
    stance: label,
    aim: +anim.aim.toFixed(2),
    crouchBlend: +anim.loco.stanceBlend.toFixed(2),
    proneBlend: +anim.loco.proneBlend.toFixed(2),
    rootY: +ch.root.position.y.toFixed(3),
    headY: boneY('head'),
    shoulderRY: boneY('clavR') ?? boneY('upperArmR'),
    handRY: boneY('handR'),
    gripY: gripWorldY(),
    // The pose the blender actually produced, in root space.
    poseY: +anim._p.y.toFixed(3),
  });
  const c = document.createElement('canvas');
  c.width = 960; c.height = 540;
  c.getContext('2d').drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, 960, 540);
  shots[label] = c.toDataURL('image/png');
}

key('KeyE', true);                       // aim, and hold it throughout
sample('stand+aim');
key('ControlLeft', true); run(2); key('ControlLeft', false);
sample('crouch+aim');
key('KeyZ', true); run(2); key('KeyZ', false);
sample('prone+aim');
key('KeyE', false);
sample('prone+carry');

for (const c of [...held]) key(c, false);
W.gameState.setMode('godmode');

return { rows, boneNames: bones ? Object.keys(bones).slice(0, 24) : null, ...shots };
