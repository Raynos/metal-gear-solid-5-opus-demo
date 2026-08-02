/**
 * audit2g.js — reproduce the split, and per-pass on the same back-pressured
 * clock, with the noise floor measured IN THE SAME ROUND-ROBIN: `full1` and
 * `full1_repeat` are the identical configuration, so their difference is
 * exactly what this instrument cannot resolve today.
 */
const g = window.__GAME;
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
  return { median: at(0.5), q1: at(0.25), q3: at(0.75) };
}
const look = () => window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, movementX: 8, movementY: 0 }));
const origBlit = pipe._blit.bind(pipe);
const presentBlit = () => {
  pipe.fxaaMat.uniforms.tDiffuse.value = pipe.compositeRT.texture;
  origBlit(pipe.fxaaMat, null);
};
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
  return n2(quant(ts.slice(Math.max(5, Math.floor(n / 3)))).median);
}

eng.stop();
eng.deterministic = true;
window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F13', key: 'F13', bubbles: true }));
g.applyShot('gameplay');
mySettle(6);
g.setAutomation(true);
W.gameState.setMode('play');
mySettle(40);
const PLAY = { ...pipe.enabled };
R.mode = { mode: W.gameState.mode, active: W.registry?.gameplay?.active, flags: PLAY };

const withFlags = (over) => () => {
  look();
  eng.step(1 / 60);
  Object.assign(pipe.enabled, PLAY, over);
  eng.render();
  Object.assign(pipe.enabled, PLAY);
};

const cases = {
  full1: withFlags({}),
  full1_repeat: withFlags({}),
  no_bloom: withFlags({ bloom: false }),
  no_ssao: withFlags({ ssao: false }),
  no_taa: withFlags({ taa: false }),
  no_dof_mb: withFlags({ dof: false, motionBlur: false }),
  no_fxaa: withFlags({ fxaa: false }),
  all_off: withFlags({ ssao: false, bloom: false, taa: false, fxaa: false, dof: false, motionBlur: false, autoExposure: false }),
  scene1: () => {
    look();
    eng.step(1 / 60);
    rasterOnce();
    presentBlit();
  },
  scene2: () => {
    look();
    eng.step(1 / 60);
    rasterOnce();
    rasterOnce();
    presentBlit();
  },
  full2: () => {
    look();
    eng.step(1 / 60);
    eng.render();
    eng.render();
  },
};

const runs = {};
for (const k of Object.keys(cases)) runs[k] = [];
for (let r = 0; r < 4; r++) {
  for (const [name, work] of Object.entries(cases)) runs[name].push(await rafClock(work, 22));
}
Object.assign(pipe.enabled, PLAY);

const med = {};
for (const [k, v] of Object.entries(runs)) med[k] = n2(quant(v).median);
R.perRound = runs;
R.medians = med;

// The noise floor: the same configuration, twice, inside the same round-robin.
const floor = Math.abs(med.full1 - med.full1_repeat);
const perPairFloor = runs.full1.map((v, i) => n2(v - runs.full1_repeat[i]));
const spread = Math.max(...perPairFloor) - Math.min(...perPairFloor);
const cost = (name) => {
  const d = med.full1 - med[name];
  return Math.abs(d) > Math.max(floor, spread / 2)
    ? `${n2(d)} ms`
    : `BELOW NOISE (${n2(d)} ms, floor ${n2(Math.max(floor, spread / 2))})`;
};

const raster = n2(med.scene2 - med.scene1);
R.result = {
  noiseFloorMs: n2(floor),
  noiseFloorPerRound: perPairFloor,
  realFrameTimeMs: med.full1,
  realFrameFps: Math.round(1000 / med.full1),
  wholeFrameWorkMs: n2(med.full2 - med.full1),
  sceneRasterMs: raster,
  postChainMs: n2(med.full2 - med.full1 - raster),
  perPass: {
    bloom: cost('no_bloom'),
    ssao: cost('no_ssao'),
    taa: cost('no_taa'),
    dofAndMotionBlurPass: cost('no_dof_mb'),
    fxaaFlag: cost('no_fxaa'),
    everyGatedPassTogether: cost('all_off'),
  },
};
R.probeSeconds = n2((performance.now() - T0) / 1000);
R.pageErrors = g.errors.slice(0, 6);
return R;
