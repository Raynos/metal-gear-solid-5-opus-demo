/**
 * (i3) INTEGRATOR, round 7 — aerial perspective, on EVERY shot.
 *
 * d5-haze.js measures one shot (it reads a `SHOT_NAME` global that the eval
 * harness does not inject, so it always ran on the vista however it was
 * invoked, and the vista contains no geometry past 2.7 km — which is why the
 * 3-5 km acceptance band came back empty). Same ablation, same definitions,
 * looped over every shipped framing so the far ridges are actually in the data:
 *
 *   S = ablate.haze        -> bare surface, no extinction and no in-scatter
 *   B = ablate.apGain = 0  -> surface * Ts, extinction only
 *   opacity = 1 - mean(B)/mean(S) == 1 - Ts, exactly
 *
 * `ridgeOverSky` < 1 is the far ridge sitting DARKER than the sky above it,
 * and the acceptance shape is that it climbs toward 1 with distance — the
 * ridge converging on the sky FROM BELOW, not bleaching past it.
 */
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer, pipeline = engine.pipeline;
const pass = g.world.registry.volumetrics.pass;
const W = pipeline.width, H = pipeline.height;

const copyMat = new THREE.ShaderMaterial({
  uniforms: { t: { value: null } },
  vertexShader: 'varying vec2 v; void main(){ v = uv; gl_Position = vec4(position.xy*2.0, 0.0, 1.0); }',
  fragmentShader: 'uniform sampler2D t; varying vec2 v; void main(){ gl_FragColor = texture2D(t, v); }',
  depthTest: false, depthWrite: false,
});
const qs = new THREE.Scene(); qs.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), copyMat));
const qc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const fRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, colorSpace: THREE.NoColorSpace, depthBuffer: false });
const fbuf = new Float32Array(W * H * 4);
function grab(tex) {
  copyMat.uniforms.t.value = tex;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(fRT); renderer.render(qs, qc);
  renderer.readRenderTargetPixels(fRT, 0, 0, W, H, fbuf);
  renderer.setRenderTarget(prev);
  return fbuf.slice();
}
const at = (x, y) => ((H - 1 - y) * W + x) * 4;
function boxL(b, x0, yTop, x1, yBot) {
  let r = 0, g2 = 0, bl = 0, n = 0;
  for (let y = yTop; y < yBot; y++) for (let x = x0; x < x1; x++) {
    const i = at(x, y); r += b[i]; g2 += b[i + 1]; bl += b[i + 2]; n++;
  }
  return (0.2126 * r + 0.7152 * g2 + 0.0722 * bl) / n;
}

const out = { params: { ...pass.params }, shots: {} };
for (const shot of ['vista', 'ridge', 'outpost', 'dawn', 'ground', 'gameplay']) {
  g.applyShot(shot);
  pass.ablate.haze = false; pass.ablate.apGain = null;
  g.settle(12);
  const A = grab(pipeline.hdr.texture);
  const D = grab(pass.depthRT.texture);
  pass.ablate.apGain = 0; g.settle(12);
  const B = grab(pipeline.hdr.texture);
  pass.ablate.apGain = null; pass.ablate.haze = true; g.settle(12);
  const S = grab(pipeline.hdr.texture);
  pass.ablate.haze = false; g.settle(6);

  const cam = engine.camera, far = cam.far;
  const fwd = new THREE.Vector3(); cam.getWorldDirection(fwd);
  const invVP = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
  const rayFor = (x, y) => new THREE.Vector3((x / W) * 2 - 1, 1 - (y / H) * 2, 1)
    .applyMatrix4(invVP).sub(cam.position).normalize();
  const isSky = (x, y) => D[at(x, y)] > far * 0.9;

  // Opacity and ridge-over-sky binned by RANGE rather than by screen column,
  // so the number is answering "at 3-5 km" and not "at wherever this framing
  // happens to put a ridge".
  const RB = [[500, 1000], [1000, 1500], [1500, 2000], [2000, 3000], [3000, 5000], [5000, 8000], [8000, 20000]];
  const racc = RB.map(() => ({ b: 0, s: 0, a: 0, n: 0 }));
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    const z = D[at(x, y)];
    if (z > far * 0.9) continue;
    const d = z / Math.max(0.2, rayFor(x, y).dot(fwd));
    const k = RB.findIndex(([a, b2]) => d >= a && d < b2);
    if (k < 0) continue;
    const i = at(x, y);
    racc[k].b += 0.2126 * B[i] + 0.7152 * B[i + 1] + 0.0722 * B[i + 2];
    racc[k].s += 0.2126 * S[i] + 0.7152 * S[i + 1] + 0.0722 * S[i + 2];
    racc[k].a += 0.2126 * A[i] + 0.7152 * A[i + 1] + 0.0722 * A[i + 2];
    racc[k].n++;
  }
  // Sky radiance just above the skyline, as the convergence target.
  function skylineRow(x0, x1) {
    for (let y = 4; y < H - 90; y++) {
      let solid = 0;
      for (let x = x0; x < x1; x += 4) if (!isSky(x, y)) solid++;
      if (solid > (x1 - x0) / 8) return y;
    }
    return -1;
  }
  const cols = [[180, 320], [620, 760], [960, 1100], [1380, 1520], [1700, 1840]];
  const bands = cols.map(([x0, x1]) => {
    const sk = skylineRow(x0, x1);
    if (sk < 0) return null;
    const y0 = sk + 8, y1 = sk + 68;
    let s = 0, n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const z = D[at(x, y)];
      if (z > far * 0.9) continue;
      s += z / Math.max(0.2, rayFor(x, y).dot(fwd)); n++;
    }
    const rA = boxL(A, x0, y0, x1, y1);
    const sA = boxL(A, x0, Math.max(0, sk - 70), x1, Math.max(1, sk - 8));
    const rB = boxL(B, x0, y0, x1, y1), rS = boxL(S, x0, y0, x1, y1);
    return {
      x0, dist_m: n ? Math.round(s / n) : -1,
      opacity: +(1 - rB / Math.max(rS, 1e-9)).toFixed(3),
      ridgeOverSky: +(rA / Math.max(sA, 1e-9)).toFixed(3),
    };
  }).filter(Boolean);

  out.shots[shot] = {
    byRange: RB.map(([a, b2], k) => ({
      range: `${a}-${b2}`, px: racc[k].n,
      opacity: racc[k].n ? +(1 - racc[k].b / racc[k].s).toFixed(3) : null,
    })).filter((r) => r.px > 0),
    bands,
  };
}
fRT.dispose();
return out;
