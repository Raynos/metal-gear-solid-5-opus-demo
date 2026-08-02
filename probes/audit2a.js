/**
 * audit2a.js — frame time and geometry, in a play mode that is ACTUALLY play mode.
 *
 * src/ui/state.js `guardHarness()` monkey-patches __GAME.settle / applyShot /
 * stats / probeLuminance / setTimeOfDay so that every one of them forces
 * gameState back to 'godmode'. Any probe that enters play mode and then calls
 * g.settle() is measuring godmode with the free-fly camera, and holding KeyW
 * moves that camera, so a "did the player move?" capability check passes.
 * This probe never calls a wrapped entry point after entering play.
 *
 * Scenarios are measured ROUND-ROBIN, not in sequence: this machine's GPU
 * throughput drifts several-fold within one run, so measuring scenario A three
 * times and then scenario B three times charges the drift to B.
 */

const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const eng = W.engine;
const cam = eng.camera;
const renderer = eng.renderer;
const pipe = eng.pipeline;
const gl = renderer.getContext();

const R = {};
const T0 = performance.now();
const n2 = (v) => +Number(v).toFixed(2);
const guard = (name, fn) => {
  try {
    R[name] = fn();
  } catch (e) {
    R[name] = `FAILED: ${e?.message ?? e}\n${e?.stack ?? ''}`;
  }
};
function quant(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const at = (q) => {
    const i = (s.length - 1) * q;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  return { median: at(0.5), q1: at(0.25), q3: at(0.75), min: s[0], max: s[s.length - 1] };
}
const NOOP = () => {};

const rFull = (m, i) => {
  m(i);
  eng.step(1 / 60);
  eng.render();
};
/** settle() without the harness guard that forces godmode. */
const mySettle = (n) => {
  for (let i = 0; i < n; i++) rFull(NOOP, i);
};

const WARM = 4;
const N = 16;
function block(mutate = NOOP, render = rFull) {
  for (let i = 0; i < WARM; i++) render(mutate, i);
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) render(mutate, WARM + i);
  gl.finish();
  return (performance.now() - t0) / N;
}

// --- input -----------------------------------------------------------------
const key = (code, type) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }));
const holdDown = (codes) => codes.forEach((c) => key(c, 'keydown'));
const holdUp = (codes) => codes.forEach((c) => key(c, 'keyup'));
const look = (dx, dy = 0) =>
  window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, movementX: dx, movementY: dy, clientX: 960, clientY: 540 }));
// 8 px * 0.0022 rad/px * 60 fps = 1.01 deg/frame = 60 deg/s.
const LOOK_PX = 8;

// ===========================================================================
eng.stop();
eng.deterministic = true;
const flagsBefore = { ...pipe.enabled };
window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F13', key: 'F13', bubbles: true }));
window.dispatchEvent(new KeyboardEvent('keyup', { code: 'F13', key: 'F13', bubbles: true }));
const flagsAfterArm = { ...pipe.enabled };

g.applyShot('gameplay');
mySettle(8);
const GOD = { ...pipe.enabled };
const godPose = { p: cam.position.clone(), q: cam.quaternion.clone(), fov: cam.fov };

const automation = g.setAutomation(true);
W.gameState.setMode('play');
mySettle(30);
const PLAY = { ...pipe.enabled };
const gp = W.registry?.gameplay ?? null;

const size = renderer.getSize(new THREE.Vector2());
R.config = {
  viewport: `${size.x}x${size.y}`,
  drawingBuffer: `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`,
  pixelRatio: renderer.getPixelRatio(),
  pipelineRenderScale: pipe.renderScale,
  hdrTarget: `${pipe.hdr.width}x${pipe.hdr.height}`,
  internalResIsNative: pipe.hdr.width === gl.drawingBufferWidth && pipe.hdr.height === gl.drawingBufferHeight,
  aoTarget: `${pipe.aoRT.width}x${pipe.aoRT.height}`,
  compositeTarget: `${pipe.compositeRT.width}x${pipe.compositeRT.height}`,
  shadowMapSizes: (W.lighting?.cascades ?? []).map((l) => l.shadow.mapSize.x),
  flagsAtProbeEntry: flagsBefore,
  flagsAfterSettingsArm: flagsAfterArm,
  flagsInGodmode: GOD,
  flagsInPlay: PLAY,
  automationAccepted: automation,
};

// --- did we actually get into play mode? ------------------------------------
guard('playCapability', () => {
  const before = {
    mode: W.gameState.mode,
    active: gp?.active,
    ctrl: gp?.controller?.position?.clone?.(),
    camPos: cam.position.clone(),
    camYaw: gp?.camera?.yaw,
  };
  holdDown(['KeyW']);
  for (let i = 0; i < 30; i++) rFull(NOOP, i);
  holdUp(['KeyW']);
  const walked = before.ctrl ? before.ctrl.distanceTo(gp.controller.position) : null;
  for (let i = 0; i < 30; i++) rFull(() => look(LOOK_PX), i);
  const turned = THREE.MathUtils.radToDeg((gp?.camera?.yaw ?? 0) - (before.camYaw ?? 0));
  // The godmode trap: prove W would ALSO have moved a godmode camera, which is
  // why the old capability check could not tell the two apart.
  return {
    modeDuring: before.mode,
    gameplayActive: before.active,
    playerWalkedMetresIn30Frames: walked === null ? 'no controller' : n2(walked),
    cameraTurnedDegIn30Frames: n2(turned),
    cameraFov: n2(cam.fov),
    playerPos: gp ? [n2(gp.controller.position.x), n2(gp.controller.position.y), n2(gp.controller.position.z)] : null,
    stance: gp?.stance,
    modeAfter: W.gameState.mode,
    activeAfter: gp?.active,
  };
});

// ===========================================================================
// throughput, round-robin over scenarios so drift is shared, not charged
// ===========================================================================
const ROUNDS = 5;

guard('playFrames', () => {
  const scen = {
    standing: { keys: [], mutate: NOOP },
    lookOnly: { keys: [], mutate: () => look(LOOK_PX) },
    walkLook: { keys: ['KeyW'], mutate: () => look(LOOK_PX) },
    sprintLook: { keys: ['KeyW', 'ShiftLeft'], mutate: () => look(LOOK_PX) },
    combat: {
      keys: ['KeyW', 'KeyD'],
      mutate: (i) => {
        look(6, i % 8 < 4 ? 2 : -2);
        if (i % 8 === 0) window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }));
        if (i % 8 === 4) window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, buttons: 0 }));
      },
    },
  };
  const acc = {};
  for (const k of Object.keys(scen)) acc[k] = [];
  const modeCheck = [];
  for (let r = 0; r < ROUNDS; r++) {
    // Re-enter play so every round starts from the same spawn: a sprint round
    // otherwise leaves the player 15 m from where the next round begins.
    W.gameState.setMode('godmode');
    W.gameState.setMode('play');
    mySettle(12);
    modeCheck.push(`${W.gameState.mode}/${gp?.active}`);
    for (const [name, s] of Object.entries(scen)) {
      holdDown(s.keys);
      acc[name].push(block(s.mutate));
      holdUp(s.keys);
    }
  }
  const out = { _modeEachRound: modeCheck };
  for (const [k, b] of Object.entries(acc)) {
    const q = quant(b);
    out[k] = {
      ms: n2(q.median),
      fps: Math.round(1000 / q.median),
      iqrMs: n2(q.q3 - q.q1),
      minMs: n2(q.min),
      maxMs: n2(q.max),
      blocks: b.map(n2),
    };
  }
  return out;
});

// ===========================================================================
// the real rAF loop in play mode — owes nothing to gl.finish()
// ===========================================================================
R.playRealLoop = await (async () => {
  try {
    const f0 = eng.frame;
    eng.deterministic = false;
    eng.clock.getDelta();
    eng.start();
    const ts = [];
    await new Promise((res) => {
      let last = performance.now();
      let n = 0;
      const tick = () => {
        look(LOOK_PX);
        const now = performance.now();
        ts.push(now - last);
        last = now;
        if (++n < 150) requestAnimationFrame(tick);
        else res();
      };
      requestAnimationFrame(tick);
    });
    eng.stop();
    eng.deterministic = true;
    const warm = ts.slice(30);
    const q = quant(warm);
    return {
      mode: W.gameState.mode,
      active: gp?.active,
      engineFramesDrawn: eng.frame - f0,
      samples: warm.length,
      medianMs: n2(q.median),
      fps: Math.round(1000 / q.median),
      p25Ms: n2(q.q1),
      p75Ms: n2(q.q3),
      maxMs: n2(q.max),
      note: 'rAF deltas, engine driving itself, camera turning. HUD DOM updates are suppressed (ui latches harnessDriving on the first deterministic frame).',
    };
  } catch (e) {
    eng.deterministic = true;
    return `FAILED: ${e?.message ?? e}`;
  }
})();

// ===========================================================================
// geometry from the ACTUAL play camera
// ===========================================================================
guard('playGeometry', () => {
  W.gameState.setMode('godmode');
  W.gameState.setMode('play');
  mySettle(40); // LOD rings and clipmaps must finish populating
  const sample = (mutate, n = 40) => {
    for (let i = 0; i < 20; i++) rFull(mutate, i);
    let sc = 0, st = 0, fc = 0, ft = 0, pc = 0, pt = 0;
    for (let i = 0; i < n; i++) {
      rFull(mutate, i);
      sc += pipe.sceneStats.calls;
      st += pipe.sceneStats.triangles;
      fc += renderer.info.render.calls;
      ft += renderer.info.render.triangles;
      pc = Math.max(pc, renderer.info.render.calls);
      pt = Math.max(pt, pipe.sceneStats.triangles);
    }
    return {
      sceneAndShadowDraws: Math.round(sc / n),
      sceneAndShadowTriangles: Math.round(st / n),
      wholeFrameDraws: Math.round(fc / n),
      peakWholeFrameDraws: pc,
      peakSceneTriangles: pt,
      postBlitDraws: Math.round((fc - sc) / n),
    };
  };
  const turning = sample(() => look(LOOK_PX));
  const still = sample(NOOP);
  // Worst case over a full 360: sample every 30 degrees.
  const sweep = [];
  for (let a = 0; a < 12; a++) {
    for (let i = 0; i < 30; i++) rFull(() => look(LOOK_PX), i); // 30 deg
    for (let i = 0; i < 8; i++) rFull(NOOP, i);
    sweep.push({ deg: a * 30, draws: renderer.info.render.calls, tris: pipe.sceneStats.triangles });
  }
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = false;
  const frozen = sample(() => look(LOOK_PX), 20);
  renderer.shadowMap.autoUpdate = true;
  return {
    turning,
    still,
    yawSweep: sweep,
    worstDrawsOverSweep: Math.max(...sweep.map((s) => s.draws)),
    worstTrianglesOverSweep: Math.max(...sweep.map((s) => s.tris)),
    shadowsFrozen: frozen,
    shadowMapDrawsPerFrame: turning.sceneAndShadowDraws - frozen.sceneAndShadowDraws,
    shadowMapTrianglesPerFrame: turning.sceneAndShadowTriangles - frozen.sceneAndShadowTriangles,
    budget: '< 350 draws, < 2.5 M triangles',
  };
});

// ===========================================================================
// godmode, same round-robin, for comparison with every previous round
// ===========================================================================
guard('godmodeFrames', () => {
  W.gameState.setMode('godmode');
  g.applyShot('gameplay');
  mySettle(10);
  const base = godPose.p.clone();
  const q0 = godPose.q.clone();
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q0);
  const scen = {
    static: NOOP,
    pan60: (i) => {
      cam.quaternion.copy(q0);
      cam.rotateY((i * Math.PI) / 180);
    },
    walk: (i) => cam.position.copy(base).addScaledVector(fwd, (i * 4) / 60),
  };
  const acc = { static: [], pan60: [], walk: [] };
  for (let r = 0; r < ROUNDS; r++) {
    for (const [name, m] of Object.entries(scen)) {
      cam.position.copy(base);
      cam.quaternion.copy(q0);
      acc[name].push(block(m));
    }
  }
  cam.position.copy(base);
  cam.quaternion.copy(q0);
  const out = { flags: { ...pipe.enabled } };
  for (const [k, b] of Object.entries(acc)) {
    const q = quant(b);
    out[k] = { ms: n2(q.median), fps: Math.round(1000 / q.median), iqrMs: n2(q.q3 - q.q1), blocks: b.map(n2) };
  }
  // Geometry for the godmode gameplay pose, so play and godmode are comparable.
  for (let i = 0; i < 40; i++) rFull(NOOP, i);
  out.geometry = {
    sceneAndShadowDraws: pipe.sceneStats.calls,
    sceneAndShadowTriangles: pipe.sceneStats.triangles,
    wholeFrameDraws: renderer.info.render.calls,
  };
  return out;
});

R.probeSeconds = n2((performance.now() - T0) / 1000);
R.pageErrors = g.errors.slice(0, 10);
return R;
