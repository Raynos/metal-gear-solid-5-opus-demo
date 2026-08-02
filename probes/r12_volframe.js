/**
 * r12_volframe.js — one build's frame time, for comparing TWO BUILDS.
 *
 * The volumetric march's resolution is fixed at target-allocation time, and
 * this project has already established that A/B-ing a resolution by resizing a
 * half-float target at runtime stalls far harder than the effect being measured
 * (r12_frame.js's header). So the only honest instrument is one configuration,
 * measured on two builds, back to back in one sitting.
 *
 * Same shape as r12_frame.js: no flags flipped, no targets resized, constant
 * ballast so the governor sees the same load on both builds. Two camera poses
 * are measured because the pass's cost is dominated by how much SKY is on
 * screen — `vista` is nearly half sky and is where the cumulus march is
 * biggest, `gameplay` is the frame the budget is actually about.
 *
 * It prints the volumetric target's pixel size, so the output says which build
 * it came from and no result can be filed under the wrong one.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();
const vol = g.world?.registry?.volumetrics?.pass ?? null;

const WARM = 48;
const N = 32;
const REPS = 6;
const K = 6;

eng.deterministic = true;
eng.stop();

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

let t = 0;
let start = null;
const cam = eng.camera;

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
  cam.lookAt(start.lx, start.ly, start.lz);
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

const SHOTS = ['gameplay', 'vista'];
const samples = { gameplay: [], vista: [] };

function pose(name) {
  const s = g.applyShot(name);
  pipe.enabled.dof = true;
  pipe.enabled.motionBlur = true;
  start = {
    x: cam.position.x, y: cam.position.y, z: cam.position.z,
    lx: s.target[0], ly: s.target[1], lz: s.target[2],
  };
  t = 0;
}

pose('gameplay');
block(); // compile the ballast shader, warm every target, settle the clocks

for (let r = 0; r < REPS; r++) {
  for (const s of SHOTS) {
    pose(s);
    samples[s].push(block());
  }
}

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const out = {};
for (const [k, v] of Object.entries(samples)) {
  out[k] = {
    medianMs: med(v),
    minMs: Math.min(...v),
    runs: v,
    spreadMs: +(Math.max(...v) - Math.min(...v)).toFixed(2),
  };
}

return {
  framePx: `${renderer.domElement.width}x${renderer.domElement.height}`,
  volMarchPx: vol ? `${vol.volRT.width}x${vol.volRT.height}` : 'no volumetric pass',
  volDepthPx: vol ? `${vol.depthRT.width}x${vol.depthRT.height}` : '-',
  perShot: out,
};
