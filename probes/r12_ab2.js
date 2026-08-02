/**
 * r12_ab2.js — frame-interleaved A/B over the world systems, with a POSITIVE
 * CONTROL of known size.
 *
 * r12_ab.js reported ~0.1-0.3 ms for every terrain-shader ablation including
 * "skip the entire 1200-line fragment body". That is either a real and very
 * useful negative result or a dead instrument, and there is no way to tell them
 * apart from a null control alone — a null control only proves the instrument
 * reads zero for nothing, not that it can read anything at all. So arm
 * `ballastMinus4` removes four of the 24 ballast blits, whose cost was measured
 * independently at 0.34 ms each (a12_ballast.js), and the probe has to report
 * about +1.4 ms or nothing else in the table can be believed.
 *
 * Everything switched here is switchable per frame without a recompile: a
 * uniform write, `visible`, `castShadow`, or a ballast count. Nothing that
 * reallocates a target or rebuilds a program may be measured this way.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();

const WARM = 64;
const FRAMES = 600;
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
    : /talus|apron/i.test(n) ? 'talus'
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
  nullB:          () => {},
  ballastMinus4:  () => { bal = K - 4; },
  flatTerrain:    () => { if (U) U.uPerf.value.x = 1; },
  noGrass:        () => hide('grass'),
  noScrub:        () => hide('scrub'),
  noClast:        () => hide('clast'),
  noRock:         () => hide('rock'),
  noChar:         () => hide('char'),
  noOutpost:      () => { if (outpostRoot) outpostRoot.visible = false; },
  noGroundClutter:() => { hide('grass'); hide('scrub'); hide('clast'); hide('rock'); },
  shadowFrozen:   () => { renderer.shadowMap.autoUpdate = false; },
  noCastersAtAll: () => { for (const o of casters) o.castShadow = false; },
};

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
function run(applyB) {
  reset();
  for (let i = 0; i < WARM; i++) { reset(); if (i & 1) applyB(); step(); }
  gl.finish();
  const A = [], Bs = [];
  for (let i = 0; i < FRAMES; i++) {
    const b = (i & 1) === 1;
    reset(); if (b) applyB();
    const t0 = performance.now();
    step();
    gl.finish();
    (b ? Bs : A).push(performance.now() - t0);
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

const out = {};
for (const [k, apply] of Object.entries(ARMS)) out[k] = run(apply);
reset();
return {
  framePx: `${renderer.domElement.width}x${renderer.domElement.height}`,
  casterMeshes: casters.length,
  note: 'positive control ballastMinus4 must read ~+1.4 ms (0.34 ms/blit, a12_ballast). nullB is the floor.',
  results: out,
};
