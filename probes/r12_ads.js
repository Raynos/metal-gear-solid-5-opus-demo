/**
 * r12_ads.js — everything about the AIMED frame, in numbers, in one pass.
 *
 * Reproduces exactly what `tools/shot.mjs gameplay --aim` photographs
 * (applyShot -> play -> hold KeyE -> 45 real frames) and then measures the five
 * things the complaint is actually about, so a change can be judged by
 * something other than staring at a PNG:
 *
 *   1. THE LENS      — hip/ADS FOV, the zoom ratio, and how many pixels of a
 *                      1080-line frame a human head subtends at 15 / 25 / 40 m.
 *   2. THE FRAMING   — the screen rectangle the player's own body occupies, as
 *                      a fraction of frame width, and where the aim space is.
 *   3. THE WEAPON    — grip and muzzle projected to screen, plus whether the
 *                      muzzle is behind the player's own skin (a camera->muzzle
 *                      ray against the character's mesh).
 *   4. THE ALIGNMENT — barrel axis against the dart's line and against the
 *                      aimTarget the rig was handed. This is r12_pose.js's
 *                      measurement taken in the CANONICAL shot pose instead of
 *                      a synthesised one, so it is the same frame as the image.
 *   5. THE SIGHT     — is the reticle actually on screen, and where.
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const reg = W.registry;
const gp = reg.gameplay ?? reg.player;
const eng = W.engine;
const st = gp.stealth;
const cam = eng.camera;
const out = [];
const D = (r) => (r * 180 / Math.PI);
const ang = (a, b) => D(Math.acos(THREE.MathUtils.clamp(a.clone().normalize().dot(b.clone().normalize()), -1, 1)));

// --- the same pose the harness photographs --------------------------------
g.applyShot('gameplay');
g.setMode('play');
window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
for (let k = 0; k < 45; k++) eng.step(1 / 60);

const H = window.innerHeight;
const Wd = window.innerWidth;
const proj = (p) => {
  const v = p.clone().project(cam);
  return { x: v.x, y: v.y, px: (v.x * 0.5 + 0.5) * Wd, py: (-v.y * 0.5 + 0.5) * H, front: v.z < 1 };
};
/** px a sphere of diameter `d` subtends at range `r`. */
const subtend = (d, r) => d / (2 * r * Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5)) * H;

const a = gp.player;
const anim = a.anim;
const ctl = gp.controller;

out.push('1. THE LENS');
out.push(`  fov ${cam.fov.toFixed(1)} deg   aimBlend ${gp.camera.aimBlend.toFixed(3)}   aimAmount ${st.aimAmount.toFixed(2)}`);
out.push(`  zoom vs hip 45 deg: ${(Math.tan(THREE.MathUtils.degToRad(45) * 0.5) / Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5)).toFixed(2)}x`);
out.push(`  a 0.22 m head is ${subtend(0.22, 15).toFixed(1)} px at 15 m, ${subtend(0.22, 25).toFixed(1)} px at 25 m, `
  + `${subtend(0.22, 40).toFixed(1)} px at 40 m  (reticle box is 16 px)`);
out.push(`  look scale ${gp.camera.lookScale().toFixed(3)}; ADS screen-space look speed vs hip = ${(gp.camera.lookScale() * Math.tan(THREE.MathUtils.degToRad(45) * 0.5) / Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5)).toFixed(3)}x (1.000 is the invariant)`);
out.push('');

// --- 2. framing ------------------------------------------------------------
// The body's screen rectangle, from the skinned bones rather than a bounding
// box: a bounding box on a skinned mesh is the BIND pose and says nothing about
// where the shoulder actually is this frame.
out.push('2. THE FRAMING');
// SPLIT THE HULL. The first version of this pooled every bone and the number it
// produced was useless: raising the weapon puts the firing HAND further right
// than any part of the torso, so "the bone hull reaches 45% across the frame"
// tracked the hand and said nothing about the body that is doing the blocking.
const bp = new THREE.Vector3();
const hull = (pred, label) => {
  let x0 = 1e9; let x1 = -1e9; let n = 0;
  for (const b of a.rig?.bones ?? []) {
    if (!pred(b.name)) continue;
    b.getWorldPosition(bp);
    const s = proj(bp);
    if (!s.front) continue;
    n++;
    x0 = Math.min(x0, s.px); x1 = Math.max(x1, s.px);
  }
  out.push(`  ${label.padEnd(22)} ${n} bones, x ${x0.toFixed(0)}..${x1.toFixed(0)} px `
    + `— its inboard edge is at ${(x1 / Wd * 100).toFixed(0)}% of frame width (centre is 50%)`);
};
hull((n) => /spine|chest|hips|neck|head|clav/i.test(n), 'torso + head');
hull((n) => /arm|hand/i.test(n), 'arms + hands');
const rig = gp.camera;
const root = ctl.position;
const eyeW = new THREE.Vector3(root.x, st.eyeY, root.z);
out.push(`  camera is ${cam.position.distanceTo(eyeW).toFixed(3)} m from the eye; `
  + `offset right/up/back = ${(() => {
    const d = cam.position.clone().sub(eyeW);
    const y = rig.yaw;
    return [`${(d.x * Math.cos(y) - d.z * Math.sin(y)).toFixed(3)}`, `${d.y.toFixed(3)}`,
      `${(d.x * Math.sin(y) + d.z * Math.cos(y)).toFixed(3)}`].join(', ');
  })()}`);
out.push('');

// --- 3. the weapon ---------------------------------------------------------
out.push('3. THE WEAPON');
const M = anim._weaponM;
const muzzle = new THREE.Vector3(0.585, 0.012, 0).applyMatrix4(M);
const grip = new THREE.Vector3(-0.078, -0.075, 0).applyMatrix4(M);
const butt = new THREE.Vector3(-0.3, -0.006, 0).applyMatrix4(M);
const sm = proj(muzzle); const sg = proj(grip); const sb = proj(butt);
out.push(`  muzzle at screen (${sm.px.toFixed(0)}, ${sm.py.toFixed(0)}) ${sm.front ? '' : 'BEHIND LENS '}`
  + `— ${(sm.px - Wd / 2).toFixed(0)} px from centre`);
out.push(`  grip   at screen (${sg.px.toFixed(0)}, ${sg.py.toFixed(0)})   butt at (${sb.px.toFixed(0)}, ${sb.py.toFixed(0)})`);
out.push(`  the weapon draws ${Math.hypot(sm.px - sb.px, sm.py - sb.py).toFixed(0)} px long on screen`);
// Named anchors, so a grey plate in a screenshot can be identified instead of
// guessed at. Every one of these is read off the model, not assumed.
{
  const rf = a.rifle ?? {};
  const marks = [
    ['muzzle tip   ', rf.muzzle ?? new THREE.Vector3(0.585, 0.012, 0)],
    ['optic        ', new THREE.Vector3(0.01, 0.105, 0)],
    ['magazine base', new THREE.Vector3(0.108, -0.205, 0)],
    ['pistol grip  ', rf.gripCenter ?? new THREE.Vector3(-0.078, -0.075, 0)],
    ['butt pad     ', new THREE.Vector3(-0.30, -0.006, 0)],
    ['foregrip     ', rf.foregrip ?? new THREE.Vector3(0.24, -0.02, 0)],
  ];
  for (const [name, v] of marks) {
    const s = proj(v.clone().applyMatrix4(M));
    out.push(`    ${name} -> (${s.px.toFixed(0)}, ${s.py.toFixed(0)})`);
  }
  for (const side of ['handR', 'handL']) {
    const b = a.rig?.byName?.get?.(side);
    if (!b) continue;
    const s = proj(b.getWorldPosition(new THREE.Vector3()));
    out.push(`    ${side.padEnd(13)} -> (${s.px.toFixed(0)}, ${s.py.toFixed(0)})`);
  }
}
// IS THE BODY IN THE WAY? Ray from the lens to points along the barrel, against
// the player's own mesh.
//
// THE OBVIOUS VERSION OF THIS TEST IS WRONG AND I PUBLISHED IT ONCE. The rifle
// is welded into the character's own skinned geometry (character.js assembles
// its parts under `rigidHandR`), so a ray to the muzzle hits the SUPPRESSOR AND
// HANDGUARD on its way in and every sample comes back "occluded" no matter
// where the weapon is. The first run of this probe reported 11 of 11 points
// behind his own body in a pose where the weapon was plainly visible on screen.
//
// So classify by WHERE the blocking hit is in the character's own frame: a hit
// within 0.35 m of the sample point along the same ray is the weapon (or the
// hand on it), and anything earlier than that is torso, pack, arm or skull.
const rc = new THREE.Raycaster();
const skin = [];
a.root.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) skin.push(o); });
const invRoot = new THREE.Matrix4().copy(a.root.matrixWorld).invert();
let occl = 0;
let firstDesc = '';
for (let i = 0; i <= 10; i++) {
  const p = grip.clone().lerp(muzzle, i / 10);
  const d2 = p.clone().sub(cam.position);
  const L = d2.length();
  rc.set(cam.position, d2.normalize());
  rc.far = L - 0.02;
  const hits = rc.intersectObjects(skin, true);
  const body = hits.find((h) => L - h.distance > 0.35);
  if (!body) continue;
  occl++;
  if (!firstDesc) {
    const lp = body.point.clone().applyMatrix4(invRoot);
    firstDesc = `char-space (${lp.x.toFixed(2)}, ${lp.y.toFixed(2)}, ${lp.z.toFixed(2)}), `
      + `${(L - body.distance).toFixed(2)} m in front of the barrel`;
  }
}
out.push(`  ${occl} of 11 points along grip->muzzle are behind his own BODY`
  + `${firstDesc ? ` — first occluder at ${firstDesc}` : ' — the barrel is in the clear'}`);
out.push('');

// --- 4. alignment ----------------------------------------------------------
out.push('4. THE ALIGNMENT');
const o = new THREE.Vector3();
const d = new THREE.Vector3();
st.aimRay(o, d);
const axis = muzzle.clone().sub(grip);
out.push(`  anim.aim ${anim.aim.toFixed(3)}  aimActive ${anim.aimActive}  aimTarget ${anim.aimTarget.distanceTo(o).toFixed(1)} m out`);
out.push(`  aimTarget is ${ang(anim.aimTarget.clone().sub(o), d).toFixed(2)} deg off the dart's line (gameplay's half)`);
out.push(`  barrel axis is ${ang(axis, d).toFixed(1)} deg off the dart's line`);
out.push(`  barrel axis is ${ang(axis, anim.aimTarget.clone().sub(grip)).toFixed(1)} deg off the aimTarget it was handed`);
{
  // Split the error into flat and pitch so it says WHICH way it is wrong.
  const f = (v) => ({ yaw: Math.atan2(-v.x, -v.z), pitch: Math.atan2(v.y, Math.hypot(v.x, v.z)) });
  const A = f(axis); const B = f(d);
  const dy = Math.atan2(Math.sin(A.yaw - B.yaw), Math.cos(A.yaw - B.yaw));
  out.push(`    -> ${D(dy).toFixed(1)} deg in yaw, ${D(A.pitch - B.pitch).toFixed(1)} deg in pitch`);
}
out.push(`  muzzlePoint() lands ${(() => { const m2 = new THREE.Vector3(); st.muzzlePoint(m2, d); return m2.distanceTo(muzzle).toFixed(3); })()} m from the model's barrel tip`);
{
  const shR = a.rig?.byName?.get?.('armR')?.getWorldPosition(new THREE.Vector3());
  if (shR) {
    out.push(`  butt pad is ${butt.distanceTo(shR).toFixed(3)} m from the right shoulder ball (shouldered ~0.05-0.15, low ready 0.35+)`);
    // In the character's OWN frame, so the authored pose can be moved by the
    // difference instead of by trial and error.
    const inv = new THREE.Matrix4().copy(a.root.matrixWorld).invert();
    const bl = butt.clone().applyMatrix4(inv);
    const sl = shR.clone().applyMatrix4(inv);
    out.push(`    butt is at char (${bl.x.toFixed(3)}, ${bl.y.toFixed(3)}, ${bl.z.toFixed(3)}), `
      + `shoulder ball at char (${sl.x.toFixed(3)}, ${sl.y.toFixed(3)}, ${sl.z.toFixed(3)})`);
  }
}
out.push('');

// --- 5. the sight ----------------------------------------------------------
out.push('5. THE SIGHT');
const el = document.querySelector('.gp-ret');
const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(el?.style.transform || '');
out.push(`  reticle element ${el ? 'exists' : 'MISSING'}, opacity ${el?.style.opacity ?? 'n/a'}, `
  + `size ${el?.style.getPropertyValue('--sz') || 'n/a'}, at ${m ? `(${(+m[1] - Wd / 2).toFixed(0)}, ${(+m[2] - H / 2).toFixed(0)}) px from centre` : 'no transform'}`);
out.push(`  engine.deterministic = ${eng.deterministic} (true suppresses it: gameplay/index.js order 1100)`);
out.push(`  swayScale ${st.swayScale.toFixed(2)} -> box would be ${Math.max(9, Math.min(64, Math.round(16 * st.swayScale / 2) * 2))} px`);
out.push('');
out.push(`page errors: ${g.errors.length ? g.errors.slice(0, 4).join(' | ') : 'none'}`);
return out.join('\n');
