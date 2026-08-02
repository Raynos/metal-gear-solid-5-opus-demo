/**
 * r11_cascade_lag.js — the temporal half of the shadow defect, in metres.
 *
 * `refreshInterval` is [1,3,6,12]: cascades 1..3 are only refitted and only
 * re-rasterised every 3rd, 6th and 12th frame. A stale cascade is NOT wrong in
 * world space — its map and its shadow matrix go stale together, so the shadow
 * stays nailed to the ground. What DOES go stale is its COVERAGE: the box was
 * fitted to where the view frustum was N frames ago, and the fragment weights
 * in CSM_DIR_BLOCK are computed from the stale coordinate. A fragment that
 * walks out of cascade c's box mid-interval is handed to cascade c+1, whose
 * texel is 3-4x coarser and whose penumbra scale is different, and it is handed
 * BACK on the next refresh. That is a per-fragment quality flip at 20 Hz and 10
 * Hz under a walking camera, and no still frame can show it.
 *
 * So measure it. Drive the camera exactly the way tools/render.mjs's film mode
 * does, and each frame compute what _fitCascades WOULD produce for the current
 * pose, against what each cascade is actually still holding. Report the lag in
 * metres, as a fraction of the cascade radius, and — the number that matters —
 * how far the current frustum slice pokes outside the stale box, in units of
 * the 0.40..0.487 crossfade band the shader fades over.
 */
const g = window.__GAME;
const THREE = g.THREE;
const eng = g.engine;
const lighting = g.world.lighting;

const name = (ARGS && ARGS[0]) || 'gameplay';
// Metres per second the camera is trucked at. The film mode's own truck peaks
// at 1.12 m/s, which is a stroll; a player sprints at 5-6. Sweep it, because
// "the lag is sub-texel" is only interesting if it survives a sprint.
// Speed comes in as ARGS[1]; sweep it from the shell rather than inside one page.
g.applyShot(name);
if (window.__pinDeterminism) window.__pinDeterminism();
eng.deterministic = true;
eng.stop();
for (let i = 0; i < 8; i++) { eng.step(1 / 60); eng.render(); }

const cam = eng.camera;
const p0 = cam.position.clone();
const q0 = cam.quaternion.clone();

/** The centre and radius _fitCascades would solve for cascade c, right now. */
function idealFit(c) {
  const splits = lighting._splits;
  cam.updateMatrixWorld();
  const e = cam.matrixWorld.elements;
  const right = new THREE.Vector3(e[0], e[1], e[2]).normalize();
  const up = new THREE.Vector3(e[4], e[5], e[6]).normalize();
  const fwd = new THREE.Vector3(-e[8], -e[9], -e[10]).normalize();
  const tanV = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
  const tanH = tanV * cam.aspect;
  const corners = [];
  for (const d of [splits[c], splits[c + 1]]) {
    for (const sy of [-1, 1]) for (const sx of [-1, 1]) {
      corners.push(
        cam.position.clone()
          .addScaledVector(fwd, d)
          .addScaledVector(up, d * tanV * sy)
          .addScaledVector(right, d * tanH * sx),
      );
    }
  }
  const centre = new THREE.Vector3();
  for (const q of corners) centre.add(q);
  centre.multiplyScalar(1 / 8);
  let radius = 0;
  for (const q of corners) radius = Math.max(radius, centre.distanceTo(q));
  return { centre, radius, corners };
}

const N = lighting.cascadeCount;
const stats = Array.from({ length: N }, () => ({ lagMax: 0, lagSum: 0, outMax: 0, outSum: 0, flips: 0, n: 0 }));
// The shader's crossfade: full weight below 0.40 of the half-extent, zero above
// 0.487. A fragment crossing that band changes which cascade shades it.
const FADE_LO = 0.40, FADE_HI = 0.487;
let prevIn = null;
const trace = [];

const fwd0 = new THREE.Vector3(0, 0, -1).applyQuaternion(q0).setY(0).normalize();
const speed = +((ARGS && ARGS[1]) || 1.1);
let t = 0;
for (let f = 0; f < 90; f++) {
  t += 1 / 60;
  const yaw = Math.sin(t * 0.22) * 0.16;
  cam.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw).multiply(q0);
  cam.position.copy(p0).addScaledVector(fwd0, speed * t);
  eng.step(1 / 60);
  eng.render();

  const inCascade = [];
  for (let c = 0; c < N; c++) {
    const L = lighting.cascades[c];
    const held = L.target.position.clone();      // the box centre actually in use
    const heldR = (L.shadow.camera.right - L.shadow.camera.left) / 2;
    const want = idealFit(c);
    const lag = held.distanceTo(want.centre);

    // How far outside the HELD box do this frame's slice corners reach, as a
    // fraction of the held half-extent, measured in the light's own basis.
    // The shader's OWN coordinate: shadow.matrix maps world into the [0,1] box
    // that CSM_DIR_BLOCK takes abs(xy - 0.5) of. Using the light's matrixWorld
    // instead is wrong — a DirectionalLight carries no rotation, only the
    // shadow camera does — and the first run of this probe reported a slice
    // reaching 13x its own box because of exactly that.
    const sm = L.shadow.matrix;
    let worst = 0;
    for (const q of want.corners) {
      const lp = q.clone().applyMatrix4(sm);
      worst = Math.max(worst, Math.abs(lp.x - 0.5), Math.abs(lp.y - 0.5));
    }
    const s = stats[c];
    s.lagMax = Math.max(s.lagMax, lag); s.lagSum += lag;
    s.outMax = Math.max(s.outMax, worst); s.outSum += worst;
    s.n++;
    // The centre of the slice: is it inside this cascade's full-weight core?
    const cm = want.centre.clone().applyMatrix4(sm);
    inCascade.push(Math.max(Math.abs(cm.x - 0.5), Math.abs(cm.y - 0.5)) < FADE_HI);
    if (f < 24) trace.push({ f, c, lag: +lag.toFixed(3), out: +worst.toFixed(3) });
  }
  if (prevIn) for (let c = 0; c < N; c++) if (prevIn[c] !== inCascade[c]) stats[c].flips++;
  prevIn = inCascade;
}

return {
  shot: name,
  cameraSpeedMS: speed,
  refreshInterval: lighting.refreshInterval.slice(0, N),
  splits: Array.from(lighting._splits).map((v) => +v.toFixed(1)),
  fadeBand: [FADE_LO, FADE_HI],
  perCascade: stats.map((s, c) => ({
    c,
    everyNFrames: lighting.refreshInterval[c],
    radiusM: +((lighting.cascades[c].shadow.camera.right - lighting.cascades[c].shadow.camera.left) / 2).toFixed(1),
    texelCm: +(((lighting.cascades[c].shadow.camera.right - lighting.cascades[c].shadow.camera.left) / lighting.cascades[c].shadow.mapSize.x) * 100).toFixed(1),
    lagMeanM: +(s.lagSum / s.n).toFixed(3),
    lagMaxM: +s.lagMax.toFixed(3),
    /** 1.0 = the slice exactly fills the box. >0.487 means it is in the fade. */
    sliceReachMean: +(s.outSum / s.n).toFixed(3),
    sliceReachMax: +s.outMax.toFixed(3),
    coreFlips: s.flips,
  })),
  trace: trace.slice(0, 36),
};
