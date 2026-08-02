/**
 * a12_gpu.js — per-BLIT GPU time for the whole frame, via timer queries.
 * ARGS: [renderScale=1] [frames=120]
 *
 * WHY. probes/r11_post.js priced everything that has an enabled[] flag and left
 * ~12 ms of the per-pixel half unattributed, believed (unverified) to live in
 * the unflagged passes: prep, luminance chain, adaptation, composite, present.
 * Ablation cannot reach those without a switch. A TIME_ELAPSED span around each
 * individual renderer.render call can, and every pass in this frame IS a
 * renderer.render call: the pipeline's _blit and the volumetric module's _blit
 * both route through one fullscreen quad each, so wrapping renderer.render and
 * naming the span by the quad's current material covers the entire frame —
 * including the three volumetric blits that run inside eng.step, before the
 * pipeline is ever entered, which the pipeline's own profiler marks never see.
 *
 * TRUST. A GPU timer query has been 6x off in this project's history, so the
 * probe carries its own validation: it measures the wall-clock frame with the
 * r11_post block method (WARM=64, gl.finish paced) in the same session, and
 * reports gpuSum vs wall side by side. If gpuSum tracks wall minus a small CPU
 * residue, the table is credible; if not, the table says so itself.
 *
 * The renderer.render wrap is restored in a finally block. Nothing in src/ is
 * touched. The wrap itself adds one createQuery/beginQuery/endQuery per draw
 * batch (~30 per frame) — CPU-side, and the query does not serialise the GPU.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();
const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
if (!ext) return { error: 'no EXT_disjoint_timer_query_webgl2' };
const vol = g.world?.registry?.volumetrics?.pass ?? null;

const scale = +((typeof ARGS !== 'undefined' && ARGS && ARGS[0]) || 1);
const FRAMES = +((typeof ARGS !== 'undefined' && ARGS && ARGS[1]) || 120);

const names = new Map();
for (const [k, n] of [
  ['aoMat', 'ao.gtao'], ['aoBlurMat', 'ao.blur'], ['prepMat', 'prep'],
  ['taaMat', 'taa'], ['lumMat', 'lum.64'], ['downMat', 'lum.down'],
  ['adaptMat', 'lum.adapt'], ['brightMat', 'bloom.bright'],
  ['blurMat', 'bloom.blur'], ['upsampleMat', 'bloom.up'],
  ['streakMat', 'bloom.streak'], ['dofMat', 'dofPass'],
  ['compositeMat', 'composite'], ['fxaaMat', 'present'],
]) if (pipe[k]) names.set(pipe[k], n);
if (vol) for (const [k, n] of [
  ['depthMat', 'vol.depthLin'], ['volMat', 'vol.march'], ['resolveMat', 'vol.resolve'],
]) if (vol[k]) names.set(vol[k], n);

const cam = eng.camera;
const start = cam.position.clone();
let t = 0;
function step() {
  t += 1 / 60;
  cam.position.set(start.x + Math.sin(t * 0.6) * 6, start.y, start.z + Math.cos(t * 0.6) * 6);
  cam.lookAt(0, 2, 0);
  eng.step(1 / 60);
  eng.render();
}
// Same instrument as r11_post/r11_fill: WARM absorbs any flip stall, finish
// paces the pipe so the number is a real frame time for THIS session.
function block() {
  for (let i = 0; i < 64; i++) step();
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < 40; i++) step();
  gl.finish();
  return +((performance.now() - t0) / 40).toFixed(2);
}

eng.deterministic = true;
eng.stop();
pipe.setRenderScale(scale);
block(); // settle
const wallMs = block();
const wallMs2 = block();

const origRender = renderer.render;
let recording = false;
let frameIdx = -1;
const pending = [];
renderer.render = function (scene, camera) {
  if (!recording) return origRender.call(this, scene, camera);
  let name = 'scene';
  if (scene === pipe.quadScene) name = names.get(pipe.quad.material) || 'pipe.other';
  else if (vol && scene === vol.quadScene) name = names.get(vol.blitQuad.material) || 'vol.other';
  const q = gl.createQuery();
  gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
  origRender.call(this, scene, camera);
  gl.endQuery(ext.TIME_ELAPSED_EXT);
  pending.push({ name, q, frame: frameIdx });
};

let disjoint = false;
let result;
try {
  for (let i = 0; i < 30; i++) step(); // saturate before recording
  recording = true;
  for (let i = 0; i < FRAMES; i++) { frameIdx = i; step(); }
  recording = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let tries = 0; tries < 300; tries++) {
    const last = pending[pending.length - 1];
    if (gl.getQueryParameter(last.q, gl.QUERY_RESULT_AVAILABLE)) break;
    step(); // keep the queue moving so results land
    await sleep(5);
  }
  disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);

  // Per-frame, per-name sums (a name can blit many times per frame).
  const perFrame = Array.from({ length: FRAMES }, () => ({}));
  let dropped = 0;
  for (const { name, q, frame } of pending) {
    if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) { dropped++; gl.deleteQuery(q); continue; }
    const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
    perFrame[frame][name] = (perFrame[frame][name] || 0) + ms;
    gl.deleteQuery(q);
  }
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const allNames = [...new Set(pending.map((p) => p.name))];
  const passMs = {};
  for (const n of allNames) {
    const a = perFrame.filter((f) => n in f).map((f) => f[n]);
    if (a.length) passMs[n] = +med(a).toFixed(3);
  }
  const totals = perFrame
    .map((f) => Object.values(f).reduce((s, v) => s + v, 0))
    .filter((v) => v > 0);
  const gpuSum = +med(totals).toFixed(2);

  result = {
    renderScale: scale,
    resolution: `${pipe.width}x${pipe.height}`,
    frames: FRAMES,
    droppedQueries: dropped,
    disjoint,
    wallMsBlocks: [wallMs, wallMs2],
    gpuSumMs: gpuSum,
    passMs: Object.fromEntries(Object.entries(passMs).sort((a, b) => b[1] - a[1])),
    note: 'passMs is the median across frames of the per-frame SUM of all blits sharing a name. scene includes shadow-map raster and all in-scene draws. wall - gpuSum is CPU + scheduling residue.',
  };
} finally {
  renderer.render = origRender;
  recording = false;
  pipe.setRenderScale(1);
}
return result;
