/**
 * r12_terrcost.js — what does Terrain.js's fragment shader actually cost?
 *
 * PAIRED blocks. r12_attrib.js's first run showed why: the null control between
 * two ADJACENT blocks was 0.11 ms, but the same base configuration measured at
 * rotation slot 0 and slot 13 of the same rep differed by 5.56 ms. Adjacent
 * precision is excellent and long-range drift is fatal, so every config is
 * measured immediately after its own base block and only the pair difference is
 * reported. A `null` config (base measured as if it were a treatment) bounds
 * what the instrument charges for nothing.
 *
 * Ablation is by uPerf, a uniform branch that BYPASSES a block — not a weight
 * set to zero, which still pays for the arithmetic. No shader recompile, so the
 * ~50 ms flag-flip stall does not apply; WARM = 64 absorbs it either way.
 * Constant ALU ballast throughout (a12_ballast.js) so the governor cannot clock
 * one arm against the other.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();

const WARM = 24, N = 40, REPS = 9, K = 24;

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
function block() {
  for (let i = 0; i < WARM; i++) step();
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) step();
  gl.finish();
  return +((performance.now() - t0) / N).toFixed(2);
}

function base() { U.uPerf.value.set(0, 0, 0, 0); for (const o of terr) o.visible = true; }
const CONFIGS = {
  nullCtrl:    () => base(),
  flat:        () => { base(); U.uPerf.value.x = 1; },
  noBedrock:   () => { base(); U.uPerf.value.y = 1; },
  noDetailNrm: () => { base(); U.uPerf.value.z = 1; },
  noNearField: () => { base(); U.uPerf.value.w = 1; },
};

base();
block(); // compile ballast + settle; discard

const pairs = {};
for (const k of Object.keys(CONFIGS)) pairs[k] = { base: [], cfg: [] };
try {
  for (let r = 0; r < REPS; r++) {
    for (const [k, apply] of Object.entries(CONFIGS)) {
      base();
      pairs[k].base.push(block());
      apply();
      pairs[k].cfg.push(block());
    }
  }
} finally { base(); }

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const out = {};
for (const [k, v] of Object.entries(pairs)) {
  const deltas = v.base.map((b, i) => +(b - v.cfg[i]).toFixed(2));
  out[k] = {
    savingMs: med(deltas),
    minSavingMs: +(Math.min(...v.base) - Math.min(...v.cfg)).toFixed(2),
    minBase: Math.min(...v.base),
    minCfg: Math.min(...v.cfg),
    deltas,
    baseRuns: v.base,
    cfgRuns: v.cfg,
  };
}
return {
  terrainMeshes: terr.length,
  framePx: `${renderer.domElement.width}x${renderer.domElement.height}`,
  note: 'savingMs = paired (base - config) median. nullCtrl is the noise floor; nothing below it is real.',
  results: out,
};
