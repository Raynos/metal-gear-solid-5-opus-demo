/**
 * r12_volres.js — what does the volumetric march cost at half vs quarter res?
 *
 *   node tools/shot.mjs eval probes/r12_volres.js [shot]
 *
 * PAIRED, in one page. `VolumetricPass.setMarchDiv` swaps between two sets of
 * march targets that are both allocated up front, so switching resolution
 * costs three uniform writes and a history reset rather than a reallocation —
 * which is the only reason this can be measured at all. Reallocating a
 * half-float target mid-run stalls harder than the effect (r12_frame.js), and
 * comparing two builds on this machine means comparing across an hour of
 * another author's load: the same configuration measured 25 ms and 49 ms today.
 *
 * Every difference below is a PAIRED difference — config A and config B in the
 * same rep, differenced, then the median over reps. Differencing medians (what
 * every earlier probe here did) throws away the pairing and lets slow drift in
 * as noise; a paired difference is immune to any drift slower than one rep.
 *
 * `half_a` / `half_b` are the same configuration twice: the null control.
 * The sign test is the honest summary — with 8 reps, an effect that is real
 * shows up in nearly every rep, and one that is not shows up in about half.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();
const vol = g.world?.registry?.volumetrics?.pass ?? null;
if (!vol) return { error: 'no volumetric pass' };

const WARM = 48;
const N = 32;
const REPS = 8;
const K = 6;

const shot = (typeof ARGS !== 'undefined' && ARGS && ARGS[0]) || 'vista';
const s = g.applyShot(shot);
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
const look = s.target;
let t = 0;

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
  cam.lookAt(look[0], look[1], look[2]);
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

// `noVol` is the POSITIVE CONTROL: the whole pass skipped. The round-11 audit
// prices its blits at 1.5-1.9 ms plus 0.6 for the in-scene quad. If the
// instrument cannot see THAT, a 0.8 ms resolution change means nothing.
const origBlit = vol._blit.bind(vol);
let skipVol = false;
vol._blit = function (material, target) {
  if (skipVol && material !== vol.depthMat) return;
  return origBlit(material, target);
};

const CONFIGS = ['half_a', 'quarter', 'half_b', 'noVol'];
function apply(k) {
  skipVol = k === 'noVol';
  vol.setMarchDiv(k === 'quarter' ? 4 : 2);
}

// Allocate BOTH target sets and compile everything before any timing starts.
for (const k of CONFIGS) {
  apply(k);
  block();
}

const samples = { half_a: [], quarter: [], half_b: [], noVol: [] };
for (let r = 0; r < REPS; r++) {
  for (const k of CONFIGS) {
    apply(k);
    samples[k].push(block());
  }
}
skipVol = false;
vol._blit = origBlit;
vol.setMarchDiv(2);

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
function paired(a, b) {
  const d = samples[a].map((v, i) => +(v - samples[b][i]).toFixed(2));
  const pos = d.filter((x) => x > 0).length;
  return { medianMs: med(d), perRep: d, repsPositive: `${pos}/${d.length}` };
}

return {
  shot,
  framePx: `${renderer.domElement.width}x${renderer.domElement.height}`,
  marchPxHalf: '960x540',
  marchPxQuarter: '480x270',
  absolute: Object.fromEntries(
    Object.entries(samples).map(([k, v]) => [k, { medianMs: med(v), runs: v }]),
  ),
  savingOfQuarterMs: paired('half_a', 'quarter'),
  nullControlMs: paired('half_a', 'half_b'),
  positiveControlWholePassMs: paired('half_a', 'noVol'),
};
