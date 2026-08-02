/**
 * r12_attrib.js — price each world system inside the FULL play-mode frame by
 * hiding it, at pinned GPU clocks.
 *
 * Rules obeyed (TODO.md section 0): no ablation-flag flips, no target resizes,
 * WARM = 64, a null control (`base` measured twice at two rotation slots), and
 * constant ALU ballast (a12_ballast.js's trick) so the governor cannot clock one
 * config differently from another. Hiding a mesh is a `visible = false`, which
 * costs nothing to apply — it is not a shader recompile, so the 50 ms flag-flip
 * stall does not apply here.
 *
 * The delta for a hidden system is raster + shading + shadow-cast, i.e. what
 * deleting it would actually save. It is NOT what LODing it would save.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();

const WARM = 64, N = 40, REPS = 3, K = 24;

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
function block() {
  for (let i = 0; i < WARM; i++) step();
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) step();
  gl.finish();
  return +((performance.now() - t0) / N).toFixed(2);
}

// ---- classify every visible mesh once ----------------------------------
const buckets = {};
eng.scene.traverse((o) => {
  if (!o.isMesh) return;
  const n = o.name || '';
  const k = /^terrain/.test(n) ? 'terrain'
    : /talus|apron/i.test(n) ? 'talus'
    : /clast/i.test(n) ? 'clast'
    : /^rock/i.test(n) ? 'rock'
    : /^grass/.test(n) ? 'grass'
    : /scrub|bush|brush|tree|tumble/i.test(n) ? 'scrub'
    : /^char-/.test(n) ? 'char'
    : /^volumetric/.test(n) ? 'volq'
    : null;
  if (k) (buckets[k] ??= []).push(o);
  // the outpost is a subtree, not a name convention
});
const outpostRoot = eng.scene.getObjectByName('outpost');
const rockRoot = eng.scene.getObjectByName('rocks');

function show(list, v) { for (const o of list) o.visible = v; }
function restore() {
  for (const l of Object.values(buckets)) show(l, true);
  if (outpostRoot) outpostRoot.visible = true;
  if (rockRoot) rockRoot.visible = true;
  renderer.shadowMap.autoUpdate = true;
  for (const l of Object.values(buckets)) for (const o of l) if (o.userData.__oc !== undefined) { o.castShadow = o.userData.__oc; delete o.userData.__oc; }
  bal = K;
}
function noCast(names) {
  for (const nm of names) for (const o of (buckets[nm] ?? [])) {
    if (o.userData.__oc === undefined) o.userData.__oc = o.castShadow;
    o.castShadow = false;
  }
}

const CONFIGS = {
  base:        () => {},
  baseCtrl:    () => {},
  noGrass:     () => show(buckets.grass ?? [], false),
  noScrub:     () => show(buckets.scrub ?? [], false),
  noClast:     () => show(buckets.clast ?? [], false),
  noRock:      () => { show(buckets.rock ?? [], false); if (rockRoot) rockRoot.visible = false; },
  noOutpost:   () => { if (outpostRoot) outpostRoot.visible = false; },
  noChar:      () => show(buckets.char ?? [], false),
  noTerrain:   () => show(buckets.terrain ?? [], false),
  noVeg:       () => { show(buckets.grass ?? [], false); show(buckets.scrub ?? [], false); show(buckets.clast ?? [], false); },
  shadowFroz:  () => { renderer.shadowMap.autoUpdate = false; },
  castOffVeg:  () => noCast(['scrub', 'clast', 'rock']),
  bal16:       () => { bal = 16; },
  baseLate:    () => {},
};

block();  // compile the ballast shader + settle; discard
const samples = {};
for (const k of Object.keys(CONFIGS)) samples[k] = [];
try {
  for (let r = 0; r < REPS; r++) {
    for (const [k, apply] of Object.entries(CONFIGS)) {
      restore(); apply();
      samples[k].push(block());
    }
  }
} finally { restore(); }

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const out = {};
for (const [k, v] of Object.entries(samples)) out[k] = { ms: med(v), runs: v };
const d = (a) => +(out.base.ms - out[a].ms).toFixed(2);
return {
  counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
  controls: {
    nullControlMs: Math.abs(+(out.base.ms - out.baseCtrl.ms).toFixed(2)),
    rotationSlotMs: Math.abs(+(out.base.ms - out.baseLate.ms).toFixed(2)),
    perBallastBlitMs: +((out.base.ms - out.bal16.ms) / 8).toFixed(3),
  },
  baseMs: out.base.ms,
  savingMs: {
    grass: d('noGrass'), scrub: d('noScrub'), clast: d('noClast'), rock: d('noRock'),
    outpost: d('noOutpost'), char: d('noChar'), terrain: d('noTerrain'), allVeg: d('noVeg'),
    shadowCascadeRaster: d('shadowFroz'), castOffScrubClastRock: d('castOffVeg'),
  },
  configs: out,
};
