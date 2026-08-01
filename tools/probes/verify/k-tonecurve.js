/**
 * (k) TONE CURVE — the delivered display response, measured, not modelled.
 *
 * An UNLIT emissive patch of known linear radiance is pinned to frame centre
 * and stepped in half-stops; the delivered 8-bit code is read out of the
 * presented framebuffer. Frame centre is the whole point: vignette, barrel
 * distortion and chromatic aberration are all radial, so at the centre they are
 * identical for every sample and the only thing varying is the curve.
 *
 * The patch is a raw ShaderMaterial writing its radiance straight into the HDR
 * buffer, 0.6 m from the lens, so no light transport, no shadow, no AO and no
 * aerial perspective touch it. What comes back is exactly
 *
 *     code = pipeline( linear radiance )
 *
 * for the composite's exposure, ACES/filmic curve, sRGB encode and grade LUT.
 *
 * Two columns of linear light are reported, because they are not the same
 * question:
 *   `lin`  the patch's own radiance — scene-referred, the units the ambient
 *          probe (b-ambient.js) reports and the units a shaded surface is
 *          quoted in;
 *   `tmIn` the same value times the solved exposure, i.e. what actually
 *          arrives at the tone curve.
 *
 * `codesPerStop` is the finite difference in display code between adjacent
 * half-stop samples, doubled — the slope of the print. Below ~10 it is not a
 * gradient any more, it is a plate.
 */
g.setFreeFly(false);
const THREE_ = g.THREE;
const engine = g.engine;
const scene = engine.scene;
const renderer = engine.renderer;
const pipeline = engine.pipeline;
const gl = renderer.getContext();

const shot = (typeof ARGV !== 'undefined' && ARGV[0]) || 'vista';
g.applyShot(shot);
g.settle(6);

const cam = engine.camera;
const patchMat = new THREE_.ShaderMaterial({
  uniforms: { uRad: { value: new THREE_.Vector3(0, 0, 0) } },
  vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: 'uniform vec3 uRad; void main(){ gl_FragColor = vec4(uRad, 1.0); }',
  depthTest: true,
  depthWrite: true,
  fog: false,
});
// 0.6 m from the lens, sized so it covers roughly the central third of frame.
const dist = 0.6;
const halfH = dist * Math.tan((cam.fov * Math.PI) / 180 / 2) * 0.55;
const patch = new THREE_.Mesh(new THREE_.PlaneGeometry(halfH * 2 * cam.aspect, halfH * 2), patchMat);
patch.frustumCulled = false;
patch.castShadow = false;
patch.receiveShadow = false;
patch.renderOrder = -100;
const fwd = new THREE_.Vector3();
cam.getWorldDirection(fwd);
patch.position.copy(cam.position).addScaledVector(fwd, dist);
patch.quaternion.copy(cam.quaternion);
scene.add(patch);

const W = pipeline.width;
const H = pipeline.height;
const buf = new Uint8Array(W * H * 4);
// A 48x48 box at the exact optical centre; grain is zero-mean so 2304 samples
// bring its +/-4 code swing down to well under a tenth of a code.
const BOX = 24;
const x0 = Math.floor(W / 2) - BOX;
const y0 = Math.floor(H / 2) - BOX;

function measure(rad) {
  patchMat.uniforms.uRad.value.set(rad, rad, rad);
  g.settle(8);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let r = 0, gg = 0, b = 0, n = 0;
  for (let y = y0; y < y0 + BOX * 2; y++) {
    for (let x = x0; x < x0 + BOX * 2; x++) {
      const i = (y * W + x) * 4;
      r += buf[i]; gg += buf[i + 1]; b += buf[i + 2]; n++;
    }
  }
  return [r / n, gg / n, b / n];
}

// Half-stops. The bottom of the sweep is two stops under the darkest thing a
// daylight frame contains; the top is where bloom starts to contribute.
const START = 0.000884;
const N = 24;

function sweep() {
  const rows = [];
  for (let i = 0; i < N; i++) {
    const rad = START * Math.pow(2, i * 0.5);
    const [r, gg, b] = measure(rad);
    rows.push({ lin: +rad.toFixed(6), r: +r.toFixed(1), g: +gg.toFixed(1), b: +b.toFixed(1) });
  }
  const E = pipeline._finalExposure;
  for (let i = 0; i < rows.length; i++) {
    rows[i].tmIn = +(rows[i].lin * E).toFixed(6);
    rows[i].codesPerStop = i === 0 ? null : +((rows[i].g - rows[i - 1].g) * 2).toFixed(2);
  }
  return { exposure: +E.toFixed(5), rows };
}

// Both states in ONE run. A table measured against a previous round attributes
// nothing; this ablates the curve and re-measures the same patch.
pipeline.setToneToe(false);
g.settle(8);
const before = sweep();
pipeline.setToneToe(true);
g.settle(8);
const after = sweep();

scene.remove(patch);
patch.geometry.dispose();
patchMat.dispose();
g.settle(4);

return { shot, ev: +pipeline.exposureInfo.ev.toFixed(4), before, after };
