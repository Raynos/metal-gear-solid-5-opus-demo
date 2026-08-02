/**
 * r11_bloom.js — confirm the bloom cost by THROUGHPUT, not by paired ablation.
 *
 * tools/probes/perf.js reports bloom at ~20 ms of a ~31 ms frame from paired
 * adjacent frames, twice, on two independent runs (20.05 and 20.24, IQR 9.74
 * and 13.48). That is a large enough claim to deserve confirmation down a
 * DIFFERENT measurement path before anybody optimises against it — every perf
 * number in this project has been wrong at least once, and two agreeing runs of
 * the same instrument agree about the instrument as much as about the frame.
 *
 * So this measures the way the throughput headline does: warm until the GPU
 * queue is saturated, time many frames, one present per tick, divide. Configs
 * are interleaved round-robin so slow drift lands on all of them equally, and
 * every config is measured three times so the spread is visible rather than
 * assumed.
 */
const g = window.__GAME;
const eng = g.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();

const WARM = 8;
const N = 40;
const REPS = 3;

// Move the camera. A static pose skips clipmap updates, cascade refits and LOD
// churn — the godmode static block reads 11 ms against 26 ms panning.
const cam = eng.camera;
const start = cam.position.clone();
let t = 0;

function block() {
  for (let i = 0; i < WARM; i++) {
    t += 1 / 60;
    cam.position.set(start.x + Math.sin(t * 0.6) * 6, start.y, start.z + Math.cos(t * 0.6) * 6);
    cam.lookAt(0, 2, 0);
    eng.step(1 / 60);
    eng.render();
  }
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    t += 1 / 60;
    cam.position.set(start.x + Math.sin(t * 0.6) * 6, start.y, start.z + Math.cos(t * 0.6) * 6);
    cam.lookAt(0, 2, 0);
    eng.step(1 / 60);
    eng.render();
  }
  gl.finish();
  return (performance.now() - t0) / N;
}

const CONFIGS = {
  full: () => { pipe.enabled.bloom = true; pipe.bloomMips = 6; },
  noBloom: () => { pipe.enabled.bloom = false; },
  mips3: () => { pipe.enabled.bloom = true; pipe.bloomMips = 3; },
  mips2: () => { pipe.enabled.bloom = true; pipe.bloomMips = 2; },
};

eng.deterministic = true;
eng.stop();

const samples = {};
for (const k of Object.keys(CONFIGS)) samples[k] = [];
// Round-robin, so drift is charged to every config rather than to whichever
// one happened to run last. That single mistake is failure #1 in perf.js's
// header — a variant "measured" at 9 ms when it costs nothing.
for (let r = 0; r < REPS; r++) {
  for (const [k, apply] of Object.entries(CONFIGS)) {
    apply();
    samples[k].push(block());
  }
}

CONFIGS.full();

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const out = {};
for (const [k, v] of Object.entries(samples)) {
  out[k] = {
    ms: +med(v).toFixed(2),
    runs: v.map((x) => +x.toFixed(2)),
    spreadMs: +(Math.max(...v) - Math.min(...v)).toFixed(2),
  };
}

return {
  note: 'throughput per config, camera moving, round-robin, median of 3 blocks of 40 frames',
  resolution: `${renderer.domElement.width}x${renderer.domElement.height}`,
  configs: out,
  bloomCostMs: +(out.full.ms - out.noBloom.ms).toFixed(2),
  mips6to3SavingMs: +(out.full.ms - out.mips3.ms).toFixed(2),
  mips6to2SavingMs: +(out.full.ms - out.mips2.ms).toFixed(2),
  worstSpreadMs: +Math.max(...Object.values(out).map((o) => o.spreadMs)).toFixed(2),
};
