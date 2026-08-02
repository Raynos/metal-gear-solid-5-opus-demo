/**
 * audit2b.js — (1) reconcile the two instruments, (2) the split, (3) per-pass.
 *
 * audit2a measured 22-29 ms per frame with gl.finish() blocks and 61 ms per
 * frame with the browser's own rAF loop, for the same work. One of those is
 * wrong, or they measure different things. Part 1 settles it by running FOUR
 * rAF loops that differ only in how much of the frame they do, so the cost of
 * presentation, of the post chain and of the systems can be read off directly
 * on the same clock.
 *
 * Everything runs in real play mode. g.settle() is never called after entering
 * it — see src/ui/state.js guardHarness(), which forces godmode from inside
 * settle/applyShot/stats.
 */

const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const eng = W.engine;
const cam = eng.camera;
const renderer = eng.renderer;
const pipe = eng.pipeline;
const gl = renderer.getContext();
const vol = W.registry?.volumetrics?.pass ?? null;

const R = {};
const T0 = performance.now();
const n2 = (v) => +Number(v).toFixed(2);
const guard = (name, fn) => {
  try {
    R[name] = fn();
  } catch (e) {
    R[name] = `FAILED: ${e?.message ?? e}`;
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
const look = (dx, dy = 0) =>
  window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, movementX: dx, movementY: dy, clientX: 960, clientY: 540 }));
const LOOK = 8;
const panLook = () => look(LOOK);

const rasterOnce = () => {
  renderer.setRenderTarget(pipe.hdr);
  renderer.clear(true, true, false);
  renderer.render(eng.scene, cam);
  renderer.setRenderTarget(null);
};
const rFull = (m, i) => {
  m(i);
  eng.step(1 / 60);
  eng.render();
};
const rScene = (m, i) => {
  m(i);
  eng.step(1 / 60);
  rasterOnce();
};
const rScene2 = (m, i) => {
  m(i);
  eng.step(1 / 60);
  rasterOnce();
  rasterOnce();
};
const rFull2 = (m, i) => {
  m(i);
  eng.step(1 / 60);
  rasterOnce();
  eng.render();
};
const rStep = (m, i) => {
  m(i);
  eng.step(1 / 60);
};
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

const PAIRS = 14;
const GROUP = 4;
function paired(applyA, applyB, { mutate = panLook, renderA = rFull, renderB = rFull, pairs = PAIRS, group = GROUP } = {}) {
  let idx = 0;
  applyB();
  for (let i = 0; i < WARM; i++) renderB(mutate, idx++);
  applyA();
  for (let i = 0; i < WARM; i++) renderA(mutate, idx++);
  gl.finish();
  const timeGroup = (apply, r) => {
    apply();
    gl.finish();
    const t0 = performance.now();
    for (let i = 0; i < group; i++) r(mutate, idx++);
    gl.finish();
    return (performance.now() - t0) / group;
  };
  const diffs = [];
  for (let p = 0; p < pairs; p++) {
    let a, b;
    if (p % 2 === 0) {
      a = timeGroup(applyA, renderA);
      b = timeGroup(applyB, renderB);
    } else {
      b = timeGroup(applyB, renderB);
      a = timeGroup(applyA, renderA);
    }
    diffs.push(b - a);
  }
  applyA();
  const q = quant(diffs);
  const iqr = q.q3 - q.q1;
  const resolved = Math.abs(q.median) > iqr;
  return {
    medianMs: n2(q.median),
    iqrMs: n2(iqr),
    resolved,
    verdict: resolved ? `${n2(q.median)} ms (IQR ${n2(iqr)})` : `BELOW NOISE (median ${n2(q.median)}, IQR ${n2(iqr)})`,
  };
}

// --- enter real play mode ---------------------------------------------------
eng.stop();
eng.deterministic = true;
window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F13', key: 'F13', bubbles: true }));
g.applyShot('gameplay');
mySettle(6);
g.setAutomation(true);
W.gameState.setMode('play');
mySettle(40);
const PLAY = { ...pipe.enabled };
const gp = W.registry?.gameplay;
R.mode = { mode: W.gameState.mode, active: gp?.active, flags: PLAY };

// ===========================================================================
// 1. reconcile the clocks — four rAF loops that differ only in workload
// ===========================================================================
async function rafRun(work, n = 90) {
  const ts = [];
  await new Promise((res) => {
    let last = performance.now();
    let k = 0;
    const tick = () => {
      work(k++);
      const now = performance.now();
      ts.push(now - last);
      last = now;
      if (k < n) requestAnimationFrame(tick);
      else res();
    };
    requestAnimationFrame(tick);
  });
  const warm = ts.slice(Math.floor(n / 3));
  const q = quant(warm);
  return { medianMs: n2(q.median), p25: n2(q.q1), p75: n2(q.q3), maxMs: n2(q.max), samples: warm.length };
}

R.clockReconciliation = await (async () => {
  try {
    const idle = await rafRun(() => {}, 60);
    const stepOnly = await rafRun((i) => rStep(panLook, i), 60);
    const sceneNoPresent = await rafRun((i) => rScene(panLook, i), 60);
    const fullFrame = await rafRun((i) => rFull(panLook, i), 90);
    // The same three configurations on the gl.finish() clock, right now, so the
    // comparison is not across a drift.
    const finishFull = block(panLook, rFull);
    const finishScene = block(panLook, rScene);
    const finishStep = block(panLook, rStep);
    return {
      rAF_idlePageMs: idle,
      rAF_stepOnlyMs: stepOnly,
      rAF_sceneIntoHdrNoPresentMs: sceneNoPresent,
      rAF_fullFrameMs: fullFrame,
      glFinish_fullFrameMs: n2(finishFull),
      glFinish_sceneIntoHdrMs: n2(finishScene),
      glFinish_stepOnlyMs: n2(finishStep),
      presentCostMs: n2(fullFrame.medianMs - sceneNoPresent.medianMs),
      note:
        'idle is the empty rAF cadence: if it is ~16.7 the loop is vsync-paced and every other row is quantised to it; ' +
        'if it is ~0 the loop is free-running and the rows are real work.',
    };
  } catch (e) {
    return `FAILED: ${e?.message ?? e}`;
  }
})();
eng.deterministic = true;
eng.stop();
mySettle(8);

// ===========================================================================
// 2. throughput anchors, round-robin so the split is not measured across drift
// ===========================================================================
guard('splitByThroughput', () => {
  const acc = { full: [], scene: [], step: [] };
  for (let r = 0; r < 5; r++) {
    acc.full.push(block(panLook, rFull));
    acc.scene.push(block(panLook, rScene));
    acc.step.push(block(panLook, rStep));
  }
  const out = {};
  for (const [k, b] of Object.entries(acc)) {
    const q = quant(b);
    out[k] = { ms: n2(q.median), iqrMs: n2(q.q3 - q.q1), blocks: b.map(n2) };
  }
  out.derived = {
    postChainMs: n2(out.full.ms - out.scene.ms),
    sceneRasterPlusShadowsMs: n2(out.scene.ms - out.step.ms),
    systemsCpuAndVolumetricsMs: out.step.ms,
  };
  return out;
});

// ===========================================================================
// 3. paired costs — noise floor first, and it governs everything below
// ===========================================================================
const setPlay = () => Object.assign(pipe.enabled, PLAY);
const setOff = (keys) => () => {
  Object.assign(pipe.enabled, PLAY);
  for (const k of keys) pipe.enabled[k] = false;
};

guard('noiseFloor', () => paired(setPlay, setPlay));

guard('splitByPairing', () => {
  const out = {};
  out.postChain = paired(setPlay, setPlay, { renderA: rScene, renderB: rFull });
  out.systemsAndVolumetrics_stepVsScene = paired(setPlay, setPlay, { renderA: rStep, renderB: rScene });
  out.extraRaster_withoutPost = paired(setPlay, setPlay, { renderA: rScene, renderB: rScene2 });
  out.extraRaster_withPost = paired(setPlay, setPlay, { renderA: rFull, renderB: rFull2 });
  out.additivity =
    out.extraRaster_withoutPost.resolved && out.extraRaster_withPost.resolved
      ? `one extra scene raster measured twice: ${out.extraRaster_withoutPost.medianMs} vs ${out.extraRaster_withPost.medianMs} ms — ` +
        (Math.abs(out.extraRaster_withoutPost.medianMs - out.extraRaster_withPost.medianMs) <
        0.35 * Math.max(out.extraRaster_withoutPost.medianMs, out.extraRaster_withPost.medianMs)
          ? 'AGREE, the clock is additive'
          : 'DISAGREE, treat every split below as suspect')
      : 'at least one estimate below noise — additivity untestable this run';
  return out;
});

guard('shadowMaps', () => {
  const freeze = () => {
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;
  };
  const thaw = () => {
    renderer.shadowMap.autoUpdate = true;
  };
  const r = paired(freeze, thaw);
  thaw();
  return r;
});

guard('volumetricSystem', () => {
  if (!vol) return 'volumetric pass not found';
  const real = vol.update.bind(vol);
  const r = paired(
    () => {
      vol.update = () => {};
    },
    () => {
      vol.update = real;
    },
  );
  vol.update = real;
  return { ...r, note: 'a SYSTEM, not a pipeline flag: 3 blits inside eng.step() that no enabled[] key gates' };
});

guard('perPass', () => {
  const groups = {
    bloom: ['bloom'],
    ssao: ['ssao'],
    taa: ['taa'],
    dofAndMotionBlurPass: ['dof', 'motionBlur'],
    motionBlurBranch: ['motionBlur'],
    fxaaFlag: ['fxaa'],
    autoExposureBranch: ['autoExposure'],
  };
  const out = {};
  for (const [name, keys] of Object.entries(groups)) {
    if (!keys.every((k) => PLAY[k])) {
      out[name] = `off in play config (${keys.map((k) => `${k}=${PLAY[k]}`).join(', ')})`;
      continue;
    }
    out[name] = paired(setOff(keys), setPlay).verdict;
  }
  setPlay();
  return out;
});

// A second noise floor at the END: if it differs from the first, the machine
// moved under the measurement and the middle of this run is worth less.
guard('noiseFloorAfter', () => paired(setPlay, setPlay));

R.finalMode = { mode: W.gameState.mode, active: gp?.active };
R.probeSeconds = n2((performance.now() - T0) / 1000);
R.pageErrors = g.errors.slice(0, 10);
return R;
