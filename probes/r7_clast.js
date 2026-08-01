// TASK 4 acceptance: do small rocks separate from the sand, and do they cast a
// contact shadow?
//
// The round-6 probe compared every pixel an ablation moved by >= 8 codes, and on
// a family whose bodies are 2-6 px across that population is almost entirely
// ANTIALIASED EDGE — a blend of rock and the ground behind it, which by
// construction measures close to the ground. That is why three rounds of value
// work kept coming back at "ratio 1.00". This one keeps only pixels the ablation
// moved hard (>= 20 codes), which is the body of a clast rather than its rim,
// and reports the population size so the reader can see whether the number is
// worth anything.
g.setFreeFly(false);
const engine = g.engine, scene = engine.scene, renderer = engine.renderer;
const gl = renderer.getContext();
engine.pipeline.enabled.autoExposure = false;
const W = engine.pipeline.width, H = engine.pipeline.height;

function grab() {
  g.settle(6);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}
const lum = (p, i) => (0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]) / 255;

function cmp(A, B, S, TH) {
  const n = W * H;
  let c = 0, sa = 0, sb = 0, ra = 0, ba = 0, rb = 0, bb = 0, cooler = 0, darker = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (S && Math.max(Math.abs(A[o] - S[o]), Math.abs(A[o + 1] - S[o + 1]), Math.abs(A[o + 2] - S[o + 2])) > 2) continue;
    const d = Math.max(Math.abs(A[o] - B[o]), Math.abs(A[o + 1] - B[o + 1]), Math.abs(A[o + 2] - B[o + 2]));
    if (d < TH) continue;
    c++;
    const la = lum(A, o), lb = lum(B, o);
    sa += la; sb += lb;
    if (la < lb) darker++;
    ra += A[o]; ba += A[o + 2]; rb += B[o]; bb += B[o + 2];
    if (A[o] * B[o + 2] < B[o] * A[o + 2]) cooler++;
  }
  if (!c) return { px: 0 };
  return {
    px: c,
    obj: +(sa / c).toFixed(4), gnd: +(sb / c).toFixed(4),
    ratio: +(sa / sb).toFixed(3), stops: +Math.log2(sa / sb).toFixed(2),
    objRB: +(ra / ba).toFixed(3), gndRB: +(rb / bb).toFixed(3),
    warmerPct: +(100 - (cooler / c) * 100).toFixed(0),
    darkerPct: +((darker / c) * 100).toFixed(0),
  };
}

const rocks = g.world.registry.rocks;
const SMALL = ['chips', 'stones', 'talus'];
const small = (rocks.meshes ?? []).filter((m) => SMALL.some((f) => m.name.includes('rock_' + f)));
const casters = small.filter((m) => m.castShadow);

const out = { smallMeshes: small.length, shadowCasters: casters.length };
for (const shot of ['outpost', 'ground', 'gameplay', 'vista']) {
  g.applyShot(shot);
  const A = grab();
  const S = grab();                            // stability mask
  const prev = small.map((m) => m.visible);
  small.forEach((m) => (m.visible = false));
  const off = grab();
  small.forEach((m, i) => (m.visible = prev[i]));
  casters.forEach((m) => (m.castShadow = false));
  const noSh = grab();
  casters.forEach((m) => (m.castShadow = true));
  out[shot] = {
    body: cmp(A, off, S, 20),
    edgeAndBody: cmp(A, off, S, 8),
    contactShadow: cmp(A, noSh, S, 6),
  };
}
return out;
