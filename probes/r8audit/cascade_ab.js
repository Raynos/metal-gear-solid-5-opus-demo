/**
 * CASCADE A/B — what the round-8 shadow cut actually costs, per distance band.
 *
 * Round 8 changed the cascade set from 2048/2048/2048 refreshed 1/2/4 to
 * 2048/1536/1024 refreshed 1/3/6. This measures the delivered frame with the
 * SHIPPED config and then with the round-7 config, in ONE page load.
 *
 * TWO CONFOUNDS THIS CONTROLS FOR, both of which faked a large effect on the
 * first attempt:
 *
 *  1. `settle(n)` ADVANCES THE ANIMATION CLOCK. Comparing a frame settled now
 *     against one settled 16 frames later measures the wind and the guards
 *     walking, not the shadow maps. Every settle here uses dt = 0, so
 *     `engine.elapsed` is frozen and only the render state moves.
 *  2. TAA still rejitters with dt = 0 (`uFrame % 64`), so two reads of the
 *     IDENTICAL config still differ. There is therefore a CONTROL ARM: the
 *     shipped config is read twice with nothing changed in between, and that
 *     diff is the noise floor every band is judged against.
 *
 * Pixels are binned by TRUE view depth read out of the pipeline's depth
 * attachment, not by screen row, so "cascade 1" means 29-89 m and not
 * "somewhere in the middle of the picture".
 *
 * ARGS: <shot>
 */
const g = window.__GAME;
const THREE = g.THREE;
const engine = g.engine;
const renderer = engine.renderer;
const pipeline = engine.pipeline;
const lighting = g.world.lighting;
const gl = renderer.getContext();
g.setFreeFly(false);

const A = (typeof ARGS !== 'undefined' && ARGS) || [];
const shot = A[0] || 'outpost';
const N = +(A[1] || 24);
g.applyShot(shot);
g.settle(24);          // one real settle, with time, to get the world into pose

// SILENCE THE STOCHASTIC PASSES. With them on, two reads of the IDENTICAL
// config differ by 4-5 codes MAD (measured), which is ~25x the effect being
// looked for — film grain is reseeded per frame and TAA keeps rejittering even
// with the clock frozen. SSAO's own noise is on `uFrame % 64` too. None of
// these are what round 8 changed, so all three are turned off in BOTH arms and
// the control arm below proves the floor really did drop.
pipeline.enabled.taa = false;
pipeline.enabled.motionBlur = false;
pipeline.enabled.dof = false;
pipeline.enabled.ssao = false;
pipeline.grade.grainAmount = 0;
g.settle(N, 0);        // then freeze

const W = pipeline.width, H = pipeline.height;

// ---- linear view depth readback ------------------------------------------
const depthMat = new THREE.ShaderMaterial({
  uniforms: { tDepth: { value: null }, uProjInv: { value: new THREE.Matrix4() }, uFar: { value: 4000 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.0,1.0); }',
  fragmentShader: `
    precision highp float; varying vec2 vUv;
    uniform sampler2D tDepth; uniform mat4 uProjInv; uniform float uFar;
    void main(){
      float d = texture2D(tDepth, vUv).x;
      if (d >= 0.9999995) { gl_FragColor = vec4(1.0); return; }
      vec4 c = uProjInv * vec4(vUv*2.0-1.0, d*2.0-1.0, 1.0);
      float vz = -(c.z / c.w);
      float t = clamp(vz / uFar, 0.0, 0.999999);
      vec3 enc = fract(t * vec3(1.0, 255.0, 65025.0));
      enc -= enc.yzz * vec3(1.0/255.0, 1.0/255.0, 0.0);
      gl_FragColor = vec4(enc, 1.0);
    }`,
  depthTest: false, depthWrite: false,
});
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), depthMat);
const oScene = new THREE.Scene(); oScene.add(quad);
const oCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const dRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });

function readDepth() {
  depthMat.uniforms.tDepth.value = pipeline.hdr.depthTexture;
  depthMat.uniforms.uProjInv.value.copy(engine.camera.projectionMatrixInverse);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(dRT);
  renderer.render(oScene, oCam);
  const buf = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(dRT, 0, 0, W, H, buf);
  renderer.setRenderTarget(prev);
  const out = new Float32Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) out[i] = (buf[p] / 255 + buf[p + 1] / 65025 + buf[p + 2] / 16581375) * 4000;
  return out;
}
const readFrame = () => { const b = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; };

const shipped = {
  sizes: lighting.cascades.map((l) => l.shadow.mapSize.x),
  interval: lighting.refreshInterval.slice(),
  phase: lighting._refreshPhase.slice(),
};
function setCascades(sizes, interval, phase) {
  lighting.cascades.forEach((l, i) => {
    const s = sizes[Math.min(i, sizes.length - 1)];
    if (l.shadow.mapSize.x !== s) {
      l.shadow.mapSize.set(s, s);
      if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; }
    }
    l.shadow.needsUpdate = true;
  });
  lighting.refreshInterval = interval.slice();
  lighting._refreshPhase = phase.slice();
}

const P1 = readFrame();                       // shipped
const depth = readDepth();
g.settle(N, 0); const P2 = readFrame();       // shipped again -> CONTROL (TAA floor)
setCascades([2048, 2048, 2048, 1024], [1, 2, 4, 8], [0, 0, 1, 3]);
g.settle(N, 0); const P3 = readFrame();       // round-7 cascades
setCascades(shipped.sizes, shipped.interval, shipped.phase);
g.settle(N, 0); const P4 = readFrame();       // back to shipped -> effect, reversed

const splits = Array.from(lighting._splits || []);
const EDGES = [0, splits[1] || 29, splits[2] || 89, splits[3] || 380, 4000];
const NB = EDGES.length - 1;
const lum = (b, i) => 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2];

function compare(X, Y) {
  const bin = Array.from({ length: NB }, () => ({ n: 0, sum: 0, over8: 0, max: 0, sgn: 0 }));
  for (let i = 0; i < W * H; i++) {
    const z = depth[i]; if (z >= 3999) continue;
    let k = 0; while (k < NB - 1 && z >= EDGES[k + 1]) k++;
    const p = i * 4;
    const d = Math.max(Math.abs(X[p] - Y[p]), Math.abs(X[p + 1] - Y[p + 1]), Math.abs(X[p + 2] - Y[p + 2]));
    const b = bin[k]; b.n++; b.sum += d; if (d >= 8) b.over8++; if (d > b.max) b.max = d;
    b.sgn += lum(X, p) - lum(Y, p);
  }
  return bin.map((b, k) => ({
    range: `${EDGES[k].toFixed(0)}-${EDGES[k + 1].toFixed(0)}m`,
    pxPct: +(100 * b.n / (W * H)).toFixed(2),
    mad: b.n ? +(b.sum / b.n).toFixed(3) : 0,
    pctOver8: b.n ? +(100 * b.over8 / b.n).toFixed(2) : 0,
    max: b.max,
    sgnL: b.n ? +(b.sgn / b.n).toFixed(3) : 0,
  }));
}

// ---- where is the effect, and what does it look like ---------------------
// A number cannot say whether a shadow edge went from soft to staircased, so
// the worst 64x64 tile is returned as three PNGs: shipped, round-7, and the
// difference at 8x gain. readPixels is bottom-up; the crop flips back.
const TILE = 64;
const tx = Math.floor(W / TILE), ty = Math.floor(H / TILE);
const tiles = [];
for (let j = 0; j < ty; j++) for (let i = 0; i < tx; i++) {
  let s = 0, n = 0;
  for (let y = j * TILE; y < (j + 1) * TILE; y++) for (let x = i * TILE; x < (i + 1) * TILE; x++) {
    const p = (y * W + x) * 4;
    s += Math.max(Math.abs(P2[p] - P3[p]), Math.abs(P2[p + 1] - P3[p + 1]), Math.abs(P2[p + 2] - P3[p + 2]));
    n++;
  }
  tiles.push({ i, j, x: i * TILE, yFromBottom: j * TILE, mad: +(s / n).toFixed(2) });
}
tiles.sort((a, b) => b.mad - a.mad);

function cropPNG(buf, x0, y0, w, h, gain, other) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sp = ((y0 + y) * W + x0 + x) * 4;
    const dp = ((h - 1 - y) * w + x) * 4;          // flip: readPixels is bottom-up
    for (let k = 0; k < 3; k++) {
      img.data[dp + k] = other
        ? Math.min(255, Math.abs(buf[sp + k] - other[sp + k]) * gain)
        : buf[sp + k];
    }
    img.data[dp + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}
const PAD = 128;
const hot = tiles[0];
const cx = Math.max(0, Math.min(W - PAD * 2, hot.x - PAD / 2));
const cy = Math.max(0, Math.min(H - PAD * 2, hot.yFromBottom - PAD / 2));

return {
  shot, splits: splits.map((v) => +v.toFixed(1)),
  shippedSizes: shipped.sizes, shippedInterval: shipped.interval,
  control_shippedVsShipped: compare(P1, P2),
  effect_shippedVsR7: compare(P2, P3),
  effect_r7VsShippedAgain: compare(P3, P4),
  hotTiles: tiles.slice(0, 8),
  crop: { x: cx, yFromBottom: cy, w: PAD * 2, h: PAD * 2 },
  png: {
    shipped: cropPNG(P2, cx, cy, PAD * 2, PAD * 2),
    r7: cropPNG(P3, cx, cy, PAD * 2, PAD * 2),
    diff8x: cropPNG(P2, cx, cy, PAD * 2, PAD * 2, 8, P3),
  },
};
