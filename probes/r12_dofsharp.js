/**
 * r12_dofsharp.js — did half-res DOF cost any sharpness where it must not?
 *
 * The whole argument for running the defocus gather at half resolution is that
 * the composite keeps the full-resolution sharp read wherever the pass reports
 * it did nothing (alpha 0 on the early-out). If that blend is wrong, the
 * in-focus majority of the frame goes soft and the saving is not worth having.
 *
 * So this measures high-frequency energy — mean |Laplacian| over the presented
 * frame — in a band that is IN FOCUS, with the defocus pass on and off. If the
 * blend works, those two numbers agree closely: an in-focus pixel should be
 * bit-comparable whether or not the pass ran. A drop means the half-res buffer
 * is leaking into sharp regions.
 *
 * It also reports the same metric with the pass forced through at full alpha,
 * as a positive control — if that does NOT drop, the metric cannot see blur at
 * all and the test is worthless.
 */
const g = window.__GAME;
const eng = g.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();

g.applyShot('gameplay');
eng.deterministic = true;
eng.stop();

const fw = renderer.domElement.width;
const fh = renderer.domElement.height;

/** Mean |Laplacian| of luma over a rect: high-frequency detail energy. */
function sharpness(x, y, w, h) {
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const L = (i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  let sum = 0;
  let n = 0;
  for (let j = 1; j < h - 1; j++) {
    for (let i = 1; i < w - 1; i++) {
      const c = (j * w + i) * 4;
      const lap = 4 * L(c) - L(c - 4) - L(c + 4) - L(c - w * 4) - L(c + w * 4);
      sum += Math.abs(lap);
      n++;
    }
  }
  return +(sum / n).toFixed(3);
}

function shot() {
  g.settle(16);
  return {
    // The near foreground is what the gameplay camera focuses on.
    nearFocus: sharpness(600, 120, 500, 220),
    // Mid-ground, also within the focal range at this pose.
    mid: sharpness(900, 500, 500, 200),
  };
}

const out = {};
pipe.enabled.dof = false;
pipe.enabled.motionBlur = false;
out.dofOff = shot();

pipe.enabled.dof = true;
pipe.enabled.motionBlur = true;
out.dofOn_halfRes = shot();

// Positive control: force the blend to take the half-res buffer everywhere,
// which SHOULD visibly soften. If it does not, this metric proves nothing.
const cu = pipe.compositeMat.uniforms;
const saved = cu.uDofOn.value;
cu.uDofOn.value = 1;
const patched = pipe.compositeMat.fragmentShader;
out.note = 'positive control forces the dof blend weight to 1 via a shader edit below';
pipe.compositeMat.fragmentShader = patched.replace(
  'color = mix(color, dofS.rgb, clamp(dofS.a, 0.0, 1.0));',
  'color = mix(color, dofS.rgb, 1.0);',
);
pipe.compositeMat.needsUpdate = true;
out.dofOn_forcedFullBlend = shot();
pipe.compositeMat.fragmentShader = patched;
pipe.compositeMat.needsUpdate = true;
cu.uDofOn.value = saved;

const dOn = +(out.dofOn_halfRes.nearFocus - out.dofOff.nearFocus).toFixed(3);
const dForced = +(out.dofOn_forcedFullBlend.nearFocus - out.dofOff.nearFocus).toFixed(3);

return {
  regions: out,
  nearFocusDelta_halfResVsOff: dOn,
  nearFocusDelta_forcedBlendVsOff: dForced,
  metricCanSeeBlur: dForced < -0.5,
  verdict:
    dForced >= -0.5
      ? 'INCONCLUSIVE — the positive control did not soften, so this metric cannot see blur here'
      : Math.abs(dOn) < Math.abs(dForced) * 0.25
        ? 'PASS — in-focus sharpness preserved; the alpha blend is keeping the full-res read'
        : 'FAIL — half-res buffer is leaking into in-focus pixels',
};
