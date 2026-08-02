/**
 * audit2d.js — does the browser's rAF clock scale with the work? And is the
 * 35 ms gap between "scene into HDR" and "whole frame" POST or PRESENT?
 *
 * Smaller than audit2c, which crashed the renderer (three full frames enqueued
 * per rAF tick with no present is enough to lose the device on this backend —
 * itself worth knowing).
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const eng = W.engine;
const cam = eng.camera;
const renderer = eng.renderer;
const pipe = eng.pipeline;

const R = {};
const T0 = performance.now();
const n2 = (v) => +Number(v).toFixed(2);
function quant(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const at = (q) => {
    const i = (s.length - 1) * q;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  return { median: at(0.5), q1: at(0.25), q3: at(0.75), max: s[s.length - 1] };
}
const look = () => window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, movementX: 8, movementY: 0 }));
const rasterOnce = () => {
  renderer.setRenderTarget(pipe.hdr);
  renderer.clear(true, true, false);
  renderer.render(eng.scene, cam);
  renderer.setRenderTarget(null);
};
const mySettle = (n) => {
  for (let i = 0; i < n; i++) {
    eng.step(1 / 60);
    eng.render();
  }
};

const offRT = new THREE.WebGLRenderTarget(pipe.width, pipe.height, { type: THREE.HalfFloatType });
const origBlit = pipe._blit.bind(pipe);

async function rafClock(work, n) {
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
  const q = quant(ts.slice(Math.max(6, Math.floor(n / 3))));
  return { ms: n2(q.median), p25: n2(q.q1), p75: n2(q.q3), max: n2(q.max) };
}

eng.stop();
eng.deterministic = true;
window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F13', key: 'F13', bubbles: true }));
g.applyShot('gameplay');
mySettle(6);
g.setAutomation(true);
W.gameState.setMode('play');
mySettle(40);
R.mode = { mode: W.gameState.mode, active: W.registry?.gameplay?.active, dof: pipe.enabled.dof };

const cases = {
  idle: () => {},
  full_k1: () => {
    look();
    eng.step(1 / 60);
    eng.render();
  },
  full_k2: () => {
    look();
    eng.step(1 / 60);
    eng.render();
    eng.render();
  },
  scene_k1: () => {
    look();
    eng.step(1 / 60);
    rasterOnce();
  },
  scene_k2: () => {
    look();
    eng.step(1 / 60);
    rasterOnce();
    rasterOnce();
  },
  // Whole pipeline, post and all, final blit into an offscreen target: the
  // canvas is never written, so anything this is cheaper by is PRESENT, not post.
  fullOffscreen_k1: () => {
    look();
    eng.step(1 / 60);
    pipe._blit = (mat, target) => origBlit(mat, target === null ? offRT : target);
    eng.render();
    pipe._blit = origBlit;
  },
  // Scene + one present-sized blit to the canvas, no post chain at all.
  scenePlusPresent_k1: () => {
    look();
    eng.step(1 / 60);
    rasterOnce();
    pipe.fxaaMat.uniforms.tDiffuse.value = pipe.compositeRT.texture;
    origBlit(pipe.fxaaMat, null);
  },
};

R.rAF = {};
for (let pass = 0; pass < 2; pass++) {
  for (const [name, work] of Object.entries(cases)) {
    R.rAF[pass === 0 ? name : `${name}_p2`] = await rafClock(work, name === 'idle' ? 30 : 40);
  }
}

const m = (k) => R.rAF[k].ms;
R.interpretation = {
  floorMs: m('idle'),
  oneExtraWholeFrameMs: n2(m('full_k2') - m('full_k1')),
  oneExtraSceneRasterMs: n2(m('scene_k2') - m('scene_k1')),
  wholeFrameOverScene: n2(m('full_k1') - m('scene_k1')),
  postChainOnlyMs_offscreenMinusScene: n2(m('fullOffscreen_k1') - m('scene_k1')),
  presentCostMs_fullMinusOffscreen: n2(m('full_k1') - m('fullOffscreen_k1')),
  presentCostMs_sceneWithPresentMinusScene: n2(m('scenePlusPresent_k1') - m('scene_k1')),
  pass2Repeat: {
    oneExtraWholeFrameMs: n2(m('full_k2_p2') - m('full_k1_p2')),
    presentCostMs: n2(m('full_k1_p2') - m('fullOffscreen_k1_p2')),
  },
};

offRT.dispose();
R.probeSeconds = n2((performance.now() - T0) / 1000);
R.pageErrors = g.errors.slice(0, 6);
return R;
