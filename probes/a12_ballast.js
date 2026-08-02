/**
 * a12_ballast.js — per-pass marginal costs at PINNED GPU clocks.
 *
 * a12_ladder.js exposed the third broken instrument of this audit: the M3 Pro
 * downclocks under light GPU load, so a scene-only block read 4.7 ms right
 * after a heavy config and 16.1 ms right after a light one, and 6 extra
 * fullscreen blits cost nothing. Wall-clock on a light config measures the
 * GPU's power governor, not the work. (This also explains a12_unflagged: every
 * single-pass skip left the frame heavy, clocks stayed up, and the deltas were
 * honest but small; the moment whole groups were removed the numbers went
 * bimodal.)
 *
 * Fix: every config carries BALLAST — K extra fullscreen ALU-loop blits
 * bounced between the unused TAA targets, injected just before the present
 * blit — so every block presents a similar total GPU load and the clock state
 * cancels in differences. The ballast's own cost is measured in-run from two
 * ballast levels (B16 vs B24 slope), and a null control plus a repeated base
 * config at a different rotation slot bound what the instrument charges for
 * nothing.
 *
 * All at native. No resizes (see a12_scene.js NaN trap). All targets warmed
 * by full frames first, so skipped passes leave stale-but-valid content.
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
const K = 24; // standard ballast level

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
const ballast = { n: K };

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

const E = pipe.enabled;
const S = pipe.bloomStages;
function full(bal = K) {
  skip.clear();
  present.mode = 'real';
  ballast.n = bal;
  E.ssao = true; E.microAO = true; E.contactShadows = true;
  E.bloom = true; E.taa = false; E.fxaa = true; E.aerial = true;
  E.dof = true; E.motionBlur = true; E.autoExposure = true;
  S.blur = true; S.upsample = true; S.streak = true;
  S.compositeFetch = true; S.compositeAdd = true;
}
function sceneBase(bal = K) {
  full(bal);
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
  base24: () => sceneBase(24),
  base24ctrl: () => sceneBase(24),
  base16: () => sceneBase(16),
  ao: () => { sceneBase(); E.ssao = true; },
  volp: () => { sceneBase(); if (vol) { skip.delete(vol.depthMat); skip.delete(vol.volMat); skip.delete(vol.resolveMat); } },
  volDepthOnly: () => { sceneBase(); if (vol) skip.delete(vol.depthMat); },
  prep: () => prepBase(),
  lum: () => { prepBase(); skip.delete(pipe.lumMat); skip.delete(pipe.downMat); skip.delete(pipe.adaptMat); present.src = () => pipe.adaptB.texture; },
  dofp: () => { prepBase(); E.dof = true; E.motionBlur = true; present.src = () => pipe.dofRT.texture; },
  bloomp: () => { prepBase(); E.bloom = true; present.src = () => pipe.bloomRTs[0].a.texture; },
  presentReal: () => { prepBase(); present.mode = 'real'; },   // composite still skipped: prices the FXAA blit vs the copy blit
  compositeReal: () => { prepBase(); skip.delete(pipe.compositeMat); present.mode = 'real'; },
  base24late: () => sceneBase(24),                             // rotation-slot check
  fullB: () => full(24),
  fullBctrl: () => full(24),
  fullNoBallast: () => full(0),
};

eng.deterministic = true;
eng.stop();
full(0);
block(); // warm every target with real content
sceneBase(24);
block(); // compile copy + ballast shaders, settle

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
  const perBallast = +((out.base24.ms - out.base16.ms) / 8).toFixed(3);

  const marginal = {
    ao: d('ao', 'base24'),
    volAll3Blits: d('volp', 'base24'),
    volDepthLinOnly: d('volDepthOnly', 'base24'),
    prep: d('prep', 'base24'),
    lumChain: d('lum', 'prep'),
    dofPass: d('dofp', 'prep'),
    bloomAll: d('bloomp', 'prep'),
    fxaaVsCopyPresent: d('presentReal', 'prep'),
    compositePass: d('compositeReal', 'presentReal'),
  };
  const sum = +(marginal.ao + marginal.volAll3Blits + marginal.prep + marginal.lumChain +
    marginal.dofPass + marginal.bloomAll + marginal.fxaaVsCopyPresent + marginal.compositePass).toFixed(2);

  result = {
    resolution: `${pipe.width}x${pipe.height}`,
    controls: {
      nullControlMs: Math.abs(d('base24', 'base24ctrl')),
      rotationSlotMs: Math.abs(d('base24', 'base24late')),
      fullNullMs: Math.abs(d('fullB', 'fullBctrl')),
      perBallastBlitMs: perBallast,
      clockSanity: 'base16 must be BELOW base24 by ~8x perBallastBlit; if not, clocks are still moving and nothing here is real',
    },
    configs: out,
    marginalMs: marginal,
    accounting: {
      scenePlusPresentMs: +(out.base24.ms - 24 * perBallast).toFixed(2),
      sumOfMarginalsMs: sum,
      fullWithBallastMs: out.fullB.ms,
      fullPredictedMs: +(out.base24.ms + sum).toFixed(2),
      fullNoBallastMs: out.fullNoBallast.ms,
      note: 'fullPredicted = base24 + sum of marginals; compare against fullB. fullNoBallast ties this session to r11_fill’s 26.44.',
    },
  };
} finally {
  pipe._blit = origPipeBlit;
  if (vol && origVolBlit) vol._blit = origVolBlit;
  full(0);
}
return result;
