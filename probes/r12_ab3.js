/**
 * r12_ab3.js — mini-block interleaved A/B. Third instrument; the first two are
 * both retracted below, and the reason each died is worth more than the numbers
 * either produced.
 *
 * 1. BLOCK-PAIRED (r12_attrib, r12_terrcost). Killed by a co-tenant. The same
 *    base configuration read 29 / 50 / 29 ms across nine reps of one run, and
 *    `shot.mjs status` said "quiet" on both sides of it. No pairing survives a
 *    disturbance whose period is longer than a block.
 *
 * 2. FRAME-INTERLEAVED WITH gl.finish PER FRAME (r12_ab, r12_ab2). Immune to
 *    the co-tenant, and DEAD: the positive control — four fewer ballast blits,
 *    independently priced at 0.34 ms each — read +0.2 ms against a +0.2 ms null
 *    control. A finish every frame destroys CPU/GPU overlap, so the span timed
 *    is command encoding with the GPU hidden underneath it, and 1.4 ms of extra
 *    GPU work changes nothing. Every "~0" in r12_ab.js is an artefact of this,
 *    including its headline "the whole terrain fragment body is free".
 *
 * So: alternate in MINI-BLOCKS of 10 frames with one finish per mini-block. Ten
 * frames is short enough that contention lands on both arms in proportion, and
 * long enough that the pipeline refills and the frame is throughput-bound again.
 * The first frame after a finish runs against an empty queue and is cheap — the
 * oldest trap in this project — but both arms pay it once per mini-block, so it
 * cancels in the difference and the null control bounds what is left.
 *
 * The positive control is not optional. Read it first; if ballastMinus4 is not
 * near +1.4 ms, nothing else in the table is a measurement.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();

const WARM = 64;
const M = 10;      // frames per mini-block
const ALT = 60;    // mini-blocks per arm-pair (30 samples each side)
const K = 24;

g.applyShot('gameplay');
eng.deterministic = true;
eng.stop();
pipe.enabled.dof = true;
pipe.enabled.motionBlur = true;

let U = null;
const B = {};
eng.scene.traverse((o) => {
  if (!o.isMesh) return;
  const n = o.name || '';
  if (/^terrain-L/.test(n) && o.material?.userData?.shader) U = o.material.userData.shader.uniforms;
  const k = /^terrain-L/.test(n) ? 'terrain'
    : /clast/i.test(n) ? 'clast'
    : /^rock/i.test(n) ? 'rock'
    : /^grass/.test(n) ? 'grass'
    : /scrub|bush|brush|tree|tumble/i.test(n) ? 'scrub'
    : /^char-/.test(n) ? 'char'
    : null;
  if (k) (B[k] ??= []).push(o);
});
const outpostRoot = eng.scene.getObjectByName('outpost');
const casters = [];
eng.scene.traverse((o) => { if (o.isMesh && o.castShadow) casters.push(o); });

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
let bal = K;
function ballast() {
  let src = pipe.hdr.texture;
  for (let i = 0; i < bal; i++) {
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

function reset() {
  bal = K;
  if (U) U.uPerf.value.set(0, 0, 0, 0);
  for (const l of Object.values(B)) for (const o of l) o.visible = true;
  if (outpostRoot) outpostRoot.visible = true;
  for (const o of casters) o.castShadow = true;
  renderer.shadowMap.autoUpdate = true;
}
const hide = (k) => { for (const o of (B[k] ?? [])) o.visible = false; };

const ARMS = {
  nullB:           () => {},
  ballastMinus4:   () => { bal = K - 4; },
  ballastZero:     () => { bal = 0; },
  ballastHalf:     () => { bal = 12; },
  ballastDouble:   () => { bal = 48; },
  flatTerrain:     () => { if (U) U.uPerf.value.x = 1; },
  terrNoBedrock:   () => { if (U) U.uPerf.value.y = 1; },
  terrNoDetailNrm: () => { if (U) U.uPerf.value.z = 1; },
  terrNoNearField: () => { if (U) U.uPerf.value.w = 1; },
  noGrass:         () => hide('grass'),
  noScrub:         () => hide('scrub'),
  noClast:         () => hide('clast'),
  noRock:          () => hide('rock'),
  noChar:          () => hide('char'),
  noOutpost:       () => { if (outpostRoot) outpostRoot.visible = false; },
  noGroundClutter: () => { hide('grass'); hide('scrub'); hide('clast'); hide('rock'); },
  shadowFrozen:    () => { renderer.shadowMap.autoUpdate = false; },
  noCastersAtAll:  () => { for (const o of casters) o.castShadow = false; },
};

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
function run(applyB) {
  reset();
  for (let i = 0; i < WARM; i++) { reset(); if (i & 1) applyB(); step(); }
  gl.finish();
  const A = [], Bs = [];
  for (let m = 0; m < ALT; m++) {
    // ABBA, not ABAB. In ABAB the B arm read cheaper than A whatever B was —
    // including when B was doing TWICE the ballast work — so there is a
    // position bias of ~0.5-3 ms attached to being second after the finish.
    // ABBA gives each arm both positions equally and cancels it, along with any
    // drift that is linear over four mini-blocks.
    const b = ((m >> 1) & 1) !== (m & 1);
    reset(); if (b) applyB();
    const t0 = performance.now();
    for (let i = 0; i < M; i++) step();
    gl.finish();
    (b ? Bs : A).push((performance.now() - t0) / M);
  }
  reset();
  const r = (x) => +x.toFixed(3);
  return {
    savingMedMs: r(pct(A, 0.50) - pct(Bs, 0.50)),
    savingP25Ms: r(pct(A, 0.25) - pct(Bs, 0.25)),
    aMed: r(pct(A, 0.50)), bMed: r(pct(Bs, 0.50)),
    aP90: r(pct(A, 0.90)), bP90: r(pct(Bs, 0.90)),
    n: A.length,
  };
}

const only = (typeof ARGS !== 'undefined' && ARGS && ARGS.length) ? new Set(ARGS) : null;
const out = {};
for (const [k, apply] of Object.entries(ARMS)) {
  if (only && !only.has(k)) continue;
  out[k] = run(apply);
}
reset();
return {
  framePx: `${renderer.domElement.width}x${renderer.domElement.height}`,
  casterMeshes: casters.length,
  note: 'READ ballastMinus4 FIRST: must be ~+1.4 ms or the table is not a measurement.',
  results: out,
};
