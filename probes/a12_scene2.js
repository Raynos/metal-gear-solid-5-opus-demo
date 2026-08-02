/**
 * a12_scene2.js — decompose the ~15 ms SCENE render found by a12_ballast.js.
 *
 * a12_ballast established, with pinned clocks (24-blit ballast, slope 0.34
 * ms/blit verified in two contexts) and a 0.5 ms null control:
 *   scene+present ~15 ms, AO 2.9, vol blits 1.9, dof+mb ~3.3, bloom 1.7,
 *   composite 0.7, prep/lum/present-shader all ~0.
 * The "~12 ms in the unflagged passes" belief in TODO.md section 1 is dead:
 * the unattributed time is the SCENE pass itself, which r11 booked at
 * "6.8-8.8 ms" using an instrument that this audit has shown reads light
 * configs at whatever the GPU governor feels like.
 *
 * This probe splits the scene: shadow-cascade re-raster (autoUpdate=false),
 * the volumetric module's IN-SCENE cost (composite quad + particles, via
 * registry.volumetrics.setEnabled(false)), and the per-pixel vs fixed split of
 * what remains (scale sweep at 0.55 with ballast slope re-measured at that
 * scale, since the ballast targets resize too).
 *
 * Every config application clears every offscreen target it might leave
 * stale, because a resize reallocates them and sampling uninitialized
 * half-float memory poisons the raster (a12_scene.js). Clear cost is once per
 * block and absorbed by WARM.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();
const volReg = g.world?.registry?.volumetrics ?? null;
const vol = volReg?.pass ?? null;

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

const SM = Object.getPrototypeOf(pipe.prepMat).constructor;
const VERT = 'varying vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const copyMat = new SM({
  vertexShader: VERT,
  fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv;\nvoid main(){ gl_FragColor = texture2D(tDiffuse, vUv); }',
  uniforms: { tDiffuse: { value: null } },
  depthTest: false, depthWrite: false,
});
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

const skip = new Set();
const present = { mode: 'copy', src: () => pipe.hdr.texture };
const ballast = { n: 24 };

const origPipeBlit = pipe._blit;
pipe._blit = function (material, target) {
  if (skip.has(material)) return;
  if (material === pipe.fxaaMat) {
    let src = pipe.hdr.texture;
    for (let i = 0; i < ballast.n; i++) {
      const dst = i % 2 === 0 ? pipe.taaA : pipe.taaB;
      ballastMat.uniforms.tDiffuse.value = src;
      origPipeBlit.call(this, ballastMat, dst);
      src = dst.texture;
    }
    if (present.mode === 'copy') {
      copyMat.uniforms.tDiffuse.value = present.src();
      return origPipeBlit.call(this, copyMat, target);
    }
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

function clearAll() {
  const prev = renderer.getRenderTarget();
  const rts = [
    pipe.prepRT, pipe.taaA, pipe.taaB, pipe.dofRT, pipe.compositeRT,
    pipe.aoRT, pipe.aoBlurRT, pipe.streakA, pipe.streakB,
    ...pipe.lumRTs, pipe.adaptA, pipe.adaptB,
    ...pipe.bloomRTs.flatMap((r) => [r.a, r.b]),
  ];
  if (vol) rts.push(vol.depthRT, vol.volRT, vol.histRT0, vol.histRT1);
  for (const rt of rts) {
    if (!rt) continue;
    renderer.setRenderTarget(rt);
    renderer.clear(true, false, false);
  }
  renderer.setRenderTarget(prev);
}

const E = pipe.enabled;
const S = pipe.bloomStages;
function full(bal = 24) {
  skip.clear();
  present.mode = 'real';
  ballast.n = bal;
  renderer.shadowMap.autoUpdate = true;
  if (volReg) volReg.setEnabled(true);
  E.ssao = true; E.microAO = true; E.contactShadows = true;
  E.bloom = true; E.taa = false; E.fxaa = true; E.aerial = true;
  E.dof = true; E.motionBlur = true; E.autoExposure = true;
  S.blur = true; S.upsample = true; S.streak = true;
  S.compositeFetch = true; S.compositeAdd = true;
  pipe.setRenderScale(1.0);
  clearAll();
}
function sceneBase(bal = 24, scale = 1.0) {
  full(bal);
  E.ssao = false; E.bloom = false; E.dof = false; E.motionBlur = false;
  skip.add(pipe.prepMat); skip.add(pipe.lumMat); skip.add(pipe.downMat);
  skip.add(pipe.adaptMat); skip.add(pipe.compositeMat);
  present.mode = 'copy';
  present.src = () => pipe.hdr.texture;
  if (vol) { skip.add(vol.depthMat); skip.add(vol.volMat); skip.add(vol.resolveMat); }
  pipe.setRenderScale(scale);
  clearAll();
}

const CONFIGS = {
  b24: () => sceneBase(24),
  b24ctrl: () => sceneBase(24),
  shadowFrozen: () => { sceneBase(24); renderer.shadowMap.autoUpdate = false; },
  volModOff: () => { sceneBase(24); if (volReg) volReg.setEnabled(false); },
  s55b24: () => { sceneBase(24, 0.55); if (volReg) volReg.setEnabled(false); },
  s55b16: () => { sceneBase(16, 0.55); if (volReg) volReg.setEnabled(false); },
  fullB: () => full(24),
  fullBnoDofMb: () => { full(24); E.dof = false; E.motionBlur = false; },
  fullNoBallast: () => full(0),
};

eng.deterministic = true;
eng.stop();
full(0);
block(); // warm all targets
sceneBase(24);
block(); // compile probe shaders, settle

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
  const d = (a, b) => +(out[a].ms - out[b].ms).toFixed(2);
  const perBallast55 = +((out.s55b24.ms - out.s55b16.ms) / 8).toFixed(3);
  const perBallast = 0.34; // a12_ballast, verified in two contexts this session band
  const scene100 = +(out.volModOff.ms - 24 * perBallast).toFixed(2);
  const scene55 = +(out.s55b24.ms - 24 * perBallast55).toFixed(2);
  const pf = 1 - 0.55 * 0.55;

  result = {
    resolution1x: '1920x1080',
    controls: {
      nullControlMs: Math.abs(d('b24', 'b24ctrl')),
      perBallastBlit55Ms: perBallast55,
      perBallastBlitAssumed1x: perBallast,
    },
    configs: out,
    derived: {
      cascadeRasterMs: d('b24', 'shadowFrozen'),
      inSceneVolCostMs: d('b24', 'volModOff'),
      dofMbInFullMs: d('fullB', 'fullBnoDofMb'),
      sceneNoVol_1x_Ms: scene100,
      sceneNoVol_055_Ms: scene55,
      scenePerPixelMs: +((scene100 - scene55) / pf).toFixed(2),
      sceneFixedMs: +(scene100 - (scene100 - scene55) / pf).toFixed(2),
      fullNoBallastMs: out.fullNoBallast.ms,
    },
  };
} finally {
  pipe._blit = origPipeBlit;
  if (vol && origVolBlit) vol._blit = origVolBlit;
  full(0);
}
return result;
