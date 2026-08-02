/**
 * r12_clastshadow.js — does clast receive the cascaded shadow, or not?
 *
 *   node tools/shot.mjs eval probes/r12_clastshadow.js [shot]
 *
 * The vegetation author reported that `csmSunVis` returns 1.0 over every clast
 * fragment, which matters well beyond the stones: TODO 2.1's black band on the
 * outpost yard was argued NOT to be a shadow partly because the pale chips
 * lying inside it are as bright as the ones outside, and a chip that cannot
 * receive a shadow says nothing about whether one is there.
 *
 * This asks the question from the outside, with no shader edits, so it cannot
 * be wrong about what the shader "should" do:
 *
 *   A  the frame as shipped
 *   C  the frame with every clast mesh hidden      -> clast pixels are |A - C|
 *   B  the frame with the SHADOW TERM ablated      -> shadow pixels are |A - B|
 *
 * The shadow ablation is `light.shadow.intensity = 0`, which is a uniform
 * (`shadowIntensity` in getShadowCSM's final mix) and not a define, so nothing
 * recompiles and the ~50 ms flip stall does not apply. It is also the exact
 * term under suspicion rather than a proxy for it.
 *
 * The control is the RING: pixels within 3 px of a clast pixel that are not
 * clast. That is the ground the stone is lying on — same cascade, same texels,
 * same distance, same time of day. If the ring brightens when the shadow term
 * is ablated and the stone in the middle of it does not, the stone is not
 * receiving the shadow. Restricting to rings that brighten by more than 8 codes
 * restricts the whole comparison to places that ARE in shade, which is the only
 * place the question means anything.
 */
const g = window.__GAME;
const eng = g.engine ?? g.world.engine;
const renderer = eng.renderer;
const gl = renderer.getContext();
const lighting = g.world.lighting;

const shot = (typeof ARGS !== 'undefined' && ARGS && ARGS[0]) || 'gameplay';
g.applyShot(shot);

const W = renderer.domElement.width;
const H = renderer.domElement.height;
const buf = new Uint8Array(W * H * 4);

function grab() {
  g.settle(12);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    L[i] = 0.2126 * buf[o] + 0.7152 * buf[o + 1] + 0.0722 * buf[o + 2];
  }
  return L;
}

const clasts = [];
eng.scene.traverse((o) => {
  if (o.isMesh && typeof o.name === 'string' && o.name.startsWith('clast')) clasts.push(o);
});

const A = grab();

for (const l of lighting.cascades) l.shadow.intensity = 0;
lighting.invalidateShadows();
const B = grab();
for (const l of lighting.cascades) l.shadow.intensity = 1;
lighting.invalidateShadows();

// EXPERIMENT 2, and the one that tests the round-11 claim exactly.
//
// The sun-gated ground bounce in AMB_APPLY is
//     irradiance += uAmbBounce * ambDown^2 * ambSun * ambVis
// with `ambSun = clamp(csmSunVis, 0, 1) * csmCloud`. A fragment genuinely in
// shadow has csmSunVis ~ 0 and therefore takes NO bounce, so zeroing
// uAmbBounce should barely move shaded ground. If it moves shaded CLAST a lot,
// that fragment was taking the full sunlit-ground bounce while standing in a
// shadow — which is what "csmSunVis returns 1.0 over every clast fragment"
// predicts, and it is a brightening that needs no direct sun at all.
//
// SHARED_UNIFORMS is a module-private object, but `cloneUniforms` copies plain
// objects BY REFERENCE, so the value hanging off any injected material IS that
// object (TODO section 2.1: reach uniforms through userData, not .uniforms).
const bounceU = clasts[0]?.material?.userData?.shader?.uniforms?.uAmbBounce?.value ?? null;
let D = null;
if (bounceU) {
  const keep = { x: bounceU.x, y: bounceU.y, z: bounceU.z };
  bounceU.x = 0;
  bounceU.y = 0;
  bounceU.z = 0;
  D = grab();
  Object.assign(bounceU, keep);
  grab();
}

const wasVisible = clasts.map((m) => m.visible);
for (const m of clasts) m.visible = false;
const C = grab();
for (let i = 0; i < clasts.length; i++) clasts[i].visible = wasVisible[i];
grab(); // put the temporal history back

// Clast pixels: hiding the stones changed them. 6 codes is well clear of the
// AO/volumetric perturbation that hiding meshes causes (TODO section 0).
const isClast = new Uint8Array(W * H);
let clastPx = 0;
for (let i = 0; i < W * H; i++) {
  if (Math.abs(A[i] - C[i]) > 6) {
    isClast[i] = 1;
    clastPx++;
  }
}

// Ring: within 3 px of a clast pixel, not itself clast.
const isRing = new Uint8Array(W * H);
const R = 3;
for (let y = R; y < H - R; y++) {
  for (let x = R; x < W - R; x++) {
    const i = y * W + x;
    if (isClast[i]) continue;
    let near = 0;
    for (let dy = -R; dy <= R && !near; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (isClast[i + dy * W + dx]) {
          near = 1;
          break;
        }
      }
    }
    if (near) isRing[i] = 1;
  }
}

// Restrict to shaded neighbourhoods: a ring pixel that brightens by > 8 codes
// when the shadow term goes away was in shadow.
const SH = 8;
let ringN = 0;
let ringSum = 0;
let clastN = 0;
let clastSum = 0;
let clastLit = 0;
let ringLit = 0;
for (let y = R; y < H - R; y++) {
  for (let x = R; x < W - R; x++) {
    const i = y * W + x;
    const d = B[i] - A[i];
    if (isRing[i] && d > SH) {
      ringN++;
      ringSum += d;
      ringLit += A[i];
    }
  }
}
// A clast pixel counts if its own ring neighbourhood is shaded.
for (let y = R; y < H - R; y++) {
  for (let x = R; x < W - R; x++) {
    const i = y * W + x;
    if (!isClast[i]) continue;
    let shadedNeighbour = 0;
    for (let dy = -R; dy <= R && !shadedNeighbour; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const j = i + dy * W + dx;
        if (isRing[j] && B[j] - A[j] > SH) {
          shadedNeighbour = 1;
          break;
        }
      }
    }
    if (!shadedNeighbour) continue;
    clastN++;
    clastSum += B[i] - A[i];
    clastLit += A[i];
  }
}

// Experiment 2, over the same two masks.
let ringD = 0;
let ringDn = 0;
let clastD = 0;
let clastDn = 0;
if (D) {
  for (let y = R; y < H - R; y++) {
    for (let x = R; x < W - R; x++) {
      const i = y * W + x;
      const shaded = B[i] - A[i] > SH;
      if (isRing[i] && shaded) {
        ringD += A[i] - D[i];
        ringDn++;
      }
      if (isClast[i]) {
        let sn = 0;
        for (let dy = -R; dy <= R && !sn; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            const j = i + dy * W + dx;
            if (isRing[j] && B[j] - A[j] > SH) { sn = 1; break; }
          }
        }
        if (sn) {
          clastD += A[i] - D[i];
          clastDn++;
        }
      }
    }
  }
}

// Whole-frame scale, for context.
let frameSum = 0;
let frameN = 0;
for (let i = 0; i < W * H; i++) {
  const d = B[i] - A[i];
  if (d > SH) {
    frameSum += d;
    frameN++;
  }
}

return {
  shot,
  clastMeshes: clasts.map((m) => m.name),
  clastPixels: clastPx,
  shadedRing: {
    pixels: ringN,
    meanBrighteningWhenShadowAblated: +(ringSum / Math.max(ringN, 1)).toFixed(2),
    meanShippedLuminance: +(ringLit / Math.max(ringN, 1)).toFixed(1),
  },
  clastInsideThoseShadows: {
    pixels: clastN,
    meanBrighteningWhenShadowAblated: +(clastSum / Math.max(clastN, 1)).toFixed(2),
    meanShippedLuminance: +(clastLit / Math.max(clastN, 1)).toFixed(1),
  },
  wholeFrame: {
    pixelsBrightenedOver8: frameN,
    pctOfFrame: +((100 * frameN) / (W * H)).toFixed(2),
    meanBrightening: +(frameSum / Math.max(frameN, 1)).toFixed(2),
  },
  groundBounceInShadow: D
    ? {
        ringLostWhenBounceZeroed: +(ringD / Math.max(ringDn, 1)).toFixed(2),
        clastLostWhenBounceZeroed: +(clastD / Math.max(clastDn, 1)).toFixed(2),
        note:
          'the bounce is gated by csmSunVis. A shaded fragment should lose ~nothing. ' +
          'If clast loses much more than the ground it lies on, clast is taking the ' +
          'sunlit-ground bounce while standing in shade, i.e. its csmSunVis is ~1.',
      }
    : { error: 'could not reach uAmbBounce through clast material userData' },
  reading:
    'If clastInsideThoseShadows.meanBrightening is near zero while shadedRing is ' +
    'well above it, clast is not receiving the cascaded shadow. If the two are ' +
    'comparable, it is, and the round-11 report is about something else.',
};
