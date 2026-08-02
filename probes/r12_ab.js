/**
 * r12_ab.js — frame-interleaved A/B for anything switchable by a uniform.
 *
 * Two block-paired attempts (r12_attrib, r12_terrcost) died the same way: this
 * machine acquires a co-tenant mid-run and the SAME base configuration reads
 * 29 ms in rep 1, 50 ms in reps 2-7 and 29 ms again in rep 9. `shot.mjs status`
 * said "quiet" on both sides of that. No block-level pairing survives a
 * disturbance whose period is longer than a block.
 *
 * So the arms alternate EVERY FRAME. The interference then lands on both arms
 * in the same proportion whatever its period, and the paired difference is
 * clean even while the absolute number is not.
 *
 * This is allowed to do what section 0 forbids ("flipping an ablation flag
 * stalls ~50 ms") only because the flip here is a uniform write into an
 * already-compiled shader: no recompile, no pass reconfiguration, no target
 * reallocation. Anything that recompiles must NOT be measured with this probe.
 * The nullA/nullB control (both arms identical) is what proves the flip itself
 * is free — if it is not, that control will be the size of the stall.
 *
 * Each frame carries a gl.finish, so a sample is one frame's GPU latency rather
 * than pipelined throughput; absolute numbers therefore run above the shipped
 * frame time and only differences mean anything. p10 is reported alongside the
 * median because contention is one-sided: it can only add.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();

const WARM = 64;
const FRAMES = 700;   // 350 samples per arm
const K = 24;

g.applyShot('gameplay');
eng.deterministic = true;
eng.stop();
pipe.enabled.dof = true;
pipe.enabled.motionBlur = true;

let U = null;
const terr = [];
eng.scene.traverse((o) => {
  if (!o.isMesh || !/^terrain-L/.test(o.name || '')) return;
  terr.push(o);
  if (o.material?.userData?.shader) U = o.material.userData.shader.uniforms;
});
if (!U) return { error: 'terrain shader uniforms not reachable' };

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

const off = () => U.uPerf.value.set(0, 0, 0, 0);
const ARMS = {
  nullB:       () => off(),
  flat:        () => { off(); U.uPerf.value.x = 1; },
  noBedrock:   () => { off(); U.uPerf.value.y = 1; },
  noDetailNrm: () => { off(); U.uPerf.value.z = 1; },
  noNearField: () => { off(); U.uPerf.value.w = 1; },
};

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

function run(applyB) {
  off();
  for (let i = 0; i < WARM; i++) { if (i & 1) applyB(); else off(); step(); }
  gl.finish();
  const A = [], B = [];
  for (let i = 0; i < FRAMES; i++) {
    const b = (i & 1) === 1;
    if (b) applyB(); else off();
    const t0 = performance.now();
    step();
    gl.finish();
    (b ? B : A).push(performance.now() - t0);
  }
  off();
  const r = (x) => +x.toFixed(3);
  return {
    savingP10Ms: r(pct(A, 0.10) - pct(B, 0.10)),
    savingMedMs: r(pct(A, 0.50) - pct(B, 0.50)),
    savingP25Ms: r(pct(A, 0.25) - pct(B, 0.25)),
    aP10: r(pct(A, 0.10)), bP10: r(pct(B, 0.10)),
    aMed: r(pct(A, 0.50)), bMed: r(pct(B, 0.50)),
    aP90: r(pct(A, 0.90)), bP90: r(pct(B, 0.90)),
    n: A.length,
  };
}

const out = {};
for (const [k, apply] of Object.entries(ARMS)) out[k] = run(apply);
off();
return {
  framePx: `${renderer.domElement.width}x${renderer.domElement.height}`,
  terrainMeshes: terr.length,
  note: 'A = shipped, B = named ablation. Positive saving = B is cheaper. nullB is the noise floor.',
  results: out,
};
