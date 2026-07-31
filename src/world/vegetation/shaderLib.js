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
 * Ground query, GPU side. Mirrors VegField: `uHeightMap` is Terrain's near-grid
 * heightfield as R32F (sampled NEAREST and interpolated by hand, so no float
 * filtering extension is required), `uSurfMap` is its baked drainage / bedrock /
 * scree / occlusion channels.
 */
export const GLSL_TERRAIN = /* glsl */ `
uniform sampler2D uHeightMap;
uniform sampler2D uSurfMap;
uniform vec4 uGridInfo; // (origin, cell, n, 1/n)

vec2 vegGridUV(vec2 wxz) {
  return clamp((wxz - uGridInfo.x) / uGridInfo.y, vec2(0.0), vec2(uGridInfo.z - 1.001));
}
float vegHeightAt(vec2 wxz) {
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
vec3 vegNormalAt(vec2 p, float e) {
  float hL = vegHeightAt(p - vec2(e, 0.0));
  float hR = vegHeightAt(p + vec2(e, 0.0));
  float hD = vegHeightAt(p - vec2(0.0, e));
  float hU = vegHeightAt(p + vec2(0.0, e));
  return normalize(vec3(hL - hR, 2.0 * e, hD - hU));
}
/**
 * Where vegetation is allowed to grow. Grass follows water: it thickens along
 * the drainage lines the terrain's erosion pass carved, breaks into patches on
 * the open flats, and is simply absent from bedrock, talus and steep faces.
 */
float vegDensity(vec2 p, out float slope) {
  vec3 n = vegNormalAt(p, 2.0);
  slope = 1.0 - n.y;
  vec4 s = vegSurfAt(p);

  // Three scales, each doing a different job: where the range is grazed out
  // (~120 m), where a stand of grass took hold (~19 m), and the individual
  // tussock (~2.4 m). The last one is what turns an even stubble into clumps
  // with bare ground between them, which is the whole read.
  float macro = vegFbm(p * 0.0085 + 41.0, 3);
  float meso = vegFbm(p * 0.052 - 12.0, 2);
  float clump = vegFbm(p * 0.42 + 7.0, 2);

  float raw = 0.46 + s.r * 0.85 + (macro - 0.5) * 1.5 + (meso - 0.5) * 1.3;
  float d = smoothstep(0.06, 0.52, raw) * smoothstep(0.30, 0.60, clump);
  d *= 1.0 - smoothstep(0.13, 0.48, slope);
  d *= 1.0 - smoothstep(0.15, 0.62, max(s.g, s.b * 0.6));
  return clamp(d, 0.0, 1.0);
}
`;

/**
 * Wind. A coherent gust field — two noise octaves scrolling along the wind
 * vector — so gusts travel across the field as visible waves. Every blade in a
 * gust leans together; only the small flutter term is per-blade.
 */
export const GLSL_WIND = /* glsl */ `
uniform float uTime;
uniform vec4 uWind; // (dirX, dirZ, strength, gustScale)

float vegGust(vec2 wxz) {
  vec2 d = uWind.xy;
  float g1 = vegNoise(wxz * 0.026 - d * uTime * 1.05);
  float g2 = vegNoise(wxz * 0.085 - d * uTime * 2.30);
  float g3 = vegNoise(wxz * 0.30 - d * uTime * 4.10);
  return (g1 * 0.55 + g2 * 0.32 + g3 * 0.13) * uWind.w;
}
`;
