/**
 * a12_groups.js — decompose the 18.7 ms per-pixel half by GROUP, in one session.
 *
 * a12_unflagged.js showed no single unflagged pass is worth more than ~1.5 ms —
 * the "~12 ms is in the unflagged passes" belief cannot be right as stated. The
 * remaining suspect is the scene render's own per-pixel shading, which r11
 * dismissed on the grounds that "the whole scene is only 6.8-8.8 ms" without
 * asking how much of THAT scales with pixels.
 *
 * Groups, all reached through the same _blit patch + flags:
 *   sceneOnly   = scene render + cheap present, nothing else. Run at scale 1.0
 *                 and 0.55, its slope IS the scene's per-pixel shading cost.
 *   full        = shipping config, also at both scales (replicates r11_fill
 *                 inside this session so the slopes subtract cleanly).
 *   noUnflagged = full minus {prep, lum chain, composite, vol depth linearise},
 *                 present cheapened: the unflagged group's total price.
 *   noFlagged   = full minus every flaggable module (AO, bloom, dof/mb, vol
 *                 march+resolve): the flagged group's total price.
 *
 * Cross-check: (full - sceneOnly) should equal noUnflagged-delta +
 * noFlagged-delta within the control floor, and the slopes should reproduce
 * r11_fill's 18.7 ms/pixel-fraction.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();
const vol = g.world?.registry?.volumetrics?.pass ?? null;

const WARM = 64;
const N = 40;
const REPS = 5;

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
const mkCopy = () => new (Object.getPrototypeOf(pipe.prepMat).constructor)({
  vertexShader: 'varying vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv;\nvoid main(){ gl_FragColor = texture2D(tDiffuse, vUv); }',
  uniforms: { tDiffuse: { value: null } },
  depthTest: false,
  depthWrite: false,
});
const copyMat = mkCopy();

const origPipeBlit = pipe._blit;
pipe._blit = function (material, target) {
  if (skip.has(material)) return;
  if (cheapPresent.on && material === pipe.fxaaMat) {
    copyMat.uniforms.tDiffuse.value = pipe.compositeRT.texture;
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
  full55: () => base(0.55),
  sceneOnly: () => sceneOnly(1.0),
  sceneOnly55: () => sceneOnly(0.55),
  noUnflagged: () => {
    base(1.0);
    skip.add(pipe.prepMat); skip.add(pipe.lumMat); skip.add(pipe.downMat);
    skip.add(pipe.adaptMat); skip.add(pipe.compositeMat);
    cheapPresent.on = true;
    if (vol) skip.add(vol.depthMat);
  },
  noFlagged: () => {
    base(1.0);
    E.ssao = false; E.bloom = false; E.dof = false; E.motionBlur = false;
    if (vol) { skip.add(vol.volMat); skip.add(vol.resolveMat); }
  },
};

eng.deterministic = true;
eng.stop();
base(1.0);
block(); // settle

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

  const pf = 1 - 0.55 * 0.55; // pixel-fraction span of the two scales
  const fullSlope = +((out.full.ms - out.full55.ms) / pf).toFixed(2);
  const sceneSlope = +((out.sceneOnly.ms - out.sceneOnly55.ms) / pf).toFixed(2);

  result = {
    resolution1x: '1920x1080',
    nullControlMs: floor,
    configs: out,
    groups: {
      unflaggedGroupMs: +(out.full.ms - out.noUnflagged.ms).toFixed(2),
      flaggedGroupMs: +(out.full.ms - out.noFlagged.ms).toFixed(2),
      allPostMs: +(out.full.ms - out.sceneOnly.ms).toFixed(2),
      crossCheck: 'allPost should ~= unflagged + flagged within the floor',
    },
    slopes: {
      fullPerPixelMs: fullSlope,
      sceneOnlyPerPixelMs: sceneSlope,
      postPerPixelMs: +(fullSlope - sceneSlope).toFixed(2),
      note: 'per full-frame-worth of pixels; fullPerPixelMs should reproduce r11_fill’s 18.7',
    },
  };
} finally {
  pipe._blit = origPipeBlit;
  if (vol && origVolBlit) vol._blit = origVolBlit;
  base(1.0);
}
return result;
