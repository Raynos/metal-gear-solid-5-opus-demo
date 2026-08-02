/**
 * a12_scene.js — what the SCENE render actually costs, with the instrument
 * fixed after a12_groups.js produced an impossible negative slope.
 *
 * What was wrong in a12_groups: the cheapened present copied compositeRT,
 * which in sceneOnly configs is never written again — and after a
 * setRenderScale reallocation it is UNINITIALIZED memory. The presented image
 * did not depend on the frame's work (CLAUDE.md trap: unpresented work can
 * time at submission speed) and the copy sampled undefined half-float data.
 * sceneOnly read 2.67 ms at native and 16.59 ms at 0.55 scale, which is not a
 * measurement, it is a broken instrument.
 *
 * Here the cheap present samples pipe.hdr.texture — freshly rendered every
 * frame, so the canvas depends on the scene render and nothing reads
 * uninitialized memory. sceneOnly appears at three scales AND twice at native
 * in different rotation slots, so an order/thermal artifact shows up as the
 * two native slots disagreeing.
 *
 * shadowFrozen prices the cascade re-raster (autoUpdate=false keeps sampling
 * the last map, so only the shadow-map RENDER is removed).
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();
const vol = g.world?.registry?.volumetrics?.pass ?? null;

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

const skip = new Set();
const cheapPresent = { on: false };
const copyMat = new (Object.getPrototypeOf(pipe.prepMat).constructor)({
  vertexShader: 'varying vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv;\nvoid main(){ gl_FragColor = texture2D(tDiffuse, vUv); }',
  uniforms: { tDiffuse: { value: null } },
  depthTest: false,
  depthWrite: false,
});

const origPipeBlit = pipe._blit;
pipe._blit = function (material, target) {
  if (skip.has(material)) return;
  if (cheapPresent.on && material === pipe.fxaaMat) {
    copyMat.uniforms.tDiffuse.value = pipe.hdr.texture; // real dependency, fresh every frame
    return origPipeBlit.call(this, copyMat, target);
  }
  return origPipeBlit.call(this, material, target);
};
let origVolBlit = null;
if (vol) {
  origVolBlit = vol._blit;
  vol._blit = function (material, target) {
    if (skip.has(material)) return;
    return origVolBlit.call(this, material, target);
  };
}

const E = pipe.enabled;
const S = pipe.bloomStages;
function base(scale = 1.0) {
  skip.clear();
  cheapPresent.on = false;
  renderer.shadowMap.autoUpdate = true;
  E.ssao = true; E.microAO = true; E.contactShadows = true;
  E.bloom = true; E.taa = false; E.fxaa = true; E.aerial = true;
  E.dof = true; E.motionBlur = true; E.autoExposure = true;
  S.blur = true; S.upsample = true; S.streak = true;
  S.compositeFetch = true; S.compositeAdd = true;
  pipe.setRenderScale(scale);
}
function sceneOnly(scale) {
  base(scale);
  E.ssao = false; E.bloom = false; E.dof = false; E.motionBlur = false;
  skip.add(pipe.prepMat); skip.add(pipe.lumMat); skip.add(pipe.downMat);
  skip.add(pipe.adaptMat); skip.add(pipe.compositeMat);
  cheapPresent.on = true;
  if (vol) { skip.add(vol.depthMat); skip.add(vol.volMat); skip.add(vol.resolveMat); }
}

const CONFIGS = {
  full: () => base(1.0),
  control: () => base(1.0),
  sceneOnly10: () => sceneOnly(1.0),
  sceneOnly55: () => sceneOnly(0.55),
  sceneOnly10b: () => sceneOnly(1.0),
  sceneOnly70: () => sceneOnly(0.70),
  sceneFrozenShadow: () => { sceneOnly(1.0); renderer.shadowMap.autoUpdate = false; },
  full55: () => base(0.55),
};

eng.deterministic = true;
eng.stop();
base(1.0);
block(); // settle + compile copyMat

let result;
try {
  const samples = {};
  for (const k of Object.keys(CONFIGS)) samples[k] = [];
  for (let r = 0; r < REPS; r++) {
    for (const [k, apply] of Object.entries(CONFIGS)) {
      apply();
      samples[k].push(block());
    }
  }

  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const out = {};
  for (const [k, v] of Object.entries(samples)) {
    out[k] = { ms: med(v), runs: v, spread: +(Math.max(...v) - Math.min(...v)).toFixed(2) };
  }
  const floor = Math.abs(+(out.full.ms - out.control.ms).toFixed(2));

  const pf = (s) => s * s;
  const slope = +((out.sceneOnly10.ms - out.sceneOnly55.ms) / (1 - pf(0.55))).toFixed(2);
  result = {
    resolution1x: '1920x1080',
    nullControlMs: floor,
    configs: out,
    derived: {
      orderArtifactMs: +(out.sceneOnly10.ms - out.sceneOnly10b.ms).toFixed(2),
      fullSlopeMs: +((out.full.ms - out.full55.ms) / (1 - pf(0.55))).toFixed(2),
      sceneOnlySlopeMs: slope,
      sceneOnly70predicted: +(out.sceneOnly10.ms - slope * (1 - pf(0.7))).toFixed(2),
      shadowRasterMs: +(out.sceneOnly10.ms - out.sceneFrozenShadow.ms).toFixed(2),
      allPostAtNativeMs: +(out.full.ms - out.sceneOnly10.ms).toFixed(2),
    },
  };
} finally {
  pipe._blit = origPipeBlit;
  if (vol && origVolBlit) vol._blit = origVolBlit;
  base(1.0);
}
return result;
