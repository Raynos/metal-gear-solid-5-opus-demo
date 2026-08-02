/**
 * r11_vol.js — the pass no ablation in this project can reach.
 *
 * probes/results/r11-fill.json puts 18.67 ms of a 26.44 ms frame in per-pixel
 * work. Everything the pipeline's own flags can price adds up to about 4 ms:
 * occlusion 2.46, DOF 0.89, bloom nothing, and the composite's CA, LUT and
 * grain all at or below a 0.57 ms floor. The rest has to be somewhere, and
 * there is exactly one full-screen per-pixel consumer that is not in
 * `pipeline.enabled` at all -- src/render/volumetrics.
 *
 * It is invisible to every existing instrument by construction. It installs as
 * an engine SYSTEM rather than a pipeline pass, it renders its own targets in
 * update(), and it composites through an in-scene quad with premultiplied
 * blending. tools/probes/perf.js audits `pipeline.enabled` and this appears in
 * none of it. `enabled.aerial` looks like the switch and is not: volumetrics
 * CLAIMS the haze at install by clearing that flag, so ablating it hands the
 * haze BACK and turns a second one on.
 *
 * So this ablates it the only honest way -- by removing its systems from the
 * engine and hiding the meshes it added to the scene -- and restores everything
 * afterwards. Method as in r11_post.js: WARM 64 frames so the flip stall is
 * absorbed, plus a null control that is the same configuration measured twice.
 */
const g = window.__GAME;
const eng = g.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();
const vol = g.world.registry.volumetrics;

if (!vol) return { error: 'volumetrics did not install; nothing to measure' };

const WARM = 64;
const N = 40;
const REPS = 3;

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
function block() {
  for (let i = 0; i < WARM; i++) step();
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) step();
  gl.finish();
  return +((performance.now() - t0) / N).toFixed(2);
}

const ALL = eng.systems.slice();
const mine = ALL.filter((s) => s === vol.pass || s === vol.particles);
// Everything these two put in the scene. Collected by identity rather than by
// name so a rename cannot silently make this measure nothing.
const meshes = [];
g.world.scene.traverse((o) => {
  if (o.isMesh || o.isPoints || o.isInstancedMesh) {
    if (o === vol.pass?.compositeMesh) meshes.push(o);
    else if (o.userData?.volumetric) meshes.push(o);
  }
});
if (vol.particles) {
  for (const k of ['mesh', 'dustMesh', 'hazeMesh', 'shaftMesh']) {
    const m = vol.particles[k];
    if (m && !meshes.includes(m)) meshes.push(m);
  }
}

function volOn() {
  eng.systems = ALL.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const m of meshes) m.visible = true;
}
function volOff() {
  eng.systems = ALL.filter((s) => !mine.includes(s));
  for (const m of meshes) m.visible = false;
}

eng.deterministic = true;
eng.stop();
volOn();
block();

const samples = { full: [], control: [], noVolumetrics: [] };
for (let r = 0; r < REPS; r++) {
  volOn(); samples.full.push(block());
  volOn(); samples.control.push(block());
  volOff(); samples.noVolumetrics.push(block());
}
volOn();

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const out = {};
for (const [k, v] of Object.entries(samples)) {
  out[k] = { ms: med(v), runs: v, spread: +(Math.max(...v) - Math.min(...v)).toFixed(2) };
}
const floor = Math.abs(+(out.full.ms - out.control.ms).toFixed(2));
const cost = +(out.full.ms - out.noVolumetrics.ms).toFixed(2);

return {
  systemsRemoved: mine.length,
  meshesHidden: meshes.length,
  frameMs: out.full.ms,
  configs: out,
  nullControlMs: floor,
  worstBlockSpreadMs: +Math.max(...Object.values(out).map((o) => o.spread)).toFixed(2),
  volumetricsCostMs: Math.abs(cost) > floor ? cost : `below noise (${cost}, floor ${floor})`,
};
