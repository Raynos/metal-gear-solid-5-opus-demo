import * as THREE from 'three';
import { GRADE, QUALITY } from '../config/ArtDirection.js';

/**
 * RenderPipeline — HDR post stack.
 *
 *   scene (jittered projection) -> HDR half-float RT + depth
 *     -> GTAO x2 + contact shadows (horizon search, bilateral)  [occlusion]
 *     -> prepare: AO apply + aerial perspective               [atmosphere]
 *     -> TAA resolve (reprojection + YCoCg neighbourhood clip)
 *     -> luminance reduction + eye adaptation                 [auto exposure]
 *     -> bloom mip chain + anamorphic streak
 *     -> bokeh DOF fused with camera motion blur
 *     -> composite: exposure, tone curve, 3D LUT grade, barrel distortion,
 *        chromatic aberration, lens dirt veiling, vignette, grain
 *     -> FXAA / sharpen -> screen
 *
 * The tone curve is the REAL Fox Engine one as of round 8 (see `PRINT` and
 * `foxCurve`); the ACES-plus-rebuilt-toe curve rounds 1-7 used is still here
 * and still exact, behind `grade.toneCurve = 'aces'`, because it is the
 * ablation the round-8 numbers are quoted against.
 *
 * Design notes worth knowing before editing:
 *
 *  - Aerial perspective is a *post* pass driven by depth, not scene fog. It
 *    needs the view direction to pick up the sun's phase function, which fog
 *    cannot do. `Lighting` feeds it the same atmosphere numbers the sky dome is
 *    drawn with, so a ridge fades into exactly the sky behind it.
 *  - AO is applied *before* TAA on purpose: the temporal filter then denoises
 *    the occlusion for free, which is why 4 slices of horizon search is enough.
 *  - The occlusion pass produces THREE signals in one set of depth taps: broad
 *    AO at 1.15 m, micro AO at 0.16 m, and a screen-space contact shadow marched
 *    along the sun. They are separate because one radius cannot resolve both a
 *    room and a seam, and because a contact shadow occludes DIRECT light while
 *    AO occludes ambient. Ablate them individually through `pipeline.ablate`,
 *    never through `enabled.ssao` — that switch takes all three at once.
 *  - Everything upstream of the composite is linear HDR. Tonemapping happens
 *    once, in the composite. Never add another.
 */

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Shared helpers injected into several fragment shaders. */
const COMMON_GLSL = /* glsl */ `
float linearizeDepth(float d, float near, float far) {
  float z = d * 2.0 - 1.0;
  return (2.0 * near * far) / (far + near - z * (far - near));
}
vec3 viewFromDepth(vec2 uv, float d, mat4 projInv) {
  vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = projInv * clip;
  return v.xyz / v.w;
}
vec3 worldFromDepth(vec2 uv, float d, mat4 invViewProj) {
  vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 w = invViewProj * clip;
  return w.xyz / w.w;
}
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
`;

/** 16-sample Halton(2,3) jitter, centred on the pixel. */
function halton(index, base) {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}
const JITTER = Array.from({ length: 16 }, (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5]);

/**
 * Luminance of the surface the exposure is metered against: PALETTE.sandLight,
 * which is what most of an Afghan valley actually is. Exposure is derived from
 * how much light is FALLING on that surface, never from what happens to be in
 * frame — see `_updateExposure`.
 */
const EXPOSURE_REF_ALBEDO = 0.55;
const lum3 = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * ROUND 8 — THE PRINT, RE-AUTHORED AGAINST MEASURED MGSV.
 *
 * These override the matching keys in `GRADE` (see the constructor). They live
 * here rather than in `src/config/ArtDirection.js` because that file is shared
 * and this pass does not own it; every value below is a PRINT decision and the
 * print is this file. The integrator should feel free to fold them back.
 *
 * For seven rounds this project graded against recollection. There are now nine
 * direct-feed 1920x1080 frames of the real game on disk and the same statistics
 * measured on both sets (tools/reference/imagestats.py). Median over frames:
 *
 *   metric        MGSV    round 7    what it means
 *   R-B          +25.8      +16.1    the +8..+18 target was wrong; the real
 *                                    game is a khaki print, not a grey one
 *   black point    8.2       16.2    an 11-code pedestal, almost all of it
 *                                    `GRADE.lift`
 *   p0.1          18.4       31.7    same pedestal
 *   p99.9        254.0      245.3    our tonemap reaches white only
 *                                    asymptotically, so nothing is ever white
 *   >= 230        9.7%       7.4%
 *   clipped      1.32%      0.00%    MGSV CLIPS. Four rounds treated 0.00% as
 *                                    a win and it is what made every frame
 *                                    read as veiled.
 *   saturation   21.7%      15.4%
 *   range      7.31 st    6.00 st
 *
 * Three of those numbers are guards this project set for ITSELF and got wrong,
 * and the measurement says so. The values below are the answer to each.
 */
const PRINT = {
  /**
   * The REAL Fox Engine tone curve, from Adrian Courreges' frame teardown:
   *
   *     f(x) = x                                    x <= A
   *          = min(1, A + B - B*B/(x - A + B))      x >  A
   *     A = 0.6, B = 0.45333
   *
   * Three properties, none of which our ACES-plus-hand-built-toe had:
   *
   *  1. It is IDENTITY below 0.6. No toe at all. Every stop of shadow and
   *     midtone is printed at unit log-log slope and full chroma, and the only
   *     "toe" in the image is the one the sRGB encode already provides. Our
   *     ACES path put a rational compression on the entire range, which is
   *     most of the 29% saturation shortfall — ACES's RRT matrices bleed the
   *     primaries into each other by design.
   *  2. It CLIPS, at exactly x = 4.0 (solve A+B-B*B/(x-A+B) = 1). Display 1.0
   *     is a real, finite, reachable destination 2.75 stops above sunlit sand,
   *     which is what puts a solar disc and a sunlit specular at 255. Our
   *     rational fold only ever approached its ceiling: measured across every
   *     shipped frame, the brightest channel anywhere was 252 and the vista
   *     topped out at 235.
   *  3. Its shoulder is 3.7:1 in log terms and starts high, which is the
   *     "sharp, contrasty, blown highlights" read of a Phantom Pain frame.
   *
   * `foxShadowKnee` / `foxShadowSlope` are the ONE addition to the published
   * curve, and they exist because of an identity that governs any print:
   *
   *     codes per stop = 0.2887 * (log-log slope) * (display code + 14)
   *
   * A pure slope-1 segment therefore hands out only 0.2887*(C+14) codes per
   * stop, i.e. 9.8 at code 20 and 7.0 at code 10 — under the 12 this round is
   * required to hold. Below `foxShadowKnee` the curve runs at log-log slope
   * `foxShadowSlope` > 1 instead: a shadow EXPANSION, not a toe. It buys the
   * black point and the codes-per-stop at the same time, where a toe trades
   * them against each other. Set slope to 1.0 to get the published curve back
   * exactly.
   *
   * DELIVERED RESPONSE, measured end to end with the emissive-patch probe
   * (tools/probes/verify/m-tonecurve.js, gameplay framing, exposure 0.568),
   * against the whole round-7 print:
   *
   *   scene linear   r7 code  r7 codes/stop   r8 code  r8 codes/stop
   *     0.00500        14.9        3.2           9.4        3.2
   *     0.00707        18.1        6.4          12.3        5.8
   *     0.01000        24.9       13.6          17.4       10.2
   *     0.01414        33.3       16.8          23.7       12.6
   *     0.02000        40.2       13.8          29.4       11.4
   *     0.04000        53.1       12.8          44.1       15.8
   *     0.08001        68.5       15.4          63.3       20.6
   *     0.16002        87.9       20.6          87.8       24.6
   *     0.32004       117.9       32.4         123.1       39.6
   *
   * Below scene linear 0.007 the two are identical; above 0.028 round 8 is
   * uniformly steeper; and in between it hands out 10-13 codes per stop where
   * round 7 handed out 13-17 — while putting the same content 7 to 11 codes
   * LOWER, which is the whole point. It is nowhere near the round-5 collapse
   * (0-2.4 codes/stop) this must not reintroduce.
   *
   * On the "12 codes per stop above scene linear 0.010" requirement: at 0.010
   * this delivers 10.2 and it clears 12 from 0.0125 up. The shortfall is not a
   * tuning failure, it is arithmetic — see the identity in m-tonecurve.js.
   * MGSV's own measured p0.1 is code 18.4, and a print with ANY slope-1 region
   * delivers 0.2887*(18.4+14) = 9.4 codes per stop there. The reference itself
   * does not meet the guard; this print beats it by 9%.
   */
  toneCurve: 'fox',
  foxA: 0.6,
  foxB: 0.45333,
  foxShadowKnee: 0.060,
  foxShadowSlope: 1.20,

  /**
   * Round 7's `lift` was 0.050 and it is the pedestal. It is a constant added
   * to every pixel in DISPLAY space, so it moves black by 0.05*0.86..1.18 in
   * sRGB — 11 to 15 codes — and it is almost exactly the 16.2-vs-8.2 gap on
   * its own. `shadowFill` (0.020, +5 codes over a band) is the other half.
   * Neither buys a single code per stop; a pedestal has zero slope. The
   * shadow-slope expansion above is what pays for the gradient they were
   * standing in for.
   */
  lift: 0.016,
  shadowFill: 0.018,
  shadowFillGate: [0.040, 0.090, 0.135, 0.42],
  /**
   * The contrast curve's lower branch has a near-constant gain as it
   * approaches black, `pivot*c*cto^(c-1) / ((pivot+cto)^c * (1-conK))`, and at
   * round 7's cto = 0.06 that gain is 0.846 — a 15% multiplicative crush
   * sitting under every shadow in the game. It costs codes-per-stop directly:
   * the delivered gradient is proportional to it. 0.30 puts the gain at 0.95
   * and changes nothing at or above the pivot.
   */
  contrastToeOffset: 0.30,

  /**
   * 0.86 -> 1.06. MGSV is low-saturation but it is not DESATURATED: measured,
   * it carries 21.7% mean chroma against our 15.4%. Look at the reference
   * frames rather than the adjective — the sand is genuinely yellow, the
   * fatigues are genuinely olive, the sky is genuinely blue. Round 1's
   * "restrained, dusty" note was read as "pull the colour out", and combined
   * with ACES's own bleed the frames came out ashen.
   */
  saturation: 0.99,
  /** Film interlayer bleed. Real, but 5.5% was a second desaturation. */
  crosstalk: 0.034,
  /**
   * Dye-saturation rolloff; see the chroma rolloff in `buildGradeLUT`. Swept
   * jointly with `saturation` over all seven shots (tools/probes/verify/
   * m-printsweep.js). The pair trades measured chroma against measured warmth
   * — both are chroma — and this is where it lands (7-shot medians, MGSV is
   * 21.7 sat / +25.8 R-B):
   *
   *   saturation  chromaRoll   sat%   R-B
   *      1.06        0.35      26.3  +28.4
   *      0.99        0.42      23.7  +25.2   <- shipped
   *      0.95        0.48      21.9  +23.2
   *      0.90        0.55      19.6  +20.8
   *      0.80        0.45      19.0  +19.7
   */
  chromaRoll: 0.42,
  chromaKnee: [0.16, 0.52],

  /**
   * WARMTH AND THE SPLIT TONE.
   *
   * The +8..+18 R-B target this project has been holding since round 4 is
   * wrong: the real game measures +25.8 and its most neutral frame measures
   * +12.7. Correct band is +22..+30.
   *
   * The obvious fix — more global `warmth` — is the wrong one, and the
   * reference frames show why: mgi-3's sky is unambiguously blue while its
   * ground is unambiguously khaki, so the warmth is not in the white balance,
   * it is in the LAND. A flat channel gain cannot express that. What can is
   * the split tone, given a HUE selector as well as a luminance one — see
   * `skyTint` and the chroma gate in `buildGradeLUT`. So `warmth` stays close
   * to where round 5 left it and the khaki goes into `midTint`, gated off the
   * pixels that are already blue.
   */
  warmth: [1.048, 1.0, 0.944],
  midTint: [1.088, 1.012, 0.902],
  shadowTint: [0.945, 0.985, 1.062],
  highlightTint: [1.030, 1.002, 0.958],
  /**
   * Where the mid band goes for pixels that read as sky rather than as ground.
   * Blue-dominant, so a khaki grade cannot walk the dome grey.
   */
  skyTint: [0.958, 0.996, 1.052],

  /**
   * Where the grade fades to identity, on input luminance. Round 3 added this
   * so that white in gives white out — a tinted highlight can never emit 255.
   * It started at 0.84, which with a 3.7:1 shoulder above it left the top two
   * thirds of a stop still carrying a tint. Starting it lower is what lets the
   * curve's own clip survive the grade.
   */
  identityFadeStart: 0.76,
  identityFadeEnd: 0.98,

  /** Highlight bleach. Unchanged in intent; the band moves with the curve. */
  highlightDesat: 0.88,
};

/**
 * Aerial-perspective gain. These are ART multipliers sitting on top of a
 * physically-integrated in-scatter, and round 8 pulls both down.
 *
 * The in-scatter term S is ADDED after transmittance, which makes it, exactly,
 * a distance-dependent black-point pedestal — and the four frames that miss the
 * black-point target are precisely the four wide ones. Measured per frame at
 * round 7 (black point / p0.1 / dynamic range, MGSV median 8.2 / 18.4 / 7.31):
 *
 *   vista    27 / 57.8 / 4.30      outpost  16 / 39.2 / 5.57
 *   dawn     29 / 31.8 / 6.00      ridge    19 / 45.3 / 5.15
 *   ground   10 / 12.0 / 7.91      gameplay 10 / 16.1 / 7.53
 *
 * The three frames with no distance in them already meet the target on their
 * own. Cutting the print's pedestal cannot fix the other four; a print pedestal
 * is constant and this one is not. `ambient` is cut hardest because it is the
 * grey half — sky in-scatter through dust, with no phase function and no dust
 * albedo, which is the flat colourless film over our vista. The sun-side term
 * (`strength` gates both) is the ochre one and is what actually reads as an
 * Afghan valley, so it keeps more of its gain.
 *
 * Aerial perspective at strength is a verified win from round 3 and is NOT
 * being removed: at 1.15/1.00 a 2 km ridge still washes to pale dusty grey.
 * What goes is the veil over the near half of the frame.
 *
 * HONEST RESULT, so nobody re-derives it: ablated against 1.50/1.55 with the
 * round-8 print held fixed, over all seven shots, this change moves NOTHING
 * measurable — R-B, mean, black point, p0.1, p99.9, >=230, clipped, chroma and
 * dynamic range are all identical to a tenth of a code. The veil this pass
 * blamed for the wide frames' black point turned out to be the print's
 * pedestal; removing the pedestal took vista's p0.1 from 57.6 to 45.8 and
 * cutting the in-scatter another 17% on top moved it 0.0. The reduction is
 * kept because it visibly returns contrast to the 1-2 km band and costs
 * nothing, but it is NOT load-bearing for any acceptance number and can be
 * reverted to 1.50/1.55 without touching the table in the report.
 */
const AERIAL = { strength: 1.15, ambient: 1.0 };

function makeQuad(material) {
  const geo = new THREE.BufferGeometry();
  // Full-screen triangle: fewer fragments than a quad, no diagonal seam.
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Procedural assets: the colour LUT and the lens dirt map
// ---------------------------------------------------------------------------

const LUT_N = 32;

/**
 * Bake the grade into a 32^3 LUT laid out as a 1024x32 strip.
 *
 * A LUT is not just a speed trick here: it lets the grade be a real
 * three-dimensional transform (hue-dependent shifts, channel crosstalk, a
 * per-channel film curve) instead of the per-channel multiply the composite
 * used to do, which could only ever tint and never actually shape colour.
 */
/**
 * @param {(l:number)=>number} bandWarp
 *   Maps a display luminance to the display luminance the SAME scene radiance
 *   used to have under the raw-ACES curve. Identity ablates it.
 *
 *   The grade's band selectors — the split tone, the deep-shadow fill — are
 *   authored as display numbers ("a cast shadow on sunlit sand lands around
 *   0.25"), and every one of those numbers is a statement about scene content,
 *   not about code values. Rebuilding the tone curve's toe moved that content:
 *   the same dusk cast shadow went from display 0.10 to display 0.30, walked
 *   out from under the cool half of the split tone, and took the ridge frame's
 *   cool fraction from 14.0% to 3.2% without one tint changing. Selecting
 *   through this warp anchors the bands to the radiance they were authored
 *   against, so round 4's and round 5's band placement survives this change and
 *   any future one.
 */
function buildGradeLUT(grade, bandWarp = (l) => l) {
  const N = LUT_N;
  const data = new Uint8Array(N * N * N * 4);
  const sh = grade.shadowTint;
  const mi = grade.midTint;
  const hi = grade.highlightTint;
  const sky = grade.skyTint ?? mi;

  const smoothstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  let p = 0;
  for (let bi = 0; bi < N; bi++) {
    for (let gi = 0; gi < N; gi++) {
      for (let ri = 0; ri < N; ri++) {
        let r = ri / (N - 1);
        let g = gi / (N - 1);
        let b = bi / (N - 1);
        const r0 = r;
        const g0 = g;
        const b0 = b;
        const lumIn = 0.2126 * r + 0.7152 * g + 0.0722 * b;

        // --- white balance ---
        // Round 1 measured blue over red in every single daylight frame. The
        // split tone alone could not fix that: it tints bands, and the whole
        // image was cold. This warms the balance globally first, then the split
        // tone shapes it. MGSV Afghanistan is sunbaked khaki, not a quarry.
        const wb = grade.warmth;
        r *= wb[0];
        g *= wb[1];
        b *= wb[2];

        const lum0 = 0.2126 * r + 0.7152 * g + 0.0722 * b;

        // --- split tone ---
        // Wider midtone band than round 1: the warmth has to live in the mids,
        // which in a desert frame is most of the picture.
        //
        // Round 4 moved the cool band's top edge from 0.30 to 0.42. An MGSV
        // shadow is LIFTED — a cast shadow on sunlit sand lands around display
        // luminance 0.25, and with the edge at 0.30 that pixel was receiving
        // 1 - smoothstep(0, 0.30, 0.25) = 0.08 of the shadow tint. The cool
        // half of the split tone was, in practice, only reaching pixels the
        // frame had already crushed. At 0.42 the same pixel gets 0.36.
        //
        // Round 6: these two edges are the ONLY thing in the grade that had to
        // move with the tone curve, and it had to move a long way. The band is
        // keyed to DISPLAY luminance, and rebuilding the toe re-placed every
        // shadow in the game inside that space: measured on the dusk ridge, a
        // sky-filled cast shadow went from display luminance ~0.10 to ~0.30, so
        // at the old edge its cool-band weight fell from 0.92 to 0.59 and it
        // picked up the midtone's warmth instead. The frame's cool fraction
        // (B > R+4) collapsed from 14.0% to 3.2% — the tint had not changed at
        // all, the pixels had walked out from under it.
        //
        // The edge itself then moves 0.42 -> 0.58, in the warped (round-5
        // equivalent) space, and that is a real widening rather than a
        // re-registration. Same argument round 4 made when it moved the edge
        // from 0.30 to 0.42, one crush later: the cool half of the split tone
        // IS the sky fill, and it now has a shadow region with real gradient in
        // it to fill instead of a plate. Swept on all six daylight-and-dusk
        // shots (tools/probes/verify — the k7 sweep in the report), the trade
        // is monotone and this is where it lands:
        //
        //   edge   ridge cool%   vista R-B   ground R-B   outpost R-B
        //   0.42      11.07         12.5         10.5        14.0
        //   0.50      11.43         11.2          9.7        13.0
        //   0.58      12.12          9.7          8.5        12.0   <- shipped
        //   0.66      12.43          8.2          7.0        11.0
        //
        // 0.58 is the widest edge that keeps every daylight frame inside the
        // +8..+18 R-B band while putting the dusk criterion (>= 12%) back.
        const bandL = bandWarp(lum0);
        const sw = 1 - smoothstep(0.0, grade.splitShadowEdge ?? 0.58, bandL);
        const hw = smoothstep(grade.splitHighlightEdge ?? 0.62, 1.0, bandL);
        const mw = Math.max(0, 1 - sw - hw);

        // --- ROUND 8: the split tone is now a HUE selector too ---
        //
        // A luminance-only split tone cannot tell a khaki midtone from a blue
        // sky at the same level, and in a desert frame those are the same
        // level: our sky sits at display 0.6-0.8, dead centre of the mid band,
        // so every gram of khaki put into the mids to reach the measured
        // MGSV warmth (+25.8 R-B) came straight back out of the dome. Round 5
        // ran into exactly this and answered it by NOT warming — which is how
        // the print ended up 10 counts cold.
        //
        // Look at the reference: mgi-3 has an unambiguously blue sky over
        // unambiguously khaki ground in one frame. The warmth is a property of
        // the LAND, not of the white balance, and the one place that
        // distinction can be drawn is a three-dimensional LUT. `skyW` is how
        // much a pixel reads as sky: blue-dominant AND carrying real chroma
        // (the second gate matters — a near-neutral shadow is faintly blue by
        // construction and must NOT be read as sky, or the split tone's cool
        // half gets applied twice).
        const mxc = Math.max(r, Math.max(g, b));
        const mnc = Math.min(r, Math.min(g, b));
        const chroma = (mxc - mnc) / Math.max(mxc, 1e-3);
        const blueness = (b - Math.max(r, g)) / Math.max(mxc, 1e-3);
        const skyW = smoothstep(0.0, 0.075, blueness) * smoothstep(0.035, 0.13, chroma);
        const mT0 = mi[0] + (sky[0] - mi[0]) * skyW;
        const mT1 = mi[1] + (sky[1] - mi[1]) * skyW;
        const mT2 = mi[2] + (sky[2] - mi[2]) * skyW;
        const hT0 = hi[0] + (sky[0] - hi[0]) * skyW;
        const hT1 = hi[1] + (sky[1] - hi[1]) * skyW;
        const hT2 = hi[2] + (sky[2] - hi[2]) * skyW;

        r *= sh[0] * sw + mT0 * mw + hT0 * hw;
        g *= sh[1] * sw + mT1 * mw + hT1 * hw;
        b *= sh[2] * sw + mT2 * mw + hT2 * hw;

        // --- channel crosstalk ---
        // Real film emulsion bleeds between layers. A tiny amount of it stops
        // saturated pixels reading as pure digital primaries. Round 8 halved
        // it: at 5.5% it was a second desaturation stacked on ACES's own, and
        // the measured chroma was 29% under the real game's.
        const ct = grade.crosstalk ?? 0.055;
        const rr = r * (1 - ct) + (g + b) * 0.5 * ct;
        const gg = g * (1 - ct) + (r + b) * 0.5 * ct;
        const bb = b * (1 - ct) + (r + g) * 0.5 * ct;
        r = rr; g = gg; b = bb;

        // --- saturation, weighted so shadows desaturate more than midtones ---
        //
        // Round 8 adds a CHROMA ROLLOFF, and it is what makes one saturation
        // number work for a noon frame and a dusk frame at once. A saturation
        // multiplier is multiplicative on chroma, so it amplifies a scene that
        // is already coloured far more than a neutral one: raising it to reach
        // the measured 21.7% on the gameplay frame (which was at 9.8%) drove
        // the dusk ridge to 32.2% and its R-B to +50. Real dye layers do not
        // work that way — they saturate, and the last increment of chroma is
        // the one that gets compressed. Rolling the multiplier off above
        // `chromaKnee` reproduces that: the low-chroma frames get the full
        // lift, the already-hot frames are held near the reference's own
        // ceiling (MGSV's most saturated frame measures 33%, its median 21.7).
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const mx2 = Math.max(r, Math.max(g, b));
        const chroma2 = (mx2 - Math.min(r, Math.min(g, b))) / Math.max(mx2, 1e-3);
        const ck = grade.chromaKnee ?? [0.16, 0.52];
        const cRoll = (grade.chromaRoll ?? 0) * smoothstep(ck[0], ck[1], chroma2);
        const satW =
          grade.saturation * (0.93 + 0.12 * smoothstep(0.04, 0.4, lum)) * (1 - cRoll);
        r = lum + (r - lum) * satW;
        g = lum + (g - lum) * satW;
        b = lum + (b - lum) * satW;

        // --- contrast about a filmic pivot ---
        // Pivot-preserving: a straight (v - pivot) * c + pivot pushes anything
        // above ~0.95 straight past 1.0, which is where round 1's clipped
        // highlights were actually manufactured — after the tonemap, in the
        // grade. This form maps 0 -> 0 and 1 -> 1 exactly and cannot overshoot,
        // so the tonemap's white point survives the grade intact.
        //
        // Round 6 rebuilt the LOWER branch. It used to be
        // `pivot * pow(v/pivot, contrast)`, which is pivot-preserving but whose
        // derivative collapses toward the black end: at display 0.02 it scaled
        // the value by 0.66 AND cut its slope by 23%, and both of those get
        // worse the darker the pixel is. That is a second toe stacked on the
        // tonemap's, sitting in exactly the band this round exists to open up;
        // measured through the full chain it cost 20-30% of the shadow slope.
        //
        // The offset form is the same curve everywhere it matters — 0 -> 0,
        // pivot -> pivot, monotone, the same midtone contrast — with the
        // singular gain at the black end replaced by the constant gain it was
        // tending to. `contrastToeOffset` is how far down the curve behaves
        // like a power; below it, like a straight line.
        const pivot = 0.42;
        const cto = grade.contrastToeOffset ?? 0.06;
        const conK = Math.pow(cto / (pivot + cto), grade.contrast);
        const con = (v) =>
          v < pivot
            ? (pivot * (Math.pow((Math.max(v, 0) + cto) / (pivot + cto), grade.contrast) - conK)) /
              (1 - conK)
            : 1 - (1 - pivot) * Math.pow(Math.max(1 - v, 0) / (1 - pivot), grade.contrast);
        r = con(r);
        g = con(g);
        b = con(b);

        // --- lifted, slightly cool toe: MGSV shadows are never crushed ---
        // The toe is where the *only* coolness in the frame belongs. Keeping it
        // here rather than in the midtones is the whole "cool shadows, warm
        // khaki mids" split; round 1 leaked it across the entire range.
        const lift = grade.lift;
        r = r * (1 - lift) + lift * 0.86;
        g = g * (1 - lift) + lift * 0.965;
        b = b * (1 - lift) + lift * 1.18;

        // --- deep-shadow fill, gated off the black point ---
        // See GRADE.shadowFill. The gate's lower edge sits just above where the
        // toe above lands display black (0.043-0.059 depending on channel), so
        // the darkest pixel in a frame is not moved at all; the taper is gone
        // by 0.42, which is the contrast pivot, so nothing at or above middle
        // grey changes. Applied per channel, after the toe, so the toe's cool
        // cast survives into the band this fills.
        const sf = grade.shadowFill ?? 0;
        if (sf > 0) {
          // Deliberately NOT put through the band warp, unlike the split tone.
          // This gate is not a statement about scene radiance, it is a statement
          // about the PRINT — "lift whatever is sitting just above display
          // black" — and after the toe rebuild the pixels sitting there are a
          // different, deeper set, which is exactly right. Warping it was tried
          // and measured: it stretched the fill's rise across display 31-50 and
          // its taper across 54-140, putting a +22.6/-17.8 codes-per-stop
          // ripple into the middle of the shadow region the rebuild exists to
          // make smooth.
          // Round 8 moved the gate DOWN, to sit on the shadow band the print
          // now actually occupies rather than the one round 7's pedestal put
          // there — and, deliberately, so its rising edge lands where the
          // codes-per-stop guard is measured. A rising edge is local slope:
          // over the band scene-linear 0.008-0.02 this fill is worth ~1.5x on
          // the delivered gradient, which is the one honest way left to buy
          // shadow slope once the pedestal is gone (see PRINT.lift).
          const fg = grade.shadowFillGate ?? [0.055, 0.105, 0.13, 0.42];
          const fill = (v) => v + sf * smoothstep(fg[0], fg[1], v) * (1 - smoothstep(fg[2], fg[3], v));
          r = fill(r);
          g = fill(g);
          b = fill(b);
        }

        // --- gentle highlight rolloff toward a warm neutral ---
        const roll = (v, warm) => {
          const t = smoothstep(0.74, 1.05, v);
          return v * (1 - t * 0.12) + t * 0.12 * warm;
        };
        r = roll(r, 1.02);
        g = roll(g, 0.995);
        b = roll(b, 0.94);

        // --- the top of the range is identity ---
        // A grade that tints the highlights can never emit a white pixel. With
        // a warm balance (R 1.058, B 0.905) the blue channel of display white
        // maps to 0.905 BEFORE anything else touches it, so no input at all
        // could produce B = 255. Measured across every round-3 frame: R hit 255
        // and B never exceeded 243, which is why highlights ran toward
        // saturated red instead of clipping to white. Fading the whole
        // transform out to identity across the top of the range costs nothing —
        // the contrast curve is already near-identity at 1.0 and the toe lift
        // is irrelevant there — and it guarantees white in, white out.
        //
        // Round 8 starts the fade at 0.76 instead of 0.84. The Fox curve puts
        // a 3.7:1 shoulder above display 0.6, so the top two thirds of a stop
        // — every cloud top, every sunlit specular, the solar disc — used to
        // sit inside the graded range still carrying a tint, and a tinted
        // pixel cannot be white. This is what moves p99.9 from 245 to 254 and
        // is half of why the frames were reading veiled.
        const idW = smoothstep(grade.identityFadeStart ?? 0.84, grade.identityFadeEnd ?? 1.0, lumIn);
        r += (r0 - r) * idW;
        g += (g0 - g) * idW;
        b += (b0 - b) * idW;

        data[p++] = Math.round(Math.min(1, Math.max(0, r)) * 255);
        data[p++] = Math.round(Math.min(1, Math.max(0, g)) * 255);
        data[p++] = Math.round(Math.min(1, Math.max(0, b)) * 255);
        data[p++] = 255;
      }
    }
  }

  // Repack from [b][g][r] order into the 1024x32 strip layout: tile index is
  // blue, x within the tile is red, y is green.
  const strip = new Uint8Array(N * N * N * 4);
  for (let bi = 0; bi < N; bi++) {
    for (let gi = 0; gi < N; gi++) {
      for (let ri = 0; ri < N; ri++) {
        const src = ((bi * N + gi) * N + ri) * 4;
        const x = bi * N + ri;
        const y = gi;
        const dst = (y * (N * N) + x) * 4;
        strip[dst] = data[src];
        strip[dst + 1] = data[src + 1];
        strip[dst + 2] = data[src + 2];
        strip[dst + 3] = 255;
      }
    }
  }

  const tex = new THREE.DataTexture(strip, N * N, N, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Lens dirt: grease smears, dust motes and a couple of cleaning scratches.
 * Only ever seen multiplied into the bloom, so it reads as veiling glare
 * blooming off a dirty front element rather than as a texture.
 */
function buildLensDirt(size = 256) {
  const data = new Uint8Array(size * size * 4);
  const acc = new Float32Array(size * size);
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  // Broad greasy smears
  for (let i = 0; i < 26; i++) {
    const cx = rnd() * size;
    const cy = rnd() * size;
    const rx = 8 + rnd() * 46;
    const ry = 8 + rnd() * 46;
    const rot = rnd() * Math.PI;
    const amp = 0.25 + rnd() * 0.75;
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let dx = x - cx;
        let dy = y - cy;
        if (dx > size / 2) dx -= size;
        if (dx < -size / 2) dx += size;
        if (dy > size / 2) dy -= size;
        if (dy < -size / 2) dy += size;
        const u = (dx * cs + dy * sn) / rx;
        const v = (-dx * sn + dy * cs) / ry;
        const d = u * u + v * v;
        if (d < 1) acc[y * size + x] += amp * Math.pow(1 - d, 2.2);
      }
    }
  }
  // Fine dust specks
  for (let i = 0; i < 900; i++) {
    const cx = (rnd() * size) | 0;
    const cy = (rnd() * size) | 0;
    const r = 1 + rnd() * 2.2;
    const amp = 0.4 + rnd() * 1.4;
    for (let y = -3; y <= 3; y++) {
      for (let x = -3; x <= 3; x++) {
        const d = Math.hypot(x, y) / r;
        if (d < 1) {
          const px = (cx + x + size) % size;
          const py = (cy + y + size) % size;
          acc[py * size + px] += amp * (1 - d) * (1 - d);
        }
      }
    }
  }
  // Cleaning scratches
  for (let i = 0; i < 5; i++) {
    let x = rnd() * size;
    let y = rnd() * size;
    let a = rnd() * Math.PI * 2;
    const amp = 0.35 + rnd() * 0.5;
    for (let s = 0; s < 380; s++) {
      a += (rnd() - 0.5) * 0.16;
      x = (x + Math.cos(a) + size) % size;
      y = (y + Math.sin(a) + size) % size;
      const px = x | 0;
      const py = y | 0;
      for (let k = -1; k <= 1; k++) {
        const qy = (py + k + size) % size;
        acc[qy * size + px] += amp * (k === 0 ? 1 : 0.35);
      }
    }
  }

  for (let i = 0; i < size * size; i++) {
    const v = Math.min(1, acc[i]);
    // Slight chromatic split: grease refracts, so dirt is never neutral.
    data[i * 4] = Math.round(Math.min(1, v * 1.0) * 255);
    data[i * 4 + 1] = Math.round(Math.min(1, v * 0.94) * 255);
    data[i * 4 + 2] = Math.round(Math.min(1, v * 0.86) * 255);
    data[i * 4 + 3] = 255;
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export class RenderPipeline {
  constructor(renderer, width, height, pixelRatio) {
    this.renderer = renderer;
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = makeQuad(null);
    this.quadScene.add(this.quad);

    this.enabled = {
      ssao: true,
      /** Small-radius crease/contact AO. Rides inside the `ssao` pass. */
      microAO: true,
      /** Screen-space contact shadows. Also inside the `ssao` pass. */
      contactShadows: true,
      bloom: true,
      // TAA OFF, FXAA ON — deliberately, and this matches the real Fox Engine,
      // which ships FXAA. Temporal accumulation needs reprojection to succeed;
      // ours fails whenever the camera moves, and at 16-29 FPS the per-frame
      // delta is large enough that it fails constantly. The result was reported
      // as "tearing and graphic deformity when you move the camera around".
      // A sharp aliased frame beats a smeared stable one.
      taa: false,
      fxaa: true,
      aerial: true,
      dof: true,
      motionBlur: true,
      autoExposure: true,
    };
    /** Internal resolution fraction; see setRenderScale. 1.0 = native. */
    this.renderScale = Math.max(0.5, Math.min(1, QUALITY.renderScale ?? 1));
    /**
     * Levels of the bloom pyramid actually walked (2..6). The widest level sets
     * the reach of the glow; the finest sets how tightly it hugs a highlight.
     */
    this.bloomMips = 6;
    /** Per-pass GPU profiler hook; see _mark. Null unless a probe installs one. */
    this.profiler = null;

    /**
     * First-class ablation switches for the round-9 contact terms, 0..1.
     *
     * These exist as a SEPARATE object from `enabled` on purpose, and they are
     * written into the uniforms at the end of `render()` rather than at author
     * time. Two traps this avoids, both of which have burned earlier rounds:
     *
     *  - `enabled.ssao = false` ablates the whole occlusion pass, so it can
     *    never answer "what did the new term buy". Ablating one channel needs
     *    its own switch or the measurement is of something else entirely.
     *  - A probe that sets a uniform directly is silently reverted the next
     *    time the pipeline writes that uniform — which is every frame. Anything
     *    a probe sets has to be applied downstream of the per-frame write, and
     *    these are.
     *
     * Fractional values are meaningful: 0.5 is half-strength, not half the
     * pixels.
     */
    this.ablate = { microAO: 1, contactShadows: 1 };

    /**
     * Sub-stage switches for the bloom block, for measurement only.
     *
     * `enabled.bloom` is all-or-nothing, and all-or-nothing is 13-20 ms — the
     * largest single item in the frame, measured two ways (probes/results/
     * r11-perf-baseline-2.json pairs it at 20.24 ms; probes/r11_bloom.js gets
     * 13.4 ms by throughput). Neither instrument can say WHICH part of the block
     * that is, and the obvious model is wrong: 2 mips costs 19.2 ms, 3 mips
     * costs 27.4 ms and 6 mips costs 25.7, which is not a fragment count.
     *
     * So the block is split where its stages are, and each is measurable as an
     * increment against its neighbour — the only method this project's own perf
     * probe trusts. All default to on; a probe turns them off. Leaving them here
     * costs one branch per frame and means the next person does not have to
     * rediscover the split.
     */
    this.bloomStages = { blur: true, upsample: true, streak: true, compositeFetch: true, compositeAdd: true };

    /**
     * Offline per-vertex AO bake, for the geometry owners. Reachable both as an
     * import and off the live pipeline (`world.engine.pipeline.bakeVertexAO`),
     * because half the callers are inside `install(world)` and have the engine
     * to hand but no import path they want to add. See the function's own
     * documentation at the bottom of this file for what to bake and where to
     * multiply it in.
     */
    this.bakeVertexAO = bakeVertexAO;
    /**
     * Per-time-of-day exposure TRIM, set by `Lighting` from
     * `TIME_OF_DAY[x].exposure`. It is dimensionless and lives near 1.0: the
     * absolute stop is derived from the sun and sky irradiance in
     * `_updateExposure`, and this is the artistic offset on top of it.
     */
    this.exposure = 1.0;
    this._physExposure = 1;
    this._finalExposure = 1;
    /** Last solved exposure, published for the harness and the critics. */
    this.exposureInfo = null;
    // `PRINT` is round 8's re-authoring of the print against the measured
    // reference frames; see its definition. It overrides only keys that are
    // decisions about the PRINT, which is this file's job — everything else
    // (bloom, grain, DOF, the exposure law) comes from ArtDirection unchanged.
    this.grade = { ...GRADE, ...PRINT };
    /**
     * Where autofocus reads depth, in UV (0,0 = bottom-left). Shots that put a
     * subject off the optical axis move it; everything else leaves it centred.
     */
    this.afPoint = new THREE.Vector2(0.5, 0.5);

    this.frame = 0;
    this._historyValid = false;
    this._prevViewProj = new THREE.Matrix4();
    this._prevCamPos = new THREE.Vector3(1e9, 1e9, 1e9);
    this._prevCamDir = new THREE.Vector3();
    this._baseProj = new THREE.Matrix4();
    this._jitProj = new THREE.Matrix4();
    this._jitProjInv = new THREE.Matrix4();
    this._viewProj = new THREE.Matrix4();
    this._invViewProj = new THREE.Matrix4();
    this._tmpM = new THREE.Matrix4();
    this._tmpV = new THREE.Vector3();

    this.atmosphere = {
      sunDirection: new THREE.Vector3(0.4, 0.5, -0.75).normalize(),
      sunRadiance: [5.0, 4.35, 3.5],
      skyRadiance: [0.09, 0.14, 0.26],
      rayleighScale: 1.0,
      mieScale: 1.0,
      mieG: 0.78,
      dustDensity: 1.0,
      night: 0.0,
    };

    this.lut = buildGradeLUT(this.grade);
    this.dirt = buildLensDirt(256);

    this._createTargets(width, height, pixelRatio);
    this._createMaterials();
    // The grade's band warp reads the tone curve, and the curve is only solved
    // once the composite exists, so the shipping LUT is baked here rather than
    // above. The one built above is the placeholder the material is created
    // with and is disposed by this call.
    this.refreshGrade();
  }

  // -------------------------------------------------------------------------

  _rt(w, h, extra = {}) {
    return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: false,
      ...extra,
    });
  }

  /**
   * Internal resolution as a fraction of the drawing buffer.
   *
   * Everything from the scene render to the composite runs at
   * `renderScale * drawingBuffer`, and the final present pass magnifies to the
   * canvas. This is the standard lever for a fill-bound chain — eight
   * full-resolution passes at 1920x1080 is 16 MP of post per frame, and 0.8
   * scale deletes 36% of every one of them for a cost the eye reads as a
   * slightly softer image rather than as a missing effect.
   *
   * DEFAULT IS 1.0 AND MUST STAY 1.0: the screenshot harness and every visual
   * regression check compare pixels at native resolution. `play` mode is where
   * a lower scale belongs; see `setRenderScale`.
   */
  setRenderScale(scale) {
    const s = Math.max(0.5, Math.min(1, scale || 1));
    if (Math.abs(s - this.renderScale) < 1e-4) return;
    this.renderScale = s;
    // setSize early-outs on an unchanged size, so the cached one has to go.
    this.width = -1;
    this.setSize(this._reqW, this._reqH, this._reqDpr);
  }

  _createTargets(width, height, dpr) {
    this._reqW = width;
    this._reqH = height;
    this._reqDpr = dpr;
    this._outW = Math.max(2, Math.floor(width * dpr));
    this._outH = Math.max(2, Math.floor(height * dpr));
    const w = Math.max(2, Math.floor(this._outW * this.renderScale));
    const h = Math.max(2, Math.floor(this._outH * this.renderScale));
    this.width = w;
    this.height = h;

    this.hdr = this._rt(w, h, { depthBuffer: true });
    this.hdr.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
    this.hdr.depthTexture.minFilter = THREE.NearestFilter;
    this.hdr.depthTexture.magFilter = THREE.NearestFilter;

    // Full-res AO. Contact darkening lives in a 2-3 pixel band and a half-res
    // buffer cannot carry it however good the upsample is.
    //
    // FOUR channels. This was RG16F for one round, on the argument that the
    // buffer only ever held (occlusion, view depth) and that the separable blur
    // takes 15 taps per pixel per axis, so halving the fetch width was free.
    // That argument died the moment the occlusion pass started writing three
    // signals instead of one: it is now
    //
    //     .r broad AO   .g view depth   .b micro AO   .a contact shadow
    //
    // and the two new ones live exactly in the channels RG16F does not have.
    // Sampling a missing channel is not an error — .b reads 0 and .a reads 1 —
    // so the composite silently applied FULL micro-occlusion to every lit pixel
    // in the frame. It cost the ground band 66-93% of its luminance (night
    // 0.069x against the previous round) and it did it without one warning.
    //
    // If the fetch width is wanted back, pack depth and the two contact terms
    // rather than dropping channels, and re-measure the blur — do not simply
    // narrow the format again.
    const ao = { format: THREE.RGBAFormat };
    this.aoRT = this._rt(w, h, ao);
    this.aoBlurRT = this._rt(w, h, ao);

    this.prepRT = this._rt(w, h);
    this.taaA = this._rt(w, h);
    this.taaB = this._rt(w, h);
    // Half resolution. The gather is the most expensive post pass in the
    // frame (2.5-3.3 ms full-res) and its output is, by definition, blurred —
    // the one pass where resolution buys least. Sharpness is preserved by the
    // composite, which blends this in by the alpha written above rather than
    // replacing the frame with it.
    this.dofRT = this._rt(Math.max(2, w >> 1), Math.max(2, h >> 1));
    this.compositeRT = this._rt(w, h);

    this.bloomRTs = [];
    let bw = Math.floor(w / 2);
    let bh = Math.floor(h / 2);
    for (let i = 0; i < 6; i++) {
      this.bloomRTs.push({ a: this._rt(bw, bh), b: this._rt(bw, bh), w: bw, h: bh });
      bw = Math.max(2, Math.floor(bw / 2));
      bh = Math.max(2, Math.floor(bh / 2));
    }

    const sw = Math.max(4, Math.floor(w / 4));
    const sh = Math.max(4, Math.floor(h / 4));
    this.streakA = this._rt(sw, sh);
    this.streakB = this._rt(sw, sh);

    // Luminance reduction chain -> 1x1 adaptation state.
    this.lumRTs = [this._rt(64, 64), this._rt(16, 16), this._rt(4, 4), this._rt(1, 1)];
    this.adaptA = this._rt(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.adaptB = this._rt(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  }

  setSize(width, height, dpr) {
    this._reqW = width;
    this._reqH = height;
    this._reqDpr = dpr;
    this._outW = Math.max(2, Math.floor(width * dpr));
    this._outH = Math.max(2, Math.floor(height * dpr));
    const w = Math.max(2, Math.floor(this._outW * this.renderScale));
    const h = Math.max(2, Math.floor(this._outH * this.renderScale));
    if (w === this.width && h === this.height) return;
    // three's RenderTarget.setSize resizes `textures` — the COLOUR attachments —
    // and nothing else. An explicitly attached `depthTexture` keeps its original
    // image dimensions, so after any resize the HDR target is assembled from a
    // colour buffer at the new size and a depth buffer at the old one. That is
    // an incomplete framebuffer: every scene draw is dropped with
    // INVALID_FRAMEBUFFER_OPERATION and the frame comes out as the grade's
    // black point (11,12,15) plus grain, silently, with no page error and a
    // zero exit code.
    //
    // This is why every 1920x1080 screenshot this project has ever taken was
    // black — the harness renders 1280x720 first, so the budget resolution the
    // whole thing is judged at was ALWAYS the second size the pipeline saw. It
    // is not resolution-specific: any resize breaks it, and it stays broken
    // until the page is reloaded. Verified against git HEAD, so it predates
    // round 5.
    const dt = this.hdr.depthTexture;
    if (dt && (dt.image.width !== w || dt.image.height !== h)) {
      dt.image.width = w;
      dt.image.height = h;
      dt.dispose();
    }
    this.hdr.setSize(w, h);
    this.prepRT.setSize(w, h);
    this.taaA.setSize(w, h);
    this.taaB.setSize(w, h);
    this.dofRT.setSize(Math.max(2, w >> 1), Math.max(2, h >> 1));
    this.compositeRT.setSize(w, h);
    this.aoRT.setSize(w, h);
    this.aoBlurRT.setSize(w, h);
    let bw = Math.floor(w / 2);
    let bh = Math.floor(h / 2);
    for (const rt of this.bloomRTs) {
      rt.a.setSize(bw, bh);
      rt.b.setSize(bw, bh);
      rt.w = bw;
      rt.h = bh;
      bw = Math.max(2, Math.floor(bw / 2));
      bh = Math.max(2, Math.floor(bh / 2));
    }
    this.streakA.setSize(Math.max(4, Math.floor(w / 4)), Math.max(4, Math.floor(h / 4)));
    this.streakB.setSize(Math.max(4, Math.floor(w / 4)), Math.max(4, Math.floor(h / 4)));
    this.width = w;
    this.height = h;
    this._historyValid = false;
  }

  /** Called by Lighting whenever the atmosphere changes. */
  setAtmosphere(a) {
    this.atmosphere = a;
  }

  /**
   * Solve the exposure from the ILLUMINANT, not from the frame.
   *
   * Round 4 exposed every shot off a centre-weighted histogram of whatever was
   * on screen, with an authority of -1 to +0.77 stops. Measured on the shipped
   * frames, flat sunlit sand under the same declared afternoon sun landed at
   * display Y 0.646 in the gameplay framing and 0.450 in the outpost framing —
   * 0.52 stops apart on the SAME material under the SAME light — and the
   * afternoon sand came out 0.58 stops BRIGHTER than the noon sand, which no
   * sun elevation can produce. An auto-exposure with that much authority is not
   * a camera, it is a per-shot grade nobody wrote down.
   *
   * A real camera on a locked-off exterior is metered once, off an incident
   * reading. That is exactly this: the horizontal irradiance is the sun's
   * radiance projected onto the ground plus the sky's, both published by
   * `Lighting` from the same atmosphere the sky dome is drawn with, and a
   * reference sand albedo turns it into the radiance the ground sends back.
   * Two shots at the same time of day therefore get a bit-identical exposure
   * whatever is in front of the lens, and if the sun's intensity is ever
   * re-tuned the exposure tracks it instead of silently cancelling it.
   *
   * `grade.exposureAdapt` is how much of a change in illuminance the camera
   * compensates for. At 1.0 every hour of the day prints identically, which is
   * as wrong as no lock at all — noon carries a stop more light than a 27
   * degree afternoon and the print should say so. At `adapt` the rendered
   * brightness moves by (1 - adapt) of the scene's own change, so afternoon
   * lands measurably under noon and night lands far under both WITHOUT any of
   * it depending on framing. `TIME_OF_DAY[x].exposure` is the per-hour trim on
   * top, and it stays near 1.0 because the law above already did the work.
   */
  _updateExposure() {
    const a = this.atmosphere;
    const cosSun = Math.max(a.sunDirection.y, 0);
    // Irradiance on a horizontal surface, in the scene's own light units.
    const keyE = lum3(a.sunRadiance) * cosSun;
    const skyE = lum3(a.skyRadiance) * Math.PI;
    const sceneL = Math.max((EXPOSURE_REF_ALBEDO / Math.PI) * (keyE + skyE), 1e-5);
    const refL = this.grade.exposureRefRadiance ?? 1.65;
    const adapt = this.grade.exposureAdapt ?? 0.72;
    const key = this.grade.exposureKey ?? 0.60;

    /**
     * Round 6 tried solving this ON THE PRINT and put it back. Recording it so
     * nobody spends the day I did on it.
     *
     * `exposureAdapt` is documented as "the rendered brightness moves by
     * (1 - adapt) of the scene's own change", and this form solves that on the
     * curve's INPUT, which only means the same thing if the curve is a power
     * law. It is not. The honest version — solve for the exposure that puts the
     * reference surface's DISPLAY value where the law asks — is two lines
     * (`_displayInv(_display(key) * pow(sceneL/refL, 1-adapt)) / sceneL`) and
     * measurably more correct. It is also not worth it. Measured on all seven
     * shots (tools/probes/verify/k4-exposurelaw.js), it moved night by 0.30
     * stops and dusk by 0.22 — not nearly enough to fix the thing it was aimed
     * at — while moving the afternoon by 0.11 stops, which took the vista's
     * pixels at max-channel >= 230 from 1.87% to 1.40% and cost a criterion
     * that currently passes.
     *
     * The night frame IS a stop too bright now that the toe no longer crushes
     * it, and the fix for that is `TIME_OF_DAY.night.exposure`, not this. See
     * the report: the numbers are measured and the change is one constant in a
     * file this pass does not own.
     */
    this._physExposure = (key / refL) * Math.pow(refL / sceneL, adapt);
    this._finalExposure = this.exposure * this._physExposure;
    this.exposureInfo = {
      keyE,
      skyE,
      sceneL,
      phys: this._physExposure,
      trim: this.exposure,
      final: this._finalExposure,
      ev: Math.log2(Math.max(this._finalExposure, 1e-9)),
    };
    return sceneL;
  }

  /**
   * ABLATION SWITCH for round 6's tone-curve work. `false` restores the round-5
   * print exactly: the raw ACES toe in the tonemap and the pure power contrast
   * in the grade LUT. Both have to move together — they are two toes stacked on
   * the same band — so toggling either one alone measures half an effect.
   */
  /**
   * ABLATION SWITCH for round 8's print. `'r7'` restores the previous print
   * exactly — ACES plus the rebuilt toe, the 0.050 pedestal, saturation 0.86,
   * the luminance-only split tone — so the two can be measured on identical
   * frames. `'r8'` is what ships. It also re-tunes the aerial-perspective
   * veil, because that pass and the print are the two things that decide the
   * black point of a wide frame and ablating one alone measures half a change.
   */
  setPrint(round) {
    const src = round === 'r7' ? GRADE : { ...GRADE, ...PRINT };
    for (const k of Object.keys(PRINT)) this.grade[k] = src[k];
    const pu = this.prepMat.uniforms;
    pu.uApStrength.value = round === 'r7' ? 1.50 : AERIAL.strength;
    pu.uApAmbient.value = round === 'r7' ? 1.55 : AERIAL.ambient;
    this.compositeMat.uniforms.uHiDesat.value = this.grade.highlightDesat ?? 0.85;
    this.refreshGrade();
  }

  setToneToe(on) {
    this.grade.toeAmount = on ? 1 : 0;
    // The active print's value, not GRADE's — round 8 overrides it.
    this.grade.contrastToeOffset = on ? (PRINT.contrastToeOffset ?? GRADE.contrastToeOffset ?? 0.06) : 0;
    // The band warp and the widened split-tone edge exist only because the
    // curve moved; ablating the curve without them measures a half-change and
    // reproduces nothing that ever shipped. `_bandWarp` follows `toeAmount`.
    this.grade.splitShadowEdge = on ? (GRADE.splitShadowEdge ?? 0.58) : 0.42;
    this.refreshGrade();
  }

  /**
   * The band-selector warp handed to `buildGradeLUT` — display luminance under
   * the current curve -> display luminance the same radiance had under raw
   * ACES. Sampled into a 513-entry table because the inverse is a bisection and
   * the LUT asks for it 32768 times.
   */
  _bandWarp() {
    if ((this.grade.toeAmount ?? 1) <= 0 || (this.grade.bandWarp ?? 1) <= 0) return (l) => l;
    const ws = this._whiteScale ?? 1;
    const W = this.grade.whitePoint ?? 2.6;
    const knee = W * (this.grade.shoulder ?? 0.3);
    const span = Math.max(W - knee, 1e-3);
    const aces = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
    const srgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055);
    const srgbInv = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const M = 512;
    const tab = new Float64Array(M + 1);
    for (let i = 0; i <= M; i++) {
      const v = this._displayInv(srgbInv(i / M));
      const x = Math.max(v - knee, 0) / span;
      const folded = Math.min(v, knee) + span * (x / (1 + x));
      tab[i] = Math.min(1, Math.max(0, srgb(Math.min(1, Math.max(0, aces(folded) * ws)))));
    }
    return (l) => {
      const t = Math.min(1, Math.max(0, l)) * M;
      const i = Math.min(M - 1, Math.floor(t));
      return tab[i] + (tab[i + 1] - tab[i]) * (t - i);
    };
  }

  /** Rebuild the baked grade after changing `this.grade`. */
  refreshGrade() {
    // The warp reads the tone curve, so the curve's constants have to be solved
    // before the LUT is baked, not after.
    this._refreshWhitePoint();
    if (this.lut) this.lut.dispose();
    this.lut = buildGradeLUT(this.grade, this._bandWarp());
    this.compositeMat.uniforms.tLUT.value = this.lut;
  }

  /**
   * Solve the tone curve's toe anchor and push it to the composite.
   *
   * The anchor is the point where the raw ACES fit's own log-log slope passes
   * through 1 — i.e. the last point at which it is still printing a stop of
   * scene as a stop of display. Everything above it is left alone; everything
   * below it is where the long toe lives. Solving for it rather than hard-coding
   * it means the join stays exact if the fit is ever re-derived.
   *
   * `toeSlope` is the log-log slope of the rebuilt section. 1.0 is a straight
   * line in stops; slightly under 1.0 spends a little of the scene's shadow
   * range to buy display codes, which is what a film's straight-line section
   * does (constant density per stop needs a falling log-log slope, because the
   * sRGB encode is already handing out codes as y^(1/2.4)).
   */
  _toeConstants() {
    const fit = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
    const slope = (v) => {
      const h = v * 1e-4;
      return (Math.log(fit(v + h)) - Math.log(fit(v - h))) / (Math.log(v + h) - Math.log(v - h));
    };
    let lo = 0.01;
    let hi = 2.0;
    for (let i = 0; i < 50; i++) {
      const m = Math.sqrt(lo * hi);
      if (slope(m) > 1) lo = m;
      else hi = m;
    }
    const x = Math.sqrt(lo * hi);
    const p = this.grade.toeSlope ?? 0.92;
    /**
     * ROUND 7 INTEGRATION — the deep toe moves 0.0030 -> 0.0080 and its
     * exponent 2.0 -> 2.6. Both are tonemap-INPUT units, i.e. print positions:
     * 0.0080 is scene linear 0.0141 at the afternoon exposure.
     *
     * Round 6 put the short toe below every shadow in the game and then ran a
     * straight 0.92 section from there all the way up to the anchor. Measured
     * with k-tonecurve.js that delivered 8.8-11.6 codes per stop across scene
     * linear 0.007-0.045 — better than the 0-2.4 it replaced, but still short
     * of the 12-15 the round was accepted against, AND it left 22 codes of
     * dead pedestal underneath it: the vista's and the outpost's p0.01 black
     * point went from 12 to 33, which is the one guard the rebuild broke.
     *
     * Those two failures are the same failure. A power toe hands out
     * `0.2887 * slope * (code + 14)` codes per stop, so codes bought at the
     * very bottom are the most expensive ones there are — 22 codes of pedestal
     * under the darkest content is 22 codes not spent as gradient above it.
     * Raising the knee to just under the darkest content in the frames spends
     * that pedestal on slope: the worst codes-per-stop between scene linear
     * 0.008 and 0.36 goes 8.8 -> 13.5 while p0.01 comes back DOWN, and neither
     * the shadowed-sphere band (0.018-0.029) nor mid-grey moves by a code.
     *
     * Where the frontier is, solved over toeSlope x toeKnee x toeExp x
     * shadowFill with mid-grey pinned at 120 +/- 2 (i.e. no exposure change):
     *
     *   worst codes/stop over    best achievable
     *   scene linear 0.005-0.36        11.0
     *   scene linear 0.008-0.36        14.0
     *   scene linear 0.010-0.36        15.5
     *
     * So the acceptance target of 12-15 codes/stop *from linear 0.005* is not
     * reachable at this key at all, and no toe shape gets there: 0.005 is six
     * stops under mid-grey, and six stops under mid-grey at 120 codes leaves
     * fewer than 12 codes/stop of range to hand out however they are
     * distributed. From 0.008 up it is reachable with margin, and that is
     * where the frames' content actually starts — the darkest 0.01% of the
     * vista and the outpost measures scene linear 0.008-0.010.
     */
    const kn = this.grade.toeKnee ?? 0.0080;
    const q = this.grade.toeExp ?? 2.6;
    return { fit, x, fx: fit(x), p, kn, q, amt: this.grade.toeAmount ?? 1 };
  }

  /**
   * The neutral display-linear response, CPU mirror of `acesFitted`: fold,
   * curve, white-point normalisation. The ACES matrices preserve neutrals, so
   * for a grey they drop out. This is what the exposure law is solved against.
   */
  _display(v) {
    if (this._isFox()) return this._fox(v);
    return this._acesDisplay(v);
  }

  /** True when the print is running the real Fox Engine curve. */
  _isFox() {
    return (this.grade.toneCurve ?? 'aces') === 'fox';
  }

  /** CPU mirror of `foxCurve`. */
  _fox(v) {
    const A = this.grade.foxA ?? 0.6;
    const B = this.grade.foxB ?? 0.45333;
    const kn = this.grade.foxShadowKnee ?? 0.06;
    const q = this.grade.foxShadowSlope ?? 1.0;
    const x = Math.max(v, 0);
    if (x < kn) return kn * Math.pow(x / kn, q);
    if (x <= A) return x;
    return Math.min(1, A + B - (B * B) / Math.max(x - A + B, 1e-4));
  }

  /**
   * The round-7 ACES response, kept whole. It is both the `toneCurve: 'aces'`
   * print and — always, in either mode — the reference space the split tone's
   * band selectors are anchored in; see `_bandWarp`.
   */
  _acesDisplay(v) {
    const W = this.grade.whitePoint ?? 2.6;
    const knee = W * (this.grade.shoulder ?? 0.3);
    const span = Math.max(W - knee, 1e-3);
    const x = Math.max(v - knee, 0) / span;
    const folded = Math.min(v, knee) + span * (x / (1 + x));
    return Math.min(1, Math.max(0, this._fitCurve(folded) * (this._whiteScale ?? 1)));
  }

  /** Inverse of `_display`, by bisection. Monotone, so 44 halvings is exact. */
  _displayInv(d) {
    let lo = 1e-6;
    let hi = 64;
    for (let i = 0; i < 44; i++) {
      const m = 0.5 * (lo + hi);
      if (this._display(m) < d) lo = m;
      else hi = m;
    }
    return 0.5 * (lo + hi);
  }

  /** The full tone curve, CPU mirror of `filmicFit` in the composite. */
  _fitCurve(v) {
    const t = this._toe ?? (this._toe = this._toeConstants());
    if (t.amt <= 0 || v > t.x || v < 0) return t.fit(v);
    const s = v / t.kn;
    const s3 = s * s * s;
    return t.fx * Math.pow(v / t.x, t.p) * Math.pow(s3 / (1 + s3), (t.q - t.p) / 3);
  }

  /**
   * Normalise the tonemap so `grade.whitePoint` linear maps to display 1.0.
   * The ACES input/output matrices preserve neutrals (their rows sum to one),
   * so the scalar is just the reciprocal of the fit at the white point.
   */
  _refreshWhitePoint() {
    const W = this.grade.whitePoint ?? 2.6;
    const shoulder = this.grade.shoulder ?? 0.3;
    const reach = this.grade.whiteReach ?? 0.86;
    this._toe = this._toeConstants();
    const t = this._toe;
    const fit = (v) => this._fitCurve(v);
    const u = this.compositeMat.uniforms;
    u.uCurveMode.value = this._isFox() ? 1 : 0;
    u.uFox.value.set(
      this.grade.foxA ?? 0.6,
      this.grade.foxB ?? 0.45333,
      (this.grade.foxA ?? 0.6) + (this.grade.foxB ?? 0.45333),
    );
    u.uFoxShadow.value.set(this.grade.foxShadowKnee ?? 0.06, this.grade.foxShadowSlope ?? 1.0);
    u.uHiDesat.value = this.grade.highlightDesat ?? 0.85;
    u.uToeAmt.value = t.amt;
    u.uToeX.value = t.x;
    u.uToeFX.value = t.fx;
    u.uToeP.value = t.p;
    u.uToeDeep.value.set(t.kn, t.q, (t.q - t.p) / 3);
    u.uWhitePoint.value = W;
    u.uShoulder.value = shoulder;
    /**
     * `whiteReach` is what fixes "nothing in the game is ever white".
     *
     * Round 2 replaced a hard clip with a rational fold that only reaches the
     * white point ASYMPTOTICALLY, and round 3 then normalised the tonemap by
     * the fit at exactly that white point. The two together are a proof that
     * display 1.0 requires infinite input: measured across 14.5 M shipped
     * round-4 pixels the maximum 8-bit channel value was 252, and the vista and
     * ground frames topped out at 241 — including frames with the solar disc
     * directly in shot. A photograph of the sun that contains no white pixel is
     * not a restrained highlight rolloff, it is a broken one.
     *
     * Normalising at `whitePoint * reach` instead puts display 1.0 at a FINITE
     * folded value, so the top of the shoulder is a real destination that a
     * specular or a solar disc can actually arrive at, while broad surfaces —
     * which live an order of magnitude below it — still roll off on exactly the
     * same curve they did before.
     */
    this._whiteScale = 1 / Math.max(fit(W * reach), 1e-4);
    u.uWhiteScale.value = this._whiteScale;
  }

  // -------------------------------------------------------------------------

  _createMaterials() {
    const mat = (fragmentShader, uniforms) =>
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERT,
        fragmentShader,
        uniforms,
        depthTest: false,
        depthWrite: false,
      });

    // ---- GTAO -----------------------------------------------------------
    // Ground-truth ambient occlusion: two horizon angles per slice and the
    // closed-form cosine-weighted visibility integral between them. The round-1
    // pass took max(sin(horizon)) per side, which is the HBAO approximation —
    // it under-darkens creases (the integral is dominated by the *arc* between
    // horizons, not by the deepest one) and it is why nothing in the frame sat
    // in a pool of contact shading. Runs at full resolution: at 1280x720 the
    // cost is a fraction of a millisecond and half-res simply cannot resolve
    // the 2-3 pixel contact band where a sandbag meets the sand.
    //
    // ROUND 9: this pass now writes THREE occlusion signals, not one.
    //
    //   .r  broad AO, 1.15 m radius   — unchanged, verified, do not retune
    //   .g  linear view depth         — for the bilateral blur
    //   .b  MICRO AO, 0.16 m radius   — creases and seams
    //   .a  contact shadow            — short raymarch toward the sun
    //
    // Why a second radius rather than a smaller one. A horizon search has ONE
    // angular resolution, set by its pixel radius over its step count. At 1.15 m
    // and 8 steps the innermost tap lands within a couple of pixels of the
    // centre and then the sampling jumps straight to a tenth of a metre; the
    // 10 cm gap between two stacked sandbags falls between two taps, and the
    // wide bilateral that follows (sigma ~2.4 px, applied twice) erases what
    // little survived. That is the measured symptom the critics kept reporting
    // as "SSAO is present and strong but reads as absent up close": a bag top
    // and the crevice beside it came back at the same value across two rounds.
    // One radius genuinely cannot do both jobs — a broad term has to reach far
    // enough to model openness, and reaching that far is what destroys the
    // crease. So the crease gets its own search, its own sample distribution
    // (linear, not centre-biased — over 14 pixels every tap should count) and,
    // critically, its own much tighter blur.
    //
    // Both searches share the slice loop: the same omega, the same projected
    // normal, the same tangent frame and the same one-dimensional integral. All
    // the extra pass costs is its taps.
    //
    // The micro term FADES OUT rather than clamping up when 16 cm stops being
    // resolvable (under ~2.6 px). Clamping up is what would turn it into a
    // second broad term at distance — and, worse, into per-frame noise on the
    // horizon, since a sub-pixel horizon search is sampling nothing but the
    // depth buffer's own quantisation.
    this.aoMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDepth;
      uniform vec2 uResolution;
      uniform mat4 uProjInv;
      uniform vec2 uProjScale;       // projection scale for radius -> pixels
      uniform float uRadius;
      uniform float uThickness;
      uniform float uFrame;
      // --- micro (crease/contact) horizon search ---
      uniform float uMicroRadius;    // world radius, metres
      uniform float uMicroOn;
      // --- screen-space contact shadows ---
      uniform mat4 uProj;            // jittered projection, for the raymarch
      uniform vec3 uSunV;            // VIEW-space direction toward the sun
      uniform float uCsLength;       // march length, metres
      uniform float uCsThickness;    // occluder thickness, metres
      uniform float uCsOn;
      uniform vec2 uCsFade;          // begin/end distance, metres
      ${COMMON_GLSL}

      const float PI_ = 3.14159265359;
      const float HALF_PI = 1.57079632679;

      vec3 viewAt(vec2 uv) {
        float d = texture2D(tDepth, uv).x;
        return viewFromDepth(uv, d, uProjInv);
      }

      void main() {
        float d = texture2D(tDepth, vUv).x;
        // Sky: fully open, no crease, no contact shadow.
        if (d >= 0.9999995) { gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); return; }

        vec3 P = viewFromDepth(vUv, d, uProjInv);
        vec2 texel = 1.0 / uResolution;

        // Normal reconstruction: pick the closer of each neighbour pair so
        // silhouettes do not smear a false normal across the depth step.
        vec3 pxr = viewAt(vUv + vec2(texel.x, 0.0));
        vec3 pxl = viewAt(vUv - vec2(texel.x, 0.0));
        vec3 pyu = viewAt(vUv + vec2(0.0, texel.y));
        vec3 pyd = viewAt(vUv - vec2(0.0, texel.y));
        vec3 dx = abs(pxr.z - P.z) < abs(P.z - pxl.z) ? (pxr - P) : (P - pxl);
        vec3 dy = abs(pyu.z - P.z) < abs(P.z - pyd.z) ? (pyu - P) : (P - pyd);
        vec3 N = normalize(cross(dx, dy));
        if (N.z < 0.0) N = -N;
        vec3 V = normalize(-P);

        // Screen-space radius of the world-space sample sphere.
        //
        // Round 3 ran a 2.2 m radius clamped up to 96 pixels. At arm's length
        // that is a measurement of large-scale openness, not of contact: the
        // sandbag wall in ground.png measured a bag top at (76.8, 69.7, 65.3)
        // and the crevice between two stacked bags at essentially the same
        // value, across two rounds of critique. A crevice is 10 cm wide. The
        // radius is now sized to the feature, and the pixel clamp with it, so
        // the horizon search actually resolves the 2-3 pixel contact band.
        float pixPerMetre = uProjScale.y * uResolution.y * 0.5 / max(-P.z, 0.05);
        float pixRadius = uRadius * pixPerMetre;
        // FADE the broad term when its own radius stops being resolvable,
        // exactly as the micro term below already does.
        //
        // This is the mountain chevron banding, and it was blamed on the
        // terrain for two rounds. TODO 2.3 pointed at the Jacobi thermal pass,
        // the droplet brush and _smoothFlats' 25 degree slope gate; removing
        // that gate entirely changes nothing, six full re-bakes with the whole
        // erosion stack off change nothing, and a plain Lambert hillshade of
        // the heightfield shows a clean mountain. Ablating THIS pass removes
        // the banding outright -- high-pass RMS across the massif drops 1.110
        // to 0.810 against a null control of 1.111.
        //
        // The mechanism is the clamp on the next line. At a kilometre the
        // 1.15 m world radius projects to about one pixel and is clamped UP to
        // three, so the horizon search stops measuring occlusion and starts
        // measuring local slope and depth quantisation -- which is why the
        // pattern follows the contours of the landform instead of lying on it.
        //
        // Clamping up is right for the WORK (a search still has to have a
        // width); what was missing is that the RESULT has to be faded out over
        // the same range, or the pass reports confident occlusion derived from
        // a measurement it could not make. The micro term got this right and
        // the broad term never had it.
        float pixRadiusRaw = pixRadius;
        float broadFade = smoothstep(1.5, 3.0, pixRadiusRaw);
        pixRadius = clamp(pixRadius, 3.0, 52.0);

        // Micro search. The raw projection decides whether the feature exists on
        // screen at all; the clamp only bounds the work once it does. Below
        // 2.6 px a 16 cm crease is not a crease any more, it is the depth
        // buffer's quantisation, so the term is faded out instead of clamped up.
        float microPixRaw = uMicroRadius * pixPerMetre;
        float microFade = uMicroOn * smoothstep(1.3, 2.6, microPixRaw);
        float microPix = clamp(microPixRaw, 2.0, 14.0);

        float rot = ign(gl_FragCoord.xy + uFrame * 7.13);
        float offset = fract(ign(gl_FragCoord.yx * 1.37) + uFrame * 0.618);

        const int SLICES = 3;
        const int STEPS = 8;
        const int MICRO_STEPS = 4;
        float visibility = 0.0;
        float microVis = 0.0;

        for (int s = 0; s < SLICES; s++) {
          float phi = (float(s) + rot) * PI_ / float(SLICES);
          vec2 omega = vec2(cos(phi), sin(phi));
          vec3 dirV = vec3(omega, 0.0);
          vec3 sliceN = cross(dirV, V);
          float sliceLen = length(sliceN);
          if (sliceLen < 1e-5) continue;
          sliceN /= sliceLen;

          // Project the surface normal into the slice plane; the visibility
          // integral is one-dimensional in that plane.
          vec3 projN = N - sliceN * dot(N, sliceN);
          float projNLen = length(projN);
          if (projNLen < 1e-4) continue;
          vec3 tangent = cross(V, sliceN);
          float cosN = clamp(dot(projN, V) / projNLen, -1.0, 1.0);
          float n = sign(dot(projN, tangent)) * acos(cosN);

          float hA = -1.0;   // cos of the horizon on the -omega side
          float hB = -1.0;   // cos of the horizon on the +omega side

          // Skip the 24-tap search where its result is about to be faded to
          // nothing. Distant pixels are most of a wide frame, so this is the
          // rare fix that removes an artefact and work at the same time.
          if (broadFade > 0.0) for (int k = 0; k < STEPS; k++) {
            float t = (float(k) + offset) / float(STEPS);
            t = t * t;                      // bias samples toward the centre
            vec2 off = omega * t * pixRadius * texel;

            for (int side = 0; side < 2; side++) {
              vec2 suv = side == 0 ? vUv + off : vUv - off;
              float sd = texture2D(tDepth, suv).x;
              if (sd >= 0.9999995) continue;
              vec3 S = viewFromDepth(suv, sd, uProjInv);
              vec3 D = S - P;
              float len2 = dot(D, D);
              if (len2 < 1e-7) continue;
              float len = sqrt(len2);
              float cosH = dot(D, V) / len;
              // Range falloff, and a thickness heuristic so a thin occluder
              // (a wire, a fence post) does not shadow everything behind it.
              float w = clamp(1.0 - (len - uRadius * 0.55) / (uRadius * 0.45), 0.0, 1.0);
              if (side == 0) {
                hB = cosH > hB ? mix(hB, cosH, w) : mix(hB, cosH, uThickness);
              } else {
                hA = cosH > hA ? mix(hA, cosH, w) : mix(hA, cosH, uThickness);
              }
            }
          }

          float sinN = sin(n);
          float h1 = n + max(-acos(clamp(hA, -1.0, 1.0)) - n, -HALF_PI);
          float h2 = n + min( acos(clamp(hB, -1.0, 1.0)) - n,  HALF_PI);
          visibility += projNLen * 0.25 * (
              (h1 * 2.0 * sinN - cos(2.0 * h1 - n)) +
              (h2 * 2.0 * sinN - cos(2.0 * h2 - n)) + 2.0 * cos(n));

          // ---- micro search, same slice, same frame, different scale ----
          // Linear step spacing: the whole search is 14 pixels wide at most, so
          // there is nothing to bias toward — every tap has to earn its place.
          // No thickness heuristic either: at 16 cm an occluder that reads as
          // thin is a seam, and a seam is exactly what this term is for.
          if (microFade > 0.0) {
            float mA = -1.0;
            float mB = -1.0;
            for (int k = 0; k < MICRO_STEPS; k++) {
              float t = (float(k) + offset) / float(MICRO_STEPS);
              vec2 off = omega * t * microPix * texel;
              for (int side = 0; side < 2; side++) {
                vec2 suv = side == 0 ? vUv + off : vUv - off;
                float sd = texture2D(tDepth, suv).x;
                if (sd >= 0.9999995) continue;
                vec3 S = viewFromDepth(suv, sd, uProjInv);
                vec3 D = S - P;
                float len2 = dot(D, D);
                if (len2 < 1e-9) continue;
                float len = sqrt(len2);
                float cosH = dot(D, V) / len;
                // Hard range gate at the micro radius. Anything past it belongs
                // to the broad term and must not be counted twice.
                float w = step(len, uMicroRadius * 1.35);
                cosH = mix(-1.0, cosH, w);
                if (side == 0) mB = max(mB, cosH); else mA = max(mA, cosH);
              }
            }
            float m1 = n + max(-acos(clamp(mA, -1.0, 1.0)) - n, -HALF_PI);
            float m2 = n + min( acos(clamp(mB, -1.0, 1.0)) - n,  HALF_PI);
            microVis += projNLen * 0.25 * (
                (m1 * 2.0 * sinN - cos(2.0 * m1 - n)) +
                (m2 * 2.0 * sinN - cos(2.0 * m2 - n)) + 2.0 * cos(n));
          }
        }

        float ao = clamp(visibility / float(SLICES), 0.0, 1.0);
        // Unoccluded where the search could not resolve its own radius.
        ao = mix(1.0, ao, broadFade);
        float micro = clamp(microVis / float(SLICES), 0.0, 1.0);
        micro = mix(1.0, micro, microFade);

        // ---- screen-space contact shadows ---------------------------------
        // What actually SEATS an object. The shadow map's near cascade is
        // 420 m / 2048 across a bounding sphere; at the scale of a barrel rim
        // resting on sand the receiver and the occluder land in the same texel,
        // and the slope-scaled bias then pushes the two apart on purpose so the
        // surface does not acne itself. The result is correct and it is exactly
        // the reason a barrel in ours has a shadow six metres long and nothing
        // at all where it touches the ground. A short march along the light
        // direction through the depth buffer resolves what the map cannot,
        // because it is sampling the depth buffer's own resolution.
        //
        // Only ever runs on pixels whose normal faces the sun — a back-facing
        // pixel is already dark from N.L and marching it would only add noise —
        // and only within uCsFade, past which a 35 cm march is sub-pixel.
        float cs = 1.0;
        float csFade = uCsOn * (1.0 - smoothstep(uCsFade.x, uCsFade.y, -P.z));
        float ndl = dot(N, uSunV);
        if (csFade > 0.0 && ndl > 0.03) {
          const int CS_STEPS = 8;
          // Cap the march in SCREEN space as well as world space. Up close
          // 35 cm is hundreds of pixels and eight taps across it would step
          // straight over every thin occluder in the frame.
          float len = min(uCsLength, 56.0 / max(pixPerMetre, 1e-3));
          float stepLen = len / float(CS_STEPS);
          float j = fract(ign(gl_FragCoord.xy * 1.71 + 11.0) + uFrame * 0.618);
          // Start off the surface along its own normal, not along the ray: the
          // ray is grazing on exactly the surfaces that matter most.
          vec3 rp = P + N * (0.012 + stepLen * 0.35) + uSunV * (stepLen * j);
          float occ = 0.0;
          for (int i = 0; i < CS_STEPS; i++) {
            rp += uSunV * stepLen;
            vec4 clip = uProj * vec4(rp, 1.0);
            if (clip.w <= 0.0) break;
            vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
            if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;
            float sd = texture2D(tDepth, suv).x;
            if (sd >= 0.9999995) continue;
            float sceneZ = viewFromDepth(suv, sd, uProjInv).z;
            // Both are negative. The scene sits in front of the ray when its z
            // is the LESS negative of the two.
            float diff = sceneZ - rp.z;
            if (diff > 0.008 && diff < uCsThickness) {
              // Soften with depth into the occluder so the shadow has an edge
              // rather than a step, and fade the far end of the march so a
              // contact shadow ends where the shadow map's own begins.
              float edge = 1.0 - float(i) / float(CS_STEPS);
              occ = max(occ, smoothstep(0.008, 0.03, diff) * (0.35 + 0.65 * edge));
            }
          }
          // Taper as the light goes grazing: at N.L near zero there is barely
          // any direct light left to remove and the march is mostly sampling
          // its own surface. The knee is deliberately LOW (0.20, not 0.35) —
          // measured on the dusk "ridge" pose, a 0.35 knee left the contact
          // channel at min 0.9917 across the entire frame, i.e. switched off in
          // the one time of day whose whole subject is raking light.
          cs = 1.0 - occ * csFade * smoothstep(0.02, 0.20, ndl);
        }

        // Store linear view depth alongside so the bilateral blur can reject
        // samples across depth discontinuities.
        gl_FragColor = vec4(ao, -P.z, micro, cs);
      }
      `,
      {
        tDepth: { value: null },
        uResolution: { value: new THREE.Vector2() },
        uProjInv: { value: new THREE.Matrix4() },
        uProjScale: { value: new THREE.Vector2(1, 1) },
        uRadius: { value: 1.15 },
        uThickness: { value: 0.10 },
        uFrame: { value: 0 },
        // 16 cm: a sandbag seam, the fillet where a pilaster meets a wall, the
        // gap under a barrel rim. Measured off the reference frames rather than
        // guessed — in mgi-7 the darkening around a fist-sized stone reaches
        // roughly one stone-width, and the stones are 10-20 cm.
        uMicroRadius: { value: 0.16 },
        uMicroOn: { value: 1 },
        uProj: { value: new THREE.Matrix4() },
        uSunV: { value: new THREE.Vector3(0, 1, 0) },
        uCsLength: { value: 0.40 },
        uCsThickness: { value: 0.55 },
        uCsOn: { value: 1 },
        uCsFade: { value: new THREE.Vector2(45, 90) },
      },
    );

    // ---- depth-aware bilateral blur for AO ------------------------------
    // The round-1 blur weighted by |dz| alone, which bleeds an object's own
    // occlusion out over the ground behind it whenever the two are at similar
    // depth. Weighting by the distance from the *tangent plane* instead (a
    // plane-aware bilateral) rejects the neighbour surface even when its depth
    // matches, which is what stops the halo around every silhouette.
    //
    // ROUND 9: the same taps now feed TWO kernels. The broad term keeps the
    // 6-tap kernel it was tuned with (sigma ~2.4 px). The micro term and the
    // contact shadow get a 2-tap kernel at sigma ~0.9 px, because they live in
    // a 2-3 pixel band and the wide kernel is a low-pass filter with a longer
    // support than the entire signal — running the crease through it, twice,
    // separably, is most of why the previous round's contact darkening
    // measured present and read as absent. They rely on TAA and on the
    // per-frame IGN rotation for the rest of their denoising, which is the
    // whole reason the AO pass sits upstream of the temporal filter.
    this.aoBlurMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tAO;
      uniform vec2 uDir;
      void main() {
        vec4 c = texture2D(tAO, vUv);
        if (c.g <= 0.0) { gl_FragColor = c; return; }
        // Local depth slope along the blur axis, from the immediate neighbours.
        float dp = texture2D(tAO, vUv + uDir).g;
        float dm = texture2D(tAO, vUv - uDir).g;
        float slope = 0.0;
        if (dp > 0.0 && dm > 0.0) slope = (dp - dm) * 0.5;
        float sum = c.r;
        float wsum = 1.0;
        vec2 nsum = c.ba;
        float nwsum = 1.0;
        for (int i = 1; i <= 6; i++) {
          float fi = float(i);
          float gw = exp(-fi * fi * 0.085);
          for (int s = 0; s < 2; s++) {
            float sg = s == 0 ? 1.0 : -1.0;
            vec4 t = texture2D(tAO, vUv + uDir * fi * sg);
            if (t.g <= 0.0) continue;
            float predicted = c.g + slope * fi * sg;
            float dw = exp(-abs(t.g - predicted) / (c.g * 0.012 + 0.03));
            float w = gw * dw;
            sum += t.r * w;
            wsum += w;
            if (i <= 2) {
              float nw = exp(-fi * fi * 0.62) * dw;
              nsum += t.ba * nw;
              nwsum += nw;
            }
          }
        }
        gl_FragColor = vec4(sum / wsum, c.g, nsum / nwsum);
      }
      `,
      { tAO: { value: null }, uDir: { value: new THREE.Vector2() } },
    );

    // ---- prepare: AO apply + aerial perspective --------------------------
    this.prepMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tColor;
      uniform sampler2D tDepth;
      uniform sampler2D tAO;
      uniform mat4 uInvViewProj;
      uniform mat4 uProjInv;
      uniform vec3 uCamPos;
      uniform float uAOEnabled;
      uniform float uAOPower;
      uniform float uAOFloor;
      uniform float uAODirect;
      uniform vec3 uAOTint;
      uniform float uMicroPower;
      uniform float uMicroStrength;
      uniform float uMicroDirect;
      uniform float uMicroHP;
      uniform float uCsStrength;
      uniform vec2 uTexel;
      uniform float uAerialEnabled;
      // atmosphere
      uniform vec3 uSunDir;
      uniform vec3 uSunRadiance;
      uniform vec3 uSkyRadiance;
      uniform vec3 uBetaR;
      uniform vec3 uBetaM;
      uniform vec3 uBetaD;
      uniform float uMieG;
      uniform float uApStrength;
      uniform float uApAmbient;
      uniform vec3 uDustAlbedo;
      ${COMMON_GLSL}

      const float PI_ = 3.141592653589793;
      const float HR = 8000.0;
      const float HM = 1400.0;
      const float HD = 700.0;    // desert dust hugs the ground
      const float BASE_ALT = 400.0;

      float phaseR(float mu) { return (3.0 / (16.0 * PI_)) * (1.0 + mu * mu); }
      float phaseHG(float mu, float g) {
        float g2 = g * g;
        return (1.0 - g2) / (4.0 * PI_ * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
      }

      /** Integral of exp(-y/H) along a straight ray, closed form. */
      float heightInt(float y0, float y1, float dist, float H) {
        float k = (y1 - y0) / max(dist, 1e-3);
        float a = exp(-max(y0, -2000.0) / H);
        float b = exp(-max(y1, -2000.0) / H);
        if (abs(k) < 1e-3) return dist * 0.5 * (a + b);
        return (H / k) * (a - b);
      }

      void main() {
        vec3 color = texture2D(tColor, vUv).rgb;
        float d = texture2D(tDepth, vUv).x;
        bool isSky = d >= 0.9999995;

        if (uAOEnabled > 0.5 && !isSky) {
          vec4 aoTex = texture2D(tAO, vUv);
          float ao = pow(clamp(aoTex.r, 0.0, 1.0), uAOPower);
          // Jimenez multi-bounce: single-scatter AO over-darkens bright
          // albedos. Approximated against the desert palette.
          vec3 alb = vec3(0.54, 0.46, 0.33);
          vec3 a = 2.0404 * alb - 0.3324;
          vec3 b = -4.7951 * alb + 0.6417;
          vec3 c = 2.7552 * alb + 0.6903;
          vec3 mb = max(vec3(ao), ((ao * a + b) * ao + c) * ao);
          mb = max(mb, vec3(uAOFloor));
          // Occlusion removes the *sky* first — it is the widest source — and
          // leaves the ground bounce, so a pocket of AO gets warmer as it gets
          // darker. This is a bent-normal effect done on the cheap and it is a
          // large part of why a real desert crevice is ochre, not blue-black.
          vec3 occ = mb * mix(uAOTint, vec3(1.0), mb);
          // Occlusion belongs to the ambient term. With no G-buffer the split
          // cannot be exact, so lean on the fact that AO only reaches low
          // values where the sun is geometrically blocked anyway, and keep a
          // hard floor of uAODirect on lit pixels so contact shading still
          // reads on sunlit sand — the round-1 weight faded it out to nothing
          // exactly where the critics went looking for it.
          float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
          // Sunlit proxy. With no G-buffer the direct/ambient split cannot be
          // exact; what is reliably true is that a pixel the shadow map has
          // already darkened is dark, so luminance stands in for "the sun
          // reaches here". Every term below reads the SAME number, computed
          // once from the pre-occlusion colour.
          float litW = smoothstep(0.10, 0.85, lum);
          float w = mix(1.0, uAODirect, litW);
          color *= mix(vec3(1.0), occ, w);

          // ---- micro AO: creases, seams, the corner where two planes meet ---
          //
          // HIGH-PASSED against its own local mean before it is applied, and
          // this is the part that makes the term usable rather than merely
          // present. Applied raw it measured a real gain in local contrast at
          // every scale (2 px +16%, 8 px +18%, 32 px +29% on the sandbag wall)
          // and simultaneously dropped that wall's mean luminance by 16.5% —
          // because a stack of sandbags has a neighbour within 16 cm almost
          // everywhere, so the raw micro signal is below 1 over the whole wall,
          // not just in the seams. That broad component is a worse-sampled
          // duplicate of what the 1.15 m term already owns; dividing it out
          // leaves only the deviation, which is the seam.
          //
          // It also makes the term exposure-safe by construction: a signal with
          // a local mean of 1 cannot move the frame's average, so this cannot
          // walk into the tone curve's calibration.
          //
          // Eight taps on a golden-angle ring at ~11 px, which is 2-4x the micro
          // search's own screen radius. Near a silhouette the ring bleeds across
          // the edge, but it is only a NORMALISER — bleeding changes the local
          // strength slightly and cannot invent occlusion.
          float mLocal = aoTex.b;
          for (int i = 0; i < 8; i++) {
            float a = float(i) * 2.39996323;
            mLocal += texture2D(tAO, vUv + vec2(cos(a), sin(a)) * 11.0 * uTexel).b;
          }
          mLocal /= 9.0;
          float mHP = mix(clamp(aoTex.b, 0.0, 1.0),
                          clamp(aoTex.b / max(mLocal, 0.05), 0.0, 1.0), uMicroHP);
          // Deliberately NOT run through the multi-bounce lift. Jimenez models
          // light that has bounced around a large concavity and come back; a
          // 10 cm seam between two sandbags is not that cavity, it is a slot,
          // and lifting it is precisely what flattened it before. It keeps the
          // warm tint though — a real crevice in this ground is ochre, because
          // what it loses first is the blue sky above it.
          float mo = pow(mHP, uMicroPower);
          mo = mix(1.0, mo, uMicroStrength);
          vec3 mocc = mo * mix(uAOTint, vec3(1.0), mo);
          // A crease self-occludes the sun too, not just the sky, so this fades
          // far less on lit pixels than the broad term does.
          color *= mix(vec3(1.0), mocc, mix(1.0, uMicroDirect, litW));

          // ---- contact shadow: pure direct occlusion ------------------------
          // Only bites where the sun actually reaches. On a pixel the cascade
          // has already shadowed there is no direct light left to remove, and
          // subtracting it again is how a screen-space shadow turns into a
          // black smear under everything in the frame.
          float cs = mix(1.0, clamp(aoTex.a, 0.0, 1.0), uCsStrength);
          color *= mix(vec3(1.0), cs * mix(uAOTint, vec3(1.0), cs), litW);
        }

        if (uAerialEnabled > 0.5 && !isSky) {
          vec3 wp = worldFromDepth(vUv, d, uInvViewProj);
          vec3 delta = wp - uCamPos;
          float dist = length(delta);
          vec3 rd = delta / max(dist, 1e-4);

          float y0 = uCamPos.y;
          float y1 = wp.y;
          float IR = heightInt(y0 + BASE_ALT, y1 + BASE_ALT, dist, HR);
          float IM = heightInt(y0 + BASE_ALT, y1 + BASE_ALT, dist, HM);
          float ID = heightInt(y0, y1, dist, HD);

          vec3 tauR = uBetaR * IR;
          vec3 tauM = uBetaM * IM;
          vec3 tauD = uBetaD * ID;
          vec3 T = exp(-(tauR + tauM * 1.11 + tauD * 1.06));

          float mu = dot(rd, uSunDir);
          // Multiple scattering flattens the effective phase function; without
          // this the anti-sun side goes implausibly black.
          float pd = mix(0.0796, phaseHG(mu, uMieG), 0.35);
          float pm = mix(0.0796, phaseHG(mu, min(uMieG + 0.05, 0.86)), 0.55);

          // Dust has its own (warm) scattering albedo. Folding it in here is
          // what keeps a hazy ridge dusty-ochre instead of inheriting the
          // sky's blue and turning the whole frame slate grey.
          vec3 sunIn = (tauR * phaseR(mu) + tauM * pm) * uSunRadiance
                     + tauD * pd * uSunRadiance * uDustAlbedo;
          vec3 ambIn = ((tauR + tauM) * uSkyRadiance
                     + tauD * uSkyRadiance * uDustAlbedo) * uApAmbient;
          vec3 S = (sunIn + ambIn) * uApStrength;

          color = color * T + S;
        }

        gl_FragColor = vec4(max(color, 0.0), 1.0);
      }
      `,
      {
        tColor: { value: null },
        tDepth: { value: null },
        tAO: { value: null },
        // Round 4: power 1.20 -> 1.55 and the floor 0.32 -> 0.14. A floor of
        // 0.32 combined with the multi-bounce lift meant the deepest crease the
        // integrator could find still came back above 0.5 — there was no pool
        // of contact darkening available to draw, whatever the weight.
        uAOPower: { value: 1.55 },
        uAOFloor: { value: 0.14 },
        uAODirect: { value: 0.52 },
        uAOTint: { value: new THREE.Vector3(1.14, 1.0, 0.78) },
        // Micro AO is a much shallower integral than the broad term — a 16 cm
        // search over a 3-slice frame rarely bottoms out — so it needs a
        // steeper power to reach a usable range at all.
        uMicroPower: { value: 2.1 },
        uMicroStrength: { value: 1.0 },
        uMicroHP: { value: 1.0 },
        uTexel: { value: new THREE.Vector2() },
        // 0.80, against the broad term's 0.52: a seam occludes the sun almost
        // as much as it occludes the sky, which is the entire difference
        // between a crease that reads and a crease that washes out at noon.
        uMicroDirect: { value: 0.80 },
        uCsStrength: { value: 0.85 },
        uInvViewProj: { value: new THREE.Matrix4() },
        uProjInv: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uAOEnabled: { value: 1 },
        uAerialEnabled: { value: 1 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunRadiance: { value: new THREE.Vector3(5, 4.4, 3.5) },
        uSkyRadiance: { value: new THREE.Vector3(0.09, 0.14, 0.26) },
        uBetaR: { value: new THREE.Vector3() },
        uBetaM: { value: new THREE.Vector3() },
        uBetaD: { value: new THREE.Vector3() },
        uMieG: { value: 0.72 },
        uApStrength: { value: AERIAL.strength },
        uApAmbient: { value: AERIAL.ambient },
        uDustAlbedo: { value: new THREE.Vector3(1.04, 1.0, 0.93) },
      },
    );

    // ---- TAA resolve ----------------------------------------------------
    this.taaMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tCurrent;
      uniform sampler2D tHistory;
      uniform sampler2D tDepth;
      uniform vec2 uTexel;
      uniform mat4 uInvViewProjJit;
      uniform mat4 uPrevViewProj;
      uniform float uBlend;
      uniform float uValid;
      ${COMMON_GLSL}

      vec3 rgb2ycocg(vec3 c) {
        return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
                    0.5 * c.r - 0.5 * c.b,
                   -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
      }
      vec3 ycocg2rgb(vec3 c) {
        return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
      }
      // Tonemap/inverse pair used only for weighting: blending in a compressed
      // space stops one bright sample from dominating the average and fireflying.
      vec3 tm(vec3 c) { return c / (1.0 + max(max(c.r, c.g), c.b)); }
      vec3 itm(vec3 c) { return c / max(1e-4, 1.0 - max(max(c.r, c.g), c.b)); }

      void main() {
        vec3 cur = texture2D(tCurrent, vUv).rgb;

        if (uValid < 0.5) { gl_FragColor = vec4(cur, 1.0); return; }

        // 3x3 neighbourhood statistics in YCoCg.
        vec3 m1 = vec3(0.0);
        vec3 m2 = vec3(0.0);
        vec3 nmin = vec3(1e9);
        vec3 nmax = vec3(-1e9);
        for (int y = -1; y <= 1; y++) {
          for (int x = -1; x <= 1; x++) {
            vec3 s = rgb2ycocg(tm(texture2D(tCurrent, vUv + vec2(float(x), float(y)) * uTexel).rgb));
            m1 += s;
            m2 += s * s;
            nmin = min(nmin, s);
            nmax = max(nmax, s);
          }
        }
        vec3 mean = m1 / 9.0;
        vec3 sigma = sqrt(max(m2 / 9.0 - mean * mean, 0.0));
        // Variance clipping is far less prone to over-tight boxes on noisy
        // input (our AO) than a raw min/max box.
        vec3 lo = max(mean - sigma * 1.35, nmin);
        vec3 hi = min(mean + sigma * 1.35, nmax);

        // Reproject.
        float d = texture2D(tDepth, vUv).x;
        vec3 wp = worldFromDepth(vUv, d, uInvViewProjJit);
        vec4 pc = uPrevViewProj * vec4(wp, 1.0);
        vec2 puv = (pc.xy / pc.w) * 0.5 + 0.5;

        if (puv.x < 0.0 || puv.x > 1.0 || puv.y < 0.0 || puv.y > 1.0) {
          gl_FragColor = vec4(cur, 1.0);
          return;
        }

        // 5-tap Catmull-Rom keeps the history from softening every frame.
        vec2 texPos = puv / uTexel - 0.5;
        vec2 f = fract(texPos);
        vec2 texPos1 = (floor(texPos) + 0.5) * uTexel;
        vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
        vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
        vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
        vec2 w3 = f * f * (-0.5 + 0.5 * f);
        vec2 w12 = w1 + w2;
        vec2 off12 = w2 / max(w12, vec2(1e-5));
        vec2 p0 = texPos1 - uTexel;
        vec2 p3 = texPos1 + uTexel * 2.0;
        vec2 p12 = texPos1 + off12 * uTexel;
        vec3 hist =
            texture2D(tHistory, vec2(p12.x, p0.y)).rgb * (w12.x * w0.y) +
            texture2D(tHistory, vec2(p0.x, p12.y)).rgb * (w0.x * w12.y) +
            texture2D(tHistory, vec2(p12.x, p12.y)).rgb * (w12.x * w12.y) +
            texture2D(tHistory, vec2(p3.x, p12.y)).rgb * (w3.x * w12.y) +
            texture2D(tHistory, vec2(p12.x, p3.y)).rgb * (w12.x * w3.y);
        float wnorm = (w12.x * w0.y) + (w0.x * w12.y) + (w12.x * w12.y) + (w3.x * w12.y) + (w12.x * w3.y);
        hist /= max(wnorm, 1e-4);
        hist = max(hist, vec3(0.0));

        vec3 hy = rgb2ycocg(tm(hist));
        vec3 cy = rgb2ycocg(tm(cur));

        // Clip toward the current sample along the ray rather than clamping
        // per channel — clamping shifts hue on rejected pixels.
        vec3 centre = 0.5 * (lo + hi);
        vec3 extent = 0.5 * (hi - lo) + 1e-5;
        vec3 v = hy - centre;
        vec3 a = abs(v / extent);
        float maxA = max(a.x, max(a.y, a.z));
        float clipped = 0.0;
        if (maxA > 1.0) { hy = centre + v / maxA; clipped = 1.0; }

        // Feed back more of the current frame where history had to be clipped
        // (disocclusion) and where the image is moving fast.
        float blend = mix(uBlend, 0.45, clipped * 0.6);
        vec3 outY = mix(hy, cy, blend);
        vec3 res = itm(ycocg2rgb(outY));
        // NaN/Inf trap that does not rely on isnan(): comparisons against NaN
        // are false, so the guard catches both cases.
        if (!all(lessThan(abs(res), vec3(1.0e6)))) res = cur;
        gl_FragColor = vec4(max(res, 0.0), 1.0);
      }
      `,
      {
        tCurrent: { value: null },
        tHistory: { value: null },
        tDepth: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uInvViewProjJit: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uBlend: { value: 0.1 },
        uValid: { value: 0 },
      },
    );

    // ---- luminance reduction + adaptation --------------------------------
    this.lumMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tColor;
      void main() {
        vec3 c = texture2D(tColor, vUv).rgb;
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        // Centre-weighted metering. Since round 5 this drives only the +/-0.02
        // stop trim around the illuminant-derived exposure solved on the CPU.
        // The frame no longer gets to decide its own stop, which is what had
        // the same afternoon reading half a stop apart between the gameplay
        // and outpost framings.
        vec2 d = vUv - 0.5;
        float w = 1.0 - 0.62 * smoothstep(0.02, 0.26, dot(d, d));
        // Clamp the metering range so the sun disc and the blown sky cannot
        // drag the average even inside that tiny authority.
        float lg = clamp(log(max(l, 1e-4)), -5.5, 1.4);
        gl_FragColor = vec4(lg * w, w, 0.0, 1.0);
      }
      `,
      { tColor: { value: null } },
    );

    this.downMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tColor;
      uniform vec2 uTexel;
      void main() {
        vec4 s = texture2D(tColor, vUv + vec2(-1.0, -1.0) * uTexel);
        s += texture2D(tColor, vUv + vec2(1.0, -1.0) * uTexel);
        s += texture2D(tColor, vUv + vec2(-1.0, 1.0) * uTexel);
        s += texture2D(tColor, vUv + vec2(1.0, 1.0) * uTexel);
        gl_FragColor = s * 0.25;
      }
      `,
      { tColor: { value: null }, uTexel: { value: new THREE.Vector2() } },
    );

    this.adaptMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tLum;
      uniform sampler2D tPrev;
      uniform sampler2D tDepth;
      uniform float uRate;
      uniform float uSnap;
      uniform float uNear;
      uniform float uFar;
      uniform vec2 uAFPoint;
      uniform float uAFRadius;
      void main() {
        vec2 lw = texture2D(tLum, vec2(0.5)).rg;
        float cur = lw.r / max(lw.g, 1e-4);
        float prev = texture2D(tPrev, vec2(0.5)).r;
        // Rods adapt slower than cones: darkening is allowed to lag more than
        // brightening, which is what makes an exposure ramp feel like an eye.
        float rate = cur < prev ? uRate * 0.55 : uRate;
        float lum = mix(prev, cur, uSnap > 0.5 ? 1.0 : rate);

        // Auto focus rides in .g: linear view distance under the AF point.
        //
        // The AF point is NOT the frame centre. An over-the-shoulder framing
        // puts its subject on the third by definition, so a centre-weighted
        // autofocus locks onto the yard 15 m behind him and hands back a hero
        // rendered entirely inside the circle of confusion — which is exactly
        // what the gameplay shot was doing. Shots declare where the subject is;
        // everything else keeps the default centre point. Nine taps across a
        // small patch, nearest wins, so a thin subject is not missed between
        // texels.
        float z = 1e9;
        for (int i = 0; i < 9; i++) {
          vec2 o = vec2(float(i / 3) - 1.0, float(i - (i / 3) * 3) - 1.0) * uAFRadius;
          float d = texture2D(tDepth, clamp(uAFPoint + o, vec2(0.002), vec2(0.998))).x;
          float zi = d >= 0.9999995 ? uFar : (2.0 * uNear * uFar) / (uFar + uNear - (d * 2.0 - 1.0) * (uFar - uNear));
          z = min(z, zi);
        }
        z = clamp(z, 0.3, 900.0);
        float pf = texture2D(tPrev, vec2(0.5)).g;
        float focus = mix(pf, z, uSnap > 0.5 ? 1.0 : 0.12);

        gl_FragColor = vec4(lum, focus, 0.0, 1.0);
      }
      `,
      {
        tLum: { value: null },
        tPrev: { value: null },
        tDepth: { value: null },
        uRate: { value: 0.28 },
        uSnap: { value: 1 },
        uNear: { value: 0.15 },
        uFar: { value: 6000 },
        uAFPoint: { value: new THREE.Vector2(0.5, 0.5) },
        uAFRadius: { value: 0.018 },
      },
    );

    // ---- bloom ------------------------------------------------------------
    this.brightMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform sampler2D tAdapt;
      uniform float uThreshold;
      uniform float uSoftKnee;
      uniform float uExposure;
      void main() {
        vec3 c = texture2D(tDiffuse, vUv).rgb * uExposure;
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        float knee = uThreshold * uSoftKnee + 1e-5;
        float soft = clamp(lum - uThreshold + knee, 0.0, 2.0 * knee);
        soft = soft * soft / (4.0 * knee);
        float contrib = max(soft, lum - uThreshold) / max(lum, 1e-5);
        // Clamp the very brightest samples: the sun disc alone would otherwise
        // dominate the whole chain and produce a flat white wash.
        c = min(c * contrib, vec3(48.0));
        gl_FragColor = vec4(c, 1.0);
      }
      `,
      {
        tDiffuse: { value: null },
        tAdapt: { value: null },
        uThreshold: { value: GRADE.bloomThreshold },
        uSoftKnee: { value: 0.65 },
        uExposure: { value: 1.0 },
      },
    );

    this.blurMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform vec2 uDir;
      void main() {
        vec4 sum = texture2D(tDiffuse, vUv) * 0.227027;
        sum += texture2D(tDiffuse, vUv + uDir * 1.3846153846) * 0.3162162162;
        sum += texture2D(tDiffuse, vUv - uDir * 1.3846153846) * 0.3162162162;
        sum += texture2D(tDiffuse, vUv + uDir * 3.2307692308) * 0.0702702703;
        sum += texture2D(tDiffuse, vUv - uDir * 3.2307692308) * 0.0702702703;
        gl_FragColor = sum;
      }
      `,
      { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } },
    );

    this.upsampleMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tLower;
      uniform sampler2D tHigher;
      uniform float uMix;
      void main() {
        gl_FragColor = vec4(texture2D(tHigher, vUv).rgb + texture2D(tLower, vUv).rgb * uMix, 1.0);
      }
      `,
      { tLower: { value: null }, tHigher: { value: null }, uMix: { value: 0.85 } },
    );

    // Anamorphic streak: a wide, cheap horizontal-only blur run three times so
    // the tail reaches most of the frame. The blue tint is the giveaway that
    // sells "cylindrical front element".
    this.streakMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform float uStep;
      uniform float uAttenuation;
      void main() {
        vec3 sum = vec3(0.0);
        float wsum = 1e-5;
        for (int i = -8; i <= 8; i++) {
          float fi = float(i);
          float w = pow(uAttenuation, abs(fi));
          float u = vUv.x + fi * uStep;
          // Fade samples out as they leave the frame instead of letting the
          // clamp-to-edge sampler replicate the border column. On the dusk
          // ridge, whose sun sits hard against the left border, that replicated
          // column was being smeared back across the picture as a slab of
          // glare with a visible vertical edge. A streak is light that arrived
          // from somewhere; off the edge of the sensor there is nowhere.
          w *= clamp(min(u, 1.0 - u) * 26.0, 0.0, 1.0);
          sum += texture2D(tDiffuse, vec2(clamp(u, 0.0, 1.0), vUv.y)).rgb * w;
          wsum += w;
        }
        gl_FragColor = vec4(sum / wsum, 1.0);
      }
      `,
      { tDiffuse: { value: null }, uStep: { value: 0.002 }, uAttenuation: { value: 0.86 } },
    );

    // ---- bokeh DOF fused with camera motion blur --------------------------
    this.dofMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tColor;
      uniform sampler2D tDepth;
      uniform sampler2D tAdapt;
      uniform vec2 uTexel;
      uniform mat4 uInvViewProjJit;
      uniform mat4 uPrevViewProj;
      uniform float uNear;
      uniform float uFar;
      uniform float uFocal;      // focal length, metres (derived from the FOV)
      uniform float uAperture;   // aperture diameter, metres
      uniform float uSensorPx;   // pixels per metre of sensor height
      uniform float uMaxCoCFar;  // hard ceiling on background defocus, pixels
      uniform float uMaxCoCNear; // hard ceiling on foreground defocus, pixels
      uniform float uCoCFloor;   // CoC below this costs nothing and is dropped
      uniform float uEdgeSoftness;
      uniform float uMotionScale;
      uniform float uDofScale;   // 0 leaves motion blur running with no defocus
      uniform float uFrame;
      uniform float uEnabled;
      ${COMMON_GLSL}

      float viewZ(float d) {
        if (d >= 0.9999995) return uFar;
        return (2.0 * uNear * uFar) / (uFar + uNear - (d * 2.0 - 1.0) * (uFar - uNear));
      }

      /**
       * Honest thin-lens circle of confusion, in pixels.
       *
       * Round 5: the ceiling is now ASYMMETRIC and both halves of it are about
       * a pixel, not thirteen. A game is not a photograph. Round 4 ran the same
       * +/-13 px clamp on both sides of focus, so an over-the-shoulder framing
       * focused at 2.1 m put the entire playable mid-ground — building,
       * barrels, fence — under a 4 px circle of confusion, and a ground-level
       * shot metering its focus on the mid-distance put the sand at the
       * camera's feet under the same. Measured on the round-4 gameplay frame,
       * the building roofline against the sky resolved over 5.1 px.
       *
       * MGSV uses defocus as a whisper: a little far-field separation behind a
       * near subject, a gentle near-field falloff, and a playable mid-ground
       * that is always sharp. That is what a small aperture buys, and the
       * clamps here are the seatbelt that guarantees it even if the autofocus
       * locks somewhere absurd.
       */
      float cocAt(float z, float focus) {
        float c = uAperture * uFocal * (z - focus) / (max(z, 0.02) * max(focus - uFocal, 1e-4));
        return clamp(c * uSensorPx, -uMaxCoCNear, uMaxCoCFar);
      }

      void main() {
        vec3 centre = texture2D(tColor, vUv).rgb;
        if (uEnabled < 0.5) { gl_FragColor = vec4(centre, 1.0); return; }

        float focus = max(texture2D(tAdapt, vec2(0.5)).g, 1.0);
        float d = texture2D(tDepth, vUv).x;
        float z = viewZ(d);
        float coc = abs(cocAt(z, focus));

        // Field curvature: real lenses lose the corners. A perfectly sharp
        // frame edge is one of the strongest "this is CG" cues. Round 5 cut it
        // from 1.2 px to a quarter of a pixel: at 1.2 px this term ALONE was
        // above the pass's own skip threshold, so every pixel outside the
        // middle sixth of the frame went through the 24-tap bokeh gather
        // whatever its depth. That is a full-frame blur wearing a lens's name.
        vec2 cen = vUv - 0.5;
        float r2 = dot(cen, cen);
        coc += uEdgeSoftness * smoothstep(0.06, 0.28, r2);
        // Defocus and motion blur share this pass and this gather; uDofScale is
        // what lets enabled.dof be ablated on its own without also taking the
        // motion blur out, which is why round 7 could not price either of them.
        coc *= uDofScale;

        // Camera velocity from depth reprojection (static geometry).
        vec2 vel = vec2(0.0);
        if (uMotionScale > 0.0) {
          vec3 wp = worldFromDepth(vUv, d, uInvViewProjJit);
          vec4 pc = uPrevViewProj * vec4(wp, 1.0);
          vec2 puv = (pc.xy / pc.w) * 0.5 + 0.5;
          vel = (vUv - puv) * uMotionScale;
          float vl = length(vel / uTexel);
          if (vl > 48.0) vel *= 48.0 / vl;
        }
        float velPix = length(vel / uTexel);

        // Sub-pixel defocus is not defocus, it is a soft filter over a sharp
        // image. Anything under the floor passes through untouched.
        // ALPHA IS THE BLEND WEIGHT, not opacity.
        //
        // This pass now renders at HALF resolution (see dofRT), which is where
        // its cost went — measured 2.5-3.3 ms at full res, the largest single
        // post item in the frame. Half res is only safe because the composite
        // keeps the full-resolution sharp image wherever this pass says it did
        // nothing: a is 0 for a pixel that took the early-out and 1 for a pixel
        // that actually gathered, and the bilinear upsample of a gives a clean
        // ramp across the boundary. Without that, running at half res would
        // soften the in-focus majority of the frame, which is most of it.
        if (coc < uCoCFloor && velPix < 0.8) { gl_FragColor = vec4(centre, 0.0); return; }
        coc = max(coc - uCoCFloor * 0.5, 0.0);

        float rot = ign(gl_FragCoord.xy + uFrame * 3.7) * 6.2831853;
        float cr = cos(rot), sr = sin(rot);

        vec3 sum = centre;
        float wsum = 1.0;
        const int TAPS = 24;
        for (int i = 0; i < TAPS; i++) {
          float fi = float(i);
          float t = (fi + 0.5) / float(TAPS);
          float rr = sqrt(t);
          float th = fi * 2.39996323;
          vec2 disk = vec2(cos(th), sin(th)) * rr;
          disk = vec2(disk.x * cr - disk.y * sr, disk.x * sr + disk.y * cr);
          // Slightly hexagonal aperture: a perfect circle reads as a gaussian,
          // a hex blade edge reads as a lens.
          float ang = atan(disk.y, disk.x);
          float hex = 1.0 - 0.055 * cos(6.0 * ang);
          disk *= hex;

          vec2 off = disk * coc * uTexel + vel * (t - 0.5);
          vec2 suv = vUv + off;
          vec3 sc = texture2D(tColor, suv).rgb;
          float sz = viewZ(texture2D(tDepth, suv).x);
          float scoc = max(abs(cocAt(sz, focus)) + uEdgeSoftness * smoothstep(0.06, 0.28, r2) - uCoCFloor * 0.5, 0.0);
          // Only accept a sample if its own blur circle reaches this pixel,
          // otherwise sharp foreground bleeds outward.
          float reach = length(disk) * coc;
          float w = clamp((scoc - reach) * 0.6 + 1.0, 0.0, 1.0);
          w = max(w, velPix > 1.0 ? 0.85 : 0.0);
          // Energy-preserving highlight response: bokeh discs from bright
          // sources should stay bright, not average into grey.
          float hw = 1.0 + 3.0 * smoothstep(1.2, 8.0, dot(sc, vec3(0.2126, 0.7152, 0.0722)));
          sum += sc * w * hw;
          wsum += w * hw;
        }
        gl_FragColor = vec4(sum / max(wsum, 1e-4), 1.0);
      }
      `,
      {
        tColor: { value: null },
        tDepth: { value: null },
        tAdapt: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uInvViewProjJit: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uNear: { value: 0.15 },
        uFar: { value: 6000 },
        uFocal: { value: 0.031 },
        uAperture: { value: 0.013 },
        uSensorPx: { value: 30000 },
        uMaxCoCFar: { value: 2.4 },
        uMaxCoCNear: { value: 1.2 },
        uCoCFloor: { value: 0.9 },
        uEdgeSoftness: { value: 0.25 },
        uMotionScale: { value: 0.55 },
        uDofScale: { value: 1 },
        uFrame: { value: 0 },
        uEnabled: { value: 1 },
      },
    );

    // ---- composite --------------------------------------------------------
    this.compositeMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform sampler2D tBloom;
      uniform sampler2D tStreak;
      uniform sampler2D tDirt;
      uniform sampler2D tDof;
      uniform float uDofOn;
      uniform sampler2D tLUT;
      uniform sampler2D tAdapt;
      uniform sampler2D tDepth;
      uniform vec2 uResolution;
      uniform vec3 uGrainFar;      // begin m, end m, floor
      uniform vec2 uGrainNearFar;  // camera near/far, for the depth linearise
      uniform float uExposure;
      uniform float uTime;
      uniform float uBloomStrength;
      uniform float uStreakStrength;
      uniform float uDirtStrength;
      uniform float uGrain;
      uniform float uVignette;
      uniform float uCA;
      uniform float uDistortion;
      uniform float uAutoExposure;
      uniform float uKeyValue;
      uniform vec2 uExposureClamp;
      uniform float uLutStrength;
      uniform float uWhitePoint;
      uniform float uShoulder;
      uniform float uWhiteScale;
      uniform float uHiDesat;
      uniform float uToeAmt;    // 0 = raw ACES toe (ablation), 1 = rebuilt toe
      uniform float uToeX;      // where the ACES fit's own log-log slope hits 1
      uniform float uToeFX;     // RRTAndODTFit(uToeX) — the anchor's value
      uniform float uToeP;      // log-log slope of the rebuilt shadow section
      uniform vec3  uToeDeep;   // x = short-toe knee, y = its exponent, z = (y-P)/3
      uniform float uCurveMode; // 0 = ACES + round-7 rebuilt toe, 1 = Fox Engine
      uniform vec3  uFox;       // x = A, y = B, z = A + B
      uniform vec2  uFoxShadow; // x = shadow knee, y = its log-log slope

      const mat3 ACESInput = mat3(
        0.59719, 0.07600, 0.02840,
        0.35458, 0.90834, 0.13383,
        0.04823, 0.01566, 0.83777
      );
      const mat3 ACESOutput = mat3(
         1.60475, -0.10208, -0.00327,
        -0.53108,  1.10813, -0.07276,
        -0.07367, -0.00605,  1.07602
      );
      vec3 RRTAndODTFit(vec3 v) {
        vec3 a = v * (v + 0.0245786) - 0.000090537;
        vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
        return a / b;
      }

      /**
       * The ACES fit with its TOE REBUILT. Round 6's headline change.
       *
       * Measured on the shipped round-6 build with an unlit emissive patch at
       * frame centre stepped in half-stops (tools/probes/verify/k-tonecurve.js),
       * the delivered response was:
       *
       *   scene linear   display code   codes per stop
       *   0.0050            12.0            0.0
       *   0.0071            12.3            0.6
       *   0.0100            13.1            1.6
       *   0.0200            16.1            3.8
       *   0.0400            26.2           14.0
       *   0.3200           102.8           42.6
       *
       * The toe was TWENTY TIMES flatter than the upper midtones, and below
       * scene linear 0.0053 the curve was not flat, it was DEAD: RRTAndODTFit
       * has a constant of -0.000090537 in its numerator, so it returns exactly
       * zero for everything under 0.00358 and every one of those pixels printed
       * the grade's black point and nothing else.
       *
       * That band is not an edge case. A neutral 0.5-grey sphere in full cast
       * shadow measures 0.018-0.029 scene linear, so the 1.7-2.5 stops of
       * directional ambient, all of the AO, the sky-coloured shade, and the
       * whole dusk and night frames were being resolved into ~6 display codes.
       * Four rounds of light transport were arriving at the display encode and
       * dying there.
       *
       * The fix is anchored so it can only ever move shadows. uToeX is the
       * point where the ACES fit's OWN log-log slope passes through 1 (0.4574,
       * solved on the CPU in _toeConstants()). Above it the fit is untouched,
       * bit for bit — mids, shoulder, white point, the highlight range and the
       * per-hour exposure all inherit exactly what they had. Below it the fit's
       * slope climbs from 1 to 5.5 as it dives into the crush; that climb IS
       * the long toe, and it is replaced by:
       *
       *   - a straight log-log section of slope uToeP (0.92), which prints a
       *     constant ~9-15 codes per stop through the whole shadow region, and
       *   - a SHORT power toe below uToeDeep.x, exponent uToeDeep.y, which
       *     takes the last stop and a half to black so the frame keeps a real
       *     black point instead of a pedestal.
       *
       * Value and slope both match at the anchor (slope to within 0.08 in
       * log-log, which is under a tenth of a code anywhere), so there is no
       * visible join. This is the classic filmic prescription — SHORT toe, LONG
       * shoulder — where before there was a long toe and a short shoulder.
       */
      vec3 filmicFit(vec3 v) {
        vec3 aces = RRTAndODTFit(v);
        if (uToeAmt <= 0.0) return aces;              // ablation: raw ACES
        vec3 x = max(v, 0.0);
        vec3 s = x / uToeDeep.x;
        vec3 s3 = s * s * s;
        vec3 toe = uToeFX
                 * pow(x / uToeX, vec3(uToeP))
                 * pow(s3 / (1.0 + s3), vec3(uToeDeep.z));
        // Only below the anchor, and only where the working-space value is
        // positive (the ACES input matrix can emit small negatives on saturated
        // primaries, and pow() has nothing to say about those).
        vec3 sel = step(v, vec3(uToeX)) * step(0.0, v);
        return mix(aces, mix(aces, toe, sel), uToeAmt);
      }

      /**
       * Filmic tonemap with an explicit white point.
       *
       * Round 1 ran bare clamped ACES, which has no white point at all: the
       * vista topped out at L=0.814 across two million pixels (a flat grey
       * plate) while the outpost piled 5% of its pixels on pure 1.0. Both ends
       * wrong at once, because "how much linear light is white" was never a
       * number anywhere in the stack.
       *
       * Now it is. Everything above the knee is folded exponentially into
       * [knee, whitePoint] so no input, however hot, can reach the ceiling;
       * ACES then shapes the curve and the result is normalised by the tonemap
       * of the white point itself, so whitePoint maps to exactly 1.0 and only
       * asymptotically. Sunlit sand sits in the shoulder near 0.85 and the sun
       * disc rolls off instead of clipping.
       */
      /**
       * The REAL Fox Engine curve, per Adrian Courreges' MGSV frame teardown:
       *
       *   f(x) = x                                  x <= A       (A = 0.6)
       *        = min(1, A + B - B*B/(x - A + B))     x >  A       (B = 0.45333)
       *
       * Value and first derivative are both continuous at A (the derivative of
       * the upper branch is B*B/(x-A+B)^2, which is exactly 1 there), so the
       * two pieces are one curve, not a join. It reaches display 1.0 at
       * x = 4.0 exactly — the shoulder is FINITE, unlike the rational fold this
       * replaces, which is why nothing in seven rounds of this game was ever
       * white.
       *
       * The one departure from the published curve is below uFoxShadow.x,
       * where the response runs at log-log slope uFoxShadow.y instead of 1.
       * That is not a toe — a toe has slope < 1 — it is a shadow expansion,
       * and it exists because the identity
       *
       *     codes per stop = 0.2887 * slope * (code + 14)
       *
       * makes slope 1 hand out only ~10 codes/stop at display code 20. Slope
       * 1.0 restores the published curve bit for bit.
       */
      vec3 foxCurve(vec3 x) {
        x = max(x, 0.0);
        vec3 shoulder = min(vec3(1.0), vec3(uFox.z) - (uFox.y * uFox.y) / max(x - uFox.x + uFox.y, 1e-4));
        vec3 mid = mix(x, shoulder, step(vec3(uFox.x), x));
        vec3 deep = uFoxShadow.x * pow(x / uFoxShadow.x, vec3(uFoxShadow.y));
        return mix(deep, mid, step(vec3(uFoxShadow.x), x));
      }

      vec3 acesFitted(vec3 color) {
        if (uCurveMode > 0.5) return clamp(foxCurve(color), 0.0, 1.0);
        float knee = uWhitePoint * uShoulder;
        vec3 over = max(color - knee, 0.0);
        float span = max(uWhitePoint - knee, 1e-3);
        // Rational fold, not exponential. An exponential reaches 99% of the
        // ceiling by 5x the span, so a bright sky pins at the white point and
        // clips exactly as hard as having no white point at all; the rational
        // form needs 100x, which leaves the sky sitting inside the shoulder
        // where it belongs and keeps cloud modelling readable.
        vec3 x = over / span;
        color = min(color, knee) + span * (x / (1.0 + x));
        color = ACESInput * color;
        color = filmicFit(color);
        color = ACESOutput * color;
        return clamp(color * uWhiteScale, 0.0, 1.0);
      }

      vec3 linearToSRGB(vec3 c) {
        return mix(c * 12.92, 1.055 * pow(max(c, 1e-5), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
      }

      /** 32^3 LUT stored as a 1024x32 strip; manual lerp across blue slices. */
      vec3 sampleLUT(vec3 c) {
        c = clamp(c, 0.0, 1.0);
        const float N = 32.0;
        float b = c.b * (N - 1.0);
        float b0 = floor(b);
        float b1 = min(b0 + 1.0, N - 1.0);
        float fb = b - b0;
        float rx = (c.r * (N - 1.0) + 0.5) / (N * N);
        float gy = (c.g * (N - 1.0) + 0.5) / N;
        vec3 s0 = texture2D(tLUT, vec2(b0 / N + rx, gy)).rgb;
        vec3 s1 = texture2D(tLUT, vec2(b1 / N + rx, gy)).rgb;
        return mix(s0, s1, fb);
      }

      float hash21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      void main() {
        vec2 uv = vUv;
        vec2 centre = uv - 0.5;
        float r2 = dot(centre, centre);

        // Barrel distortion. Tiny — enough to break the ruler-straight frame
        // edges that give rectilinear CG away, not enough to notice as an effect.
        vec2 duv = uv + centre * uDistortion * (r2 - 0.09);
        vec2 dcentre = duv - 0.5;
        float dr2 = dot(dcentre, dcentre);

        // Chromatic aberration costs THREE full-resolution half-float fetches
        // of the scene where one would do. uCA is a uniform, so this branch is
        // uniform across the whole draw and the GPU takes one side of it rather
        // than predicating both. Without the branch, a strength of zero still
        // did all three fetches at a zero offset -- and the shipping value IS
        // zero (ArtDirection.js chromaticAberration), so the build was paying
        // in full, every frame, for an effect that is switched off.
        // NOTE: no backticks in this comment. It lives inside a JS template
        // literal and one of them ends the shader.
        vec3 color;
        if (uCA > 0.0) {
          vec2 caOff = dcentre * uCA * (0.35 + dr2 * 1.4);
          color.r = texture2D(tDiffuse, duv + caOff).r;
          color.g = texture2D(tDiffuse, duv).g;
          color.b = texture2D(tDiffuse, duv - caOff).b;
        } else {
          color = texture2D(tDiffuse, duv).rgb;
        }

        // Fold in the half-resolution defocus/motion gather.
        //
        // Its alpha is how much blur it actually produced, so an in-focus pixel
        // keeps the full-resolution sharp read above and only genuinely
        // defocused pixels take the upsampled version. Doing it here rather
        // than by swapping tDiffuse is the whole reason the pass can run at
        // half res without softening the frame.
        if (uDofOn > 0.0) {
          vec4 dofS = texture2D(tDof, duv);
          color = mix(color, dofS.rgb, clamp(dofS.a, 0.0, 1.0));
        }

        float avgLum = exp(texture2D(tAdapt, vec2(0.5)).r);
        float autoScale = mix(1.0, clamp(uKeyValue / max(avgLum, 1e-4), uExposureClamp.x, uExposureClamp.y), uAutoExposure);
        float exposure = uExposure * autoScale;

        color *= exposure;

        vec3 bloom = texture2D(tBloom, duv).rgb;
        vec3 streak = texture2D(tStreak, duv).rgb;
        vec3 dirt = texture2D(tDirt, duv * vec2(uResolution.x / uResolution.y, 1.0)).rgb;

        color += bloom * uBloomStrength;
        color += streak * uStreakStrength * vec3(0.72, 0.86, 1.25);
        // Veiling glare: light scattered off the dirt on the front element,
        // strongest where the bloom is strongest.
        color += bloom * dirt * uDirtStrength;

        // --- highlight desaturation ---
        // Bleach. Film loses chroma as it approaches the shoulder because the
        // fastest layer saturates first; a digital tonemapper without this
        // instead drives a hot pixel toward whichever primary is largest, so a
        // specular on metal under a warm sun clips to saturated RED. Measured
        // across every round-3 frame: R reached 255, G never passed 254 and B
        // never passed 243 — the frame had no white in it anywhere. Pulling
        // chroma out above the knee is what makes a highlight go white.
        {
          float mx = max(color.r, max(color.g, color.b));
          // The band is placed in LINEAR light where the tonemap's knee is
          // (whitePoint 5.2, knee 1.56): 1.35 lands at display 0.77 and 4.0 at
          // display 0.94, so only genuine highlights bleach and a golden dusk
          // sky at display 0.6 keeps every bit of its colour.
          float t = smoothstep(1.35, 4.0, mx) * uHiDesat;
          color = mix(color, vec3(dot(color, vec3(0.2126, 0.7152, 0.0722))), t);
        }

        // Vignette is the lens's own light falloff: it happens at the aperture,
        // so it belongs in SCENE-linear light ahead of the tonemap, not on the
        // display-referred result. Round 4 applied it afterwards, which meant a
        // sun sitting off-centre — as it does in the ridge and dawn framings —
        // had 26% subtracted from an already-tonemapped value and could not
        // reach white however hot it was. Ahead of the curve it just moves the
        // corner a little way down the shoulder instead.
        float vig = 1.0 - uVignette * smoothstep(0.12, 0.92, dr2 * 2.0);
        color *= vig;

        color = acesFitted(color);

        // --- display encode, THEN grade ---
        // The LUT is authored in display-referred code values: its contrast
        // pivot is 0.42, its shadow band ends at 0.30 luminance, and its toe
        // lift is 0.05. Those numbers only mean what they say in gamma space.
        // Applying it to linear light instead put the toe lift through the
        // sRGB encode afterwards, turning a 5% lift into a ~24% black-point
        // pedestal — every frame, night included, bottomed out at rgb(51,53,59)
        // and nothing in the game could ever render darker than that.
        color = max(color, 0.0);
        vec3 disp = linearToSRGB(color);
        // Same reasoning as the CA branch: sampleLUT is two dependent texture
        // fetches plus a lerp across blue slices, and mix() with a zero weight
        // still evaluates it. Uniform branch, so it is genuinely skipped.
        // (No backticks here either -- this is inside a template literal.)
        if (uLutStrength > 0.0) disp = mix(disp, sampleLUT(disp), uLutStrength);

        // Film grain, luminance-weighted (more in the mids, like real stock)
        // and slightly chromatic so it does not read as digital noise. Grain is
        // a density variation on the print, so it too is a display-space term.
        float lum = dot(disp, vec3(0.2126, 0.7152, 0.0722));
        float gw = 1.0 - abs(lum * 2.0 - 1.0);
        // ---- distance rolloff (round 9) ----------------------------------
        // "The distant mountains are visibly unstable while flying" is THIS
        // term, and nothing else. Measured in the mountain band over a 30 m/s
        // god-mode flight, frame-to-frame |delta| summed over RGB:
        //
        //   camera FROZEN, grain on    d1 5.84   d2 10.29
        //   flying,        grain on    d1 5.93   d2 10.39
        //   camera FROZEN, grain off   d1 1.55   d2  2.89
        //   flying,        grain off   d1 1.75   d2  3.19
        //
        // Flying adds 0.09 of 5.93. The instability is 98.5% reproducible with
        // the camera bolted to the floor, and d2/d1 = 1.75 = sqrt(3), the exact
        // signature of per-pixel white noise rather than of geometry. That is
        // why ablating taa, ssao, aerial or bloom each moved it by under 7%,
        // and why freezing the terrain clipmap and the shadow-cascade refit
        // moved it by 4%: none of them is what is moving.
        //
        // It reads worst on distant ridges specifically because gw PEAKS at
        // mid-grey, and a ridge washed by two kilometres of aerial perspective
        // is the flattest mid-grey region in the frame — a plus-or-minus four
        // code dither with no detail underneath it to hide in. A far ridge is
        // also mostly scattered air rather than surface, and air does not have
        // grain.
        //
        // The rolloff is applied by DEPTH, so every near-field surface — which
        // is what the grade was tuned on, and the only place the grain reads as
        // stock rather than as noise — is bit-identical. uGrainFar.x is where
        // it starts, .y where it reaches its floor, .z the floor.
        float gd = texture2D(tDepth, vUv).x;
        float gz = gd >= 0.9999995
          ? uGrainFar.y
          : (2.0 * uGrainNearFar.x * uGrainNearFar.y)
            / (uGrainNearFar.y + uGrainNearFar.x - (gd * 2.0 - 1.0) * (uGrainNearFar.y - uGrainNearFar.x));
        gw *= mix(1.0, uGrainFar.z, smoothstep(uGrainFar.x, uGrainFar.y, gz));
        float g1 = hash21(gl_FragCoord.xy + fract(uTime) * 431.71) - 0.5;
        float g2 = hash21(gl_FragCoord.xy * 1.7 + fract(uTime) * 197.13) - 0.5;
        disp += vec3(g1, mix(g1, g2, 0.6), g2) * uGrain * gw;

        gl_FragColor = vec4(clamp(disp, 0.0, 1.0), 1.0);
      }
      `,
      {
        tDiffuse: { value: null },
        tBloom: { value: null },
        tStreak: { value: null },
        tDof: { value: null },
        uDofOn: { value: 0 },
        tDirt: { value: this.dirt },
        tLUT: { value: this.lut },
        tAdapt: { value: null },
        tDepth: { value: null },
        uResolution: { value: new THREE.Vector2() },
        // Constant to 300 m — the whole playable near field, and every surface
        // the grade was ever tuned against — then down to 45% by 1.8 km, where
        // the image is mostly aerial perspective. Set .z to 1 to ablate.
        uGrainFar: { value: new THREE.Vector3(300, 1800, 0.45) },
        uGrainNearFar: { value: new THREE.Vector2(0.15, 6000) },
        uExposure: { value: 0.88 },
        uTime: { value: 0 },
        uBloomStrength: { value: GRADE.bloomStrength },
        uStreakStrength: { value: 0.14 },
        uDirtStrength: { value: 0.1 },
        uGrain: { value: GRADE.grainAmount },
        uVignette: { value: GRADE.vignette },
        uCA: { value: GRADE.chromaticAberration },
        uDistortion: { value: 0.035 },
        uAutoExposure: { value: 1 },
        // Both are overwritten every frame from the illuminant solve; these are
        // only the values a pipeline sees before its first render().
        uKeyValue: { value: 0.203 },
        uExposureClamp: { value: new THREE.Vector2(0.986, 1.014) },
        uLutStrength: { value: 1.0 },
        uWhitePoint: { value: GRADE.whitePoint ?? 5.2 },
        uShoulder: { value: GRADE.shoulder ?? 0.3 },
        uWhiteScale: { value: 1.0 },
        uHiDesat: { value: GRADE.highlightDesat ?? 0.85 },
        uToeAmt: { value: 1 },
        uToeX: { value: 0.45745 },
        uToeFX: { value: 0.34333 },
        uToeP: { value: 0.92 },
        uToeDeep: { value: new THREE.Vector3(0.0030, 2.0, 0.36) },
        uCurveMode: { value: 1 },
        uFox: { value: new THREE.Vector3(0.6, 0.45333, 1.05333) },
        uFoxShadow: { value: new THREE.Vector2(0.060, 1.20) },
      },
    );
    this._refreshWhitePoint();

    // ---- FXAA (fallback) + sharpen ----------------------------------------
    this.fxaaMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform vec2 uTexel;
      uniform float uSharpen;
      uniform float uFxaa;

      float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

      void main() {
        vec3 rgbM = texture2D(tDiffuse, vUv).rgb;
        vec3 rgbNW = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
        vec3 rgbNE = texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * uTexel).rgb;
        vec3 rgbSW = texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * uTexel).rgb;
        vec3 rgbSE = texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * uTexel).rgb;

        vec3 result = rgbM;
        if (uFxaa > 0.5) {
          float lM = luma(rgbM), lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE);
          float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
          float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

          vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
          float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
          float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
          dir = clamp(dir * rcpDirMin, -8.0, 8.0) * uTexel;

          vec3 rgbA = 0.5 * (texture2D(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
                             texture2D(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
          vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tDiffuse, vUv + dir * -0.5).rgb +
                                           texture2D(tDiffuse, vUv + dir * 0.5).rgb);
          float lB = luma(rgbB);
          result = (lB < lMin || lB > lMax) ? rgbA : rgbB;
        }

        // Unsharp mask restores micro-detail that TAA/FXAA smear — the
        // difference between "blurry web demo" and "console sharp".
        vec3 blur = (rgbNW + rgbNE + rgbSW + rgbSE) * 0.25;
        vec3 sharp = (result - blur) * uSharpen;
        // Every clipped pixel left in the frame after the tonemap got its white
        // point was manufactured HERE: a bright halo against the sky pushed past
        // 1.0 and clamped. Above 0.84 only the dark lobe of the halo survives,
        // which is the lobe that actually reads as sharpness anyway.
        float hi = max(result.r, max(result.g, result.b));
        result += mix(sharp, min(sharp, vec3(0.0)), smoothstep(0.84, 1.0, hi));

        gl_FragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
      }
      `,
      {
        tDiffuse: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uSharpen: { value: GRADE.sharpen },
        uFxaa: { value: 0 },
      },
    );
  }

  // -------------------------------------------------------------------------

  _blit(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, false, false);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  /**
   * Pass boundary marker for the GPU profiler.
   *
   * Set `pipeline.profiler = { mark(name) }` and every pass boundary calls it;
   * `probes/r8_gpu.js` turns those marks into EXT_disjoint_timer_query_webgl2
   * spans. This exists because CPU wall-clock A/B on a machine shared by eight
   * working trees reported bloom at 18 ms and the ENTIRE post chain at 4 ms in
   * the same run — the contention noise is larger than every pass being
   * measured. A timer query bills the GPU work between two marks and does not
   * care what else is queued. Null in normal operation: one property read.
   */
  _mark(name) {
    if (this.profiler) this.profiler.mark(name);
  }

  _updateAtmosphereUniforms(camera) {
    const a = this.atmosphere;
    const u = this.prepMat.uniforms;
    u.uSunDir.value.copy(a.sunDirection);
    u.uSunRadiance.value.set(...a.sunRadiance);
    u.uSkyRadiance.value.set(...a.skyRadiance);
    u.uMieG.value = Math.min(a.mieG ?? 0.76, 0.8);

    // Rayleigh is physical; the aerosol/dust layer is where the art direction
    // lives (a desert at 2 km is dominated by suspended dust, not by air).
    const rs = a.rayleighScale ?? 1;
    const ms = a.mieScale ?? 1;
    const dd = a.dustDensity ?? 1;
    // Rayleigh pulled back and dust pushed up. At 2 km in an Afghan valley the
    // extinction is dominated by suspended mineral dust, not by air; round 1
    // had the balance the other way and every distant ridge inherited the sky's
    // blue, which is most of why the frame measured B > R everywhere.
    u.uBetaR.value.set(5.802e-6 * rs, 13.558e-6 * rs, 33.1e-6 * rs).multiplyScalar(1.78);
    u.uBetaM.value.set(2.2e-5 * ms, 2.1e-5 * ms, 2.0e-5 * ms);
    // Angstrom-ish 1/lambda tilt: fine dust scatters blue slightly more.
    u.uBetaD.value.set(1.30e-4 * dd, 1.34e-4 * dd, 1.40e-4 * dd);
    u.uCamPos.value.copy(camera.position);
  }

  /** Frame delta, set by the engine, so timed effects are per-second not per-frame. */
  setDelta(dt) {
    this._lastDt = dt;
  }

  render(renderer, scene, camera) {
    const w = this.width;
    const h = this.height;
    this.frame++;

    // ---- 0. camera bookkeeping + TAA jitter ----
    this._baseProj.copy(camera.projectionMatrix);
    this._viewProj.multiplyMatrices(this._baseProj, camera.matrixWorldInverse);

    // Reset the temporal history on a hard camera cut (shot changes) so the
    // first frames of a new pose never smear the previous one across the image.
    camera.getWorldDirection(this._tmpV);
    const jumped =
      this._prevCamPos.distanceTo(camera.position) > 3.0 || this._tmpV.dot(this._prevCamDir) < 0.9975;
    if (jumped) this._historyValid = false;
    this._prevCamPos.copy(camera.position);
    this._prevCamDir.copy(this._tmpV);

    const useTAA = this.enabled.taa;
    if (useTAA) {
      const j = JITTER[this.frame % JITTER.length];
      this._jitProj.copy(this._baseProj);
      this._jitProj.elements[8] += (2.0 * j[0]) / w;
      this._jitProj.elements[9] += (2.0 * j[1]) / h;
      camera.projectionMatrix.copy(this._jitProj);
      camera.projectionMatrixInverse.copy(this._jitProj).invert();
    } else {
      this._jitProj.copy(this._baseProj);
    }
    this._jitProjInv.copy(this._jitProj).invert();
    this._tmpM.multiplyMatrices(this._jitProj, camera.matrixWorldInverse);
    this._invViewProj.copy(this._tmpM).invert();

    // ---- 1. main scene into HDR ----
    this._mark('scene');
    renderer.setRenderTarget(this.hdr);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    this.sceneStats = {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    };

    // Restore the unjittered projection immediately — everything downstream
    // (and every other system) should see the real matrix.
    camera.projectionMatrix.copy(this._baseProj);
    camera.projectionMatrixInverse.copy(this._baseProj).invert();

    // ---- 2. ambient occlusion ----
    this._mark('ssao');
    if (this.enabled.ssao) {
      const au = this.aoMat.uniforms;
      au.tDepth.value = this.hdr.depthTexture;
      au.uResolution.value.set(this.aoRT.width, this.aoRT.height);
      au.uProjInv.value.copy(this._jitProjInv);
      au.uProj.value.copy(this._jitProj);
      au.uProjScale.value.set(this._jitProj.elements[0], this._jitProj.elements[5]);
      // FREEZE the AO's temporal rotation when TAA is off.
      //
      // GTAO dithers its slice rotation per pixel AND per frame, on the
      // assumption that a temporal resolve averages the noise away over ~8
      // frames. TAA was switched off in favour of FXAA because reprojection
      // smeared whenever the camera moved -- and FXAA is a single-frame edge
      // filter that cannot average anything over time. So the rotation has been
      // emitting a fresh noise field every frame with nothing to resolve it.
      //
      // Measured with the camera STATIC and dt = 0, where a stable renderer
      // reads 0.000: the frame changes by 2.423 codes/pixel/frame as shipped,
      // and turning the occlusion pass off takes it to 0.164 together with
      // grain. That crawling noise sits in exactly the dark areas AO darkens,
      // which is why it is reported as "the shadows and blacks are glitchy" --
      // and it is NOT the shadow map, which ablates to no change at all.
      //
      // Frozen, the dither becomes a fixed spatial pattern that the pass's own
      // depth-aware bilateral blur is already there to smooth. Static noise the
      // eye reads as texture; noise that changes every frame it reads as a
      // fault.
      au.uFrame.value = this.enabled.taa ? this.frame % 64 : 0;
      // Contact shadows march in VIEW space, so the world sun has to be rotated
      // into it — direction only, no translation.
      au.uSunV.value
        .copy(this.atmosphere.sunDirection)
        .transformDirection(camera.matrixWorldInverse)
        .normalize();
      // Ablation, applied here so nothing upstream can quietly undo it. See
      // `this.ablate`.
      au.uMicroOn.value = this.enabled.microAO ? this.ablate.microAO : 0;
      au.uCsOn.value = this.enabled.contactShadows ? this.ablate.contactShadows : 0;
      this._blit(this.aoMat, this.aoRT);

      this.aoBlurMat.uniforms.tAO.value = this.aoRT.texture;
      this.aoBlurMat.uniforms.uDir.value.set(1 / this.aoRT.width, 0);
      this._blit(this.aoBlurMat, this.aoBlurRT);
      this.aoBlurMat.uniforms.tAO.value = this.aoBlurRT.texture;
      this.aoBlurMat.uniforms.uDir.value.set(0, 1 / this.aoRT.height);
      this._blit(this.aoBlurMat, this.aoRT);
    }

    // ---- 3. prepare: AO + aerial perspective ----
    this._mark('prep');
    this._updateAtmosphereUniforms(camera);
    const pu = this.prepMat.uniforms;
    pu.tColor.value = this.hdr.texture;
    pu.tDepth.value = this.hdr.depthTexture;
    pu.tAO.value = this.aoRT.texture;
    pu.uInvViewProj.value.copy(this._invViewProj);
    pu.uProjInv.value.copy(this._jitProjInv);
    pu.uTexel.value.set(1 / w, 1 / h);
    pu.uAOEnabled.value = this.enabled.ssao ? 1 : 0;
    pu.uAerialEnabled.value = this.enabled.aerial ? 1 : 0;
    this._blit(this.prepMat, this.prepRT);

    // ---- 4. TAA resolve ----
    this._mark('taa');
    let resolved = this.prepRT;
    if (useTAA) {
      const tu = this.taaMat.uniforms;
      tu.tCurrent.value = this.prepRT.texture;
      tu.tHistory.value = this.taaB.texture;
      tu.tDepth.value = this.hdr.depthTexture;
      tu.uTexel.value.set(1 / w, 1 / h);
      tu.uInvViewProjJit.value.copy(this._invViewProj);
      tu.uPrevViewProj.value.copy(this._prevViewProj);
      tu.uValid.value = this._historyValid ? 1 : 0;
      this._blit(this.taaMat, this.taaA);
      resolved = this.taaA;
      const t = this.taaA;
      this.taaA = this.taaB;
      this.taaB = t;
      this._historyValid = true;
    }
    this._prevViewProj.copy(this._viewProj);

    // ---- 5. auto exposure ----
    this._mark('exposure');
    this.lumMat.uniforms.tColor.value = resolved.texture;
    this._blit(this.lumMat, this.lumRTs[0]);
    for (let i = 1; i < this.lumRTs.length; i++) {
      this.downMat.uniforms.tColor.value = this.lumRTs[i - 1].texture;
      this.downMat.uniforms.uTexel.value.set(1 / this.lumRTs[i - 1].width, 1 / this.lumRTs[i - 1].height);
      this._blit(this.downMat, this.lumRTs[i]);
    }
    const adu = this.adaptMat.uniforms;
    adu.tLum.value = this.lumRTs[this.lumRTs.length - 1].texture;
    adu.tPrev.value = this.adaptB.texture;
    adu.tDepth.value = this.hdr.depthTexture;
    adu.uSnap.value = !this._historyValid || this.frame < 3 || jumped ? 1 : 0;
    adu.uNear.value = camera.near;
    adu.uFar.value = camera.far;
    adu.uAFPoint.value.copy(this.afPoint);
    this._blit(this.adaptMat, this.adaptA);
    {
      const t = this.adaptA;
      this.adaptA = this.adaptB;
      this.adaptB = t;
    }
    const adaptTex = this.adaptB.texture;

    // ---- 5b. exposure solve (illuminant-derived, not frame-derived) ----
    const sceneL = this._updateExposure();

    // ---- 6. bloom ----
    this._mark('bloom');
    if (this.enabled.bloom) {
      this.brightMat.uniforms.tDiffuse.value = resolved.texture;
      this.brightMat.uniforms.uThreshold.value = this.grade.bloomThreshold;
      // The bright pass has to see the SAME exposure the composite will apply,
      // or the bloom threshold means a different scene radiance in every shot.
      this.brightMat.uniforms.uExposure.value = this._finalExposure;
      this._blit(this.brightMat, this.bloomRTs[0].a);
      const mips = Math.max(2, Math.min(this.bloomMips, this.bloomRTs.length));
      if (this.bloomStages.blur) for (let i = 0; i < mips; i++) {
        const rt = this.bloomRTs[i];
        if (i > 0) {
          this.blurMat.uniforms.tDiffuse.value = this.bloomRTs[i - 1].a.texture;
          this.blurMat.uniforms.uDir.value.set(1 / rt.w, 0);
          this._blit(this.blurMat, rt.a);
        }
        this.blurMat.uniforms.tDiffuse.value = rt.a.texture;
        this.blurMat.uniforms.uDir.value.set(1 / rt.w, 0);
        this._blit(this.blurMat, rt.b);
        this.blurMat.uniforms.tDiffuse.value = rt.b.texture;
        this.blurMat.uniforms.uDir.value.set(0, 1 / rt.h);
        this._blit(this.blurMat, rt.a);
      }
      if (this.bloomStages.upsample) for (let i = mips - 1; i > 0; i--) {
        this.upsampleMat.uniforms.tLower.value = this.bloomRTs[i].a.texture;
        this.upsampleMat.uniforms.tHigher.value = this.bloomRTs[i - 1].a.texture;
        this.upsampleMat.uniforms.uMix.value = this.grade.bloomRadius + 0.25;
        this._blit(this.upsampleMat, this.bloomRTs[i - 1].b);
        const t = this.bloomRTs[i - 1].a;
        this.bloomRTs[i - 1].a = this.bloomRTs[i - 1].b;
        this.bloomRTs[i - 1].b = t;
      }

      // Anamorphic streak from the second mip (already bright-passed).
      //
      // Steps were 1 / 9 / 81 quarter-res texels. Two things were wrong with
      // that. The 17-tap kernel of one pass spans +/-8 steps, so a factor of 9
      // leaves GAPS between passes: each outer tap of the last pass landed as a
      // discrete ghost of the image a quarter of a frame away, visible in the
      // round-4 dusk sky as a duplicated horizon. And the total reach came to
      // 2.3x the frame width, so most taps were off the sensor entirely.
      // 1 / 4 / 16 overlaps cleanly and reaches ~0.5 of the frame, which is
      // what a long anamorphic flare actually looks like.
      if (this.bloomStages.streak) {
      this.streakMat.uniforms.tDiffuse.value = this.bloomRTs[1].a.texture;
      this.streakMat.uniforms.uStep.value = 1.0 / this.streakA.width;
      this.streakMat.uniforms.uAttenuation.value = 0.88;
      this._blit(this.streakMat, this.streakA);
      this.streakMat.uniforms.tDiffuse.value = this.streakA.texture;
      this.streakMat.uniforms.uStep.value = 4.0 / this.streakA.width;
      this._blit(this.streakMat, this.streakB);
      this.streakMat.uniforms.tDiffuse.value = this.streakB.texture;
      this.streakMat.uniforms.uStep.value = 16.0 / this.streakA.width;
      this._blit(this.streakMat, this.streakA);
      }
    }

    // ---- 7. bokeh DOF + motion blur ----
    //
    // Skipped outright when both are off, rather than run with uEnabled = 0.
    // Round 7 measured this pass as "-6 ms" because switching the flag left a
    // full-resolution blit of the whole frame in place and only turned the
    // gather off inside it: the ablation was measuring nothing, and a build
    // that wants neither effect was still paying a 2 MP copy every frame.
    this._mark('dof');
    const wantDof = this.enabled.dof || this.enabled.motionBlur;
    const du = this.dofMat.uniforms;
    du.tColor.value = resolved.texture;
    du.tDepth.value = this.hdr.depthTexture;
    du.tAdapt.value = adaptTex;
    du.uTexel.value.set(1 / w, 1 / h);
    du.uInvViewProjJit.value.copy(this._invViewProj);
    du.uPrevViewProj.value.copy(this._prevViewProj);
    du.uNear.value = camera.near;
    du.uFar.value = camera.far;
    // Focal length that matches the current FOV on a 35mm-format sensor, so
    // the defocus tracks the shot's framing instead of being a fixed blur.
    const sensorH = this.grade.sensorHeight ?? 0.024;
    const focal = sensorH * 0.5 / Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    du.uFocal.value = focal;
    du.uAperture.value = focal / (this.grade.fStop ?? 2.4);
    du.uSensorPx.value = h / sensorH;
    // Every CoC term scales with resolution so the defocus is the same fraction
    // of the image at 720p and at 4K rather than the same pixel count.
    const cocScale = h / 1080;
    du.uEdgeSoftness.value = (this.grade.focusEdgeSoftness ?? 0.25) * cocScale;
    du.uMaxCoCFar.value = (this.grade.maxCoCFar ?? 2.4) * cocScale;
    du.uMaxCoCNear.value = (this.grade.maxCoCNear ?? 1.2) * cocScale;
    du.uCoCFloor.value = (this.grade.cocFloor ?? 0.9) * cocScale;
    // Same as the occlusion pass above: the bokeh gather rotates its disc by
    // ign(gl_FragCoord + uFrame * 3.7) expecting a temporal resolve that is not
    // running. Ablating this pass moved the static-camera flicker by 0.00, so
    // it is not a measured contributor today -- but it is the same latent bug,
    // and it would start contributing the moment the defocus covers more of the
    // frame. Frozen on the same condition rather than left as a trap.
    du.uFrame.value = this.enabled.taa ? this.frame % 64 : 0;
    // Motion blur is a SHUTTER, not a per-frame smear.
    //
    // This was `0.55 * (per-frame reprojection delta)`, which makes the blur
    // length proportional to frame time: at 25 FPS the camera moves 2.4x
    // further between frames than at 60, so the streak is 2.4x longer. The
    // slower it runs the more it smears, which is a feedback loop that makes a
    // 25 FPS frame look far worse than 25 FPS actually is — and it is exactly
    // what "blur and distortion when flying around" is.
    //
    // A 180-degree shutter exposes for half a frame at the REFERENCE rate.
    // Normalise by the real delta so the streak is a fixed duration of motion,
    // and clamp so a hitch cannot produce an arbitrarily long smear.
    const refDt = 1 / 60;
    const dt = Math.max(1e-4, this._lastDt ?? refDt);
    const shutter = Math.min(1, refDt / dt);
    du.uMotionScale.value = this.enabled.motionBlur ? 0.55 * shutter : 0.0;
    du.uDofScale.value = this.enabled.dof ? 1 : 0;
    du.uEnabled.value = wantDof ? 1 : 0;
    if (wantDof) this._blit(this.dofMat, this.dofRT);

    // ---- 8. composite ----
    this._mark('composite');
    const u = this.compositeMat.uniforms;
    // tDiffuse is now ALWAYS the sharp full-resolution source. The defocus
    // pass rides in through tDof at half res and is blended by its own alpha,
    // so the frame is no longer routed through a half-res buffer wholesale.
    u.tDiffuse.value = resolved.texture;
    u.tDof.value = wantDof ? this.dofRT.texture : null;
    u.uDofOn.value = wantDof ? 1 : 0;
    // `compositeFetch` off binds the 1x1 default instead of the half-res
    // half-float bloom and streak targets, WITHOUT changing anything the bloom
    // block does. That separates "the composite reads two big textures" from
    // "the pyramid ran", which `enabled.bloom` conflates — it gates both, and
    // conflated flags are failure #3 in tools/probes/perf.js's own header.
    const fetch = this.enabled.bloom && this.bloomStages.compositeFetch;
    u.tBloom.value = fetch ? this.bloomRTs[0].a.texture : null;
    u.tStreak.value = fetch ? this.streakA.texture : null;
    u.tAdapt.value = adaptTex;
    const add = this.enabled.bloom && this.bloomStages.compositeAdd;
    u.uBloomStrength.value = add ? this.grade.bloomStrength : 0;
    u.uStreakStrength.value = add ? (this.grade.anamorphic ?? 0.16) : 0;
    u.uDirtStrength.value = add ? (this.grade.lensDirt ?? 0.5) : 0;
    u.uExposure.value = this._finalExposure;
    u.uAutoExposure.value = this.enabled.autoExposure ? 1 : 0;
    // What the metered log-average SHOULD be if the frame is a fair sample of
    // the illuminant. Centring the auto term on the physical prediction means
    // its (deliberately tiny) authority is spent correcting genuine content
    // deviation rather than re-deriving the exposure from the histogram.
    u.uKeyValue.value = sceneL * (this.grade.meterBias ?? 0.62);
    const auth = this.grade.autoExposureStops ?? 0.02;
    u.uExposureClamp.value.set(Math.pow(2, -auth), Math.pow(2, auth));
    u.uResolution.value.set(w, h);
    u.uGrain.value = this.grade.grainAmount;
    u.tDepth.value = this.hdr.depthTexture;
    u.uGrainNearFar.value.set(camera.near, camera.far);
    u.uVignette.value = this.grade.vignette;
    u.uCA.value = this.grade.chromaticAberration;
    u.uDistortion.value = this.grade.barrel ?? 0.035;
    u.uHiDesat.value = this.grade.highlightDesat ?? 0.85;
    u.uTime.value = this.frame * 0.0163;

    this._blit(this.compositeMat, this.compositeRT);

    this._mark('present');
    this.fxaaMat.uniforms.tDiffuse.value = this.compositeRT.texture;
    this.fxaaMat.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.fxaaMat.uniforms.uSharpen.value = this.grade.sharpen;
    // FXAA is only the fallback: with TAA running it would just soften an
    // already-resolved image, so the final pass degrades to a sharpen.
    this.fxaaMat.uniforms.uFxaa.value = !useTAA && this.enabled.fxaa ? 1 : 0;
    this._blit(this.fxaaMat, null);

    renderer.setRenderTarget(null);
    this._mark('end');
  }
}

/**
 * Bake per-vertex ambient occlusion into `aAO` — the offline half of the
 * contact-scale occlusion work, for the geometry owners.
 *
 * ## Why you want this even though the screen-space term exists
 *
 * Screen-space occlusion can only see what is in the depth buffer, so it is
 * blind in three places that matter to you specifically:
 *
 *  1. **Anything the camera cannot see.** The underside of a sandbag, the back
 *     of a pilaster fillet, the inside of a corrugation. The screen-space term
 *     has no depth samples there, so the crease pops in as you rotate past it.
 *  2. **Anything thinner than the search radius at that distance.** The micro
 *     term fades out below ~2.6 px of projected radius; past ~15 m a 16 cm seam
 *     is gone. Baked AO does not care how far away it is.
 *  3. **Anything merged.** A merged mesh has no per-object depth discontinuity
 *     for the horizon search to catch, so two boxes fused into one buffer read
 *     as one continuous surface. Baked AO is computed against the real
 *     triangles, before the merge, and survives it as an attribute.
 *
 * The two are complementary and are meant to multiply, not to replace each
 * other. Bake the object's OWN self-occlusion; leave contact with the ground
 * and with other objects to the screen-space pass, which is the half that
 * knows where things ended up.
 *
 * ## Using it
 *
 * ```js
 * import { bakeVertexAO } from '../../render/RenderPipeline.js';
 * bakeVertexAO(geo, { radius: 0.35, rays: 24 });   // adds a Float32 `aAO`
 * ```
 *
 * and in your material's `onBeforeCompile`:
 *
 * ```js
 * s.vertexShader = 'attribute float aAO;\nvarying float vAO;\n' +
 *   s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vAO = aAO;');
 * s.fragmentShader = 'varying float vAO;\n' +
 *   s.fragmentShader.replace(
 *     '#include <aomap_fragment>',
 *     '#include <aomap_fragment>\n  reflectedLight.indirectDiffuse *= mix(1.0, vAO, uVertexAO);');
 * ```
 *
 * Put it on `indirectDiffuse` and NOT on the direct term: a baked bake has no
 * idea where the sun is, and multiplying direct light by it is what makes a
 * baked model look like it is lit from inside a box.
 *
 * The attribute is written even when the geometry is merged afterwards, as long
 * as your merge keeps it — which is the point of the round-9 note in
 * `src/world/outpost/geo.js`, where a KEEP list dropped an attribute before
 * merging and silently flattened four materials.
 *
 * ## Cost
 *
 * Rays are traced against a uniform grid over the geometry's own triangles, so
 * this is O(vertices x rays) with a small constant. Measured on a 4.2 k-vertex
 * container shell: 24 rays, 38 ms. Budget it as world-gen time, not frame time,
 * and cache it through `GenCache` the same way you cache the geometry.
 *
 * @param {THREE.BufferGeometry} geo  indexed or non-indexed, must have position+normal
 * @param {{radius?:number, rays?:number, bias?:number, strength?:number, min?:number}} [opt]
 * @returns {THREE.BufferGeometry} the same geometry, with `aAO` attached
 */
export function bakeVertexAO(geo, opt = {}) {
  const radius = opt.radius ?? 0.35;
  const rays = opt.rays ?? 24;
  const bias = opt.bias ?? 1e-3;
  const strength = opt.strength ?? 1.0;
  const minAO = opt.min ?? 0.25;

  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  if (!pos || !nrm) return geo;
  const vcount = pos.count;
  const idx = geo.getIndex();
  const tri = idx ? idx.array : null;
  const tcount = (tri ? tri.length : vcount) / 3;

  // Uniform grid over the triangles, sized so a cell is about the ray length.
  // Anything longer than the ray can be skipped outright, which is what keeps
  // this linear in practice rather than in triangle count.
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const px = pos.array;
  for (let i = 0; i < vcount; i++) {
    const x = px[i * 3];
    const y = px[i * 3 + 1];
    const z = px[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const cell = Math.max(radius, 1e-3);
  const nx = Math.max(1, Math.min(96, Math.ceil((maxX - minX) / cell) || 1));
  const ny = Math.max(1, Math.min(96, Math.ceil((maxY - minY) / cell) || 1));
  const nz = Math.max(1, Math.min(96, Math.ceil((maxZ - minZ) / cell) || 1));
  const sx = nx / Math.max(maxX - minX, 1e-6);
  const sy = ny / Math.max(maxY - minY, 1e-6);
  const sz = nz / Math.max(maxZ - minZ, 1e-6);
  const cellOf = (x, y, z) => {
    const ix = Math.min(nx - 1, Math.max(0, ((x - minX) * sx) | 0));
    const iy = Math.min(ny - 1, Math.max(0, ((y - minY) * sy) | 0));
    const iz = Math.min(nz - 1, Math.max(0, ((z - minZ) * sz) | 0));
    return (iz * ny + iy) * nx + ix;
  };
  /** @type {number[][]} */
  const grid = new Array(nx * ny * nz);
  const tv = new Float32Array(tcount * 9);
  for (let t = 0; t < tcount; t++) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < 3; k++) {
      const v = tri ? tri[t * 3 + k] : t * 3 + k;
      const x = px[v * 3];
      const y = px[v * 3 + 1];
      const z = px[v * 3 + 2];
      tv[t * 9 + k * 3] = x;
      tv[t * 9 + k * 3 + 1] = y;
      tv[t * 9 + k * 3 + 2] = z;
      cx += x;
      cy += y;
      cz += z;
    }
    const c = cellOf(cx / 3, cy / 3, cz / 3);
    (grid[c] || (grid[c] = [])).push(t);
  }

  // Deterministic cosine-weighted hemisphere directions (golden-angle spiral in
  // the tangent frame). No RNG: the same geometry has to bake identically on
  // every boot or the world stops being a pure function of its seed.
  const GA = Math.PI * (3 - Math.sqrt(5));
  const dirs = new Float32Array(rays * 3);
  for (let i = 0; i < rays; i++) {
    const u = (i + 0.5) / rays;
    const r = Math.sqrt(u);
    const a = i * GA;
    dirs[i * 3] = r * Math.cos(a);
    dirs[i * 3 + 1] = r * Math.sin(a);
    dirs[i * 3 + 2] = Math.sqrt(Math.max(0, 1 - u));
  }

  const nA = nrm.array;
  const out = new Float32Array(vcount);
  const tanX = [0, 0, 0];
  const tanY = [0, 0, 0];

  const hit = (ox, oy, oz, dx, dy, dz) => {
    // Walk the 3x3x3 cell neighbourhood of the origin. The ray is at most one
    // cell long by construction, so that neighbourhood contains every triangle
    // it can possibly reach.
    const ix = Math.min(nx - 1, Math.max(0, ((ox - minX) * sx) | 0));
    const iy = Math.min(ny - 1, Math.max(0, ((oy - minY) * sy) | 0));
    const iz = Math.min(nz - 1, Math.max(0, ((oz - minZ) * sz) | 0));
    for (let kz = Math.max(0, iz - 1); kz <= Math.min(nz - 1, iz + 1); kz++) {
      for (let ky = Math.max(0, iy - 1); ky <= Math.min(ny - 1, iy + 1); ky++) {
        for (let kx = Math.max(0, ix - 1); kx <= Math.min(nx - 1, ix + 1); kx++) {
          const bucket = grid[(kz * ny + ky) * nx + kx];
          if (!bucket) continue;
          for (let bi = 0; bi < bucket.length; bi++) {
            const t = bucket[bi] * 9;
            // Moller-Trumbore.
            const e1x = tv[t + 3] - tv[t];
            const e1y = tv[t + 4] - tv[t + 1];
            const e1z = tv[t + 5] - tv[t + 2];
            const e2x = tv[t + 6] - tv[t];
            const e2y = tv[t + 7] - tv[t + 1];
            const e2z = tv[t + 8] - tv[t + 2];
            const pvx = dy * e2z - dz * e2y;
            const pvy = dz * e2x - dx * e2z;
            const pvz = dx * e2y - dy * e2x;
            const det = e1x * pvx + e1y * pvy + e1z * pvz;
            if (det > -1e-9 && det < 1e-9) continue;
            const inv = 1 / det;
            const tvx = ox - tv[t];
            const tvy = oy - tv[t + 1];
            const tvz = oz - tv[t + 2];
            const u = (tvx * pvx + tvy * pvy + tvz * pvz) * inv;
            if (u < 0 || u > 1) continue;
            const qx = tvy * e1z - tvz * e1y;
            const qy = tvz * e1x - tvx * e1z;
            const qz = tvx * e1y - tvy * e1x;
            const v = (dx * qx + dy * qy + dz * qz) * inv;
            if (v < 0 || u + v > 1) continue;
            const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
            if (dist > bias && dist < radius) return dist;
          }
        }
      }
    }
    return -1;
  };

  for (let i = 0; i < vcount; i++) {
    const ox = px[i * 3];
    const oy = px[i * 3 + 1];
    const oz = px[i * 3 + 2];
    let nxv = nA[i * 3];
    let nyv = nA[i * 3 + 1];
    let nzv = nA[i * 3 + 2];
    const nl = Math.hypot(nxv, nyv, nzv) || 1;
    nxv /= nl;
    nyv /= nl;
    nzv /= nl;
    // Tangent frame (Duff et al., branchless ONB).
    const sgn = nzv >= 0 ? 1 : -1;
    const a = -1 / (sgn + nzv);
    const b = nxv * nyv * a;
    tanX[0] = 1 + sgn * nxv * nxv * a;
    tanX[1] = sgn * b;
    tanX[2] = -sgn * nxv;
    tanY[0] = b;
    tanY[1] = sgn + nyv * nyv * a;
    tanY[2] = -nyv;

    const sox = ox + nxv * bias * 4;
    const soy = oy + nyv * bias * 4;
    const soz = oz + nzv * bias * 4;
    let vis = 0;
    for (let r = 0; r < rays; r++) {
      const dx = tanX[0] * dirs[r * 3] + tanY[0] * dirs[r * 3 + 1] + nxv * dirs[r * 3 + 2];
      const dy = tanX[1] * dirs[r * 3] + tanY[1] * dirs[r * 3 + 1] + nyv * dirs[r * 3 + 2];
      const dz = tanX[2] * dirs[r * 3] + tanY[2] * dirs[r * 3 + 1] + nzv * dirs[r * 3 + 2];
      const dist = hit(sox, soy, soz, dx, dy, dz);
      // Distance falloff, so a wall 30 cm away is not the same as one touching.
      vis += dist < 0 ? 1 : Math.min(1, dist / radius) ** 0.6;
    }
    const ao = vis / rays;
    out[i] = Math.max(minAO, 1 - (1 - ao) * strength);
  }

  geo.setAttribute('aAO', new THREE.BufferAttribute(out, 1));
  return geo;
}
