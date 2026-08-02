/**
 * perf.js — the frame-time ruler.  node tools/shot.mjs probe tools/probes/perf.js
 *
 * ============================================================================
 * WHAT WAS WRONG WITH THE PREVIOUS RULER, and what replaced it
 * ============================================================================
 *
 * 1. IT MEASURED BASELINE ONCE. This machine's headless GPU drifts more than 2x
 *    inside a single run: four identical baseline blocks in one probe measured
 *    17.84, 23.37, 34.96 and 39.50 ms. The old code timed `full` once and then
 *    each variant in sequence, so the whole drift was charged to whichever
 *    variant happened to run last, and a pass could be "measured" at 9 ms when
 *    it costs nothing.
 *
 *    Replaced by PAIRED ADJACENT DIFFERENCES: baseline and variant are timed
 *    back to back, the order is flipped every pair, and the reported cost is the
 *    MEDIAN of the per-pair differences with the IQR beside it. Drift that is
 *    slow relative to one pair cancels; drift that is not shows up as IQR.
 *
 *    Pairing 20-frame BLOCKS was tried first and was not enough — blocks sit
 *    ~600 ms apart and the drift spikes inside that. Measured with block
 *    pairing, the same configuration against itself had an IQR of 7.25 ms on a
 *    27 ms frame and a bias of -3.95 ms: by this probe's own rule that run was
 *    void, and not one pass was resolvable. Pairing at the FRAME (two frames
 *    ~30 ms apart) is what made the instrument work.
 *
 * 2. IT PRINTED NUMBERS THE INSTRUMENT CANNOT RESOLVE. A cost is only reported
 *    if |median| > IQR. Otherwise this prints "below noise" and the noise floor,
 *    because "bloom costs 0.4 ms" and "bloom costs nothing measurable" are
 *    different claims and only one of them was ever true.
 *
 *    The noise floor is not asserted, it is measured: `noiseFloor` runs the
 *    whole paired procedure with the SAME configuration on both sides. Its
 *    median is the residual bias (should be ~0) and its IQR is the smallest
 *    effect this machine can resolve today. Every cost below is comparable
 *    against that one number.
 *
 * 3. IT ABLATED FLAGS THAT GATE NOTHING. `pipe.enabled` has eight keys; four of
 *    them do not gate a pass:
 *      - `fxaa`   the FXAA/sharpen blit runs unconditionally; the flag only
 *                 feeds `uFxaa`, and with TAA on that uniform is forced to 0
 *                 anyway, so ablating `fxaa` is a literal no-op.
 *      - `dof`    DOF and motion blur are ONE pass gated by
 *                 `uEnabled = dof || motionBlur`. Turning off `dof` alone
 *                 leaves the pass running. They must be ablated together.
 *      - `aerial`, `autoExposure` flip a uniform inside a pass that always runs.
 *    So this probe ablates GROUPS that correspond to real passes, and separately
 *    AUDITS every flag by rendering with it on and off and comparing pixels: a
 *    flag whose two frames are bit-identical is reported inert, from evidence.
 *
 * 4. `splitMs.sceneAndShadows` WAS NOT THE SCENE. Turning every flag off still
 *    runs the prep blit, the 6-level luminance chain, the adaptation blit, the
 *    DOF blit, the composite and the FXAA blit. This probe measures the scene by
 *    rendering it into the pipeline's own HDR target with the post chain not
 *    invoked at all, and reports the always-on post separately as `ungatedPost`.
 *
 * 5. IT COULD NOT SEE PLAY MODE. `applyShot()` forces godmode, so every number
 *    ever quoted was for a mode the player never runs. Play scenarios are driven
 *    by dispatched keyboard/mouse events, exactly as a player generates them,
 *    and godmode and play are always reported side by side.
 *
 * STILL TRUE FROM BEFORE, and still the reason the headline is a throughput:
 * five frames straight after a settle are only ENQUEUED. The GPU queue is empty,
 * submission returns at command-buffer write speed, and you measure the driver.
 * Every block below warms first, ends on a finish(), and divides by frames.
 */

const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const eng = W.engine;
const cam = eng.camera;
const renderer = eng.renderer;
const pipe = eng.pipeline;
const gl = renderer.getContext();

// One timing block. Short on purpose: the shorter a block, the closer the two
// halves of a pair sit in time and the more of the drift cancels.
const BLOCK_WARM = 4;
const BLOCK_N = 16;
// Blocks per scenario, for the throughput headline. Reported as a median so one
// drift spike cannot become the quoted frame time.
const BLOCKS = 3;
// Pairs per comparison. Each pair is two frames, so this is ~50 frames (~2 s).
// Must be even so each configuration is measured first exactly as often as it
// is measured second.
//
// Kept deliberately modest. Nine authors share one GPU and one queue on this
// machine; a probe that takes four minutes is a probe that gets killed by
// somebody else's `stop` before it finishes, which is not a more accurate
// measurement than one that completes. `--pairs`-style tuning would be nice but
// the honest lever is the reported IQR: if it is too wide to resolve what you
// care about, raise PAIRS and pay for it knowingly.
const PAIRS = 24;

const NOOP = () => {};

function timeBlock(mutate = NOOP, render = renderFull) {
  for (let i = 0; i < BLOCK_WARM; i++) render(mutate, i);
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < BLOCK_N; i++) render(mutate, i);
  gl.finish();
  return (performance.now() - t0) / BLOCK_N;
}

function renderFull(mutate, i) {
  mutate(i);
  eng.step(1 / 60);
  eng.render();
}

/**
 * The scene alone: systems tick, shadow cascades refresh, the scene rasterises
 * into the pipeline's HDR target — and then nothing. This is the only honest
 * "how much of the frame is the world" number; ablating post FLAGS cannot
 * produce it because six post blits have no flag.
 */
function renderSceneOnly(mutate, i) {
  mutate(i);
  eng.step(1 / 60);
  renderer.info.reset();
  renderer.setRenderTarget(pipe.hdr);
  renderer.clear(true, true, false);
  renderer.render(eng.scene, cam);
  renderer.setRenderTarget(null);
}

function quantiles(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const at = (q) => {
    const i = (s.length - 1) * q;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  return { median: at(0.5), q1: at(0.25), q3: at(0.75) };
}

/** One frame, serialised. Latency, not throughput — see `paired()`. */
function timeFrame(mutate, i, render) {
  const t0 = performance.now();
  render(mutate, i);
  gl.finish();
  return performance.now() - t0;
}

/**
 * Paired adjacent difference: cost of configuration B relative to A.
 *
 * PAIRED AT THE FRAME, NOT AT THE BLOCK. The first version of this paired
 * 20-frame blocks, and it could not resolve a single pass: the same
 * configuration against itself measured an IQR of 7.25 ms on a 27 ms frame,
 * because this machine's drift spikes inside one block. Two frames 30 ms apart
 * see almost the same machine; two blocks 600 ms apart do not.
 *
 * Order alternates every pair (ABBAABBA...), so a monotone drift contributes
 * +d to half the pairs and -d to the other half and the median is unbiased by
 * it. `gl.finish()` per frame serialises the pipeline, so these are latencies
 * and their absolute value is higher than the throughput headline — but the
 * DIFFERENCE is the extra GPU work B does, which is the thing being asked for,
 * and it is measured against a machine that has not had time to drift.
 */
function paired(applyA, applyB, { mutate = NOOP, render = renderFull, pairs = PAIRS } = {}) {
  // Warm both configurations so neither pays a first-touch cost inside the loop.
  applyB();
  for (let i = 0; i < BLOCK_WARM; i++) render(mutate, i);
  applyA();
  for (let i = 0; i < BLOCK_WARM; i++) render(mutate, i);
  gl.finish();

  const diffs = [];
  for (let p = 0; p < pairs; p++) {
    let a, b;
    if (p % 2 === 0) {
      applyA();
      a = timeFrame(mutate, 2 * p, render);
      applyB();
      b = timeFrame(mutate, 2 * p + 1, render);
    } else {
      applyB();
      b = timeFrame(mutate, 2 * p, render);
      applyA();
      a = timeFrame(mutate, 2 * p + 1, render);
    }
    diffs.push(b - a);
  }
  applyA();
  const q = quantiles(diffs);
  const iqr = q.q3 - q.q1;
  const out = {
    medianMs: +q.median.toFixed(2),
    iqrMs: +iqr.toFixed(2),
    pairs,
  };
  // The whole point of the rewrite: refuse to report a number the instrument
  // cannot separate from its own noise.
  out.resolved = Math.abs(q.median) > iqr;
  out.verdict = out.resolved ? `${out.medianMs} ms` : `below noise (|${out.medianMs}| <= IQR ${out.iqrMs})`;
  return out;
}

// ---------------------------------------------------------------------------
// flag audit — does this flag change anything at all?
// ---------------------------------------------------------------------------

const FLAGS = Object.keys(pipe.enabled || {});
const saveFlags = () => ({ ...pipe.enabled });
const restoreFlags = (s) => Object.assign(pipe.enabled, s);
const BASE = saveFlags();

/**
 * Render a fixed, reproducible frame and hash the pixels.
 *
 * TAA and the grain both read `pipe.frame`, and TAA also reads its own history
 * buffer, so a capture is only reproducible if BOTH are reset first. Two
 * captures of an unchanged configuration must hash identically or this whole
 * audit means nothing — `selfCheck` below asserts exactly that.
 */
const CAP_W = 480;
const CAP_H = 270;
const capBuf = new Uint8Array(CAP_W * CAP_H * 4);
function capture(frames = 16) {
  pipe.frame = 0;
  pipe._historyValid = false;
  eng.elapsed = 0;
  // The harness installs this (tools/shotd.mjs); the fallback keeps the probe
  // working against a daemon booted from a tree that predates it. Without it
  // the character animation clocks keep running and the self-check below fails
  // for reasons that have nothing to do with the flag being audited.
  if (window.__pinDeterminism) window.__pinDeterminism();
  else {
    const list = W.registry?.characters?.characters;
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) {
        const a = list[i]?.anim;
        if (!a) continue;
        a.t = 7.31 * i + 3.5;
        a.phase = (0.6180339887 * (i + 1)) % 1;
        a.breath = 2.17 * i + 1.1;
        a.hitTime = 1e3;
        a.smoothSpeed = a.speed ?? 0;
        a.weaponSway?.set?.(0, 0, 0);
        a.weaponSwayVel?.set?.(0, 0, 0);
        a.lookBlend?.set?.(0, 0);
      }
    }
    for (const name of ['taaA', 'taaB', 'adaptA', 'adaptB']) {
      const rt = pipe[name];
      if (!rt) continue;
      renderer.setRenderTarget(rt);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(null);
    W.lighting.invalidateShadows();
  }
  for (let i = 0; i < frames; i++) {
    eng.step(1 / 60);
    eng.render();
  }
  const size = renderer.getSize(new THREE.Vector2());
  // Read a centred window rather than the whole frame: 30x cheaper and it still
  // covers the subject, which is where every post pass shows up.
  const x = Math.max(0, ((size.x - CAP_W) >> 1) | 0);
  const y = Math.max(0, ((size.y - CAP_H) >> 1) | 0);
  gl.readPixels(x, y, CAP_W, CAP_H, gl.RGBA, gl.UNSIGNED_BYTE, capBuf);
  return capBuf.slice();
}

/** rms and peak difference in 8-bit codes, alpha excluded. */
function pixDiff(a, b) {
  let sq = 0;
  let n = 0;
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i];
    sq += d * d;
    if (Math.abs(d) > max) max = Math.abs(d);
    n++;
  }
  return { rms: +Math.sqrt(sq / n).toFixed(3), maxCode: max };
}

// ---------------------------------------------------------------------------
// GPU timer query — only trusted if it can prove itself
// ---------------------------------------------------------------------------
/**
 * A previous round shipped a GPU-timer probe that reported 140 ms against a
 * ~22 ms wall clock — 6x off — and it was quoted anyway. A timer query is only
 * usable if a whole-frame query agrees with the wall-clock throughput, so that
 * is made a precondition: the number is returned only when it lands within 20%,
 * and otherwise the extension is declared unusable on this machine.
 */
function gpuTimerSelfTest(wallMs) {
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return { available: false, reason: 'EXT_disjoint_timer_query_webgl2 not exposed' };
  try {
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    eng.step(1 / 60);
    eng.render();
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    gl.finish();
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    if (disjoint || !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
      gl.deleteQuery(q);
      return { available: false, reason: disjoint ? 'GPU_DISJOINT' : 'result never became available' };
    }
    const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
    gl.deleteQuery(q);
    const ratio = ms / wallMs;
    const ok = ratio > 0.8 && ratio < 1.2;
    return {
      available: ok,
      wholeFrameMs: +ms.toFixed(2),
      wallClockMs: +wallMs.toFixed(2),
      ratio: +ratio.toFixed(2),
      reason: ok ? 'self-test passed' : 'whole-frame query disagrees with throughput by more than 20% — DO NOT QUOTE',
    };
  } catch (err) {
    return { available: false, reason: String(err?.message ?? err) };
  }
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

const shot = (typeof ARGS !== 'undefined' && ARGS && ARGS[0]) || 'gameplay';
g.applyShot(shot);
g.settle(6);

const base = cam.position.clone();
const q0 = cam.quaternion.clone();
const fwd = new THREE.Vector3();
cam.getWorldDirection(fwd);
const reset = () => {
  cam.position.copy(base);
  cam.quaternion.copy(q0);
};

const godScenarios = {
  static: NOOP,
  // 1 deg/frame = 60 deg/s, a brisk look-around. Panning invalidates TAA
  // history, refits every cascade and churns the LOD rings.
  pan60: (i) => {
    cam.quaternion.copy(q0);
    cam.rotateY((i * 1.0 * Math.PI) / 180);
  },
  walk: (i) => cam.position.copy(base).addScaledVector(fwd, (i * 4) / 60),
  sprint: (i) => cam.position.copy(base).addScaledVector(fwd, (i * 40) / 60),
};

/**
 * Throughput headline: the MEDIAN of several pipelined blocks.
 *
 * Neither the mean nor the minimum survives this machine. The minimum of two
 * blocks reported 2.5 ms for a standing player and 21 ms for a sprint that is
 * plainly heavier than the 27 ms walk, because one block landed in a trough.
 * `blockSpreadMs` is the IQR across blocks: if it rivals `ms`, the machine was
 * drifting during the scenario and no difference smaller than it is real.
 */
function throughputOf(mutate) {
  const b = [];
  for (let i = 0; i < BLOCKS; i++) b.push(timeBlock(mutate));
  const q = quantiles(b);
  return {
    ms: +q.median.toFixed(1),
    fps: Math.round(1000 / q.median),
    blockSpreadMs: +(q.q3 - q.q1).toFixed(1),
  };
}

const frames = { godmode: {}, play: {} };
for (const [name, fn] of Object.entries(godScenarios)) {
  reset();
  frames.godmode[name] = throughputOf(fn);
}
reset();

// ---------------------------------------------------------------------------
// play mode — real dispatched input, because applyShot() cannot reach it
// ---------------------------------------------------------------------------

const canvas = renderer.domElement;
function key(code, type) {
  const init = { code, key: code, bubbles: true, cancelable: true };
  window.dispatchEvent(new KeyboardEvent(type, init));
  document.dispatchEvent(new KeyboardEvent(type, init));
}
function mouse(type, extra = {}) {
  const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 640, clientY: 360, ...extra };
  canvas.dispatchEvent(new MouseEvent(type, init));
  window.dispatchEvent(new MouseEvent(type, init));
}

/** Hold a key set for the whole of a scenario, then release it. */
function holding(codes, body) {
  for (const c of codes) key(c, 'keydown');
  try {
    return body();
  } finally {
    for (const c of codes) key(c, 'keyup');
  }
}

let playNote = null;
g.setMode('play');
g.settle(10);

// Is play mode actually a thing in this tree? Hold W for half a second and see
// whether anything moves the camera. This is a capability probe, not a guess:
// when the gameplay module is a stub the honest answer is "cannot be measured".
const posBeforeInput = cam.position.clone();
holding(['KeyW'], () => {
  for (let i = 0; i < 30; i++) {
    eng.step(1 / 60);
    eng.render();
  }
});
const playerMoves = posBeforeInput.distanceTo(cam.position) > 0.05;

if (!playerMoves) {
  playNote =
    'play mode present but inert in this tree: holding KeyW for 30 frames moved the camera ' +
    posBeforeInput.distanceTo(cam.position).toFixed(3) +
    ' m. registry.gameplay=' +
    (W.registry?.gameplay ? 'installed' : 'null') +
    '. Play scenarios are wired and will report the moment the gameplay module lands.';
}

const playScenarios = {
  standing: { keys: [] },
  walking: { keys: ['KeyW'] },
  sprinting: { keys: ['KeyW', 'ShiftLeft'] },
  // Fire while strafing and turning: the case that actually drops frames.
  combat: {
    keys: ['KeyW', 'KeyD'],
    mutate: (i) => {
      mouse('mousemove', { movementX: 6, movementY: i % 8 < 4 ? 2 : -2 });
      if (i % 8 === 0) mouse('mousedown');
      if (i % 8 === 4) mouse('mouseup');
    },
  },
};

// When play mode is inert, measuring four scenarios produces the same static
// number four times and dressing it up as walking and sprinting. Measure one,
// and let `playNote` say why there is only one.
const playToRun = playerMoves ? Object.keys(playScenarios) : ['standing'];
for (const name of playToRun) {
  const s = playScenarios[name];
  frames.play[name] = holding(s.keys, () => throughputOf(s.mutate ?? NOOP));
}

g.setMode('godmode');
g.applyShot(shot);
g.settle(6);
reset();

// ---------------------------------------------------------------------------
// where does the time go — all of it paired, in godmode, panning
// ---------------------------------------------------------------------------

// Pan while measuring costs too: a static pose skips cascade refits and TAA
// history invalidation, so it under-reports every temporal pass.
const costMutate = godScenarios.pan60;
const setBase = () => restoreFlags(BASE);
const setOff = (keys) => () => {
  restoreFlags(BASE);
  for (const k of keys) pipe.enabled[k] = false;
};

reset();
// Measured, not asserted: the same configuration against itself. Its IQR is the
// resolution limit of every number below it.
const noiseFloor = paired(setBase, setBase, { mutate: costMutate });

const passGroups = {
  // Real passes, gated by a flag that really does skip work.
  bloom: ['bloom'],
  ssao: ['ssao'],
  taa: ['taa'],
  // ONE pass behind two flags (uEnabled = dof || motionBlur); ablating either
  // alone leaves the pass running, which is why `dof` used to measure ~0.
  dofAndMotionBlurPass: ['dof', 'motionBlur'],
  // Uniform-only: the pass runs either way, so this is the cost of the shader
  // BRANCH, not of the pass. Labelled as such in the output.
  aerialBranch: ['aerial'],
  autoExposureBranch: ['autoExposure'],
  motionBlurBranch: ['motionBlur'],
};

const passCost = {};
for (const [name, keys] of Object.entries(passGroups)) {
  if (!keys.every((k) => BASE[k])) continue;
  reset();
  passCost[name] = { flags: keys, ...paired(setOff(keys), setBase, { mutate: costMutate }) };
}
setBase();

// Scene / post split. This one pairs two RENDER functions rather than two flag
// sets — A rasterises the scene into HDR and stops, B draws the whole frame.
const allOff = Object.fromEntries(FLAGS.map((f) => [f, false]));
/**
 * The same ABBA frame pairing as `paired()`, but the two sides differ by which
 * RENDER function runs rather than by which flags are set — there is no flag
 * that can turn the post chain off, which is the whole point of measuring it
 * this way.
 */
function pairedTwoRenders(renderA, renderB) {
  const diffs = [];
  const warm = (r) => {
    for (let i = 0; i < BLOCK_WARM; i++) r(costMutate, i);
  };
  warm(renderA);
  warm(renderB);
  gl.finish();
  for (let p = 0; p < PAIRS; p++) {
    let a, b;
    if (p % 2 === 0) {
      a = timeFrame(costMutate, 2 * p, renderA);
      b = timeFrame(costMutate, 2 * p + 1, renderB);
    } else {
      b = timeFrame(costMutate, 2 * p, renderB);
      a = timeFrame(costMutate, 2 * p + 1, renderA);
    }
    diffs.push(b - a);
  }
  const q = quantiles(diffs);
  const iqr = q.q3 - q.q1;
  return { medianMs: +q.median.toFixed(2), iqrMs: +iqr.toFixed(2), resolved: Math.abs(q.median) > iqr };
}

reset();
const postChain = pairedTwoRenders(renderSceneOnly, renderFull);
reset();
restoreFlags(allOff);
const ungatedPost = pairedTwoRenders(renderSceneOnly, renderFull);
setBase();

reset();
const totalMs = throughputOf(costMutate).ms;
reset();
const sceneBlocks = [];
for (let i = 0; i < BLOCKS; i++) sceneBlocks.push(timeBlock(costMutate, renderSceneOnly));
const sceneMs = quantiles(sceneBlocks).median;

// ---------------------------------------------------------------------------
// flag audit (pixels, not opinion)
// ---------------------------------------------------------------------------
reset();
setBase();
const refA = capture();
const refB = capture();
// The self-diff IS the threshold. Two captures of an unchanged build are not
// bit-identical (see tools/probes/determinism.js — TAA and the exposure
// adaptation are still converging at 24 frames), so "inert" has to mean "moves
// the frame no more than doing nothing at all does", measured here rather than
// assumed.
const selfDiff = pixDiff(refA, refB);
const flagAudit = {
  _selfCheck:
    `two captures of the unchanged build differ by rms ${selfDiff.rms} / max ${selfDiff.maxCode} codes. ` +
    'A flag is called INERT only if flipping it stays inside that.',
};
for (const f of FLAGS) {
  restoreFlags(BASE);
  pipe.enabled[f] = !BASE[f];
  const d = pixDiff(refA, capture());
  restoreFlags(BASE);
  const inert = d.rms <= selfDiff.rms && d.maxCode <= Math.max(selfDiff.maxCode, 2);
  flagAudit[f] = `${inert ? 'INERT' : 'live'} — rms ${d.rms}, max ${d.maxCode} codes`;
}
setBase();

reset();
const gpuTimer = gpuTimerSelfTest(totalMs);

const size = renderer.getSize(new THREE.Vector2());
const info = renderer.info;

reset();
setBase();
g.settle(4);

const fmt = (c) => (c.resolved ? `${c.medianMs} ms (IQR ${c.iqrMs})` : `below noise (median ${c.medianMs}, IQR ${c.iqrMs})`);

// A run whose pairing failed to cancel the drift is not a weaker measurement,
// it is not a measurement. Say so at the top level so it cannot be skimmed past.
const rulerValid = Math.abs(noiseFloor.medianMs) < noiseFloor.iqrMs;

return {
  RULER_VALID: rulerValid,
  rulerWarning: rulerValid
    ? undefined
    : `VOID RUN — the same configuration paired against itself has a median of ${noiseFloor.medianMs} ms, ` +
      `which is not inside its own IQR of ${noiseFloor.iqrMs} ms. The pairing did not cancel the machine's ` +
      'drift; do not quote any cost from this run.',
  shot,
  resolution: `${size.x}x${size.y} @dpr${renderer.getPixelRatio()}`,
  budget: { fps60Ms: 16.7, fps30Ms: 33.3 },

  // Median of BLOCKS pipelined blocks per scenario. `blockSpreadMs` is the IQR
  // across those blocks — if it rivals the number itself, the machine was
  // drifting and nothing finer than that spread is meaningful today.
  frames,
  playNote,

  ruler: {
    throughputBlock: `${BLOCK_WARM} warm + ${BLOCK_N} timed, x${BLOCKS}, median`,
    pairsPerComparison: PAIRS,
    pairing: 'adjacent FRAMES, order alternating (ABBA), median of per-pair differences',
    noiseFloorMs: noiseFloor.iqrMs,
    noiseFloorBiasMs: noiseFloor.medianMs,
    note:
      'noiseFloorMs is the IQR of the same configuration paired against itself. ' +
      'Nothing below it can be reported as a cost. noiseFloorBiasMs should be ~0; ' +
      'if it is not, the pairing is not cancelling the drift and the run is void.',
  },

  splitMs: {
    totalFrameMs: totalMs,
    sceneIntoHdrMs: +sceneMs.toFixed(1),
    postChainPaired: fmt(postChain),
    ungatedPostPaired: fmt(ungatedPost),
    note:
      'sceneIntoHdr is systems + shadow cascades + the scene rasterised into the pipeline HDR target, ' +
      'with the post chain never invoked. ungatedPost is what post still costs with EVERY enabled[] flag ' +
      'false — the prep blit, the 6-level luminance chain, the adaptation blit, DOF, composite and FXAA ' +
      'have no flag at all, so the old "sceneAndShadows" number included all six.',
  },

  perPassCost: Object.fromEntries(
    Object.entries(passCost)
      .sort((a, b) => b[1].medianMs - a[1].medianMs)
      .map(([k, v]) => [k, { verdict: fmt(v), flags: v.flags }]),
  ),

  flagAudit,
  gpuTimer,

  draws: pipe?.sceneStats?.calls ?? info.render.calls,
  triangles: pipe?.sceneStats?.triangles ?? info.render.triangles,
  programs: info.programs?.length ?? 0,
};
