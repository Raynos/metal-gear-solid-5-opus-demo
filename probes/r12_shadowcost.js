/**
 * r12_shadowcost.js — price ONE cascade-0 re-rasterisation, by amplifying it,
 * and then find out whether the amplifier is measuring the work or itself.
 *
 * r12_cascade.js compared refresh intervals directly and could not resolve the
 * difference: 80 shadow draws and 0.7 M triangles a frame came off the frame and
 * the median frame time moved -0.25 to +1.16 ms against a null control of
 * 0.56-0.79 ms. Freezing cascade 0 outright — 160 draws, 1.4 M triangles, gone
 * from every frame — moved the median 25.20 -> 24.86.
 *
 * So the obvious next move is to measure the effect at a scale the instrument
 * can see. WRAP `renderer.shadowMap.render` and, on the way out, rasterise
 * cascade 0 k extra times: same casters, same frustum cull, same depth material,
 * same 2048x2048 target, k times the work the schedule is trying to remove.
 * Sweep k, fit a slope, and one raster is the slope. (It has to be a WRAPPER
 * and not a call of its own: three's renderBufferDirect reads the renderer's
 * current render STATE, which only exists inside WebGLRenderer.render, so
 * calling shadowMap.render from outside a frame throws on a null state.)
 *
 * That ladder came back at 7.21 ms per raster with r^2 = 0.999 — beautifully
 * linear, and IMPOSSIBLE. It would put 7.2 ms of cascade-0 raster inside a
 * 25.3 ms frame, and freezing cascade 0 would then have to drop the frame to
 * ~18 ms. It drops it by 0.34 ms.
 *
 * THIS PROBE IS THE ARBITRATION. It runs two ladders in one page:
 *
 *   real   k extra rasterisations of cascade 0, all 160 draws of it
 *   empty  k extra shadow passes over an EMPTY scene, same 2048x2048 target,
 *          same target switch, same clear, ZERO draws
 *
 * If the empty ladder is flat, the amplifier measures work and the 7.2 ms is
 * real. If the empty ladder has the same slope, then what the amplifier prices
 * is a RENDER PASS, not what is inside it — which is exactly the pathology this
 * project already found in EXT_disjoint_timer_query_webgl2 on ANGLE Metal,
 * where each query ate a command-buffer boundary and a 64x64 blit billed 15 ms.
 *
 * `k0a`/`k0b` are the same configuration twice: the null control.
 */
const g = window.__GAME;
const THREE = g.THREE;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();
const lighting = g.world.lighting;

const WARM = 48;
const N = 32;
const REPS = 4;
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
const c0 = lighting.cascades[0];

// The empty ladder's light: same map size and same shadow camera shape as
// cascade 0, but its scene has nothing in it, so the pass is a target switch
// and a clear and nothing else.
const emptyScene = new THREE.Scene();
const fake = new THREE.DirectionalLight(0xffffff, 1.0);
fake.castShadow = true;
fake.shadow.mapSize.copy(c0.shadow.mapSize);
fake.shadow.camera.copy(c0.shadow.camera);
fake.shadow.camera.updateProjectionMatrix();
fake.shadow.autoUpdate = false;

let t = 0;
let real = 0;
let empty = 0;
let cpuMs = 0;
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

const shadowMap = renderer.shadowMap;
const origShadowRender = shadowMap.render.bind(shadowMap);
shadowMap.render = function (lights, scene, camera) {
  origShadowRender(lights, scene, camera);
  const c0t = performance.now();
  for (let i = 0; i < real; i++) {
    c0.shadow.needsUpdate = true;
    origShadowRender([c0], scene, camera);
  }
  for (let i = 0; i < empty; i++) {
    fake.shadow.needsUpdate = true;
    origShadowRender([fake], emptyScene, camera);
  }
  // CPU-side submission cost of the extras, separately from the frame's wall
  // clock: if these two disagree the cost is on the GPU, if they agree it is
  // three's scene traversal.
  cpuMs += performance.now() - c0t;
};

function step() {
  t += 1 / 60;
  cam.position.set(start.x + Math.sin(t * 0.6) * 6, start.y, start.z + Math.cos(t * 0.6) * 6);
  cam.lookAt(0, 2, 0);
  eng.step(1 / 60);
  eng.render();
  frames++;
  ballast();
}
function block() {
  for (let i = 0; i < WARM; i++) step();
  gl.finish();
  cpuMs = 0;
  frames = 0;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) step();
  gl.finish();
  return {
    ms: +((performance.now() - t0) / N).toFixed(2),
    extraCpuMs: +(cpuMs / frames).toFixed(2),
  };
}

const CONFIGS = {
  k0a: [0, 0],
  r2: [2, 0],
  e2: [0, 2],
  k0b: [0, 0],
  r4: [4, 0],
  e4: [0, 4],
};

lighting.refreshInterval[0] = 1; // cascade 0 fresh every frame in every config
lighting.invalidateShadows();
block(); // compile, warm, settle

const samples = {};
for (const k of Object.keys(CONFIGS)) samples[k] = [];
for (let r = 0; r < REPS; r++) {
  for (const [k, v] of Object.entries(CONFIGS)) {
    [real, empty] = v;
    samples[k].push(block());
  }
}
real = 0;
empty = 0;
shadowMap.render = origShadowRender;
lighting.refreshInterval[0] = 2;
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
    extraCpuMs: med(v.map((x) => x.extraCpuMs)),
  };
}

const per = (a, b, k) => +((out[b].medianMs - out[a].medianMs) / k).toFixed(2);
return {
  resolution: `${pipe.width}x${pipe.height}`,
  configs: out,
  nullControlMs: +Math.abs(out.k0a.medianMs - out.k0b.medianMs).toFixed(2),
  msPerExtraPass: {
    realRaster2: per('k0a', 'r2', 2),
    realRaster4: per('k0a', 'r4', 4),
    emptyPass2: per('k0a', 'e2', 2),
    emptyPass4: per('k0a', 'e4', 4),
  },
  note:
    'emptyPass is a 2048x2048 target switch and clear with ZERO draws in it. ' +
    'If it costs about what realRaster costs, the amplifier is pricing render ' +
    'passes, not the rasterisation inside them, and its 7.2 ms/raster is an ' +
    'artefact — the same command-buffer-boundary pathology that made GPU timer ' +
    'queries unusable on ANGLE Metal.',
};
