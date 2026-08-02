/**
 * CASCADE SWEEP — isolate WHICH half of the round-8 shadow cut costs the frame,
 * and in which direction.
 *
 * Round 8 changed two things at once: map sizes 2048/2048/2048 -> 2048/1536/1024
 * and refresh 1/2/4 -> 1/3/6. `cascade_ab.js` measured them together and found a
 * building-sized region of the vista at 90-380 m going LIGHTER. This separates
 * them, and reports the sign, because "the frame changed" and "a shadow was
 * lost" are different findings.
 *
 * Everything stochastic is off in every arm (see cascade_ab.js) and the clock is
 * frozen with dt = 0, so the residual between two reads of the same config is
 * the floor — reported as arm `ctrl`.
 *
 * ARGS: <shot>
 */
const g = window.__GAME;
const THREE = g.THREE;
const engine = g.engine, renderer = engine.renderer, pipeline = engine.pipeline;
const lighting = g.world.lighting;
const gl = renderer.getContext();
g.setFreeFly(false);

const A = (typeof ARGS !== 'undefined' && ARGS) || [];
const shot = A[0] || 'vista';
const N = 24;
g.applyShot(shot);
g.settle(24);
pipeline.enabled.taa = false;
pipeline.enabled.motionBlur = false;
pipeline.enabled.dof = false;
pipeline.enabled.ssao = false;
pipeline.grade.grainAmount = 0;
g.settle(N, 0);

const W = pipeline.width, H = pipeline.height;
const readFrame = () => { const b = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; };

// depth, for the distance bands (identical in every arm — shadows move no vertices)
const depthMat = new THREE.ShaderMaterial({
  uniforms: { tDepth: { value: null }, uProjInv: { value: new THREE.Matrix4() }, uFar: { value: 4000 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.0,1.0); }',
  fragmentShader: `precision highp float; varying vec2 vUv; uniform sampler2D tDepth; uniform mat4 uProjInv; uniform float uFar;
    void main(){ float d = texture2D(tDepth, vUv).x;
      if (d >= 0.9999995) { gl_FragColor = vec4(1.0); return; }
      vec4 c = uProjInv * vec4(vUv*2.0-1.0, d*2.0-1.0, 1.0); float vz = -(c.z/c.w);
      float t = clamp(vz/uFar, 0.0, 0.999999); vec3 e = fract(t*vec3(1.0,255.0,65025.0));
      e -= e.yzz*vec3(1.0/255.0,1.0/255.0,0.0); gl_FragColor = vec4(e,1.0); }`,
  depthTest: false, depthWrite: false,
});
const oScene = new THREE.Scene(); oScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), depthMat));
const oCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const dRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
depthMat.uniforms.tDepth.value = pipeline.hdr.depthTexture;
depthMat.uniforms.uProjInv.value.copy(engine.camera.projectionMatrixInverse);
renderer.setRenderTarget(dRT); renderer.render(oScene, oCam);
const dbuf = new Uint8Array(W * H * 4); renderer.readRenderTargetPixels(dRT, 0, 0, W, H, dbuf);
renderer.setRenderTarget(null);
const depth = new Float32Array(W * H);
for (let i = 0, p = 0; i < W * H; i++, p += 4) depth[i] = (dbuf[p] / 255 + dbuf[p + 1] / 65025 + dbuf[p + 2] / 16581375) * 4000;

function setC(sizes, interval, phase) {
  lighting.cascades.forEach((l, i) => {
    const s = sizes[Math.min(i, sizes.length - 1)];
    if (l.shadow.mapSize.x !== s) { l.shadow.mapSize.set(s, s); if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; } }
    l.shadow.needsUpdate = true;
  });
  lighting.refreshInterval = interval.slice();
  lighting._refreshPhase = phase.slice();
}
const R7 = { sizes: [2048, 2048, 2048, 1024], int: [1, 2, 4, 8], ph: [0, 0, 1, 3] };
const R8 = { sizes: [2048, 1536, 1024, 1024], int: [1, 3, 6, 12], ph: [0, 0, 2, 5] };

const splits = Array.from(lighting._splits || []);
const EDGES = [0, splits[1] || 29, splits[2] || 89, splits[3] || 380, 4000];
const NB = EDGES.length - 1;
const lum = (b, i) => 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2];

function compare(X, Y) {   // X = arm, Y = r7 reference
  const bin = Array.from({ length: NB }, () => ({ n: 0, sum: 0, up8: 0, dn8: 0, max: 0, sgn: 0 }));
  for (let i = 0; i < W * H; i++) {
    const z = depth[i]; if (z >= 3999) continue;
    let k = 0; while (k < NB - 1 && z >= EDGES[k + 1]) k++;
    const p = i * 4;
    const d = Math.max(Math.abs(X[p] - Y[p]), Math.abs(X[p + 1] - Y[p + 1]), Math.abs(X[p + 2] - Y[p + 2]));
    const dl = lum(X, p) - lum(Y, p);
    const b = bin[k]; b.n++; b.sum += d; if (d > b.max) b.max = d; b.sgn += dl;
    if (d >= 8) { if (dl > 0) b.up8++; else b.dn8++; }
  }
  return bin.map((b, k) => ({
    range: `${EDGES[k].toFixed(0)}-${EDGES[k + 1].toFixed(0)}m`,
    pxPct: +(100 * b.n / (W * H)).toFixed(2),
    mad: b.n ? +(b.sum / b.n).toFixed(3) : 0,
    pctLighterBy8: b.n ? +(100 * b.up8 / b.n).toFixed(2) : 0,   // shadow LOST
    pctDarkerBy8: b.n ? +(100 * b.dn8 / b.n).toFixed(2) : 0,
    max: b.max,
    sgnL: b.n ? +(b.sgn / b.n).toFixed(3) : 0,
  }));
}

// Reference arm first: full round-7 cascades.
setC(R7.sizes, R7.int, R7.ph); g.settle(N, 0); const REF = readFrame();
const arms = {};
const run = (name, sizes, int, ph) => { setC(sizes, int, ph); g.settle(N, 0); arms[name] = compare(readFrame(), REF); };

run('ctrl_r7_again', R7.sizes, R7.int, R7.ph);                 // floor
run('sizeOnly_r8maps_r7refresh', R8.sizes, R7.int, R7.ph);     // map size alone
run('refreshOnly_r7maps_r8refresh', R7.sizes, R8.int, R8.ph);  // refresh alone
run('shipped_r8', R8.sizes, R8.int, R8.ph);                    // both
run('c2_1536', [2048, 1536, 1536, 1024], R8.int, R8.ph);       // would 1536 recover it?
run('c1_2048_c2_1024', [2048, 2048, 1024, 1024], R8.int, R8.ph);

setC(R8.sizes, R8.int, R8.ph); g.settle(8, 0);
return { shot, splits: splits.map((v) => +v.toFixed(1)), arms };
