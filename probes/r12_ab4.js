/**
 * r12_ab4.js — long-block ABBA, and it prices the frustum culling that round
 * 12's tiling exists to enable.
 *
 * The A/B is `frustumCulled` on every instanced clutter mesh. With it off,
 * every tile is submitted from every pose, which is what the module did before
 * the tiles were sized to the field — same build, same geometry, same materials,
 * same shader programs, so nothing but the culling differs. That is a far
 * cleaner comparison than two builds hours apart.
 *
 * Blocks are long (WARM 32 + 30 timed) because this GPU's governor tracks load
 * inside a 10-frame window: r12_ab3 removed 24 fullscreen ALU blits at that
 * granularity and the frame got 4.1 ms SLOWER. Order is ABBA so a
 * first-position bias and any drift linear over four blocks both cancel. Ten
 * pairs, median of paired differences.
 *
 * POSITIVE CONTROL: `aoOff`. The occlusion pass was independently measured this
 * round at ~6.45 ms, seen in 6 of 6 reps, and it is by a distance the largest
 * single item in the post chain. If this probe cannot see 6.45 ms it cannot see
 * anything and the rest of the table is void. `ballastMinus8` is kept as a
 * second, smaller control (8 blits at 0.34 ms = ~2.7 ms) so the instrument's
 * resolution can be bracketed rather than guessed. Read both FIRST.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();

const WARM = 32, N = 30, PAIRS = 12, K = 24;

g.applyShot('gameplay');
eng.deterministic = true;
eng.stop();
pipe.enabled.dof = true;
pipe.enabled.motionBlur = true;

const inst = [];
let U = null;
eng.scene.traverse((o) => {
  if (o.isInstancedMesh && o.frustumCulled) inst.push(o);
  if (o.isMesh && /^terrain-L/.test(o.name || '') && o.material?.userData?.shader) U = o.material.userData.shader.uniforms;
});

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
let bal = K;
function ballast() {
  let src = pipe.hdr.texture;
  for (let i = 0; i < bal; i++) {
    const dst = i % 2 === 0 ? pipe.taaA : pipe.taaB;
    ballastMat.uniforms.tDiffuse.value = src;
    pipe._blit(ballastMat, dst);
    src = dst.texture;
  }
  renderer.setRenderTarget(null);
}
const cam = eng.camera;
const start = cam.position.clone();
let t = 0;
function step() {
  t += 1 / 60;
  cam.position.set(start.x + Math.sin(t * 0.6) * 6, start.y, start.z + Math.cos(t * 0.6) * 6);
  cam.lookAt(0, 2, 0);
  eng.step(1 / 60);
  eng.render();
  ballast();
}
function block() {
  for (let i = 0; i < WARM; i++) step();
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) step();
  gl.finish();
  return (performance.now() - t0) / N;
}
function reset() { bal = K; pipe.enabled.ssao = true; if (U) U.uPerf.value.set(0, 0, 0, 0); for (const o of inst) o.frustumCulled = true; }
const ARMS = {
  nullB:         () => {},
  aoOff:         () => { pipe.enabled.ssao = false; },
  ballastMinus8: () => { bal = K - 8; },
  cullOff:       () => { for (const o of inst) o.frustumCulled = false; },
  // The ceiling on any terrain-shader work: uPerf.x replaces the entire 1200-line
  // custom fragment body with the baked normal and a flat albedo.
  flatTerrain:   () => { if (U) U.uPerf.value.x = 1; },
  terrNoBedrock: () => { if (U) U.uPerf.value.y = 1; },
};
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
function run(applyB) {
  const dA = [], dB = [], pair = [];
  for (let r = 0; r < PAIRS; r++) {
    const order = (r & 1) === 0 ? [false, true] : [true, false];
    const got = {};
    for (const isB of order) { reset(); if (isB) applyB(); got[isB] = block(); }
    dA.push(got[false]); dB.push(got[true]); pair.push(+(got[false] - got[true]).toFixed(2));
  }
  reset();
  const r2 = (x) => +x.toFixed(2);
  return { savingMs: r2(med(pair)), pairDeltas: pair, aMed: r2(med(dA)), bMed: r2(med(dB)) };
}
reset();
block();
const only = (typeof ARGS !== 'undefined' && ARGS && ARGS.length) ? new Set(ARGS) : null;
const out = {};
for (const [k, apply] of Object.entries(ARMS)) { if (!only || only.has(k)) out[k] = run(apply); }
reset();
return { instancedMeshes: inst.length, note: 'aoOff must read ~+6.45 ms and ballastMinus8 ~+2.7 ms, or nothing here is a measurement.', results: out };
