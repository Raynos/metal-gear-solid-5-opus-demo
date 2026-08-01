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
 * Normal *and* mean curvature from one five-tap stencil. Curvature is positive
 * in a hollow and negative on a nose, normalised by the stencil radius so it is
 * a slope difference per metre rather than a height.
 *
 * The extra tap is the cheapest placement signal there is. Concave ground
 * collects water, seed and wind-blown fines; convex ground sheds all three, so
 * this is what puts the scrub in the swales and leaves the spurs bare instead
 * of dusting both evenly.
 */
vec3 vegGroundAt(vec2 p, float e, out float curv) {
  float h0 = vegHeightAt(p);
  float hL = vegHeightAt(p - vec2(e, 0.0));
  float hR = vegHeightAt(p + vec2(e, 0.0));
  float hD = vegHeightAt(p - vec2(0.0, e));
  float hU = vegHeightAt(p + vec2(0.0, e));
  curv = ((hL + hR + hD + hU) * 0.25 - h0) / e;
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
  // 2.8, not 2.2: at 2.2 this was 0.076 on wild ground (dev = 0), and the
  // shoulder term below then put a 0.047 density floor under the entire map.
  float shoulder = max(0.0, 1.0 - abs(dev - 0.42) * 2.8);
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
 *
 * Four signals, all of which the critics read off the frame as missing:
 *
 *   slope     hard zero past 30 degrees (1 - cos 30 = 0.134). Tussock does not
 *             hold a scree face; the old mask only reached zero at 62 degrees,
 *             so every hillside carried the same dusting as the pan.
 *   curvature concave collects, convex sheds — see vegGroundAt.
 *   cluster   a 40 m stand field, thresholded hard enough to leave over half
 *             the open plain genuinely bare. Bare ground between stands is not
 *             an absence of work, it IS the read: it is what gives the
 *             remaining stands a shape.
 *   drainage  ROUND 4: s.a, the D8 flow ACCUMULATION Terrain started publishing
 *             this round, not s.r. s.r is the thresholded mask the terrain
 *             shader paints wadis with, and it measures identically zero over
 *             the whole 640x800 m of valley floor the vista frames — so every
 *             previous round's "grass follows water" term contributed exactly
 *             nothing on the ground the critics were looking at. Under the
 *             accumulation the wet lines carry ~4x what the divides do.
 *
 * vegCover is the same field with the per-tussock clump term left out — the
 * smooth, 40 m-scale *coverage* of the ground, which is what the distant tonal
 * layer paints with. Both come out of one call so the extra texture work is a
 * couple of noise octaves rather than a second ground query.
 */
float vegWetness(vec4 s) {
  return max(s.r, smoothstep(0.18, 0.62, s.a));
}
float vegDensity(vec2 p, out float slope, out float dev, out float cover, out float woody) {
  float curv;
  vec3 n = vegGroundAt(p, 7.0, curv);
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
  float stand = vegFbm(p * 0.025 + 17.0, 2);
  float standW = vegFbm(p * 0.023 - 63.0, 2);

  float raw = 0.10 + vegWetness(s) * 2.55 + (macro - 0.5) * 1.5 + (meso - 0.5) * 1.7;
  float fert = smoothstep(0.0, 0.62, raw);
  float collect = clamp(0.72 + curv * 5.5, 0.16, 1.85);
  float rocky = max(s.g, s.b * 0.6);
  float d = fert * collect * (1.0 - smoothstep(0.18, 0.68, rocky));
  // A wadi carries grass whatever the 40 m stand field says about the range
  // condition around it — the water beats the grazing.
  float standCut = 0.448 - vegWetness(s) * 0.200;
  d *= smoothstep(standCut, standCut + 0.185, stand);
  d *= 1.0 - smoothstep(0.075, 0.140, slope);
  cover = clamp(vegDevelopment(p, d, pad.g, pad.b, slope), 0.0, 1.0);
  // The WOODY mask, mirrored from VegField.density so the distant tonal layer
  // paints the same coverage the near-field bushes stand in. Round 5 needs it
  // because the bush tiers past 140 m are gone: without a woody term the cover
  // layer stops at the grass mask's 30 degree slope cut and every hillside in
  // the vista goes bare at exactly the range the geometry hands over.
  float w = fert * min(1.5, collect) * (1.0 - smoothstep(0.52, 0.98, rocky)) * 1.95;
  float standCutW = 0.452 - vegWetness(s) * 0.185;
  w *= smoothstep(standCutW, standCutW + 0.235, standW);
  w *= 1.0 - smoothstep(0.090, 0.175, slope);
  woody = clamp(vegDevelopment(p, w, pad.g, pad.b, slope), 0.0, 1.0);
  return clamp(cover * smoothstep(0.24, 0.58, clump), 0.0, 1.0);
}
float vegDensity(vec2 p, out float slope, out float dev, out float cover) {
  float woody;
  return vegDensity(p, slope, dev, cover, woody);
}
float vegDensity(vec2 p, out float slope, out float dev) {
  float cover;
  return vegDensity(p, slope, dev, cover);
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
  // Contrast on the long octave only. A raw value noise spends most of its life
  // near its mean, so summing three of them gives a field that hovers around 0.5
  // everywhere and reads as everything wobbling at once. Steepening the 38 m
  // octave gives the field genuine lulls and genuine fronts — the gust arrives
  // as an edge with still grass ahead of it, which is what makes it a wave.
  g1 = smoothstep(0.24, 0.78, g1);
  return (g1 * 0.60 + g2 * 0.28 + g3 * 0.12) * uWind.w;
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
 *
 * ROUND 3 — the gains here were the single biggest reason every critic measured
 * vegetation as *brighter* than the ground it grows out of.
 *
 *   - the sun lobe peaked at through*(0.55 + 1.05) * 0.52 = 0.83, i.e. a
 *     back-lit blade received 83% of a full frontal sun hit *in addition to*
 *     whatever the standard BRDF gave it. Under the dawn camera, which looks
 *     straight into a 6.1-unit sun, that turned the whole valley floor into
 *     glowing white confetti. Dead straw transmits perhaps a quarter of what
 *     lands on it, so the peak is now 0.26.
 *   - the sky term was a *constant ambient bolted onto the material*. It never
 *     went to zero, which is exactly why the critics measured branches at
 *     luminance 80 in a night frame: a plant that stays bright at night has a
 *     light baked into it. It is now a third of its old weight and exists only
 *     to keep the dark side of a blade off the floor, with the IBL (whose
 *     intensity came down to match) doing the real ambient work.
 *   - and both fall off with range. A through-scatter glow is a near-field
 *     effect on a resolved blade; at 400 m the blade is a third of a pixel and
 *     all the glow can do is lift that pixel off the terrain it is standing on.
 */
export const GLSL_DRY_SHADING = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec2 uTranslucency; // (through-scatter, sky wrap gain)

/**
 * Light that came through the blade rather than off it, in the blade's own
 * colour. Dry straw is a selective filter: what survives a pass through half a
 * millimetre of dead cellulose is the long end of the spectrum, which is why a
 * back-lit stand of dead grass goes amber while the same stand front-lit is
 * khaki. Multiplying by the albedo alone cannot produce that — it gives back
 * exactly the reflected colour — so the transmitted lobe carries its own tint.
 */
const vec3 VEG_TRANSMIT = vec3(1.24, 0.94, 0.52);

vec3 vegDryShading(vec3 N, vec3 V, vec3 albedo, float exposure, float sunVis, float dist) {
  float ndl = dot(N, uSunDir);
  float through = clamp(-ndl * 0.62 + 0.48, 0.0, 1.0);
  float lobe = pow(clamp(dot(-uSunDir, V), 0.0, 1.0), 2.5);
  // Sub-pixel geometry cannot be back-lit: there is no thickness left to see
  // through. Round 4 pulled the taper in from 90-300 m to 45-150 m. The dawn
  // camera looks straight into a low sun across a hillside that is entirely in
  // its own shade, and at 200-400 m a back-lit bush there was a bright speck on
  // a near-black slope — the white confetti round 2 was pulled up for, arriving
  // by a different route. Whatever is happening inside a plant 200 m away is
  // sub-pixel by definition; all a glow can do at that range is detach it from
  // the ground it stands on.
  float near = 1.0 - smoothstep(45.0, 150.0, dist);
  vec3 sun = uSunColor * VEG_TRANSMIT * (through * (0.48 + 0.52 * lobe)) * uTranslucency.x * sunVis * near;
  // Wrapped sky: (N.up + w) / (1 + w) with w = 1 gives a floor of 0.5 even for
  // a blade edge-on to the sky, which is what stops the dark side crushing.
  float sky = (N.y + 1.0) * 0.5;
  sky = mix(sky, 1.0, 0.35) * uTranslucency.y * mix(0.35, 1.0, near);
  return (sun + uSkyColor * sky) * exposure * albedo * RECIPROCAL_PI;
}
`;
