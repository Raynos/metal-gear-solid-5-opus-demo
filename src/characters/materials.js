import * as THREE from 'three';

/**
 * Character materials.
 *
 * All four are MeshStandard/MeshPhysical + onBeforeCompile so they inherit
 * cascade shadows, the sky PMREM and exponential fog for free (the house
 * pattern from Terrain.js).
 *
 * The trick that makes procedural surfacing hold up under animation: every
 * pattern is evaluated in **bind space** (`vBind`, the pre-skinning vertex
 * position) rather than world or view space. Camo, dirt, folds, seams and face
 * features are therefore glued to the body and do not swim when the character
 * moves — which is exactly what a UV-mapped texture would do, without a texture.
 *
 * Per-vertex inputs the shaders key off:
 *   aZone — garment region (jacket / sleeve / webbing / pouch / boot / …).
 *   aAO   — baked contact occlusion from skinning.js.
 *   aEdge — (angle around the cross-section, metres to the piece's cut edge).
 *           This is what draws *tailoring*: panel seams sit at fixed angles, and
 *           a stitched border sits a few mm in from every cut edge.
 *
 * COLOUR RULE, measured off the round-1 frames: red must exceed blue in every
 * daylight shot. Afghanistan is sunbaked warm khaki, not a cold grey quarry.
 * Every albedo below is warm-biased and every indirect term is warm-biased.
 */

// --- cloth zone ids ------------------------------------------------------
export const Z = {
  JACKET: 0,
  SLEEVE: 1,
  TROUSER: 2,
  VEST: 3,
  WEBBING: 4,
  POUCH: 5,
  LEATHER: 6,
  GLOVE: 7,
  KNEEPAD: 8,
  PACK: 9,
  HELMCOVER: 10,
  BANDANA: 11,
  BELT: 12,
  COLLAR: 13,
  SHIRT: 14,
  CAP: 15,
  HAIR: 16,
  // Boot uppers are their own zone: desert boots are a mid tan suede, and
  // sharing LEATHER with the holster and the eyepatch forced all three to the
  // same near-black that made the critics call the boots "solid black blobs".
  BOOT: 17,
};

// --- skin zone ids -------------------------------------------------------
export const SZ = { FACE: 0, NECK: 1, HAND: 2, ARM: 3, EYE: 4 };

// --- metal zone ids ------------------------------------------------------
export const MZ = { GUNMETAL: 0, PROSTHETIC: 1, BRASS: 2, DARKPOLY: 3, GLASS: 4 };

const NOISE = /* glsl */ `
float ch_hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float ch_noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(ch_hash(i + vec3(0,0,0)), ch_hash(i + vec3(1,0,0)), f.x),
                 mix(ch_hash(i + vec3(0,1,0)), ch_hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(ch_hash(i + vec3(0,0,1)), ch_hash(i + vec3(1,0,1)), f.x),
                 mix(ch_hash(i + vec3(0,1,1)), ch_hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float ch_fbm(vec3 p, int oct) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * ch_noise(p);
    n += a;
    a *= 0.5;
    p *= 2.03;
    p.xy = mat2(0.8, 0.6, -0.6, 0.8) * p.xy;
  }
  return s / n;
}
// Ridged variant. Cloth folds are CREASES — sharp valleys with broad flanks —
// so a smooth fbm reads as dirt while 1-|2n-1| reads as fabric.
float ch_ridge(vec3 p, int oct) {
  float n = ch_fbm(p, oct);
  return 1.0 - abs(n * 2.0 - 1.0);
}
// Screen-space cotangent frame: works on skinned geometry with no tangent
// attribute, which is what we need since the mesh deforms every frame.
mat3 ch_frame(vec3 N, vec3 p, vec2 uvv) {
  vec3 dp1 = dFdx(p), dp2 = dFdy(p);
  vec2 duv1 = dFdx(uvv), duv2 = dFdy(uvv);
  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float im = inversesqrt(max(dot(T, T), dot(B, B)) + 1e-12);
  return mat3(T * im, B * im, N);
}
/**
 * Bound a stack of tangent-space height gradients to a real surface slope.
 *
 * ROUND 5, and this is the whole of the "the pack out-reflects sunlit sand"
 * defect. The gradients below were summed raw into vec3(sum, 1.0): the fold,
 * drape, quilt and sag terms each peak near 1.0, so their sum reached 4-6 and
 * the shading normal ended up 76-81 degrees off the surface it belongs to.
 * That is not a normal map, it is a random direction generator — and on a
 * BACKLIT character it meant a large fraction of fragments on the pack had a
 * normal pointing at the sun, so a 0.20-albedo fabric standing in its own shade
 * was taking the full 8.5-unit key. Measured on shots/r4/gameplay.png the 400
 * brightest pixels of the pack came back at (220,206,187), linear luminance
 * 0.629, against fully sunlit sand at 0.304 — the pack was 2.07x BRIGHTER than
 * sand with three times the albedo, and the white blotches all over the
 * silhouette were fold-noise catching the key.
 *
 * k is tan(max slope). Worn cotton twill wrinkles are a few millimetres deep
 * over a centimetre or two; 0.60 is 31 degrees, which is already generous. The
 * soft normalise keeps everything well below k linear (so the weave, ripstop
 * and stitching are untouched) and asymptotes to k instead of clipping, so
 * there is no visible ridge where the clamp engages.
 */
vec3 ch_tangentNormal(vec2 g, float k) {
  return normalize(vec3(g * (k * inversesqrt(k * k + dot(g, g))), 1.0));
}
`;

const VARYINGS = /* glsl */ `
varying vec3 vBind;
varying float vZone;
varying float vAO;
varying vec2 vUvC;
varying vec2 vEdge;
varying vec3 vBindN;
`;

function injectVertex(shader) {
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
       attribute float aZone;
       attribute float aAO;
       attribute vec2 aEdge;
       ${VARYINGS}`,
    )
    // The BIND-pose normal, before skinning. "Which way was this panel facing on
    // the body" is what sun bleach and dust need; the deformed normal would make
    // both crawl over the garment as the character moves.
    .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n       vBindN = objectNormal;`)
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vBind = position;
       vZone = aZone;
       vAO = aAO;
       vUvC = uv;
       vEdge = aEdge;`,
    );
}

// -------------------------------------------------------------------------
// Shared character lighting response
// -------------------------------------------------------------------------
//
// Two terms, applied identically to cloth, skin, metal and rubber, and they are
// the whole answer to "the characters render as flat black cutouts with no
// internal form and no separation from the shadowed ground behind them":
//
//  1. Sand bounce. The desert floor is an enormous warm reflector. It is
//     derived from the indirect the scene has ALREADY computed rather than
//     being a constant, so it tracks time of day for free and cannot glow at
//     midnight. It is warm-biased on purpose — it is the term that keeps red
//     above blue on a body that is standing in its own shadow.
//  2. A fresnel rim. Sky wrap tinted by the actual environment plus a tight
//     backlit edge off the key. Together they hold the silhouette against a
//     dark background without reading as a plastic halo.

const CHAR_LIGHT_PARS = /* glsl */ `
uniform vec3 uBounceColor;
uniform float uBounceAmt;
uniform float uWarmMix;
uniform vec3 uRimColor;
uniform float uRimAmt;
uniform float uSunRim;
float gAO = 1.0;
const vec3 CH_LUMA = vec3(0.2126, 0.7152, 0.0722);
`;

const CHAR_BOUNCE = /* glsl */ `
{
  // How much key light there is at all. Everything below scales with it, so the
  // desert response fades out at night instead of glowing orange under a moon.
  float chKey = 0.0;
  #if NUM_DIR_LIGHTS > 0
    chKey = dot(directionalLights[0].color, CH_LUMA);
  #endif
  float chDay = saturate(chKey * 0.5);

  // Luminance-preserving warm rotation of the indirect. A soldier standing in a
  // sand valley is lit indirectly by a vast warm reflector as much as by the
  // sky; weighting the sky alone is precisely why round 1 measured blue over
  // red in every daylight frame. Applied to BOTH terms because three drives the
  // diffuse IBL off iblIrradiance, not off irradiance.
  vec3 chTint = uBounceColor / max(1e-4, dot(uBounceColor, CH_LUMA));
  float chW = uWarmMix * mix(0.45, 1.0, chDay);
  irradiance = mix(irradiance, dot(irradiance, CH_LUMA) * chTint, chW);
  iblIrradiance = mix(iblIrradiance, dot(iblIrradiance, CH_LUMA) * chTint, chW);

  // Ground bounce on top: undersides see the floor almost fully, vertical
  // panels about half, the tops of shoulders almost none. The bounce carries
  // only as much of the warm tint as the rest of the indirect does — a term
  // that is always fully orange is a private light rig by another name, and it
  // was the reason the character's shade measured nine counts warmer than every
  // shadow in the scene around it.
  vec3 chBTint = mix(vec3(1.0), chTint, clamp(uWarmMix * 1.6, 0.0, 1.0));
  vec3 chInd = irradiance + iblIrradiance;
  float chUp = geometryNormal.y * 0.5 + 0.5;
  // Round 5 flattened the up/down profile from mix(1.15, 0.28) to
  // mix(0.75, 0.30) and halved the amount. Measured on the round-5 gameplay
  // frame BEFORE this change: the pack's sky-facing top curve rendered at
  // linear 0.0223, its vertical flank at 0.0128 and its GROUND-FACING bottom
  // roll at 0.0158 — the underside was brighter than the side, i.e. this term
  // was inverting the sky ramp. It has to be small, because the scene's diffuse
  // ambient is an SH projection of the sky dome that already carries the ground
  // bounce (its own -Y irradiance measures 0.388 of its +Y, a 1.37-stop ramp),
  // so anything added here is a SECOND copy of light that is already in the
  // probe and it lands hardest exactly where the probe is darkest.
  irradiance += dot(chInd, CH_LUMA) * chBTint * uBounceAmt * mix(0.75, 0.30, chUp) * mix(0.55, 1.0, gAO) * mix(0.5, 1.0, chDay);
}
`;

const CHAR_RIM = /* glsl */ `
{
  // Round 5 changed two things that together were most of the energy defect.
  //
  //  - The fresnel is taken off nonPerturbedNormal, the INTERPOLATED vertex
  //    normal, not off the bump-mapped one. A rim describes the edge of a
  //    FORM; keying it to a per-fragment wrinkle normal meant every crease in
  //    the middle of a flat panel fired a full-strength rim, which is why the
  //    round-4 pack was covered in cream blotches rather than outlined by one.
  //  - Both lobes are now normalised by 1/PI, i.e. expressed as a reflectance
  //    against the same irradiance the Lambert lobe sees. Before, the sky lobe
  //    ran at 0.35 * 0.40 = 0.14 * irradiance at grazing while the fabric's own
  //    diffuse is albedo/PI = 0.065 * irradiance — the "rim" was 2.2x the
  //    surface it was supposed to trim. A cloth sheen edge is 0.15-0.30
  //    reflectance, i.e. AT MOST comparable to the diffuse, never double it.
  float chF = 1.0 - saturate(dot(nonPerturbedNormal, geometryViewDir));
  float chF2 = chF * chF;
  float chRim = chF2 * chF2;
  reflectedLight.indirectSpecular +=
    chRim * uRimAmt * RECIPROCAL_PI * uRimColor * (irradiance + iblIrradiance) * gAO;
  #if NUM_DIR_LIGHTS > 0
    // Backlit edge: only where the key is genuinely behind the subject.
    float chBack = saturate(-dot(directionalLights[0].direction, geometryViewDir));
    reflectedLight.indirectSpecular += chRim * chF2 * chBack * chBack * chBack *
      uSunRim * RECIPROCAL_PI * directionalLights[0].color * gAO;
  #endif
}
`;

/**
 * Defaults shared by every character material; per-material overrides merge in.
 *
 * Round 4 cut `warmMix` from 0.80 to 0.30 and `bounce` from 0.50 to 0.32.
 * Measured on the round-3 gameplay frame, the player's shaded back returned
 * sRGB R51 G40 B30 — R-B +21 — while the world's own cast shadow four metres
 * away returned R62 G55 B50, R-B +12. A character whose shade is nine counts
 * warmer than every shadow around it is not being lit by the scene; it is being
 * lit by a private orange rig, and that is precisely what makes it read as a
 * pasted cutout no matter how good the sculpt is. At 0.30 the character's
 * indirect is the scene's sky-and-bounce with a nudge, not a repaint of it.
 */
function lightUniforms(o = {}) {
  return {
    uBounceColor: { value: new THREE.Vector3(...(o.bounceColor ?? [1.0, 0.83, 0.63])) },
    // Round 5: 0.40 -> 0.18. The scene's diffuse ambient is a spherical-harmonic
    // projection of the sky dome that ALREADY carries the ground bounce
    // (Lighting.js `_computeSkySH`), so this term was adding a second copy of it
    // — up to +46% of the total indirect on a downward-facing panel. A real
    // secondary bounce off sand onto a vertical surface is on the order of 15%.
    uBounceAmt: { value: o.bounce ?? 0.11 },
    uWarmMix: { value: o.warmMix ?? 0.10 },
    uRimColor: { value: new THREE.Vector3(...(o.rimColor ?? [1.0, 0.94, 0.86])) },
    // Now a REFLECTANCE (the lobe is 1/PI-normalised in CHAR_RIM), so 0.30 means
    // a grazing sheen of 0.30 against a fabric whose diffuse albedo is 0.20:
    // a rim that is a stop brighter than the panel at the extreme silhouette
    // and invisible two degrees inboard of it.
    uRimAmt: { value: o.rim ?? 0.22 },
    uSunRim: { value: o.sunRim ?? 0.05 },
  };
}

/** Wire the two shared terms into a compiled shader. */
function injectLighting(shader) {
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>\n${CHAR_BOUNCE}`)
    .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${CHAR_RIM}`);
}

// -------------------------------------------------------------------------
// Cloth
// -------------------------------------------------------------------------

/**
 * Linear-space base colours per zone.
 *
 * Round 1 authored the whole kit between 0.013 and 0.05 linear — that is below
 * the albedo of coal, and it is why the critics saw "boots rendered as solid
 * black blobs" and "flat black cutouts". Nothing a soldier wears is that dark.
 * Field-worn nylon webbing is ~0.08, a sun-bleached uniform ~0.23, dusty
 * leather ~0.10. Pouches are deliberately LIGHTER than the carrier they sit on:
 * without that value step the whole chest rig merges into one slab.
 */
function defaultClothPalette() {
  const c = new Array(18).fill(null).map(() => new THREE.Vector3(0.25, 0.22, 0.15));
  // Round 4 raised the whole ladder ~24%. Measured against the sand it stands
  // on: sunlit sand renders at 0.224 display luminance and the soldier's shaded
  // side at 0.013, a 17:1 step. The lighting is not at fault — the key:fill in
  // LIGHT_TRANSPORT is 5.2 and the albedo ratio accounts for the other 3.2 —
  // but the result is a figure that is functionally black in every frame where
  // the sun is not on his face. Sun-bleached cotton twill measures 0.30-0.35
  // reflectance; 0.20 was closer to wet slate.
  c[Z.JACKET] = new THREE.Vector3(0.252, 0.214, 0.140);
  c[Z.SLEEVE] = new THREE.Vector3(0.250, 0.212, 0.138);
  c[Z.TROUSER] = new THREE.Vector3(0.234, 0.198, 0.127);
  c[Z.COLLAR] = new THREE.Vector3(0.220, 0.187, 0.121);
  c[Z.SHIRT] = new THREE.Vector3(0.168, 0.144, 0.103);
  // Round 4 lifted the load-bearing kit by ~40%. Measured on the round-3
  // gameplay frame the entire character sat at sRGB G≈28 while the ground's own
  // cast shadow four metres away sat at G≈55 — i.e. the soldier was rendering
  // half as bright as the shadow he stands in, which no khaki nylon does. The
  // value STEPS between these zones are what break the panel up, so they are
  // held (vest:webbing 1.28, pouch:vest 1.20, pack:pouch 1.12) while the whole
  // ladder moves up.
  c[Z.VEST] = new THREE.Vector3(0.152, 0.131, 0.087);
  c[Z.WEBBING] = new THREE.Vector3(0.119, 0.101, 0.068);
  c[Z.POUCH] = new THREE.Vector3(0.182, 0.155, 0.101);
  c[Z.BELT] = new THREE.Vector3(0.103, 0.086, 0.059);
  c[Z.LEATHER] = new THREE.Vector3(0.119, 0.085, 0.055);
  c[Z.GLOVE] = new THREE.Vector3(0.091, 0.075, 0.055);
  c[Z.KNEEPAD] = new THREE.Vector3(0.075, 0.067, 0.056);
  c[Z.PACK] = new THREE.Vector3(0.204, 0.174, 0.112);
  c[Z.HELMCOVER] = new THREE.Vector3(0.182, 0.157, 0.102);
  c[Z.CAP] = new THREE.Vector3(0.169, 0.143, 0.093);
  // Snake's bandana is the one saturated accent on an otherwise khaki
  // character. Round 4 pulled it toward oxide: at R/G 5.6 it was the single
  // most saturated thing in a frame whose whole grade is built on being
  // desaturated, and the tails read as a ribbon rather than as dyed cotton.
  // Round 5: lifted again. Measured on the shipped gameplay frame the whole
  // head — hair, bandana, ear, jaw — came back as ONE mass at sRGB 34-46 with a
  // 12-count spread across 110 px. The bandana at 0.132/0.038 was the same
  // LUMINANCE as the hair beside it, so the one internal value step on the head
  // was invisible; a faded oxide cotton is lighter than dark hair, not equal.
  c[Z.BANDANA] = new THREE.Vector3(0.163, 0.072, 0.056);
  // Dark brown. Round 5 put it BACK down: the round-1..4 argument for lifting
  // hair was that "the whole back of the head rendered as one silhouette", but
  // that was the inside-out skull (geometry.js), not the hair — which was
  // buried inside the skull and never drawn at all. Now that a real hair shell
  // stands 12 mm proud of a correctly-wound head, it has to be hair-coloured:
  // dark brown keratin is 0.05-0.09 diffuse reflectance, and against a 0.152
  // plate carrier that value step is the whole read of the head.
  c[Z.HAIR] = new THREE.Vector3(0.083, 0.062, 0.043);
  c[Z.BOOT] = new THREE.Vector3(0.147, 0.105, 0.065);
  return c;
}

const CLOTH_ROUGH = (() => {
  const r = new Array(18).fill(0.9);
  r[Z.LEATHER] = 0.58;
  r[Z.GLOVE] = 0.7;
  r[Z.KNEEPAD] = 0.62;
  r[Z.BELT] = 0.64;
  r[Z.POUCH] = 0.82;
  r[Z.VEST] = 0.84;
  r[Z.BANDANA] = 0.85;
  r[Z.HAIR] = 0.72;
  r[Z.BOOT] = 0.72;
  return r;
})();

const CLOTH_SHEEN = (() => {
  const s = new Array(18).fill(0.5);
  s[Z.LEATHER] = 0.08;
  s[Z.GLOVE] = 0.16;
  s[Z.KNEEPAD] = 0.1;
  s[Z.BELT] = 0.12;
  s[Z.JACKET] = 0.7;
  s[Z.SLEEVE] = 0.7;
  s[Z.TROUSER] = 0.68;
  s[Z.HAIR] = 0.9;
  s[Z.BOOT] = 0.28;
  return s;
})();

/**
 * Where fabric actually gathers, in bind space. Wrinkle amplitude is driven by
 * this, not sprayed evenly: a uniform noise field over a whole garment is the
 * single clearest "procedural" tell. Heights are read straight off the rig —
 * elbow 1.19, wrist 0.96, knee 0.51, blouse 0.25, belt 0.99, collar 1.48.
 */
const CLOTH_GATHER = /* glsl */ `
float ch_gather(vec3 b) {
  float ax = abs(b.x);
  float g = 0.0;
  float arm = smoothstep(0.19, 0.29, ax);
  // Inside of the elbow, and the cuff bunching back off the wrist.
  g += 1.30 * arm * exp(-pow((b.y - 1.185) / 0.075, 2.0));
  g += 0.95 * arm * exp(-pow((b.y - 0.985) / 0.045, 2.0));
  // Shoulder gather where the sleeve head is set into the body.
  g += 0.85 * smoothstep(0.11, 0.19, ax) * exp(-pow((b.y - 1.415) / 0.055, 2.0));
  float leg = smoothstep(0.02, 0.085, ax) * step(b.y, 0.95);
  // Back of the knee, and the blouse cinched over the boot.
  g += 1.20 * leg * exp(-pow((b.y - 0.505) / 0.070, 2.0));
  g += 1.05 * leg * exp(-pow((b.y - 0.255) / 0.050, 2.0));
  // Small of the back: pushed up by the belt, pulled down by the rig. Only at
  // the back (+z), which is the half the gameplay camera actually sees.
  g += 1.25 * smoothstep(0.01, 0.075, b.z) * exp(-pow((b.y - 1.045) / 0.065, 2.0));
  // Under the chest rig, where the straps compress the jacket.
  g += 0.80 * exp(-pow((b.y - 1.45) / 0.045, 2.0));
  // Hang of the jacket hem over the belt.
  g += 0.95 * exp(-pow((b.y - 0.905) / 0.045, 2.0));
  return g;
}
`;

/**
 * Panel seams. `vEdge.x` is the angle around the cross-section — 0 the
 * character's right, 0.25 front, 0.5 left, 0.75 back — so a side seam and a
 * centre-back seam are one smoothstep each. Add the shoulder yoke as a
 * horizontal band and a garment starts reading as something that was *cut and
 * sewn* rather than extruded.
 */
const CLOTH_SEAM = /* glsl */ `
float ch_seamLine(float a, float centre, float w) {
  float d = abs(fract(a - centre + 0.5) - 0.5);
  return 1.0 - smoothstep(w * 0.35, w, d);
}
float ch_seams(vec3 b, float a, int zi) {
  float s = 0.0;
  if (zi == 0 || zi == 2 || zi == 13) {
    // Torso / trousers: side seams and a centre-back seam.
    s = max(s, ch_seamLine(a, 0.0, 0.010));
    s = max(s, ch_seamLine(a, 0.5, 0.010));
    s = max(s, ch_seamLine(a, 0.75, 0.008) * 0.8);
  }
  if (zi == 1) {
    // Sleeve: one seam under the arm.
    s = max(s, ch_seamLine(a, 0.75, 0.012));
  }
  if (zi == 0) {
    // Yoke across the shoulder blades, and the hem stitch.
    s = max(s, (1.0 - smoothstep(0.004, 0.011, abs(b.y - 1.335))) * 0.9);
    s = max(s, (1.0 - smoothstep(0.004, 0.010, abs(b.y - 0.888))) * 0.8);
  }
  if (zi == 2) {
    // Trouser waistband and the knee-reinforcement panel.
    s = max(s, (1.0 - smoothstep(0.004, 0.010, abs(b.y - 1.012))) * 0.85);
    s = max(s, (1.0 - smoothstep(0.004, 0.010, abs(b.y - 0.575))) * 0.7);
    s = max(s, (1.0 - smoothstep(0.004, 0.010, abs(b.y - 0.445))) * 0.7);
  }
  return s;
}
`;

export function makeClothMaterial(opts = {}) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0.0,
    // Cloth sheen: a broad, rough retroreflective rim instead of a specular
    // hotspot. Without it fabric reads as painted plastic.
    sheen: 1.0,
    sheenRoughness: 0.9,
    sheenColor: new THREE.Color(0.5, 0.47, 0.42),
    specularIntensity: 0.2,
    envMapIntensity: 1.0,
    dithering: true,
  });
  mat.name = 'char-cloth';

  const palette = defaultClothPalette();
  if (opts.palette) for (const k in opts.palette) palette[k] = new THREE.Vector3(...opts.palette[k]);

  const uniforms = {
    uZoneColor: { value: palette },
    uZoneRough: { value: CLOTH_ROUGH.slice() },
    uZoneSheen: { value: CLOTH_SHEEN.slice() },
    uSeed: { value: opts.seed ?? 0 },
    uDust: { value: opts.dust ?? 0.55 },
    uWeave: { value: opts.weave ?? 1.0 },
    ...lightUniforms(opts),
  };
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    injectVertex(shader);
    injectLighting(shader);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         ${VARYINGS}
         ${NOISE}
         ${CLOTH_GATHER}
         ${CLOTH_SEAM}
         ${CHAR_LIGHT_PARS}
         uniform vec3 uZoneColor[18];
         uniform float uZoneRough[18];
         uniform float uZoneSheen[18];
         uniform float uSeed;
         uniform float uDust;
         uniform float uWeave;
         float gRough = 0.9;
         float gSheen = 0.5;
         float gGather = 0.0;
         float gStitch = 0.0;
         float gPix = 0.001;
         float gQuilt = 0.0;
         vec3 gSheenCol = vec3(0.5);
         // Load-bearing kit: carrier, pouches, webbing, belt, pack. Everything
         // in this set is a padded, stitched, laminated panel rather than a
         // draping fabric, and round 3 shaded it with the *fallback* branch of
         // every term below — which is why a 150 px span of a plate carrier
         // came back as one 8-bit value.
         // Webbing tape is 25 mm wide, so the 42 mm quilt lattice below is
         // nonsense on it — it lands as one arbitrary stripe per tape and the
         // whole rig reads as plaid. Tapes get the sag and the stitching only.
         bool ch_isKit(int zi) {
           return zi == 3 || zi == 5 || zi == 9 || zi == 12 || zi == 10 || zi == 15;
         }
         // Quilted padding: a stitch lattice at 42 mm with the pad puffing
         // between the lines. UVs are authored in metres, so this is a real
         // 42 mm cell wherever it lands. It is the single term that puts a
         // value break every ~16 px across the back panel at gameplay range.
         float ch_quilt(vec2 uvv, float pix) {
           float fade = 1.0 - smoothstep(0.0035, 0.011, pix);
           vec2 q = abs(fract(uvv / 0.042) - 0.5);
           float line = max(1.0 - smoothstep(0.02, 0.10, q.x), 1.0 - smoothstep(0.02, 0.10, q.y));
           float puff = (0.5 - q.x) * (0.5 - q.y) * 4.0;
           return (puff - 0.5 - line * 0.85) * fade;
         }`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         {
           int zi = int(vZone + 0.5);
           vec3 base = uZoneColor[zi];
           float rough = uZoneRough[zi];
           gSheen = uZoneSheen[zi];
           float ao = clamp(vAO, 0.0, 1.0);
           gAO = mix(0.35, 1.0, ao);

           // Metres covered by one pixel. Everything below thread scale is faded
           // out with it — procedural detail that survives to sub-pixel is just
           // shimmer, and shimmer is the loudest CG tell there is.
           gPix = max(fwidth(vUvC.x), fwidth(vUvC.y)) + 1e-6;

           vec3 bp = vBind * 1.0 + uSeed;
           bool garment = (zi == 0 || zi == 1 || zi == 2 || zi == 13 || zi == 14);
           bool kit = ch_isKit(zi);

           // Dye lot / sun-bleach variation: large soft patches, then a finer
           // fibre-level mottle. Kept SUBTLE — round 1 ran this so hard the
           // uniform read as blotchy camouflage instead of a solid dye lot.
           float macro = ch_fbm(bp * 2.6, 3);
           float meso = ch_fbm(bp * 11.0, 3);
           base *= 0.965 + macro * 0.075 + meso * 0.03;
           // Sun bleach lifts the upward-facing panels toward pale sand — it
           // must warm them, not grey them out.
           float bleach = smoothstep(0.2, 0.8, ch_fbm(bp * 1.6 + 4.0, 2)) *
                          smoothstep(-0.2, 0.7, vBindN.y);
           base = mix(base, base * vec3(1.26, 1.16, 1.00), bleach * 0.28);

           // Thread-level weave. A ripstop lattice at 7.5 mm (which survives to
           // gameplay distance) over a 1.4 mm plain weave (which does not, and
           // is faded out by footprint).
           float micro = 1.0 - smoothstep(0.00016, 0.00042, gPix);
           vec2 rs = abs(fract(vUvC / 0.0075) - 0.5);
           float ripstop = (1.0 - smoothstep(0.06, 0.16, rs.x)) + (1.0 - smoothstep(0.06, 0.16, rs.y));
           float wu = sin(vUvC.x * 4400.0) * 0.5 + 0.5;
           float wv = sin(vUvC.y * 4400.0) * 0.5 + 0.5;
           float weave = (wu * wv + (1.0 - wu) * (1.0 - wv));
           base *= 1.0 + (ripstop * 0.035 + (weave - 0.5) * 0.10 * micro) * uWeave * (garment ? 1.0 : 0.4);

           // Folds. Amplitude comes from where fabric really gathers, so the
           // creases land at the elbow, the back of the knee, the small of the
           // back and under the rig instead of being sprayed evenly.
           gGather = garment ? ch_gather(vBind) : 0.35;
           float foldScale = garment ? 1.0 : 1.8;
           vec3 fp = vec3(vBind.x * 26.0, vBind.y * 78.0, vBind.z * 26.0) * foldScale + uSeed * 3.0;
           float fold = ch_ridge(fp, 3);
           // Creases hold dirt and shade themselves; ridges catch the light.
           float creaseAmt = clamp(0.20 + gGather * 0.45 + (1.0 - ao) * 0.30, 0.0, 1.0);
           base *= 1.0 + (fold - 0.55) * 0.13 * creaseAmt;

           // Mid-scale sag: 6 cycles per metre, so roughly one lobe every 60 px
           // at gameplay range. Everything above runs at thread or crease
           // frequency, which the mip chain averages back to flat by the time
           // the character is 2.4 m from the lens; this is the octave that
           // actually survives. Kit gets it hardest because a loaded panel sags
           // between its stitch rows more than a sleeve does.
           float sag = ch_fbm(vBind * 6.0 + uSeed * 0.5, 2);
           base *= 1.0 + (sag - 0.5) * (kit ? 0.30 : 0.17);

           // Quilting on the load-bearing panels. The albedo share is small on
           // purpose: padding is a SHAPE, so almost all of this should arrive
           // through the normal, and a strong colour lattice reads as printed
           // plaid rather than as a stitched pad.
           if (kit) {
             gQuilt = ch_quilt(vUvC, gPix);
             base *= 1.0 + gQuilt * 0.030;
           }

           // Tailoring. Seams are a hair darker with a thread highlight beside
           // them; stitched borders run a few mm in from every cut edge.
           float seam = ch_seams(vBind, vEdge.x, zi);
           base *= 1.0 - seam * 0.20;
           float border = 1.0 - smoothstep(0.0030, 0.0055, abs(vEdge.y - 0.0042));
           float dash = step(0.42, fract(vUvC.x / 0.0026));
           gStitch = border * dash * (garment ? 0.25 : 1.0);
           // Round 4 pulled this back from *1.5 at 0.55 weight. Every lofted
           // pouch caps at both ends, so the border term fires 4.2 mm in from
           // each cap; at 50% lift that drew a bright cream outline around
           // every single piece of kit and the rig read as a line drawing.
           base = mix(base, base * 1.30 + vec3(0.008, 0.007, 0.005), gStitch * 0.38);

           // Ground-in dust: settles low on the body, in the creases, and on
           // anything that touches the ground. It LIGHTENS and warms — round 1
           // mixed toward a dark grey, which is soot, not Afghan dust.
           float low = smoothstep(0.85, 0.02, vBind.y);
           float dirtN = ch_fbm(bp * 5.5 + 11.0, 4);
           float dust = clamp(low * 0.85 + (1.0 - ao) * 0.4, 0.0, 1.0) *
                        smoothstep(0.32, 0.82, dirtN) * uDust;
           base = mix(base, vec3(0.290, 0.245, 0.166), dust * 0.24);
           rough = mix(rough, 0.97, dust * 0.6);
           // A darker grime in the deep creases keeps it from looking floured.
           base *= 1.0 - 0.10 * (1.0 - ao) * smoothstep(0.55, 0.2, fold);

           // Baked contact occlusion. Kept well off zero: an AO term that can
           // reach 0.35 is doing the job of a shadow map and turns armpits,
           // strap undersides and boot tops into holes. Round 4 raised the
           // floor again — stacked on the gAO term below it, 0.58 was taking
           // most of the character down to half the value of the shadow it
           // stands in.
           base *= mix(0.72, 1.0, pow(ao, 1.1));

           diffuseColor.rgb *= base;
           gRough = clamp(rough + (meso - 0.5) * 0.09 - seam * 0.06, 0.25, 1.0);
           // Sheen is a *whisper*. Cranked up it lights the whole garment from
           // the environment and fatigues turn into pale nylon.
           // Round 5: halved. Sheen is an ADDITIVE lobe that three adds on top
           // of the whole BRDF, so on a backlit subject a 0.078 sheen against a
           // 8.5-unit key was worth 30% of the surface's own sunlit diffuse.
           gSheenCol = mix(vec3(0.012, 0.011, 0.009), vec3(0.040, 0.037, 0.032), ao) * gSheen;
         }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = gRough;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         {
           mat3 tbn = ch_frame(normal, -vViewPosition, vUvC);
           int zi = int(vZone + 0.5);
           bool garment = (zi == 0 || zi == 1 || zi == 2 || zi == 13 || zi == 14);
           bool kit = ch_isKit(zi);
           float ao = clamp(vAO, 0.0, 1.0);

           // Ripstop lattice — a real, visible 7.5 mm grid of doubled threads.
           vec2 rs = fract(vUvC / 0.0075) - 0.5;
           vec2 nRip = vec2(-rs.x * (1.0 - smoothstep(0.06, 0.20, abs(rs.x))),
                            -rs.y * (1.0 - smoothstep(0.06, 0.20, abs(rs.y)))) * 1.7 * uWeave;
           // Plain weave under it, faded once it goes sub-pixel.
           float micro = 1.0 - smoothstep(0.00016, 0.00042, gPix);
           vec2 nWeave = vec2(cos(vUvC.x * 4400.0) * sin(vUvC.y * 4400.0),
                              sin(vUvC.x * 4400.0) * cos(vUvC.y * 4400.0)) * 0.10 * uWeave * micro;

           // Folds: stretched hard along the body axis so the creases run ACROSS
           // a limb the way real cloth gathers, and ridged so they are creases
           // rather than lumps.
           float foldScale = garment ? 1.0 : 1.8;
           vec3 fp = vec3(vBind.x * 26.0, vBind.y * 78.0, vBind.z * 26.0) * foldScale + uSeed * 3.0;
           float amp = clamp(0.16 + gGather * 0.42 + (1.0 - ao) * 0.28, 0.0, 0.95);
           float e = 0.30;
           float h0 = ch_ridge(fp, 3);
           float hx = ch_ridge(fp + vec3(e, 0.0, 0.0), 3);
           float hy = ch_ridge(fp + vec3(0.0, e * 2.4, 0.0), 3);
           vec2 nFold = vec2(h0 - hx, h0 - hy) * 2.6 * amp;

           // A second, much larger fold octave: the big diagonal drape a jacket
           // takes across the back. Sub-pixel wrinkles alone still read flat.
           vec3 gp = vec3(vBind.x * 7.0, vBind.y * 16.0, vBind.z * 7.0) + uSeed;
           float g0 = ch_fbm(gp, 2);
           vec2 nDrape = vec2(g0 - ch_fbm(gp + vec3(0.25, 0.0, 0.0), 2),
                              g0 - ch_fbm(gp + vec3(0.0, 0.25, 0.0), 2)) * 2.6 * (garment ? 1.0 : 0.85);

           // Quilt relief on the load-bearing panels: real 42 mm padding lobes
           // with a stitch trench between them. Sampled analytically off the
           // same lattice the albedo uses so the shading and the value step
           // agree, which is what stops it reading as a printed pattern.
           vec2 nQuilt = vec2(0.0);
           if (kit) {
             vec2 q = fract(vUvC / 0.042) - 0.5;
             float fade = 1.0 - smoothstep(0.0035, 0.011, max(fwidth(vUvC.x), fwidth(vUvC.y)));
             nQuilt = -q * 2.0 * fade * 0.95
                      - vec2(sign(q.x) * (1.0 - smoothstep(0.02, 0.10, abs(q.x))),
                             sign(q.y) * (1.0 - smoothstep(0.02, 0.10, abs(q.y)))) * 0.55 * fade;
           }

           // The one octave that survives the mip at gameplay range.
           vec3 sp = vBind * 6.0 + uSeed * 0.5;
           float s0 = ch_fbm(sp, 2);
           vec2 nSag = vec2(s0 - ch_fbm(sp + vec3(0.22, 0.0, 0.0), 2),
                            s0 - ch_fbm(sp + vec3(0.0, 0.22, 0.0), 2)) * (kit ? 5.5 : 3.2);

           // Seams and stitching are geometry too: a shallow trench with the
           // thread standing proud of it.
           float seam = ch_seams(vBind, vEdge.x, zi);
           float stitchN = gStitch * 0.55 - seam * 0.35;

           // Bounded. See ch_tangentNormal: the raw sum of these six terms
           // reaches 4-6, which tilts the shading normal 76-81 degrees off the
           // panel and lets a backlit 0.20-albedo pack catch the full key.
           vec2 nSum = nRip + nWeave + nFold + nDrape + nQuilt + nSag + vec2(stitchN);
           // Load-bearing kit is a stiff laminated panel and gets the tighter
           // bound; a sleeve or a trouser leg genuinely gathers harder.
           // tan(19 deg) / tan(24 deg).
           vec3 tn = ch_tangentNormal(nSum, kit ? 0.34 : 0.45);
           normal = normalize(tbn * tn);
         }`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
         material.sheenColor = gSheenCol;
         material.sheenRoughness = 0.92;`,
      );

    mat.userData.shader = shader;
  };
  return mat;
}

// -------------------------------------------------------------------------
// Skin
// -------------------------------------------------------------------------

export function makeSkinMaterial(opts = {}) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.52,
    metalness: 0.0,
    // Skin's specular is broad and weak. A default dielectric F0 with low
    // roughness is exactly the "wet plastic doll" look we must avoid.
    specularIntensity: 0.42,
    envMapIntensity: 1.0,
    dithering: true,
  });
  mat.name = 'char-skin';

  const uniforms = {
    uSkin: { value: new THREE.Vector3(...(opts.tone ?? [0.395, 0.252, 0.182])) },
    uSSS: { value: new THREE.Vector3(...(opts.sss ?? [0.72, 0.30, 0.20])) },
    uSSSAmount: { value: opts.sssAmount ?? 0.34 },
    uSeed: { value: opts.seed ?? 0 },
    uStubble: { value: opts.stubble ?? 0.5 },
    uBrow: { value: opts.brow ?? 1.0 },
    // Skin wants a warmer, weaker rim than cloth: a cold sky rim on a face
    // reads as a chrome edge.
    ...lightUniforms({ rimColor: [1.0, 0.86, 0.74], rim: 0.26, sunRim: 0.06, bounce: 0.09, warmMix: 0.14, ...opts }),
  };
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    injectVertex(shader);
    injectLighting(shader);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         ${VARYINGS}
         ${NOISE}
         ${CHAR_LIGHT_PARS}
         uniform vec3 uSkin;
         uniform vec3 uSSS;
         uniform float uSSSAmount;
         uniform float uSeed;
         uniform float uStubble;
         uniform float uBrow;
         float gRough = 0.52;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         {
           vec3 c = uSkin;
           vec3 bp = vBind * 1.0 + uSeed * 0.7;
           float ao = clamp(vAO, 0.0, 1.0);
           // The AO bake voxel is 22 mm, and a bandana, a hair shell and an
           // eyepatch strap all sit within 5 mm of the skull — so the bake
           // occludes the entire face against headgear that is physically
           // touching it. Floor it: a face has real contact shadow only in the
           // eye sockets and under the jaw, not across the cheeks.
           if (vZone < 0.5) ao = max(ao, 0.72);
           gAO = mix(0.5, 1.0, ao);

           // Dermal mottling: blotchy melanin + a finer capillary red.
           float m1 = ch_fbm(bp * 9.0, 3);
           float m2 = ch_fbm(bp * 34.0, 3);
           c *= 0.94 + m1 * 0.13;
           c = mix(c, c * vec3(1.14, 0.9, 0.87), smoothstep(0.45, 0.85, m1) * 0.5);
           c *= 0.97 + m2 * 0.06;

           // Face features, keyed to bind space so they never swim.
           vec3 hp = vBind - vec3(0.0, 1.655, -0.012);
           if (vZone > 3.5) {
             // Eyeball: sclera, limbal ring, iris, pupil.
             float ax2 = abs(hp.x);
             vec2 iv = vec2(ax2 - 0.0325, hp.y - 0.006);
             float fwd = smoothstep(-0.061, -0.069, hp.z);
             float ir = length(vec2(iv.x, iv.y * 1.03));
             vec3 sclera = vec3(0.62, 0.575, 0.545) * (0.9 + 0.16 * ch_fbm(vBind * 900.0, 2));
             vec3 iris = vec3(0.085, 0.062, 0.038) * (0.7 + 0.9 * ch_fbm(vBind * 2600.0, 2));
             vec3 c2 = mix(sclera, iris, smoothstep(0.0064, 0.0048, ir) * fwd);
             c2 = mix(c2, vec3(0.004), smoothstep(0.0028, 0.0019, ir) * fwd);
             // Painted lids: outside the almond aperture the eyeball is shaded
             // as skin, so the sphere merges into the socket without needing
             // separate eyelid geometry.
             float aperture = smoothstep(0.0072, 0.0050, abs(iv.y) + max(0.0, abs(iv.x) - 0.0026) * 0.62);
             float open = aperture * fwd;
             vec3 lid = uSkin * 0.68;
             c2 = mix(lid, c2, open);
             c2 *= mix(0.45, 1.0, ao);
             diffuseColor.rgb *= c2;
             gRough = mix(0.58, 0.13, open);
           } else {
           float isHead = smoothstep(-0.14, -0.06, hp.y) * step(vZone, 0.5);
           if (isHead > 0.0) {
             float ax = abs(hp.x);
             // Eyebrow: a 9 mm hair band, not a mask. Round 1 painted this so
             // wide and so dark that the whole mid-face went black.
             float brow = smoothstep(0.046, 0.028, ax) *
                          smoothstep(0.011, 0.004, abs(hp.y - 0.0295 + ax * 0.12)) *
                          smoothstep(-0.055, -0.072, hp.z);
             c = mix(c, vec3(0.075, 0.052, 0.038), clamp(brow, 0.0, 1.0) * 0.62 * uBrow * isHead);
             // Soft shadow under the brow ridge.
             float browShade = smoothstep(0.055, 0.02, ax) *
                               smoothstep(0.020, 0.006, abs(hp.y - 0.021)) *
                               smoothstep(-0.05, -0.068, hp.z);
             c *= 1.0 - 0.11 * clamp(browShade, 0.0, 1.0) * isHead;
             // Lash line only — the eye itself is real geometry.
             vec2 ev = vec2(ax - 0.032, hp.y - 0.008);
             float lash = smoothstep(0.013, 0.009, length(ev * vec2(0.85, 3.6))) *
                          smoothstep(-0.050, -0.066, hp.z);
             c = mix(c, vec3(0.07, 0.055, 0.048), clamp(lash, 0.0, 1.0) * 0.40 * isHead);
             // Nostril + philtrum shadow.
             float nose = smoothstep(0.015, 0.006, abs(ax - 0.011)) *
                          smoothstep(0.011, 0.004, abs(hp.y + 0.030)) *
                          smoothstep(-0.075, -0.09, hp.z);
             c = mix(c, vec3(0.085, 0.050, 0.038), clamp(nose, 0.0, 1.0) * 0.7 * isHead);
             // Mouth line, and lips a shade redder than the surrounding skin.
             float lipBody = smoothstep(0.026, 0.006, ax) *
                             smoothstep(0.016, 0.004, abs(hp.y + 0.052)) *
                             smoothstep(-0.062, -0.075, hp.z);
             c = mix(c, uSkin * vec3(1.06, 0.72, 0.66), clamp(lipBody, 0.0, 1.0) * 0.6 * isHead);
             float lip = smoothstep(0.028, 0.008, ax) *
                         smoothstep(0.005, 0.001, abs(hp.y + 0.052)) *
                         smoothstep(-0.066, -0.078, hp.z);
             c = mix(c, vec3(0.115, 0.055, 0.048), clamp(lip, 0.0, 1.0) * 0.7 * isHead);
             // Stubble across the jaw and upper lip. A tint, NOT a black mask:
             // shaved hair under skin is a cool grey shift of maybe 25%.
             float beardRegion = smoothstep(-0.024, -0.062, hp.y) *
                                 smoothstep(0.105, 0.05, ax + max(0.0, hp.z + 0.02));
             float grain = smoothstep(0.35, 0.75, ch_fbm(vBind * 420.0, 2));
             c = mix(c, c * vec3(0.80, 0.815, 0.845),
                     clamp(beardRegion, 0.0, 1.0) * (0.22 + grain * 0.34) * uStubble * isHead);
           }

           if (vZone > 0.5 && vZone < 1.5) {
             // Neck: shaded by the collar and the jaw, but never crushed. The
             // 22 mm AO voxel already buries the neck against the collar and
             // the jaw from two sides, so this term stacks on top of a bake
             // that is doing most of the work; at 0.66 the throat read as a
             // black slot between the head and the shoulders.
             c *= mix(0.80, 1.0, smoothstep(1.49, 1.585, vBind.y));
           }
           c *= mix(0.84, 1.0, pow(ao, 0.85));
           diffuseColor.rgb *= c;

           // Oilier on the forehead and nose, drier on the cheeks and hands.
           float oily = smoothstep(-0.02, 0.06, hp.y) * isHead;
           gRough = clamp(mix(0.60, 0.40, oily) + (m2 - 0.5) * 0.10, 0.3, 0.9);
           }
         }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = gRough;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         {
           mat3 tbn = ch_frame(normal, -vViewPosition, vUvC);
           float pix = max(fwidth(vUvC.x), fwidth(vUvC.y)) + 1e-6;
           // Pores fade out once they go sub-pixel; the coarser skin folds stay.
           float fine = 1.0 - smoothstep(0.0002, 0.0009, pix);
           vec3 pp = vBind * 300.0;
           float e = 0.6;
           float h0 = ch_fbm(pp, 2);
           vec2 g = vec2(h0 - ch_fbm(pp + vec3(e, 0.0, 0.0), 2), h0 - ch_fbm(pp + vec3(0.0, e, 0.0), 2));
           vec3 cp = vBind * 55.0;
           float c0 = ch_ridge(cp, 2);
           vec2 gc = vec2(c0 - ch_ridge(cp + vec3(0.2, 0.0, 0.0), 2), c0 - ch_ridge(cp + vec3(0.0, 0.2, 0.0), 2));
           // tan(19 deg). Pores and skin creases are shallow; anything steeper
           // is the same unbounded-gradient bug the cloth had.
           normal = normalize(tbn * ch_tangentNormal(g * 1.8 * fine + gc * 1.1, 0.34));
         }`,
      )
      // Subsurface: wrapped diffuse with a blood-red tint in the terminator.
      // This single term is the difference between skin and painted plastic.
      .replace(
        '#include <lights_physical_pars_fragment>',
        `#include <lights_physical_pars_fragment>
         void RE_Direct_Skin(const in IncidentLight directLight, const in vec3 geometryPosition,
                             const in vec3 geometryNormal, const in vec3 geometryViewDir,
                             const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material,
                             inout ReflectedLight reflectedLight) {
           float ndl = dot(geometryNormal, directLight.direction);
           float lam = saturate(ndl);
           vec3 irradiance = lam * directLight.color;
           reflectedLight.directSpecular += irradiance * BRDF_GGX(directLight.direction, geometryViewDir, geometryNormal, material);
           reflectedLight.directDiffuse += irradiance * BRDF_Lambert(material.diffuseColor);
           // Wrapped diffuse minus lambert = the light that only exists because
           // light scattered *through* the skin. Must go through the same
           // 1/PI normalisation as the lambert lobe or it swamps it and the
           // character turns into raw meat.
           float wrapped = saturate((ndl + 0.45) / 1.45);
           reflectedLight.directDiffuse += (wrapped - lam) * directLight.color * uSSS * uSSSAmount * BRDF_Lambert(material.diffuseColor);
         }
         #undef RE_Direct
         #define RE_Direct RE_Direct_Skin`,
      );

    mat.userData.shader = shader;
  };
  return mat;
}

// -------------------------------------------------------------------------
// Metal — weapons, the prosthetic arm, buckles
// -------------------------------------------------------------------------

export function makeMetalMaterial(opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.55,
    metalness: 1.0,
    envMapIntensity: 1.0,
    dithering: true,
  });
  mat.name = 'char-metal';

  const colors = [
    new THREE.Vector3(0.135, 0.133, 0.130), // gunmetal, phosphate-black
    new THREE.Vector3(0.145, 0.048, 0.036), // prosthetic: matte oxide red
    new THREE.Vector3(0.52, 0.40, 0.19), // brass
    new THREE.Vector3(0.048, 0.047, 0.045), // polymer furniture (dielectric)
    new THREE.Vector3(0.035, 0.055, 0.065), // optic glass
  ];
  const uniforms = {
    uMetalColor: { value: colors },
    uSeed: { value: opts.seed ?? 0 },
    ...lightUniforms({ rim: 0.30, sunRim: 0.05, bounce: 0.07, warmMix: 0.14, ...opts }),
  };
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    injectVertex(shader);
    injectLighting(shader);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         ${VARYINGS}
         ${NOISE}
         ${CHAR_LIGHT_PARS}
         uniform vec3 uMetalColor[5];
         uniform float uSeed;
         float gRough = 0.55;
         float gMetal = 1.0;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         {
           int zi = int(vZone + 0.5);
           vec3 base = uMetalColor[zi];
           float ao = clamp(vAO, 0.0, 1.0);
           gAO = mix(0.4, 1.0, ao);

           // Anodised / phosphated finishes are MATTE — the read is a soft wide
           // highlight, never a mirror. Roughness stays high; variation comes
           // from handling wear, not from a gloss coat.
           float rough = 0.6;
           float metal = 1.0;
           if (zi == 1) { rough = 0.7; metal = 0.6; }
           if (zi == 3) { rough = 0.68; metal = 0.0; }
           if (zi == 4) { rough = 0.12; metal = 0.0; }

           float grain = ch_fbm(vBind * 900.0 + uSeed, 2);
           rough += (grain - 0.5) * 0.16;

           // Directional micro-scratches from cleaning and carry.
           float scr = ch_fbm(vec3(vBind.x * 40.0, vBind.y * 620.0, vBind.z * 40.0) + uSeed * 5.0, 3);
           rough -= smoothstep(0.62, 0.9, scr) * 0.2;

           // Edge wear: exposed geometry (high AO) polishes down to bright steel.
           float wear = smoothstep(0.9, 1.0, ao) * smoothstep(0.55, 0.85, ch_fbm(vBind * 90.0 + 3.0, 3));
           base = mix(base, vec3(0.38, 0.375, 0.365), wear * 0.35 * (zi == 4 ? 0.0 : 1.0));
           rough = mix(rough, 0.28, wear * 0.5);

           base *= mix(0.52, 1.0, pow(ao, 1.1));
           diffuseColor.rgb *= base;
           gRough = clamp(rough, 0.06, 1.0);
           gMetal = metal;
         }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = gRough;`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
         metalnessFactor = gMetal;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         {
           mat3 tbn = ch_frame(normal, -vViewPosition, vUvC);
           vec3 pp = vBind * 700.0;
           float e = 0.5;
           float h0 = ch_fbm(pp, 2);
           vec2 g = vec2(h0 - ch_fbm(pp + vec3(e, 0.0, 0.0), 2), h0 - ch_fbm(pp + vec3(0.0, e, 0.0), 2));
           // Machined metal is FLAT: tan(11 deg) is already generous for a
           // phosphate finish, and an over-tilted normal on a metalness-1
           // surface samples a random mip of the sky and glitters.
           normal = normalize(tbn * ch_tangentNormal(g * 1.1, 0.20));
         }`,
      );

    mat.userData.shader = shader;
  };
  return mat;
}

/** Boot soles, rifle grips, kneepad rubber. */
export function makeRubberMaterial(opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.048, 0.045, 0.041),
    roughness: 0.84,
    metalness: 0.0,
    envMapIntensity: 0.8,
  });
  mat.name = 'char-rubber';
  const uniforms = lightUniforms({ rim: 0.28, sunRim: 0.035, bounce: 0.10, warmMix: 0.14, ...opts });
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    injectVertex(shader);
    injectLighting(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${VARYINGS}\n${NOISE}\n${CHAR_LIGHT_PARS}\nfloat gRough = 0.84;`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         {
           float ao = clamp(vAO, 0.0, 1.0);
           gAO = mix(0.45, 1.0, ao);
           // A sole that has been walked on in a desert is caked, not black.
           float dust = smoothstep(0.32, 0.8, ch_fbm(vBind * 34.0, 3));
           float low = smoothstep(0.16, 0.0, vBind.y);
           diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.235, 0.198, 0.138), dust * (0.35 + low * 0.5));
           diffuseColor.rgb *= mix(0.6, 1.0, ao);
           gRough = mix(0.84, 0.96, dust);
         }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = gRough;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         {
           mat3 tbn = ch_frame(normal, -vViewPosition, vUvC);
           // Lug pattern: a real 11 mm chevron block tread, not noise.
           vec2 lug = vUvC / vec2(0.013, 0.011);
           lug.x += floor(lug.y) * 0.5;
           vec2 lf = abs(fract(lug) - 0.5);
           vec2 nLug = vec2(-sign(fract(lug).x - 0.5) * (1.0 - smoothstep(0.28, 0.46, lf.x)),
                            -sign(fract(lug).y - 0.5) * (1.0 - smoothstep(0.28, 0.46, lf.y))) * 0.9;
           vec3 pp = vBind * 220.0;
           float h0 = ch_fbm(pp, 2);
           vec2 g = vec2(h0 - ch_fbm(pp + vec3(0.6, 0.0, 0.0), 2), h0 - ch_fbm(pp + vec3(0.0, 0.6, 0.0), 2));
           // A lug block has near-vertical walls but they are two pixels wide at
           // any distance this is seen from; tan(35 deg) is the honest average.
           normal = normalize(tbn * ch_tangentNormal(g * 2.0 + nLug, 0.70));
         }`,
      );
  };
  return mat;
}

export function makeMaterialSet(opts = {}) {
  return {
    cloth: makeClothMaterial(opts.cloth ?? {}),
    skin: makeSkinMaterial(opts.skin ?? {}),
    metal: makeMetalMaterial(opts.metal ?? {}),
    rubber: makeRubberMaterial(opts.rubber ?? {}),
  };
}
