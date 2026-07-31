/**
 * Shared GLSL fragments for the vegetation module.
 *
 * Everything here is injected into stock MeshStandardMaterial / MeshDepthMaterial
 * shaders via onBeforeCompile, so vegetation keeps shadows, IBL and fog. Nothing
 * in this file tonemaps or writes final colour.
 */

/** Hash / value noise. Integer-friendly (Hoskins) so lattice coords don't band. */
export const GLSL_NOISE = /* glsl */ `
float vegHash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 vegHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vegNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(vegHash21(i), vegHash21(i + vec2(1.0, 0.0)), f.x),
             mix(vegHash21(i + vec2(0.0, 1.0)), vegHash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float vegFbm(vec2 p, int oct) {
  float a = 0.5, s = 0.0, n = 0.0;
  mat2 rot = mat2(0.86, 0.51, -0.51, 0.86);
  for (int i = 0; i < 5; i++) {
    if (i >= oct) break;
    s += a * vegNoise(p);
    n += a;
    a *= 0.5;
    p = rot * p * 2.07;
  }
  return s / n;
}
`;

/**
 * Ground query, GPU side. Mirrors VegField.
 *
 *   uHeightMap  Terrain's near-grid heightfield as R32F (sampled NEAREST and
 *               interpolated by hand, so no float-filtering extension needed).
 *   uSurfMap    Terrain's baked drainage / bedrock / scree / occlusion.
 *   uPadMap     The outpost's grading: R lift in metres above natural ground,
 *               G development, B shelter. Zero everywhere the outpost did not
 *               touch, so `vegGroundY` degrades to the natural heightfield.
 *
 * The lift is not a nicety. The compound platform stands 25-33 m proud of the
 * terrain that `uHeightMap` describes; grass rooted on uHeightMap alone is
 * underground for 240 m in every direction.
 */
export const GLSL_TERRAIN = /* glsl */ `
uniform sampler2D uHeightMap;
uniform sampler2D uSurfMap;
uniform sampler2D uPadMap;
uniform vec4 uGridInfo; // (origin, cell, n, 1/n)
uniform vec4 uPadInfo;  // (origin, cell, n, 1/n)

vec2 vegGridUV(vec2 wxz) {
  return clamp((wxz - uGridInfo.x) / uGridInfo.y, vec2(0.0), vec2(uGridInfo.z - 1.001));
}
float vegNaturalY(vec2 wxz) {
  vec2 f = vegGridUV(wxz);
  vec2 i0 = floor(f);
  vec2 t = f - i0;
  vec2 uv = (i0 + 0.5) * uGridInfo.w;
  float d = uGridInfo.w;
  float h00 = texture2D(uHeightMap, uv).r;
  float h10 = texture2D(uHeightMap, uv + vec2(d, 0.0)).r;
  float h01 = texture2D(uHeightMap, uv + vec2(0.0, d)).r;
  float h11 = texture2D(uHeightMap, uv + vec2(d, d)).r;
  return mix(mix(h00, h10, t.x), mix(h01, h11, t.x), t.y);
}
vec4 vegSurfAt(vec2 wxz) {
  return texture2D(uSurfMap, (vegGridUV(wxz) + 0.5) * uGridInfo.w);
}
vec3 vegPadAt(vec2 wxz) {
  vec2 f = (wxz - uPadInfo.x) / uPadInfo.y;
  if (f.x < 0.0 || f.y < 0.0 || f.x > uPadInfo.z - 1.001 || f.y > uPadInfo.z - 1.001) return vec3(0.0);
  vec2 i0 = floor(f);
  vec2 t = f - i0;
  vec2 uv = (i0 + 0.5) * uPadInfo.w;
  float d = uPadInfo.w;
  vec3 p00 = texture2D(uPadMap, uv).rgb;
  vec3 p10 = texture2D(uPadMap, uv + vec2(d, 0.0)).rgb;
  vec3 p01 = texture2D(uPadMap, uv + vec2(0.0, d)).rgb;
  vec3 p11 = texture2D(uPadMap, uv + vec2(d, d)).rgb;
  return mix(mix(p00, p10, t.x), mix(p01, p11, t.x), t.y);
}
/** Finished ground: natural terrain plus whatever the engineers piled on it. */
float vegHeightAt(vec2 wxz) {
  return vegNaturalY(wxz) + vegPadAt(wxz).r;
}
vec3 vegNormalAt(vec2 p, float e) {
  float hL = vegHeightAt(p - vec2(e, 0.0));
  float hR = vegHeightAt(p + vec2(e, 0.0));
  float hD = vegHeightAt(p - vec2(0.0, e));
  float hU = vegHeightAt(p + vec2(0.0, e));
  return normalize(vec3(hL - hR, 2.0 * e, hD - hU));
}

/**
 * The engineered platform, as vegetation sees it. Mirror of applyDevelopment()
 * in VegField.js — keep the two in step.
 *   - the graded yard is driven on daily and is essentially sterile,
 *   - except right against the walls, where nothing ever drives,
 *   - and the cut embankment around it is the richest ground on the map,
 *     because that is where the wind drops everything it was carrying.
 */
float vegDevelopment(vec2 p, float d, float dev, float shelter, float slope) {
  float yard = smoothstep(0.40, 0.92, dev);
  float shoulder = max(0.0, 1.0 - abs(dev - 0.42) * 2.2);
  float ok = 1.0 - smoothstep(0.28, 0.62, slope);
  float out_ = d * (1.0 - yard * 0.985);
  // Shelter adds rather than scales: the strip against a wall is fertile
  // regardless of what the fertility noise says about the open ground. It is
  // still broken up by a metre-scale noise, though — a continuous unbroken
  // fringe around every object in the compound reads as a decal, not as weeds.
  // (the obvious name for this, 'patch', is a reserved word in GLSL ES.)
  float weedy = smoothstep(0.30, 0.72, vegFbm(p * 0.55 - 19.0, 2));
  out_ += shelter * 0.52 * ok * weedy;
  // Weeds in the cracks of the hardstand. A perfectly sterile slab is as
  // wrong as a lawn; a graded yard gets a tuft wherever the surface split.
  out_ += yard * 0.30 * ok * smoothstep(0.58, 0.90, vegFbm(p * 1.15 + 55.0, 2));
  out_ += shoulder * 0.62 * ok;
  return out_;
}

/**
 * Where vegetation is allowed to grow. Grass follows water: it thickens along
 * the drainage lines the terrain's erosion pass carved, breaks into patches on
 * the open flats, and is simply absent from bedrock, talus and steep faces.
 */
float vegDensity(vec2 p, out float slope, out float dev) {
  vec3 n = vegNormalAt(p, 2.0);
  slope = 1.0 - n.y;
  vec4 s = vegSurfAt(p);
  vec3 pad = vegPadAt(p);
  dev = pad.g;

  // Three scales, each doing a different job: where the range is grazed out
  // (~120 m), where a stand of grass took hold (~19 m), and the individual
  // tussock (~2.4 m). The last one is what turns an even stubble into clumps
  // with bare ground between them, which is the whole read.
  float macro = vegFbm(p * 0.0085 + 41.0, 3);
  float meso = vegFbm(p * 0.052 - 12.0, 2);
  float clump = vegFbm(p * 0.42 + 7.0, 2);

  // Weighted so the field genuinely *swings*: real stands of grass tens of
  // metres across with real bare ground between them. Round 1's balance left
  // it saturated almost everywhere, so the only variation left was the 2.4 m
  // clump term and the whole map read as one even stubble.
  float raw = 0.30 + s.r * 1.00 + (macro - 0.5) * 1.7 + (meso - 0.5) * 1.9;
  float d = smoothstep(0.0, 0.62, raw) * smoothstep(0.24, 0.58, clump);
  d *= 1.0 - smoothstep(0.16, 0.52, slope);
  d *= 1.0 - smoothstep(0.18, 0.68, max(s.g, s.b * 0.6));
  return clamp(vegDevelopment(p, d, pad.g, pad.b, slope), 0.0, 1.0);
}
`;

/**
 * Wind. A coherent gust field — three noise octaves scrolling along the wind
 * vector — so gusts travel across the field as visible waves. Every blade in a
 * gust leans together; only the small flutter term is per-blade.
 *
 * The long octave is deliberately very long (38 m) and slow: that is the scale
 * at which you *see* a gust arrive, as a band of bent grass crossing the field.
 */
export const GLSL_WIND = /* glsl */ `
uniform float uTime;
uniform vec4 uWind; // (dirX, dirZ, strength, gustScale)

float vegGust(vec2 wxz) {
  vec2 d = uWind.xy;
  // The scroll rates are in *noise units*, so they have to be divided by each
  // octave's frequency to read as a speed. 0.42/0.026 is about 16 m/s — the
  // speed of a real gust front, and slow enough that you watch the wave arrive.
  // Round 1's rate worked out at 40 m/s, which reads as a flicker, not a gust.
  float g1 = vegNoise(wxz * 0.026 - d * uTime * 0.42);
  float g2 = vegNoise(wxz * 0.085 - d * uTime * 1.35);
  float g3 = vegNoise(wxz * 0.30 - d * uTime * 3.60);
  return (g1 * 0.55 + g2 * 0.32 + g3 * 0.13) * uWind.w;
}
`;

/**
 * Dry-plant shading, shared by grass and scrub.
 *
 * Round 1's grass was called "harsh black-and-white straw spikes", and that is
 * exactly what a thin near-vertical ribbon does under a hard sun with nothing
 * but N.L: one half of every blade faces the sun and blows out, the other half
 * faces away and crushes. Real dry grass does two things this fixes:
 *
 *  1. It is *translucent*. A straw blade is a 0.1 mm membrane; light landing on
 *     its back comes through rather than stopping. Two lobes — a broad
 *     through-scatter that lifts every shadowed blade off black, and a tight
 *     forward lobe that flares when the camera looks toward the sun.
 *  2. It sits under an enormous hemisphere of sky. The sky term is applied with
 *     a *wrapped* cosine, because a blade's neighbours bounce light onto its
 *     dark side; a raw N.up leaves vertical blades unlit from above.
 *
 * The through-scatter *is* gated on the shadow map, via `sunVis`. It has to be:
 * at dusk the camera looks into the sun across a hillside that is entirely in
 * shadow, and an ungated glow lights up every blade on it — a field of warm
 * specks in a dark slope, which is the most obvious tell in the whole module.
 * The sky term is deliberately not gated; sky light reaches a shadowed blade.
 */
export const GLSL_DRY_SHADING = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec2 uTranslucency; // (through-scatter, sky wrap gain)

vec3 vegDryShading(vec3 N, vec3 V, vec3 albedo, float exposure, float sunVis) {
  float ndl = dot(N, uSunDir);
  float through = clamp(-ndl * 0.62 + 0.48, 0.0, 1.0);
  float lobe = pow(clamp(dot(-uSunDir, V), 0.0, 1.0), 2.5);
  vec3 sun = uSunColor * (through * (0.55 + 1.05 * lobe)) * uTranslucency.x * sunVis;
  // Wrapped sky: (N.up + w) / (1 + w) with w = 1 gives a floor of 0.5 even for
  // a blade edge-on to the sky, which is what stops the dark side crushing.
  float sky = (N.y + 1.0) * 0.5;
  sky = mix(sky, 1.0, 0.35) * uTranslucency.y;
  return (sun + uSkyColor * sky) * exposure * albedo * RECIPROCAL_PI;
}
`;
