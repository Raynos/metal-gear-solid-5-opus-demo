/**
 * r12_cascade.js — what does cascade 0's refresh interval actually cost?
 *
 * This is the ONE cut in this round that can honestly be A/B'd inside a single
 * page, and it is worth saying why, because every other attempt this project
 * has made at an in-page A/B has produced a false number:
 *
 *   - it is not an ablation FLAG, so nothing recompiles (the ~50 ms flip stall
 *     that priced bloom at 20 ms twice in a row);
 *   - it is not a RESIZE, so nothing reallocates a half-float target (which
 *     stalls harder than the effect being measured — see r12_frame.js);
 *   - `lighting.refreshInterval[0]` is an integer read once per frame. Changing
 *     it changes only how many shadow rasters a frame issues.
 *
 * So the configs rotate inside one run, which removes the "absolute times are
 * only comparable within one session" problem entirely, and every config
 * carries the same ALU ballast (a12_ballast.js) so the M3 Pro's governor sees a
 * constant load and cannot downclock the cheap config into looking expensive.
 *
 * `int1a` and `int1b` are the same configuration under two names: the NULL
 * CONTROL. Nothing smaller than |int1a - int1b| is real.
 *
 * `sceneStats.calls` is reported alongside the times because it is an
 * instrument the governor cannot lie to: if the draw count does not fall, the
 * schedule is not doing anything and no time difference can be believed.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();
const lighting = g.world.lighting;

const WARM = 48;
const N = 32;
const REPS = 6;
// Ballast blits per frame, identical in every config. K=24 (a12_ballast's
// level) was tried first and it is the wrong level HERE: it put the frame at
// 50-100 ms, which is not the regime the cut lives in, and the null control
// came back at 28.4 ms. Both configs under test are already heavy frames, so
// the governor risk this is insuring against is small; 6 is enough to keep the
// clock state identical between them without burying the frame.
const K = 6;

g.applyShot('gameplay');
eng.deterministic = true;
eng.stop();
pipe.enabled.dof = true;
pipe.enabled.motionBlur = true;

const SM = Object.getPrototypeOf(pipe.prepMat).constructor;
const VERT = 'varying vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const ballastMat = new SM({
  vertexShader: VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float a = vUv.x + c.g * 0.001;
      for (int i = 0; i < 16; i++) a = sin(a * 1.37 + float(i)) * 0.99 + c.r * 1e-4;
      gl_FragColor = vec4(c + a * 1e-6, 1.0);
    }`,
  uniforms: { tDiffuse: { value: null } },
  depthTest: false, depthWrite: false,
});

const cam = eng.camera;
const start = cam.position.clone();
let t = 0;
let calls = 0;
let tris = 0;
let frames = 0;

function ballast() {
  let src = pipe.hdr.texture;
  for (let i = 0; i < K; i++) {
    const dst = i % 2 === 0 ? pipe.taaA : pipe.taaB;
    ballastMat.uniforms.tDiffuse.value = src;
    pipe._blit(ballastMat, dst);
    src = dst.texture;
  }
  renderer.setRenderTarget(null);
}
function step() {
  t += 1 / 60;
  cam.position.set(start.x + Math.sin(t * 0.6) * 6, start.y, start.z + Math.cos(t * 0.6) * 6);
  cam.lookAt(0, 2, 0);
  eng.step(1 / 60);
  eng.render();
  calls += pipe.sceneStats.calls;
  tris += pipe.sceneStats.triangles;
  frames++;
  ballast();
}
function block() {
  for (let i = 0; i < WARM; i++) step();
  gl.finish();
  calls = 0;
  tris = 0;
  frames = 0;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) step();
  gl.finish();
  return {
    ms: +((performance.now() - t0) / N).toFixed(2),
    calls: +(calls / frames).toFixed(1),
    mtris: +(tris / frames / 1e6).toFixed(3),
  };
}

// One difference this small (~70 draws of depth-only raster) sits under the
// noise floor of a shared machine, so the instrument is a LADDER rather than a
// pair: five refresh intervals spanning 467 down to ~215 draws a frame, fitted
// for a slope. A slope survives contention that any single difference does not,
// because a contended rep can only ever push a config UP.
//
// `frozen` is interval 2^30 — no cascade ever re-rasterises except when the
// >3 m camera-move guard in Lighting.update fires (about one frame in 50 on
// this camera path, which is why its draw count is not exactly the scene's).
// It prices the WHOLE shadow re-raster on this build, which is the number the
// round-11 audit quoted as 1.75 ms and which nothing since has re-measured.
//
// `noAO` is the POSITIVE CONTROL, and it is the reason the null result below can
// be believed at all. The round-11 audit prices the AO pass at 2.2-2.9 ms. If
// this instrument cannot see THAT, it cannot see anything and "the cascade
// schedule saves nothing" would mean nothing. It is an ablation flag, so it
// carries the ~50 ms recompile stall — which is what WARM = 48 frames of
// discarded warm-up before every timed block is for.
const CONFIGS = {
  int1a: 1,
  int2: 2,
  int1b: 1, // null control: identical to int1a, different rotation slot
  int3: 3,
  int6: 6,
  frozen: 1 << 30,
  noAO: 1,
};

lighting.refreshInterval[0] = 1;
block(); // compile the ballast shader, warm every target, settle the clocks

const samples = {};
for (const k of Object.keys(CONFIGS)) samples[k] = [];
for (let r = 0; r < REPS; r++) {
  for (const [k, v] of Object.entries(CONFIGS)) {
    lighting.refreshInterval[0] = v;
    pipe.enabled.ssao = k !== 'noAO';
    lighting.invalidateShadows();
    samples[k].push(block());
  }
}
pipe.enabled.ssao = true;
lighting.refreshInterval[0] = CONFIGS.int2;
lighting.invalidateShadows();

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const out = {};
for (const [k, v] of Object.entries(samples)) {
  const ms = v.map((x) => x.ms);
  out[k] = {
    medianMs: med(ms),
    minMs: Math.min(...ms),
    runsMs: ms,
    spreadMs: +(Math.max(...ms) - Math.min(...ms)).toFixed(2),
    drawsPerFrame: med(v.map((x) => x.calls)),
    mTrisPerFrame: med(v.map((x) => x.mtris)),
  };
}

// Least-squares slope of frame time against shadow draws, over the ladder.
// Fitted on the MINIMUM of each config for the reason given below.
function slope(pick) {
  const xs = [];
  const ys = [];
  for (const k of ['int1a', 'int2', 'int3', 'int6', 'frozen']) {
    xs.push(out[k].drawsPerFrame);
    ys.push(out[k][pick]);
  }
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return {
    msPerShadowDraw: +(sxy / sxx).toFixed(4),
    r2: +((sxy * sxy) / (sxx * syy)).toFixed(3),
    points: xs.map((x, i) => [x, ys[i]]),
  };
}

return {
  resolution: `${pipe.width}x${pipe.height}`,
  schedule: lighting.refreshInterval.slice(0, lighting.cascades.length),
  configs: out,
  savingMedianMs: {
    interval2: +(out.int1a.medianMs - out.int2.medianMs).toFixed(2),
    interval3: +(out.int1a.medianMs - out.int3.medianMs).toFixed(2),
    interval6: +(out.int1a.medianMs - out.int6.medianMs).toFixed(2),
    nullControlMs: +Math.abs(out.int1a.medianMs - out.int1b.medianMs).toFixed(2),
  },
  // The machine is shared and another author's browser is on it, so a rep can
  // be arbitrarily SLOWED but never sped up. The minimum over reps is the
  // least-contended sample of each config; its null control is the honest
  // noise floor for this instrument on a busy machine.
  savingMinMs: {
    interval2: +(out.int1a.minMs - out.int2.minMs).toFixed(2),
    interval3: +(out.int1a.minMs - out.int3.minMs).toFixed(2),
    interval6: +(out.int1a.minMs - out.int6.minMs).toFixed(2),
    nullControlMs: +Math.abs(out.int1a.minMs - out.int1b.minMs).toFixed(2),
  },
  positiveControlAoMs: {
    median: +(out.int1a.medianMs - out.noAO.medianMs).toFixed(2),
    min: +(out.int1a.minMs - out.noAO.minMs).toFixed(2),
    note: 'the audit prices the AO pass at 2.2-2.9 ms; if this is not about that, the instrument is blind',
  },
  ladderSlopeMin: slope('minMs'),
  ladderSlopeMedian: slope('medianMs'),
  wholeShadowRasterMs: {
    median: +(out.int1a.medianMs - out.frozen.medianMs).toFixed(2),
    min: +(out.int1a.minMs - out.frozen.minMs).toFixed(2),
    drawsRemoved: +(out.int1a.drawsPerFrame - out.frozen.drawsPerFrame).toFixed(1),
  },
  savingDraws: {
    interval2: +(out.int1a.drawsPerFrame - out.int2.drawsPerFrame).toFixed(1),
    interval3: +(out.int1a.drawsPerFrame - out.int3.drawsPerFrame).toFixed(1),
    interval6: +(out.int1a.drawsPerFrame - out.int6.drawsPerFrame).toFixed(1),
    nullControlDraws: +Math.abs(out.int1a.drawsPerFrame - out.int1b.drawsPerFrame).toFixed(1),
  },
};
