/**
 * What round 9's character surface work costs, measured through the materials'
 * OWN uniforms rather than by rebuilding the tree.
 *
 * PAIRED ADJACENT FRAMES, which is the one thing perf.js found actually works on
 * this machine. Its header records the failure this avoids: pairing 20-frame
 * BLOCKS leaves ~600 ms between the two halves of a pair, the headless GPU here
 * drifts inside that window, and the same configuration measured against itself
 * came back with a 3.95 ms bias on a 27 ms frame. A pair whose halves are a few
 * hundred milliseconds apart is close enough together that the drift cancels;
 * see `miniBlock` for how far apart is too far.
 *
 * The order flips every pair so each configuration is measured first exactly as
 * often as it is second. The reported cost is the MEDIAN of the per-pair
 * differences; the NOISE FLOOR is the identical procedure run with the same
 * configuration on both sides, so its median is the residual bias (should be ~0)
 * and its IQR is the smallest effect resolvable today. A cost is only quoted
 * when it clears that floor.
 *
 * The camera MOVES throughout. A static pose skips clipmap updates, shadow
 * cascade refits and TAA history invalidation, which is a third of a real frame.
 *
 * usage: probes/run.sh probes/r9_charcost.js [shot]
 */
const g = window.__GAME;
const W = g.world;
const eng = W.engine;
const cam = eng.camera;
const renderer = eng.renderer;
const gl = renderer.getContext();

// Every character cloth material in the scene, via the uniform bag each
// makeClothMaterial hangs on userData.
const cloth = [];
W.scene.traverse((o) => {
  const ms = Array.isArray(o.material) ? o.material : [o.material];
  for (const m of ms) if (m && m.name === 'char-cloth' && m.userData.uniforms) cloth.push(m.userData.uniforms);
});

const saved = cloth.map((u) => ({ uCamo: u.uCamo.value, uWear: u.uWear.value, uWeave: u.uWeave.value }));
const CONFIGS = {
  // Everything round 9 added to the cloth shader, plus the weave/tooth stack it
  // shares a footprint guard with.
  full: () => cloth.forEach((u, i) => { u.uCamo.value = saved[i].uCamo; u.uWear.value = saved[i].uWear; u.uWeave.value = saved[i].uWeave; }),
  none: () => cloth.forEach((u) => { u.uCamo.value = 0; u.uWear.value = 0; u.uWeave.value = 0; }),
};

g.applyShot((typeof ARGS !== 'undefined' && ARGS && ARGS[0]) || 'gameplay');
g.settle(6);
const q0 = cam.quaternion.clone();
let spin = 0;

function frame() {
  spin += 0.4;
  cam.quaternion.copy(q0);
  cam.rotateY((spin * Math.PI) / 180);
  eng.step(1 / 60);
  eng.render();
}

/**
 * Twelve frames, fenced at both ends, reported as a mean. This number was tuned
 * against the NULL TEST, not guessed, and the sweep is worth recording because
 * both failure modes are instructive:
 *
 *   no fence at all   frame reported 2.63 ms on a 26 ms frame. Frames were only
 *                     ENQUEUED; submission returns at command-buffer write speed.
 *   fence per frame   null test unbiased (-0.10 ms) with an IQR of 44.6 ms —
 *                     correct and useless. A `gl.finish()` around ONE frame
 *                     measures that frame's latency including a full pipeline
 *                     drain, which varies more than the frame does.
 *   MINI = 5          IQR 11.6 ms, bias -2.92.
 *   MINI = 12         IQR 1.83 ms, bias -0.06.   <- here
 *
 * Twelve frames inside one fence amortises the drain, and the two halves of a
 * pair still sit ~300 ms apart, well inside the window where this machine's
 * drift cancels.
 */
const MINI = 12;
function miniBlock() {
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < MINI; i++) frame();
  gl.finish();
  return (performance.now() - t0) / MINI;
}

const PAIRS = 10;
function paired(aName, bName) {
  // Warm until the queue is saturated. The first block after a settle is only
  // ENQUEUED — submission returns at command-buffer write speed — so it is
  // discarded, exactly as ARCHITECTURE.md requires.
  CONFIGS[aName]();
  for (let i = 0; i < 16; i++) frame();
  const d = [];
  for (let p = 0; p < PAIRS; p++) {
    const flip = p % 2 === 1;
    CONFIGS[flip ? bName : aName]();
    const t1 = miniBlock();
    CONFIGS[flip ? aName : bName]();
    const t2 = miniBlock();
    d.push(flip ? t2 - t1 : t1 - t2);
  }
  d.sort((x, y) => x - y);
  const q = (f) => d[Math.floor(f * (d.length - 1))];
  return { median: q(0.5), iqr: q(0.75) - q(0.25) };
}

const out = { clothMaterials: cloth.length };
CONFIGS.full();
for (let i = 0; i < 16; i++) frame();
const ts = [];
for (let i = 0; i < 8; i++) ts.push(miniBlock());
ts.sort((a, b) => a - b);
out.frameMs = +ts[4].toFixed(2);

const floor = paired('full', 'full');
out.noiseFloorIqrMs = +floor.iqr.toFixed(3);
out.noiseFloorBiasMs = +floor.median.toFixed(3);
if (Math.abs(floor.median) > floor.iqr) {
  out.verdict = 'VOID — the null test has a bias larger than its own spread; nothing here is resolvable';
} else {
  const r = paired('full', 'none');
  out.camoWearToothMs = Math.abs(r.median) > floor.iqr
    ? `${r.median.toFixed(3)} (IQR ${r.iqr.toFixed(3)})`
    : `below noise (|${r.median.toFixed(3)}| < floor ${floor.iqr.toFixed(3)})`;
}
CONFIGS.full();
cam.quaternion.copy(q0);
return out;
