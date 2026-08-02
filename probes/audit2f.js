/**
 * audit2f.js — the split, one interleaved round-robin, every workload
 * presenting once per tick so the GPU is forced to finish inside the tick.
 *
 * Nine workloads, all measured in the same round, so the machine's drift (which
 * moved the frame time from 34 ms to 60 ms between two runs twenty minutes
 * apart) hits every one of them equally. Costs are differences between
 * neighbouring workloads, never between runs.
 */
const g = window.__GAME;
const W = g.world;
const eng = W.engine;
const cam = eng.camera;
const renderer = eng.renderer;
const pipe = eng.pipeline;
const vol = W.registry?.volumetrics?.pass ?? null;

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
  const q = quant(ts.slice(Math.max(5, Math.floor(n / 3))));
  return n2(q.median);
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
const ALLOFF = Object.fromEntries(Object.keys(PLAY).map((k) => [k, false]));
R.mode = { mode: W.gameState.mode, active: W.registry?.gameplay?.active, flags: PLAY };

const volUpdate = vol ? vol.update.bind(vol) : null;
const setVol = (on) => {
  if (vol) vol.update = on ? volUpdate : () => {};
};
const freezeShadows = (on) => {
  renderer.shadowMap.autoUpdate = !on;
  if (on) renderer.shadowMap.needsUpdate = false;
};

const cases = {
  // 1. nothing but a full-screen blit to the canvas: the fixed cost of getting
  //    one frame out of this headless browser.
  present: () => {
    look();
    presentBlit();
  },
  // 2. + all systems with the volumetric pass silenced
  stepNoVol: () => {
    look();
    setVol(false);
    eng.step(1 / 60);
    setVol(true);
    presentBlit();
  },
  // 3. + the volumetric pass (3 blits inside eng.step, gated by no flag)
  step: () => {
    look();
    eng.step(1 / 60);
    presentBlit();
  },
  // 4. + one scene rasterisation, shadow maps frozen
  sceneNoShadows: () => {
    look();
    eng.step(1 / 60);
    freezeShadows(true);
    rasterOnce();
    freezeShadows(false);
    presentBlit();
  },
  // 5. + shadow maps live
  scene1: () => {
    look();
    eng.step(1 / 60);
    rasterOnce();
    presentBlit();
  },
  // 6. two rasterisations: the second one carries no shadow pass, so
  //    scene2-scene1 is the pure main-camera raster
  scene2: () => {
    look();
    eng.step(1 / 60);
    rasterOnce();
    rasterOnce();
    presentBlit();
  },
  // 7. the real frame
  full1: () => {
    look();
    eng.step(1 / 60);
    eng.render();
  },
  // 8. the real frame with every gated post pass off
  full1FlagsOff: () => {
    look();
    eng.step(1 / 60);
    Object.assign(pipe.enabled, ALLOFF);
    eng.render();
    Object.assign(pipe.enabled, PLAY);
  },
  // 9. two real frames, one present: the increment is one whole frame of work
  full2: () => {
    look();
    eng.step(1 / 60);
    eng.render();
    eng.render();
  },
};

const runs = {};
for (const k of Object.keys(cases)) runs[k] = [];
const ROUNDS = 4;
for (let r = 0; r < ROUNDS; r++) {
  for (const [name, work] of Object.entries(cases)) runs[name].push(await rafClock(work, 24));
}
Object.assign(pipe.enabled, PLAY);
freezeShadows(false);
setVol(true);

const med = {};
for (const [k, v] of Object.entries(runs)) med[k] = n2(quant(v).median);
R.perRound = runs;
R.medians = med;

const raster = n2(med.scene2 - med.scene1);
R.derived = {
  fixedPresentCostMs: med.present,
  systemsExVolumetricsMs: n2(med.stepNoVol - med.present),
  volumetricPassMs: n2(med.step - med.stepNoVol),
  shadowMapsMs: n2(med.scene1 - med.sceneNoShadows),
  sceneRasterMs: raster,
  wholeFrameWorkMs: n2(med.full2 - med.full1),
  postChainMs: n2(med.full2 - med.full1 - raster),
  gatedPostPassesMs: n2(med.full1 - med.full1FlagsOff),
  ungatedPostMs: n2(med.full2 - med.full1 - raster - (med.full1 - med.full1FlagsOff)),
  realFrameTimeMs: med.full1,
  realFrameFps: Math.round(1000 / med.full1),
  sanity: {
    sumOfParts: n2(
      med.present +
        (med.stepNoVol - med.present) +
        (med.step - med.stepNoVol) +
        (med.scene1 - med.sceneNoShadows) +
        raster +
        (med.full2 - med.full1 - raster),
    ),
    measuredFull1: med.full1,
    note: 'sumOfParts should land near measuredFull1; a big gap means the decomposition is leaking.',
  },
};
R.probeSeconds = n2((performance.now() - T0) / 1000);
R.pageErrors = g.errors.slice(0, 6);
return R;
