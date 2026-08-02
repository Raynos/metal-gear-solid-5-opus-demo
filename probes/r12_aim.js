/**
 * r12_aim.js — what is actually wrong with aiming and shooting.
 *
 * The brief was one sentence ("the aiming and shooting experience is dog
 * shit") so this measures everything a player touches, in the order he touches
 * it, and reports numbers rather than opinions:
 *
 *   1  ADS transition — is there one, and how long does it take
 *   2  parallax — where the round goes against where the reticle/centre is
 *   3  reticle motion — does the sight sit still enough to aim with
 *   4  sway — is it the same in every heading (it is applied in WORLD space)
 *   5  look sensitivity across the ADS blend
 *   6  recoil — peak, settle, pattern
 *   7  rate of fire, SEMI vs AUTO
 *   8  trigger latency
 *   9  hip fire
 *  10  hit feedback
 *  11  muzzle point against the rendered barrel tip
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const reg = W.registry;
const gp = reg.gameplay ?? reg.player;
const eng = W.engine;
const out = [];
const held = new Set();
const key = (code, down) => {
  if (down) held.add(code); else held.delete(code);
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));
};
const clear = () => { for (const c of [...held]) key(c, false); };
const run = (n) => { for (let i = 0; i < n; i++) eng.step(1 / 60); };
const say = (s) => out.push(s);
const sec = (t) => { say(''); say(`--- ${t} ${'-'.repeat(Math.max(0, 66 - t.length))}`); };
const step = (label, fn) => {
  try { fn(); } catch (err) { say(`${label}: THREW ${err && err.message}`); }
};
const D = (r) => (r * 180 / Math.PI);

W.gameState.setMode('play');
run(3);
const st = gp.stealth;
const pc = gp.camera;
const cam3 = eng.camera;
const ctl = gp.controller;
const VW = window.innerWidth;
const VH = window.innerHeight;

// Projection needs a camera matrix; nothing renders inside a probe, and
// three.js only refreshes matrixWorldInverse in renderer.render().
const syncCam = () => {
  cam3.updateMatrixWorld(true);
  cam3.matrixWorldInverse.copy(cam3.matrixWorld).invert();
  cam3.updateProjectionMatrix();
};
const px = (p) => {
  const v = p.clone().project(cam3);
  return { x: (v.x * 0.5 + 0.5) * VW, y: (-v.y * 0.5 + 0.5) * VH, z: v.z };
};

// Put him on open, level ground looking at the compound so every range below
// exists in the world rather than in a formula.
const site = reg.outpost.bounds.getCenter(new THREE.Vector3());
const gnd = reg.characters.ground;
step('setup', () => {
  const yaw = Math.atan2(site.x - ctl.position.x, site.z - ctl.position.z) + Math.PI;
  ctl.position.set(site.x + Math.sin(yaw) * 34, 0, site.z + Math.cos(yaw) * 34);
  ctl.position.y = gnd.heightAt(ctl.position.x, ctl.position.z);
  ctl.footY = ctl.position.y;
  ctl.yaw = yaw;
  pc.reset(ctl.position, yaw);
  run(20);
});
say(`viewport ${VW}x${VH}, player at (${ctl.position.x.toFixed(1)}, ${ctl.position.z.toFixed(1)}) `
  + `looking at the compound ${Math.hypot(site.x - ctl.position.x, site.z - ctl.position.z).toFixed(0)} m away`);

// ---------------------------------------------------------- 1 ADS transition --
sec('1  ADS transition');
step('1', () => {
  run(30);
  const hipFov = cam3.fov;
  const hipBoom = pc.camera.position.distanceTo(new THREE.Vector3(ctl.position.x, ctl.position.y + 1.62, ctl.position.z));
  key('KeyE', true);
  const rows = [];
  let t90 = -1;
  let f90 = -1;
  for (let i = 1; i <= 45; i++) {
    eng.step(1 / 60);
    const t = i / 60;
    if (t90 < 0 && pc.aimBlend >= 0.9) t90 = t;
    if (f90 < 0 && cam3.fov <= 45 - 0.9 * (45 - 33)) f90 = t;
    if (i % 5 === 0) {
      rows.push(`      t=${t.toFixed(3)}s  aimAmount=${st.aimAmount.toFixed(3)} aimBlend=${pc.aimBlend.toFixed(3)} `
        + `fov=${cam3.fov.toFixed(2)} anim.aim=${gp.player.anim.aim.toFixed(3)}`);
    }
  }
  const aimBoom = pc.camera.position.distanceTo(new THREE.Vector3(ctl.position.x, ctl.position.y + 1.665, ctl.position.z));
  say(`1  hip: fov ${hipFov.toFixed(2)}, camera ${hipBoom.toFixed(2)} m from the eye`);
  say(`1  ads: fov ${cam3.fov.toFixed(2)}, camera ${aimBoom.toFixed(2)} m from the eye`);
  say(`1  time to 90% of the aim blend ${t90.toFixed(3)} s; to 90% of the FOV change ${f90.toFixed(3)} s`);
  rows.forEach(say);
});

// -------------------------------------------------------------- 2 parallax --
sec('2  where the round goes vs where the reticle and the screen centre are');
step('2', () => {
  syncCam();
  const org = new THREE.Vector3();
  const dir = new THREE.Vector3();
  st.aimRay(org, dir);
  const camPos = cam3.position.clone();
  say(`2  ray origin (${org.x.toFixed(2)}, ${org.y.toFixed(2)}, ${org.z.toFixed(2)}) is `
    + `${camPos.distanceTo(org).toFixed(3)} m from the camera`);
  // Decompose that offset in camera space: how far right / up / forward the
  // ray starts relative to the lens.
  const fwd = pc.forward(new THREE.Vector3());
  const right = new THREE.Vector3(Math.cos(pc.yaw), 0, -Math.sin(pc.yaw));
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
  const off = org.clone().sub(camPos);
  say(`2  offset in camera space: right ${off.dot(right).toFixed(3)} m, up ${off.dot(up).toFixed(3)} m, `
    + `forward ${off.dot(fwd).toFixed(3)} m  (this is the RIG and is not a defect)`);
  say(`2  aim ray vs optical axis: dot ${dir.dot(fwd).toFixed(6)} `
    + `(1.000000 means parallel, i.e. they never meet); convergence range `
    + `${st.convergeRange === undefined ? 'n/a — no convergence in this build' : st.convergeRange.toFixed(1) + ' m'}`);
  // What the player sees: the projected BALLISTIC impact, at a spread of real
  // ranges made by pitching the view, which is how a range sweep happens in
  // play. This is literally the reticle's own screen position.
  const rows = [];
  const p0 = pc.pitch;
  for (const p of [-0.30, -0.20, -0.12, -0.07, -0.04, -0.02]) {
    pc.pitch = p;
    run(14);
    syncCam();
    if (!st.aimHit) { rows.push(`      pitch ${p}: no hit`); continue; }
    // What the RETICLE draws — `sightPoint` where the build has one, the traced
    // impact where it does not. See Stealth._predict.
    const drawn = st.sightPoint ?? st.aimHit.point;
    const s = px(drawn);
    // The same thing in metres: how far the impact sits off the optical axis.
    const c = cam3.position.clone();
    const f2 = new THREE.Vector3(0, 0, -1).applyQuaternion(cam3.quaternion).normalize();
    const r2 = new THREE.Vector3(1, 0, 0).applyQuaternion(cam3.quaternion).normalize();
    const u2 = new THREE.Vector3().crossVectors(r2, f2).normalize();
    const rel = drawn.clone().sub(c);
    rows.push(`      hit at ${st.aimHit.dist.toFixed(1).padStart(5)} m: reticle `
      + `(${(s.x - VW / 2).toFixed(0)}, ${(s.y - VH / 2).toFixed(0)}) px from centre `
      + `= ${Math.abs(rel.dot(r2)).toFixed(2)} m lateral, ${(-rel.dot(u2)).toFixed(2)} m of drop, `
      + `off the optical axis`);
  }
  say('2  the reticle IS the projected impact point. Where it lands, by range:');
  say('2  (lateral is the parallax error — it should be ~0. Drop is the dart falling and is the mechanic.)');
  rows.forEach(say);
  pc.pitch = p0;
  run(10);
});

// ------------------------------------------------------- 3 reticle motion --
sec('3  does the sight sit still');
step('3', () => {
  // Sweep across the compound so the range under the sight changes the way it
  // does when a player looks around, and watch the DOM element the player sees.
  const ret = gp.reticle;
  let prev = null;
  let maxJump = 0;
  let travel = 0;
  const ranges = [];
  const jumps = [];
  for (let i = 0; i < 150; i++) {
    pc.addLook(-0.0035, 0);
    eng.step(1 / 60);
    syncCam();
    const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(ret.el.style.transform || '');
    if (!m) continue;
    const p = { x: +m[1], y: +m[2] };
    if (prev) {
      const j = Math.hypot(p.x - prev.x, p.y - prev.y);
      travel += j;
      if (j > maxJump) maxJump = j;
      jumps.push(j);
    }
    prev = p;
    if (st.aimHit) ranges.push(st.aimHit.dist);
  }
  jumps.sort((a, b) => a - b);
  const p50 = jumps[Math.floor(jumps.length * 0.5)] ?? 0;
  const p95 = jumps[Math.floor(jumps.length * 0.95)] ?? 0;
  say(`3  panning 0.0035 rad/frame for 150 frames (a slow, deliberate sweep):`);
  say(`3    reticle moved ${travel.toFixed(0)} px total; per-frame step p50 ${p50.toFixed(1)} px, `
    + `p95 ${p95.toFixed(1)} px, worst ${maxJump.toFixed(1)} px`);
  say(`3    aim range over the sweep: ${ranges.length ? `${Math.min(...ranges).toFixed(1)}–${Math.max(...ranges).toFixed(1)} m` : 'no hit'}`);
  say(`3    for scale: 150 frames x 0.0035 rad is 0.525 rad of pan, which at the aimed lens is `
    + `about 1030 px of TRUE world motion across the frame. A sight that is honest about where the `
    + `round goes should barely move at all.`);
});

// -------------------------------------------------------------- 4 aim sway --
sec('4  aim sway — the same in every heading?');
step('4', () => {
  // ISOLATE THE SWAY. Measure the LOOK direction (optical axis + sway) against
  // the unswayed optical axis. Using aimRay here would fold in the convergence
  // correction, which is a real and intended 30 mrad and would swamp the term
  // being measured. The old build has no _lookDir, so fall back to aimRay with
  // the convergence disabled by parking the ray origin under the lens.
  const look = st._lookDir
    ? (d) => st._lookDir(d)
    : (d) => { const o = new THREE.Vector3(); st.aimRay(o, d); return d; };
  const measure = (yaw) => {
    pc.yaw = yaw;
    const f = pc.forward(new THREE.Vector3());
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const up = new THREE.Vector3().crossVectors(right, f).normalize();
    const d = new THREE.Vector3();
    let sr = 0;
    let su = 0;
    const N = 900;
    for (let i = 0; i < N; i++) {
      st._swayT += 1 / 60;
      look(d);
      const dev = d.clone().sub(f);
      sr += dev.dot(right) ** 2;
      su += dev.dot(up) ** 2;
    }
    return { r: Math.sqrt(sr / N) * 1000, u: Math.sqrt(su / N) * 1000 };
  };
  const yaw0 = pc.yaw;
  const rows = [];
  for (const y of [0, Math.PI / 4, Math.PI / 2, Math.PI * 0.75]) {
    const m = measure(y);
    rows.push(`      yaw ${(D(y)).toFixed(0).padStart(3)}deg: lateral ${m.r.toFixed(2)} mrad rms, vertical ${m.u.toFixed(2)} mrad rms`);
  }
  say('4  sway as the angle between the swayed look direction and the bare optical axis,');
  say('4  standing, full breath, motionless, no bloom:');
  rows.forEach(say);
  say('4  (lateral must not vary with heading. At 15 m, 1 mrad is 15 mm.)');
  // And the things that are supposed to change it.
  const base = st.swayAngle;
  const modes = [];
  const sample = (label, setup, teardown) => {
    setup();
    look(new THREE.Vector3());
    modes.push(`${label} ${(st.swayAngle / base).toFixed(2)}x`);
    teardown();
  };
  sample('crouch', () => { ctl.stance = 'crouch'; }, () => { ctl.stance = 'stand'; });
  sample('prone', () => { ctl.stance = 'prone'; }, () => { ctl.stance = 'stand'; });
  sample('breath held', () => { st.holdingBreath = true; }, () => { st.holdingBreath = false; });
  sample('running 5.4 m/s', () => { ctl.speed = 5.4; }, () => { ctl.speed = 0; });
  sample('3 rounds just fired', () => { st.bloom = 2.55; }, () => { st.bloom = 0; });
  say(`4  sway multipliers: ${modes.join(', ')}  (1.00x = standing, rested, still)`);
  pc.yaw = yaw0;
});

// ------------------------------------------------------------ 5 sensitivity --
sec('5  look sensitivity across the aim blend');
step('5', () => {
  const s = gp.input.mouseSensitivity;
  const degPer100 = D(s * 100);
  const across = (fov) => {
    // Screen fraction covered by 100 px of mouse travel at this FOV.
    const halfW = Math.tan(THREE.MathUtils.degToRad(fov) / 2) * (VW / VH);
    return (Math.tan(s * 100) / halfW) * (VW / 2);
  };
  say(`5  mouseSensitivity ${s} rad/px = ${degPer100.toFixed(2)} deg per 100 px of raw travel`);
  say(`5  unscaled, 100 px of mouse moves the world ${across(45).toFixed(0)} px across the screen at hip `
    + `(fov 45) and ${across(33).toFixed(0)} px at ADS (fov 33) — ADS ${(across(33) / across(45)).toFixed(2)}x faster.`);
  const ls = pc.lookScale ? pc.lookScale : null;
  if (!ls) { say('5  camera.lookScale() does not exist in this build — nothing corrects it.'); return; }
  key('KeyE', false); run(45);
  const hipScale = pc.lookScale();
  key('KeyE', true); run(45);
  const adsScale = pc.lookScale();
  say(`5  lookScale(): hip ${hipScale.toFixed(4)}, ADS ${adsScale.toFixed(4)}`);
  say(`5  corrected on-screen speed: hip ${(across(45) * hipScale).toFixed(0)} px, `
    + `ADS ${(across(33) * adsScale).toFixed(0)} px — ratio `
    + `${((across(33) * adsScale) / (across(45) * hipScale)).toFixed(3)}x (1.000 is the target)`);
  // And that the wiring actually applies it, not just that the method exists.
  const y0 = pc.yaw;
  gp.input._lookX = 0.01;
  gp.input.look.x = 0;
  eng.step(1 / 60);
  say(`5  driving a raw 0.01 rad look delta through the real per-frame path while aimed moved yaw by `
    + `${(pc.yaw - y0).toFixed(5)} rad — expected ${(0.01 * adsScale).toFixed(5)} if the scale is wired in, `
    + `0.01000 if it is not`);
});

// ---------------------------------------------------------------- 6 recoil --
sec('6  recoil');
step('6', () => {
  st.rearm();
  pc._kick = 0;
  pc._kickVel = 0;
  run(10);
  const before = pc.forward(new THREE.Vector3()).clone();
  st._fireCooldown = 0;
  st.fire();
  const k = [];
  let peak = 0;
  let tPeak = 0;
  let min = 0;
  let settle = -1;
  let ky = 0;
  for (let i = 1; i <= 60; i++) {
    eng.step(1 / 60);
    const v = pc._kick;
    ky = Math.max(ky, Math.abs(pc._kickYaw ?? 0));
    k.push(v);
    if (Math.abs(v) > Math.abs(peak)) { peak = v; tPeak = i / 60; }
    if (v < min) min = v;
    if (settle < 0 && i / 60 > tPeak && Math.abs(v) < Math.abs(peak) * 0.1) settle = i / 60;
  }
  say(`6  one shot: peak kick ${D(peak).toFixed(2)} deg at t=${tPeak.toFixed(3)} s, `
    + `undershoot ${D(min).toFixed(2)} deg, back inside 10% at t=${settle < 0 ? '>1.0' : settle.toFixed(3)} s`);
  say(`6  lateral kick this shot: ${D(pc._kickYaw ?? 0).toFixed(3)} deg residual, `
    + `peak |yaw| over the settle ${D(ky).toFixed(2)} deg`);
  say(`6  trace (deg, every 3rd frame): ${k.filter((_, i) => i % 3 === 0).slice(0, 14).map((v) => D(v).toFixed(2)).join(' ')}`);
  // Automatic fire: does the kick accumulate at all?
  st.rearm();
  pc._kick = 0;
  pc._kickVel = 0;
  pc._kickYaw = 0;
  pc._kickYawVel = 0;
  st.fireMode = 'AUTO';
  let amax = 0;
  let ymax = 0;
  let fired = 0;
  for (let i = 0; i < 180; i++) {
    if (st._fireCooldown <= 0 && st.ammo > 0) { st.fire(); fired++; }
    eng.step(1 / 60);
    amax = Math.max(amax, Math.abs(pc._kick));
    ymax = Math.max(ymax, Math.abs(pc._kickYaw ?? 0));
  }
  say(`6  AUTO, 3 s of continuous fire (${fired} rounds): peak accumulated kick ${D(amax).toFixed(2)} deg `
    + `pitch / ${D(ymax).toFixed(2)} deg yaw (a single shot is ${D(Math.abs(peak)).toFixed(2)} deg) `
    + `— ratio ${(amax / Math.abs(peak)).toFixed(2)}x`);
  st.fireMode = 'SEMI';
});

// ------------------------------------------------------- 7 rate of fire ----
sec('7  rate of fire');
step('7', () => {
  st.rearm();
  st.fireMode = 'SEMI';
  key('KeyE', true);
  run(20);
  let a0 = st.ammo;
  key('Space', true);
  run(120);
  const semi = a0 - st.ammo;
  key('Space', false);
  run(5);
  st.rearm();
  st.fireMode = 'AUTO';
  a0 = st.ammo;
  key('Space', true);
  run(120);
  const auto = a0 - st.ammo;
  key('Space', false);
  say(`7  holding the trigger for 2.0 s: SEMI fired ${semi} round(s), AUTO fired ${auto}`);
  say(`7  AUTO cadence = ${(auto / 2).toFixed(1)} rounds/s = ${(auto / 2 * 60).toFixed(0)} RPM. `
    + `An MGSV assault rifle is 550-750 RPM; below ~200 RPM "automatic" is indistinguishable from SEMI.`);
  st.fireMode = 'SEMI';
  st.rearm();
});

// ------------------------------------------------------------- 8 latency ----
sec('8  trigger latency and input swallowing');
step('8', () => {
  st.rearm();
  run(4);
  const a0 = st.ammo;
  key('Space', true);
  let frames = 0;
  for (let i = 1; i <= 12; i++) { eng.step(1 / 60); if (st.ammo < a0) { frames = i; break; } }
  key('Space', false);
  say(`8  keydown -> ammo decrement: ${frames || '>12'} frame(s)`);
  // Fire while a CQC/takedown freeze is running.
  st.rearm();
  st.action = 'takedown';
  st.actionTimer = 0.5;
  const b0 = st.ammo;
  key('Space', true);
  run(20);
  key('Space', false);
  say(`8  during a 0.5 s action freeze: ${b0 - st.ammo} round(s) left the magazine (cmd.frozen returns early, `
    + `so aim, fire, reload and fire-mode are ALL dead for the duration)`);
  st.action = 'none';
  st.actionTimer = 0;
  run(5);
  // Reload lock-out.
  st.rearm();
  st.ammo = 4;
  st.reload();
  run(6);
  say(`8  mid-reload: isAiming=${st.isAiming} aimAmount=${st.aimAmount.toFixed(2)} — the weapon comes down and `
    + `the trigger is dead for the whole ${st.reloadTime.toFixed(2)} s`);
  run(Math.round(st.reloadTime * 60) + 6);
  st.rearm();
});

// Sections 6 and 7 put ~200 rounds into a live garrison, which alerts it and
// gets the player shot. `vitals.dead` makes the order-15 system early-return,
// so everything after it silently measured a corpse: the first run of this
// probe reported aimAmount 0.000 and an aimTarget 94 degrees off the shot,
// which was not a defect at all — it was the free-look branch of `_writeAnim`
// on a dead man. Heal him and say so, rather than reading the numbers.
sec('9  hip fire');
step('9', () => {
  clear();
  gp.vitals.reset();
  say(`9  (player healed first; he was dead=${gp.dead} after the rate-of-fire section)`);
  run(6);
  st.rearm();
  const a0 = st.ammo;
  key('Space', true);
  run(30);
  key('Space', false);
  say(`9  trigger held 0.5 s with NO aim button: ${a0 - st.ammo} round(s) fired. `
    + `Stealth.update gates fire on isAiming, so there is no hip fire at all.`);
});

// -------------------------------------------------------- 10 hit feedback ---
sec('10  hit feedback');
step('10', () => {
  const seen = [];
  const cues = [];
  const off = gp.events.on((e) => seen.push(e.type));
  const offCue = gp.onEvent((n) => cues.push(n));
  gp.vitals.reset();
  const ai = reg.ai;
  const victim = ai.guards.find((q) => !q.down);
  const v = victim.ch;
  // HE HAS TO STAND STILL. The first version of this test aimed at a chest
  // position sampled 0.9 s before it fired, and a patrolling sentry had walked
  // out of it — which made the fixed ray "miss" and the broken one "hit", i.e.
  // it reported the exact opposite of the truth.
  v.controlled = true;
  v.anim.speed = 0;
  // Stand 14 m behind him and point the weapon at his chest.
  const yaw = Math.atan2(v.position.x - ctl.position.x, v.position.z - ctl.position.z);
  ctl.position.set(v.position.x - Math.sin(yaw) * 14, 0, v.position.z - Math.cos(yaw) * 14);
  ctl.position.y = gnd.heightAt(ctl.position.x, ctl.position.z);
  ctl.footY = ctl.position.y;
  ctl.yaw = yaw + Math.PI;
  pc.reset(ctl.position, yaw + Math.PI);
  key('KeyE', true);
  run(25);
  // THE ACCEPTANCE TEST. Point the MIDDLE OF THE SCREEN at his chest — no
  // reticle, no ballistics, just the optical axis — and see what the round
  // does. Converging on the axis is exactly the claim that this must hit.
  const target = new THREE.Vector3(v.position.x, (v.groundY ?? 0) + 1.30, v.position.z);
  const aimAt = () => {
    for (let i = 0; i < 30; i++) {
      // The camera position moves as the pitch orbits the boom, so solve, step,
      // and solve again until the axis is on him.
      const w = target.clone().sub(cam3.position).normalize();
      const wantPitch = Math.asin(THREE.MathUtils.clamp(w.y, -1, 1));
      const wantYaw = Math.atan2(-w.x, -w.z);
      // forward() = pitch + pitchBase(+kick); undo the base to get the stick pose.
      pc.pitch += (wantPitch - Math.asin(THREE.MathUtils.clamp(pc.forward(new THREE.Vector3()).y, -1, 1)));
      pc.yaw += Math.atan2(Math.sin(wantYaw - pc.yaw), Math.cos(wantYaw - pc.yaw));
      eng.step(1 / 60);
    }
  };
  // A CLEAR FIRING LINE, found rather than assumed. The compound puts walls
  // between most pairs of points, and standing at one fixed bearing behind a
  // guard put one in the way on two runs out of three — which reads as "the
  // fix missed" and is really "the player is shooting a wall he can see over".
  // probes/r12_jump.js established that both marches are right in that case.
  let clear = false;
  for (const bearing of [0, 0.9, -0.9, 2.0, -2.0, Math.PI]) {
    const b = yaw + bearing;
    ctl.position.set(v.position.x - Math.sin(b) * 14, 0, v.position.z - Math.cos(b) * 14);
    ctl.position.y = gnd.heightAt(ctl.position.x, ctl.position.z);
    ctl.footY = ctl.position.y;
    ctl.yaw = b + Math.PI;
    pc.reset(ctl.position, b + Math.PI);
    run(20);
    target.set(v.position.x, (v.groundY ?? 0) + 1.30, v.position.z);
    aimAt();
    const o = new THREE.Vector3();
    const d = new THREE.Vector3();
    st.aimRay(o, d);
    if (st._trace(o, d)?.character === v) { clear = true; break; }
  }
  say(`10  clear firing line found after searching six bearings: ${clear}`);
  v.position.copy(target).setY(v.position.y);
  run(3);
  syncCam();
  const onAxis = px(target);
  say(`10  the optical axis is on ${v.name}'s chest at ${cam3.position.distanceTo(target).toFixed(1)} m: `
    + `he projects to (${(onAxis.x - VW / 2).toFixed(0)}, ${(onAxis.y - VH / 2).toFixed(0)}) px from screen centre`);
  // CONTROL: what the SHIPPED formula would have done from this identical pose
  // — eye position, camera forward, no convergence.
  const oldO = new THREE.Vector3(ctl.position.x, st.eyeY ?? (ctl.position.y + 1.42), ctl.position.z);
  const oldD = pc.forward(new THREE.Vector3());
  oldO.addScaledVector(oldD, 0.35);
  const oldHit = st._trace(oldO, oldD);
  say(`10  CONTROL — the pre-fix ray (eye origin, camera forward, no convergence) from this exact pose `
    + `hits: ${oldHit ? (oldHit.character ? oldHit.character.name : `${oldHit.surface} at ${oldHit.point.distanceTo(oldO).toFixed(1)} m`) : 'nothing'}`);
  say(`10  aiming at ${v.name} ${cam3.position.distanceTo(target).toFixed(1)} m away, aimHit=${st.aimHit ? (st.aimHit.character ? `CHARACTER ${st.aimHit.character.name}` : `${st.aimHit.dist.toFixed(1)} m ${'ground'}`) : 'null'}`
    + `, reticle data-on=${gp.reticle.el.getAttribute('data-on')}, box ${gp.reticle._sz} px`);
  seen.length = 0;
  cues.length = 0;
  st._fireCooldown = 0;
  const hit = st.fire();
  run(2);
  say(`10  fire(): hit=${hit ? (hit.character ? `${hit.character.name} headshot=${hit.headshot}` : hit.surface) : 'null'}`);
  say(`10  events: ${seen.join(', ') || 'none'}`);
  say(`10  audio cues: ${cues.join(', ') || 'none'}`);
  say(`10  reticle data-hit=${gp.reticle.el.getAttribute('data-hit')}, feedback=${JSON.stringify(gp.feedback.stats())}`);
  say(`10  target: down=${v.downed} tranquillised=${v.tranquillised} — a dart is instantly fatal-equivalent; `
    + `there is no non-lethal damage model and therefore no such thing as a hit that does not drop him.`);
  say(`10  headshot flag is computed in _trace and READ BY NOBODY (grep 'headshot' outside Stealth.js).`);
  off();
  offCue();
});

// ------------------------------------------------------------ 11 muzzle -----
sec('11  muzzle point vs the rendered barrel');
step('11', () => {
  gp.vitals.reset();
  key('KeyE', true);
  run(30);
  const a = gp.player;
  const o = new THREE.Vector3();
  const d = new THREE.Vector3();
  st.aimRay(o, d);
  const mine = st.muzzlePoint(new THREE.Vector3(), d);
  const real = new THREE.Vector3(0.585, 0.012, 0).applyMatrix4(a.anim._weaponM);
  const grip = new THREE.Vector3(-0.078, -0.075, 0).applyMatrix4(a.anim._weaponM);
  say(`11  muzzleReach() = ${st.muzzleReach() === null ? 'null' : st.muzzleReach().toFixed(3) + ' m'}`);
  say(`11  muzzlePoint() (${mine.x.toFixed(2)}, ${mine.y.toFixed(2)}, ${mine.z.toFixed(2)}) vs the weapon's own `
    + `muzzle tip (${real.x.toFixed(2)}, ${real.y.toFixed(2)}, ${real.z.toFixed(2)}) — ${mine.distanceTo(real).toFixed(3)} m apart`);
  const axis = real.clone().sub(grip).normalize();
  say(`11  the weapon's barrel points ${D(Math.acos(THREE.MathUtils.clamp(axis.dot(d), -1, 1))).toFixed(1)} deg `
    + `off the direction the dart travels`);
  // Whose fault is that? gameplay publishes anim.aimTarget and characters poses
  // the arms to it, so compare the barrel against the target it was GIVEN.
  const want = gp.player.anim.aimTarget.clone().sub(real).normalize();
  say(`11  ...and ${D(Math.acos(THREE.MathUtils.clamp(axis.dot(want), -1, 1))).toFixed(1)} deg off the `
    + `anim.aimTarget it was handed. gameplay owns aimTarget; src/characters owns whether the pose reaches it.`);
  say(`11  aimTarget is ${gp.player.anim.aimTarget.distanceTo(real).toFixed(1)} m out, and it is `
    + `${D(Math.acos(THREE.MathUtils.clamp(want.dot(d), -1, 1))).toFixed(2)} deg off the dart's line `
    + `(that part IS gameplay's and should be ~0).`);
  say(`11  raw: aimAmount=${st.aimAmount.toFixed(3)} aimTarget=(${gp.player.anim.aimTarget.toArray().map((q) => q.toFixed(2))}) `
    + `st.aimPoint=(${st.aimPoint.toArray().map((q) => q.toFixed(2))}) rayOrigin=(${o.toArray().map((q) => q.toFixed(2))}) `
    + `dir=(${d.toArray().map((q) => q.toFixed(3))})`);
  syncCam();
  const sm = px(mine);
  const sr = px(real);
  say(`11  on screen: flash at (${sm.x.toFixed(0)}, ${sm.y.toFixed(0)}) px, barrel tip at (${sr.x.toFixed(0)}, ${sr.y.toFixed(0)}) px`);
});

// ------------------------------------------------------------- 12 cost -----
sec('12  what the aim solve costs per frame');
step('12', () => {
  gp.vitals.reset();
  key('KeyE', true);
  run(20);
  const o = new THREE.Vector3();
  const d = new THREE.Vector3();
  const time = (label, fn, n) => {
    for (let i = 0; i < 200; i++) fn();          // warm
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn();
    return `${label} ${((performance.now() - t0) / n * 1000).toFixed(1)} us`;
  };
  const parts = [];
  parts.push(time('aimRay', () => st.aimRay(o, d), 4000));
  st.aimRay(o, d);
  parts.push(time('_trace', () => st._trace(o, d), 2000));
  if (st._solveConverge) parts.push(time('_solveConverge', () => st._solveConverge(1 / 60), 2000));
  say(`12  ${parts.join(', ')}  — a 60 Hz frame is 16700 us`);
});

clear();
say('');
say(`page errors: ${g.errors.length ? g.errors.slice(0, 4).join(' | ') : 'none'}`);
return out.join('\n');
