/**
 * a12_ladder.js — additive pass ladder, all at NATIVE, no resizes.
 *
 * Instrument history, because two attempts died before this one:
 *  - a12_gpu.js: EXT_disjoint_timer_query on ANGLE Metal bills each query a
 *    command-buffer boundary — 317 ms of "GPU" in a 24 ms frame. Unusable.
 *  - a12_groups/a12_scene: mixing setRenderScale with skipped blits made
 *    sceneOnly SLOWER at 0.55 than at 1.0. Cause: the resize reallocates the
 *    volumetric history target, the in-scene volumetric composite quad then
 *    samples UNINITIALIZED half-float memory (NaN-dense) with premultiplied
 *    blending, and with the vol blits skipped it is never rewritten. NaN
 *    sampling+blending on a fullscreen quad wrecks the raster. The one slot
 *    that ran without a preceding resize read 4.87 ms and was the only honest
 *    number in the run.
 *
 * So: NOTHING here resizes. Every target is pre-warmed with full frames before
 * measurement, so a skipped pass leaves stale-but-VALID content. Passes are
 * added one at a time on top of a scene-only base; each rung's marginal cost is
 * rung minus its stated base, and the rungs sum to the full frame or the
 * residue is reported.
 *
 * Extra instruments:
 *  - elision check: AO pass with its output consumed by the present copy vs
 *    not consumed at all. If ANGLE elides unconsumed offscreen passes, these
 *    two differ and every "unconsumed" rung is a lie. (a12_unflagged's
 *    noUnflagged config argued they do not differ; here it is explicit.)
 *  - dummyN: N extra fullscreen half-float copies bounced between the unused
 *    TAA targets. The slope per copy is the raw per-pass floor at native —
 *    render-pass boundary + 2 MP RGBA16F read + write — which is the number
 *    the "fuse the composite and present" argument depends on.
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
const present = { mode: 'real', src: null }; // 'real' | 'copy'
const dummy = { n: 0 };
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
  if (material === pipe.fxaaMat) {
    // Dummy fullscreen copies, bounced between the unused TAA targets.
    let src = pipe.hdr.texture;
    for (let i = 0; i < dummy.n; i++) {
      const dst = i % 2 === 0 ? pipe.taaA : pipe.taaB;
      copyMat.uniforms.tDiffuse.value = src;
      origPipeBlit.call(this, copyMat, dst);
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

const E = pipe.enabled;
const S = pipe.bloomStages;
function full() {
  skip.clear();
  present.mode = 'real';
  dummy.n = 0;
  E.ssao = true; E.microAO = true; E.contactShadows = true;
  E.bloom = true; E.taa = false; E.fxaa = true; E.aerial = true;
  E.dof = true; E.motionBlur = true; E.autoExposure = true;
  S.blur = true; S.upsample = true; S.streak = true;
  S.compositeFetch = true; S.compositeAdd = true;
}
function sceneBase() {
  full();
  E.ssao = false; E.bloom = false; E.dof = false; E.motionBlur = false;
  skip.add(pipe.prepMat); skip.add(pipe.lumMat); skip.add(pipe.downMat);
  skip.add(pipe.adaptMat); skip.add(pipe.compositeMat);
  present.mode = 'copy';
  present.src = () => pipe.hdr.texture;
  if (vol) { skip.add(vol.depthMat); skip.add(vol.volMat); skip.add(vol.resolveMat); }
}
function prepBase() {
  sceneBase();
  skip.delete(pipe.prepMat);
  present.src = () => pipe.prepRT.texture;
}

const CONFIGS = {
  scene: () => sceneBase(),
  sceneCtrl: () => sceneBase(),                       // null control
  aoUnconsumed: () => { sceneBase(); E.ssao = true; },
  aoConsumed: () => { sceneBase(); E.ssao = true; present.src = () => pipe.aoRT.texture; },
  dummy6: () => { sceneBase(); dummy.n = 6; },
  dummy12: () => { sceneBase(); dummy.n = 12; },
  volOn: () => { sceneBase(); if (vol) { skip.delete(vol.depthMat); skip.delete(vol.volMat); skip.delete(vol.resolveMat); } },
  prep: () => prepBase(),
  lum: () => { prepBase(); skip.delete(pipe.lumMat); skip.delete(pipe.downMat); skip.delete(pipe.adaptMat); present.src = () => pipe.adaptB.texture; },
  dof: () => { prepBase(); E.dof = true; E.motionBlur = true; present.src = () => pipe.dofRT.texture; },
  bloom: () => { prepBase(); E.bloom = true; present.src = () => pipe.bloomRTs[0].a.texture; },
  compositePresent: () => { prepBase(); skip.delete(pipe.compositeMat); present.mode = 'real'; },
  full: () => full(),
  fullCtrl: () => full(),                             // second null control
};

eng.deterministic = true;
eng.stop();
full();
block(); // settle: every target written with real content; copyMat compiles below
sceneBase();
block();

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
  const floorA = Math.abs(+(out.scene.ms - out.sceneCtrl.ms).toFixed(2));
  const floorB = Math.abs(+(out.full.ms - out.fullCtrl.ms).toFixed(2));

  const d = (a, b) => +(out[a].ms - out[b].ms).toFixed(2);
  const marginal = {
    ao: d('aoUnconsumed', 'scene'),
    aoElisionCheck: d('aoConsumed', 'aoUnconsumed'),
    vol: d('volOn', 'scene'),
    prep: d('prep', 'scene'),
    lumChain: d('lum', 'prep'),
    dofPass: d('dof', 'prep'),
    bloomAll: d('bloom', 'prep'),
    compositePlusRealPresent: d('compositePresent', 'prep'),
    perDummyBlit: +((out.dummy12.ms - out.scene.ms) / 12).toFixed(3),
    perDummyBlitAlt: +((out.dummy6.ms - out.scene.ms) / 6).toFixed(3),
  };
  const ladderSum = +(
    out.scene.ms + marginal.ao + marginal.vol + marginal.prep + marginal.lumChain +
    marginal.dofPass + marginal.bloomAll + marginal.compositePlusRealPresent
  ).toFixed(2);

  result = {
    resolution: `${pipe.width}x${pipe.height}`,
    nullControls: { sceneMs: floorA, fullMs: floorB },
    configs: out,
    marginalMs: marginal,
    ladder: {
      sceneMs: out.scene.ms,
      sumOfRungsMs: ladderSum,
      fullMs: out.full.ms,
      residueMs: +(out.full.ms - ladderSum).toFixed(2),
      note: 'residue is interaction/overlap cost the ladder cannot see. compositePlusRealPresent includes swapping the cheap present back for the real FXAA blit.',
    },
  };
} finally {
  pipe._blit = origPipeBlit;
  if (vol && origVolBlit) vol._blit = origVolBlit;
  full();
}
return result;
