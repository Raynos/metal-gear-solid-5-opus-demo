/**
 * r11_upper.js — is the upper body a passenger?
 *
 *   node tools/shot.mjs eval probes/r11_upper.js
 *
 * The complaint this measures: the hands are welded to a weapon transform that
 * hangs off `ch.root.matrixWorld` (the actor's Group), so the 0.24 rad
 * contralateral chest yaw that locomotion.js already produces never reaches
 * them. Two numbers say whether that is true.
 *
 *  1. HAND TRAVEL. Path length of each wrist per gait cycle, measured in
 *     CHARACTER SPACE (root.matrixWorld inverted out) so the body's own
 *     translation is not counted as arm swing. Peak-to-peak per axis is
 *     reported alongside it because a hand can rack up path length by
 *     vibrating; the two together describe the actual shape.
 *
 *  2. PHASE LOCK. Pearson correlation between wrist height and head height.
 *     If the only vertical the hands carry is the root bob, this is ~+1 and the
 *     arms are furniture bolted to the ribcage. Reported in world space AND in
 *     character space: world-Y correlation can never go to zero (both are on
 *     the same body walking over the same ground), so the character-space
 *     number is the one that is about the ANIMATION.
 *
 * TRAPS, both paid for once already:
 *  - LOD. Past the near ring the legs run pure FK and the plant latch does not
 *    exist. `setLodBias(false)` or the numbers describe a different rig.
 *  - Ambient behaviour will happily walk the actor off the measurement.
 *    `setControlled` first, then drive `setLocomotion` by hand every frame —
 *    behaviour.js overwrites velocity otherwise.
 */

const g = window.__GAME;
const W = g.world;
const THREE = g.THREE;
const api = W.registry?.characters;
if (!api) return { error: 'characters module not installed' };

api.setAmbient(false);
api.setLodBias(false);

const actor = api.player ?? api.characters[0];
if (!actor) return { error: 'no actor' };
actor.controlled = true;

const eng = W.engine;
const _inv = new THREE.Matrix4();
const _v = new THREE.Vector3();

function local(boneName) {
  actor.anim.b[boneName].getWorldPosition(_v);
  return _v.applyMatrix4(_inv).clone();
}
function world(boneName) {
  actor.anim.b[boneName].getWorldPosition(_v);
  return _v.clone();
}

function pearson(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den < 1e-12 ? 0 : num / den;
}

function pathLen(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += pts[i].distanceTo(pts[i - 1]);
  return s;
}
/**
 * Trajectory DIAMETER — the largest distance between any two points the hand
 * visits. This is the number the brief calls "hand travel", and it is not the
 * same thing as path length: the baseline carry traces a tight figure-of-eight
 * three times per cycle, which racks up 42 cm of path inside an 8 cm box. Path
 * length measures wobble; diameter measures swing.
 */
function span(pts) {
  let m = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) m = Math.max(m, pts[i].distanceToSquared(pts[j]));
  }
  return Math.sqrt(m);
}
/** Amplitude (cm) of the k-th gait harmonic in `y`, sampled against `phase`. */
function harm(ysrc, phase) {
  // Subtract the mean FIRST. The first pass at this did not, and a head bone
  // sitting at y = 1.6 leaked its DC term into every bin: it reported a 21 cm
  // stride-frequency component on a head whose total vertical excursion was
  // 3.8 cm. The phase samples are near-uniform but not exactly, and that is
  // all the leakage a 1.6 m offset needs.
  const mean = ysrc.reduce((a, b) => a + b, 0) / ysrc.length;
  const y = ysrc.map((v) => v - mean);
  const out = {};
  for (const k of [1, 2]) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < y.length; i++) {
      const a = k * 2 * Math.PI * phase[i];
      re += y[i] * Math.cos(a);
      im += y[i] * Math.sin(a);
    }
    out[`x${k}`] = +((2 * Math.hypot(re, im) / y.length) * 100).toFixed(2);
  }
  return out;
}

function ptp(pts, axis) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) { lo = Math.min(lo, p[axis]); hi = Math.max(hi, p[axis]); }
  return hi - lo;
}

/** Drive the actor at a fixed speed on a fixed heading and record the rig. */
function sample(speed, cycles = 3) {
  const yaw = 0.6;
  actor.desiredYaw = yaw;
  actor.yaw = yaw;
  const v = new THREE.Vector3(-Math.sin(yaw) * speed, 0, -Math.cos(yaw) * speed);
  const dt = 1 / 90; // finer than a frame so the phase samples are dense
  // Settle: smoothSpeed is a first-order filter at 5.5/s, and the hip-drop and
  // the weapon spring both need to reach steady state before anything is read.
  for (let i = 0; i < 400; i++) {
    actor.setLocomotion(v);
    eng.step(dt);
  }
  const rec = {
    handR: [], handL: [], head: [], chest: [],
    wHandR: [], wHandL: [], wHead: [], phase: [], extR: [], extL: [],
  };
  // Scale matters: twoBoneIK is handed `armLen * ch.root.scale.x`, so an
  // unscaled reach reports a straight arm as 1.014 of full extension and looks
  // like a solver bug. The clamp itself sits 4 mm short of straight.
  const reach = (actor.anim.armLen.upper + actor.anim.armLen.lower) * (actor.root.scale.x || 1);
  // Record exactly `cycles` gait cycles by watching the phase wrap.
  let wraps = 0;
  let last = actor.anim.loco.phase;
  let guard = 0;
  while (wraps < cycles && guard++ < 20000) {
    actor.setLocomotion(v);
    eng.step(dt);
    _inv.copy(actor.root.matrixWorld).invert();
    rec.handR.push(local('handR'));
    rec.handL.push(local('handL'));
    rec.head.push(local('head'));
    rec.chest.push(local('chest'));
    rec.wHandR.push(world('handR'));
    rec.wHandL.push(world('handL'));
    rec.wHead.push(world('head'));
    // How close is each arm to running out of reach? A support hand that is
    // already at 100% extension in the carry pose cannot absorb a bigger swing
    // — it comes off the handguard instead, which reads as a bug.
    rec.extR.push(world('armR').distanceTo(world('handR')) / reach);
    rec.extL.push(world('armL').distanceTo(world('handL')) / reach);
    const p = actor.anim.loco.phase;
    rec.phase.push(p);
    if (p < last) wraps++;
    last = p;
  }
  const n = rec.handR.length;
  const per = (arr) => ({
    spanCm: +(span(arr) * 100).toFixed(1),
    pathPerCycleCm: +((pathLen(arr) / cycles) * 100).toFixed(1),
    ptpCm: [ptp(arr, 'x'), ptp(arr, 'y'), ptp(arr, 'z')].map((q) => +(q * 100).toFixed(1)),
  });
  const rng = (a) => [+Math.min(...a).toFixed(3), +Math.max(...a).toFixed(3)];
  const ys = (arr) => arr.map((p) => p.y);
  return {
    speedMs: +actor.anim.loco.smoothSpeed.toFixed(2),
    gait: actor.anim.loco.label,
    gaitAxis: +actor.anim.loco.smoothG.toFixed(2),
    frames: n,
    cycleSeconds: +actor.anim.loco.cycle.toFixed(3),
    handR: per(rec.handR),
    handL: per(rec.handL),
    chest: per(rec.chest),
    head: per(rec.head),
    armExtensionFrac: { R: rng(rec.extR), L: rng(rec.extL) },
    // Where the vertical energy lives. The pelvis bob is |cos(phase)|, which
    // is a STEP-frequency (2x) signal; an arm swing is STRIDE frequency (1x).
    // If the hand's vertical is all 2x it is carrying the body and nothing
    // else, whatever the correlation happens to come out at.
    handRvertHarmonicsCm: harm(rec.handR.map((p) => p.y), rec.phase),
    headVertHarmonicsCm: harm(rec.head.map((p) => p.y), rec.phase),
    corrHandHeadY: {
      localR: +pearson(ys(rec.handR), ys(rec.head)).toFixed(3),
      localL: +pearson(ys(rec.handL), ys(rec.head)).toFixed(3),
      worldR: +pearson(ys(rec.wHandR), ys(rec.wHead)).toFixed(3),
      worldL: +pearson(ys(rec.wHandL), ys(rec.wHead)).toFixed(3),
    },
  };
}

const out = {
  walk: sample(1.45),
  run: sample(3.4),
  sprint: sample(6.2),
};

// --- where the support wrist actually rests --------------------------------
// `HOME` in actions.js is the first and last waypoint of every left-wrist path,
// and it is measured, not guessed. If the weapon's support grip moves, HOME has
// to move with it or the hand jumps off the handguard the instant a reload
// starts. Re-measure it after the rifle change.
{
  actor.setLocomotion(null);
  actor.setAimTarget(null);
  for (let i = 0; i < 240; i++) eng.step(1 / 60);
  _inv.copy(actor.root.matrixWorld).invert();
  const p = local('handL');
  out.supportWristHome = [p.x, p.y, p.z].map((q) => +q.toFixed(3));
}

// --- the takedown clip -----------------------------------------------------
// It is authored (actions.js) and nothing in the game plays it. Check the
// RECEIVING end works: does playAction drive it, for how long, and does the
// support hand actually leave the weapon while it runs?
{
  actor.setLocomotion(null);
  for (let i = 0; i < 60; i++) eng.step(1 / 60);
  const ok = actor.playAction('takedown');
  const dt = 1 / 60;
  let frames = 0;
  let maxHandW = 0;
  let maxStep = 0;
  let maxTwist = 0;
  const homeL = actor.anim.b.handL.getWorldPosition(new THREE.Vector3());
  let maxHandTravel = 0;
  const names = new Set();
  while (actor.anim.actions.busy && frames++ < 400) {
    eng.step(dt);
    names.add(actor.anim.actions.action);
    maxHandW = Math.max(maxHandW, actor.anim.actions.hand.L.w);
    maxStep = Math.max(maxStep, actor.anim.actions.stepZ);
    maxTwist = Math.max(maxTwist, Math.abs(actor.anim.actions.bone.spine2Y));
    maxHandTravel = Math.max(
      maxHandTravel,
      actor.anim.b.handL.getWorldPosition(new THREE.Vector3()).distanceTo(homeL),
    );
  }
  out.takedown = {
    playAccepted: ok,
    ranNames: [...names],
    frames,
    measuredSeconds: +(frames * dt).toFixed(3),
    authoredDur: 1.6,
    peakSupportHandOverride: +maxHandW.toFixed(3),
    peakLungeMetres: +maxStep.toFixed(3),
    peakSpineTwistRad: +maxTwist.toFixed(3),
    supportHandTravelMetres: +maxHandTravel.toFixed(3),
  };
  // Stealth.js freezes the player for 0.75 / 0.90 / 1.05 s. Prove the clip
  // survives being asked to fit that, because that is the call being asked for.
  for (const d of [0.75, 0.9, 1.05]) {
    for (let i = 0; i < 40; i++) eng.step(1 / 60);
    actor.anim.actions.cancel();
    const started = actor.playAction('takedown', { duration: d });
    let f = 0;
    let travel = 0;
    let peakW = 0;
    const h0 = actor.anim.b.handL.getWorldPosition(new THREE.Vector3());
    while (actor.anim.actions.busy && f++ < 400) {
      eng.step(1 / 60);
      peakW = Math.max(peakW, actor.anim.actions.hand.L.w);
      travel = Math.max(travel, actor.anim.b.handL.getWorldPosition(new THREE.Vector3()).distanceTo(h0));
    }
    out[`takedown_${d}s`] = {
      started,
      measuredSeconds: +(f / 60).toFixed(3),
      peakSupportHandOverride: +peakW.toFixed(3),
      supportHandTravelMetres: +travel.toFixed(3),
    };
  }
  out.takedownVsStealth = {
    stealthActionTimerChoke: 0.75,
    stealthActionTimerThrow: 1.05,
    stealthActionTimerGrabChoke: 0.9,
    note: 'Stealth.js freezes the player for these; the clip is 1.60 s.',
  };
}

return out;
