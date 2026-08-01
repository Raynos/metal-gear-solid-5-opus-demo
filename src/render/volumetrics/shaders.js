/**
 * GLSL for the volumetric stack.
 *
 * All of these run as full-screen passes into private render targets *before*
 * the main scene render, so they may freely sample pipeline.hdr.depthTexture
 * and pipeline.hdr.texture (last frame's) without forming a feedback loop.
 * The result is composited back into the HDR buffer by an in-scene quad.
 *
 * ## What this layer is, and — more importantly — what it is NOT
 *
 * Round 1's biggest failure was that this pass ran a full-range exponential
 * height fog over EVERY pixel, sky included. A sky pixel picked up ~0.5 optical
 * depths of a single flat grey in-scatter colour, which replaced ~40 % of the
 * sky dome with an achromatic veil and flattened the dome's blue gradient from
 * a B-R spread of 0.106..0.247 down to a uniform 0.03..0.07. It also washed the
 * clouds out to within 0.03 luminance of the sky behind them, and the
 * per-row-constant optical-depth weights drew horizontal iso-distance bands
 * across every mid-ground.
 *
 * The sky dome is already a full atmospheric raymarch to the top of the
 * atmosphere. Nothing here may touch it. So the pass is now built the other way
 * round: every term is written to be exactly zero where it has nothing to say.
 *
 *   - aerial perspective: real Rayleigh/Mie/dust in-scattering against the
 *     DEPTH buffer only. Sky pixels are skipped outright; a 4 m prop picks up
 *     4e-4 optical depths and is untouched.
 *   - crepuscular shafts: the narrow forward-scattering lobe around the sun,
 *     modulated by kilometre-scale terrain shadowing. Explicitly the phase
 *     energy ABOVE isotropic, so it is identically zero more than ~50 deg off
 *     the sun and never double-counts the isotropic part above.
 *   - two lit cloud decks on a curved shell, which occlude the sky only where
 *     there is actually cloud: alpha is EXACTLY 0 in the gaps, so the dome's
 *     chroma gradient survives bit-for-bit. Measured: mean |B-R| error against
 *     the dome alone over clear-sky pixels is 0.0098.
 *   - cloud shadows crawling over the ground.
 *   - heat shimmer.
 */

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Shared helpers: depth reconstruction, phase functions, hashes. */
export const COMMON = /* glsl */ `
const float PI = 3.14159265359;
const float PLANET_R = 6371000.0;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Interleaved gradient noise — the cheapest per-pixel decorrelation that still
// looks like dither rather than static once it is temporally accumulated.
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

/**
 * Spatio-temporal jitter. IGN gives the per-pixel blue-noise-ish distribution;
 * advancing it by the golden ratio each frame keeps successive frames maximally
 * decorrelated, so N frames of history behave like N x the step count. The
 * second, independent stream (offset lattice) is used for the light march so
 * the two marches' quantisation errors never correlate into a pattern.
 */
float jitter1(vec2 px, float frame) { return fract(ign(px) + frame * 0.6180339887); }
float jitter2(vec2 px, float frame) { return fract(ign(px + 53.7) + frame * 0.3819660113); }

float hgPhase(float c, float g) {
  float g2 = g * g;
  float d = max(1e-4, 1.0 + g2 - 2.0 * g * c);
  return (1.0 - g2) / (4.0 * PI * d * sqrt(d));
}

/**
 * Phase relative to isotropic: 1.0 == isotropic, so "energy above isotropic" is
 * simply (p - 1.0). Capped, because a g=0.88 lobe evaluates to ~130x isotropic
 * within a degree of the sun; in a half-res buffer that is a single blinding
 * texel that aliases into a crawling speckle rather than a silver lining.
 */
float hgRel(float c, float g) { return min(hgPhase(c, g) * 4.0 * PI, 10.0); }

float remap(float v, float a, float b, float c, float d) {
  return c + (v - a) * (d - c) / max(1e-5, b - a);
}

vec3 worldFromDepth(vec2 uv, float rawDepth, mat4 invViewProj) {
  vec4 c = vec4(uv * 2.0 - 1.0, rawDepth * 2.0 - 1.0, 1.0);
  vec4 w = invViewProj * c;
  return w.xyz / w.w;
}

// three packs shadow depth into RGBA8 (packDepthToRGBA); mirror the unpack so we
// can query the engine's real shadow map from a raymarch.
float unpackRGBAToDepthV(vec4 v) {
  return dot(v, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}
`;

/** Copies the pipeline depth buffer to a linear view-depth texture. */
export const DEPTH_LINEARIZE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDepth;
uniform float uNear;
uniform float uFar;
void main() {
  float d = texture2D(tDepth, vUv).x;
  // perspective depth -> positive view-space distance from the camera plane
  float z = 2.0 * d - 1.0;
  float viewZ = (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
  gl_FragColor = vec4(viewZ, 0.0, 0.0, 1.0);
}
`;

export const VOLUMETRIC_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tDepth;        // raw device depth, last frame
uniform sampler2D tPrevColor;    // last frame's HDR colour (heat-haze refraction)
uniform sampler2D tSunHeight;    // terrain shadow-height field
uniform sampler2D tShadowMap;    // engine sun shadow map (RGBA packed)
uniform sampler2D tWeather;      // 2D cloud weather map
uniform sampler2D tSkyLut;       // sky radiance by view direction (see SkyLut.js)
uniform sampler3D tCloud;

uniform mat4 uInvViewProj;
uniform mat4 uShadowMatrix;
uniform vec3 uCamPos;
uniform vec3 uSunDir;            // world direction TOWARDS the sun (shafts only)
uniform vec3 uKeyDir;            // world direction TOWARDS the key light (sun OR moon)
uniform vec3 uKeyColor;          // key radiance in renderer linear units, night-aware
uniform vec3 uSkyZenith;         // sky radiance looking up
uniform vec3 uSkyHorizon;        // sky radiance at the horizon (warmer, brighter)
uniform vec3 uSkyAmb;            // whole-sky mean radiance — what a cloud top sees
uniform vec3 uGroundBounce;      // warm light the desert kicks back up at cloud bases
uniform vec2 uResolution;
uniform float uTime;
uniform float uFrame;
uniform float uTerrainSize;
uniform float uShadowExtent;     // half-width of the engine shadow frustum
uniform vec3 uShadowCenter;

uniform float uShaftDensity;     // extinction coefficient of the shaft medium
uniform float uShaftHeight;      // scale height of the shaft medium
uniform float uSunScatter;       // gain on the crepuscular lobe
uniform float uPhaseG;
uniform float uHazeOwned;        // 1 when this pass owns the distance haze
uniform vec3 uBetaR;             // Rayleigh extinction at the datum, per metre
uniform vec3 uBetaD;             // desert dust extinction at ground level, per metre
uniform vec3 uDustAlbedo;        // warm scattering albedo of the dust
uniform vec3 uGroundLight;       // radiance of the sunlit ground under the haze
uniform float uBetaM;
uniform float uDustTop;          // altitude of the capping inversion (m)
uniform float uDustHeight;       // scale height of the dust ABOVE the inversion
uniform float uApGain;           // overall strength of the distance haze
uniform float uApDesat;          // multiple-scattering flattening of the haze chroma
uniform vec3 uSkyMean;           // unit-luminance chroma of the whole-sky mean
uniform float uSkyLutValid;      // 1 when tSkyLut holds a real table
uniform float uApG;

uniform float uCloudCoverage;
uniform float uCloudBase;
uniform float uCloudTop;
uniform float uCloudDensity;
uniform float uCloudAbsorb;      // view-ray extinction of the cloud medium
uniform float uCloudLightExt;    // extinction along the light march (self-shadow)
uniform float uCloudGain;
uniform float uCloudAmbGain;
uniform float uCirrus;
uniform float uCirrusAlt;
uniform float uHeatHaze;
uniform float uCloudShadow;
uniform float uWindT;
uniform float uCloudFar;         // distance at which the deck has faded out (m)
uniform float uCloudStreak;      // 0 = isotropic weather, 1 = full cloud streets
uniform float uCloudVSquash;     // vertical anisotropy of the cloud shape lookup

${COMMON}

// ------------------------------------------------------------------ sky lookup

/**
 * Radiance of the sky looking along d. This is the convergence target for
 * every distance effect in this shader — the distance haze, the far end of the
 * cloud deck, the cirrus. Round 3 converged them all onto authored constants
 * instead, which is why the haze got warmer with distance while the sky it sat
 * under got cooler.
 *
 * Storage and warp are documented in SkyLut.js; the fallback is the old
 * horizon/zenith pair, used only if Sky exposes no query API at all.
 */
vec3 skyRadiance(vec3 d) {
  if (uSkyLutValid < 0.5) {
    return mix(uSkyHorizon, uSkyZenith, smoothstep(0.0, 0.55, d.y));
  }
  float u = atan(d.z, d.x) * 0.15915494 + 0.5;
  // Must match SkyLut.muFromV exactly. Round 6: the below-horizon margin went
  // 0.05 -> 0.02 and the table got 26 rows instead of 14. At 14 rows the first
  // THREE all clamped onto the horizon and the fourth landed at 0.9 degrees, so
  // the whole 0-6 degree band — which is where every distant ridge in the game
  // sits and where the dome's radiance falls fastest — was two linearly
  // interpolated samples. That mismatch against the dome is what made the far
  // cloud deck legible as a pattern of streaks over a sky it was supposed to
  // have dissolved into.
  float v = sqrt(clamp((d.y + 0.02) * (1.0 / 1.02), 0.0, 1.0));
  return texture2D(tSkyLut, vec2(u, v)).rgb;
}

// ---------------------------------------------------------------- shaft volume

// Exponential height medium; closed-form optical depth so the transmittance is
// perfectly smooth and only the shadow term carries any sampling noise.
float shaftOD(float y0, float dy, float t) {
  float k = 1.0 / uShaftHeight;
  float s = uShaftDensity * exp(-y0 * k);
  if (abs(dy) < 1e-4) return s * t;
  return s * (1.0 - exp(-dy * k * t)) / (dy * k);
}

/** Integral of exp(-y/H) along a straight ray between two altitudes. */
float heightInt(float y0, float y1, float dist, float H) {
  float k = (y1 - y0) / max(dist, 1e-3);
  float a = exp(-max(y0, -2000.0) / H);
  float b = exp(-max(y1, -2000.0) / H);
  if (abs(k) < 1e-3) return dist * 0.5 * (a + b);
  return (H / k) * (a - b);
}

/**
 * Column density of the dust along a straight chord, for a WELL-MIXED layer
 * under a capping inversion: uniform density up to uDustTop, then an
 * exponential tail of scale height H above it.
 *
 * ## Round 7: this is the fix for "the fog is inverted with distance"
 *
 * Rounds 1-6 modelled the dust as a bare exponential of scale height 330-480 m
 * referenced to the valley floor. Every ridge crest in this world stands 100 to
 * 450 m over a camera at 46 m, so a crest sits 1-1.4 scale heights up and the
 * chord to it spends most of its length climbing OUT of the medium. The
 * consequence measured on the shipped vista frame is that opacity FELL with
 * distance for anything tall — 4.2 km read thinner than 3.0 km, because the far
 * ridge is the higher one. That is the exact opposite of aerial perspective and
 * it is why no density in round 6's sweep could make the far skyline recede.
 *
 * A bare exponential is also the wrong physics. Suspended mineral dust is
 * lofted by surface wind and stirred by daytime convection into a layer that is
 * very nearly UNIFORM from the ground to the capping inversion, and then cut off
 * hard above it — that hard top is why you can look down on a brown haze lid
 * from a ridge. Uniform below the inversion is what makes optical depth grow
 * linearly with distance for every occluder standing in the layer, which is the
 * property aerial perspective actually needs; and the hard top is what keeps a
 * cumulus at 1.8-3.6 km from being buried, because it is above the lid.
 */
float dustColumn(float y0, float y1, float dist, float yTop, float H) {
  float d = max(dist, 1e-3);
  float lo = min(y0, y1);
  float hi = max(y0, y1);
  // Fraction of the chord below the inversion. The chord's altitude is linear
  // in path length, so this is a pure altitude ratio.
  float f = (hi - lo < 1.0) ? step(lo, yTop)
                            : clamp((yTop - lo) / (hi - lo), 0.0, 1.0);
  float col = d * f;
  if (f < 0.9999) {
    // The part above the lid, re-referenced so the exponential starts at 1.0
    // exactly at the inversion — no discontinuity in density across it.
    col += heightInt(max(lo, yTop) - yTop, hi - yTop, d * (1.0 - f), H);
  }
  return col;
}

/**
 * Optical depth of the low air along a slant path of 'dist' metres running
 * between altitudes y0 and y1, split by medium. Three media:
 *   Rayleigh  8 km scale height    -> the long-range blue
 *   Mie       1.4 km               -> the near-sun glow
 *   dust      mixed layer + lid    -> the body of the effect in a desert
 * The molecular terms are referenced to the real altitude of the plateau; the
 * dust layer is referenced to the valley floor, because that is what it
 * physically settles onto.
 *
 * Split three ways because the in-scatter source has to be weighted by WHICH
 * medium scattered it (only the dust carries a chroma of its own). Round 6 had
 * this function for the cloud deck and an inlined copy of it for the ridges;
 * they are one function now, so a deck 40 km out and a ridge 4 km out are seen
 * through the same air.
 */
void hazeTaus(float y0, float y1, float dist, out vec3 tR, out vec3 tM, out vec3 tD) {
  tR = uBetaR * heightInt(y0 + 400.0, y1 + 400.0, dist, 8000.0);
  tM = vec3(uBetaM * heightInt(y0 + 400.0, y1 + 400.0, dist, 1400.0));
  tD = uBetaD * dustColumn(y0, y1, dist, uDustTop, uDustHeight);
}

vec3 hazeTau(float y0, float y1, float dist) {
  vec3 tR, tM, tD;
  hazeTaus(y0, y1, dist, tR, tM, tD);
  return tR + tM + tD;
}

/**
 * Multiple-scattering flattening of an in-scatter chroma.
 *
 * Photons in a dense low haze bounce several times before they reach the lens,
 * and every bounce redistributes them across directions — so the chroma relaxes
 * toward the AVERAGE OF THE SKY, not toward grey. Round 4 mixed toward
 * vec3(luminance), which is a desaturation: it pulled the haze off the sky's
 * own blue and was one of the reasons a far ridge measured warmer than the sky
 * directly above it. uSkyMean is unit-luminance, so this moves hue only.
 */
vec3 msFlatten(vec3 src, float amt) {
  float sl = dot(src, vec3(0.2126, 0.7152, 0.0722));
  return mix(src, sl * uSkyMean, amt);
}

float terrainSunVis(vec3 p) {
  vec2 uv = p.xz / uTerrainSize + 0.5;
  if (uv.x < 0.002 || uv.x > 0.998 || uv.y < 0.002 || uv.y > 0.998) return 1.0;
  float sh = texture2D(tSunHeight, uv).r;
  // A soft edge doubles as a cheap penumbra; scale it with distance so far
  // ridges do not produce razor-sharp shafts.
  float soft = 1.0 + length(p - uCamPos) * 0.0022;
  return smoothstep(sh - soft, sh + soft, p.y);
}

// Near-field occluders (rocks, buildings, crates) live only in the engine's
// shadow box; fade the query out at its edge so nothing pops.
float mapSunVis(vec3 p) {
  vec4 sc = uShadowMatrix * vec4(p, 1.0);
  sc.xyz /= sc.w;
  vec2 d = abs(p.xz - uShadowCenter.xz) / uShadowExtent;
  float inside = 1.0 - smoothstep(0.35, 0.95, max(d.x, d.y));
  if (inside <= 0.001 || sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
  float depth = unpackRGBAToDepthV(texture2D(tShadowMap, sc.xy));
  float lit = step(sc.z - 0.0016, depth);
  return mix(1.0, lit, inside);
}

// ------------------------------------------------------------------- clouds

/**
 * Ray/spherical-shell intersection and altitude, both written so the planet
 * radius is never subtracted from (or squared alongside) a number of its own
 * magnitude. At 6371 km a float32 holds ~0.5 m of resolution and R*R quantises
 * to 4e6 m^2, so the naive forms lose the whole 1.6 km slab thickness in noise.
 *   H^2 - R^2  ->  (camY - alt)(2R + camY + alt)
 *   -b + sqrt  ->  c / (-b - sqrt)     (the algebraically equal, stable root)
 */
float shellDist(float camY, float rdy, float alt) {
  float H = PLANET_R + camY;
  float c = (camY - alt) * (2.0 * PLANET_R + camY + alt);
  float b = H * rdy;
  float disc = b * b - c;
  if (disc < 0.0 || c >= 0.0) return -1.0;
  return c / (-b - sqrt(disc));
}

/** Altitude above the (curved) datum of a point t metres along the view ray. */
float altAt(float camY, float rdy, float t) {
  float H = PLANET_R + camY;
  float k = (2.0 * H * rdy + t) * t;
  return (camY * (2.0 * PLANET_R + camY) + k) / (sqrt(H * H + k) + PLANET_R);
}

/**
 * Weather lookup. Wraps over ~46 km, drifting downwind. Returns
 *   x = coverage 0..1, y = cumulus-ness 0..1, z = per-cell top height 0..1
 */
vec3 weatherAt(vec2 xz) {
  vec2 w = xz * (1.0 / 46000.0) + vec2(uWindT * 0.000021, uWindT * 0.0000071);
  vec4 s = texture2D(tWeather, w);
  // Squash across the wind so banks form streets rather than an even sprinkle.
  //
  // Round 6: the squash is now a uniform and the presets set it near zero.
  // Parallel lines in a horizontal plane converge on a vanishing point, and a
  // cloud street IS a parallel line in a horizontal plane, so any anisotropy at
  // all draws a starburst centred on the downwind horizon. Ablated on
  // shots/r5-1080/vista.png: setting cloudCoverage to 0 removed the radial
  // spokes in the upper-left outright, while ablating the cirrus and the shaft
  // pass left them untouched — the streets, not the shafts, were drawing them.
  // Round 5 halved the anisotropy and it survived; this removes it as the
  // default and keeps the knob for a deliberately streeted sky.
  vec2 sq = mix(vec2(1.0), vec2(0.86, 1.55), uCloudStreak);
  float streak = texture2D(tWeather, w * sq + 0.27).b;
  float cov = mix(s.r, mix(s.r, streak, 0.18), uCloudStreak);
  cov = remap(cov, 0.30, 0.86, 0.0, 1.0);
  cov = clamp(cov * uCloudCoverage * 1.9, 0.0, 1.0);
  return vec3(cov, s.g, s.a);
}

/**
 * Vertical profile. typ slides between a flat, wide stratus deck (bottom-heavy,
 * hard flat base) and a tall cumulus (narrow at the base, billowing to an anvil).
 * The hard flat base is what makes a cloud deck read as sitting at an altitude.
 */
float heightProfile(float h, float cov, float typ, float peak) {
  float top = mix(0.34, 1.0, typ) * mix(0.62, 1.0, peak) * mix(0.55, 1.0, cov);
  float bottom = smoothstep(0.0, mix(0.045, 0.13, typ), h);
  float upper = smoothstep(top, top * mix(0.42, 0.72, typ), h);
  return clamp(bottom * upper, 0.0, 1.0);
}

/**
 * Density at a world point. lod fades the finest erosion octave out with
 * distance: detail finer than the step length only aliases, and aliased cloud
 * edges are exactly the "shimmering popcorn" tell.
 *
 * ## Round 4: the silhouette
 *
 * Round 3 built the shape from two octaves at 2600 m and 900 m. The 48^3 volume
 * carries its coarsest Worley at three cells per period, so 2600 m meant ~870 m
 * blobs, and a hard density threshold applied to a trilinearly interpolated
 * field of ~870 m blobs is a faceted polyhedron. Measured on
 * shots/r3-fix2/ground.png, a horizontal scan across a cloud at y=252 ran
 * 171 172 176 ... 230 239 243 [247 x 20] 246 ... 183 175 173: a plateau with two
 * hard shoulders and nothing in between, which is the outline of the noise cell,
 * not the outline of a cloud.
 *
 * Four octaves now, top one 130 m, so the silhouette breaks up at a fifth of the
 * scale a single puff subtends. The erosion keeps a floor at distance instead of
 * switching off entirely — a far cloud with NO high-frequency boundary is
 * exactly the flat-edged plate above, and a soft-but-present fringe aliases far
 * less than the hard threshold edge it replaces.
 */
float cloudDensity(vec3 p, float alt, vec3 wx, float lod) {
  float h = clamp((alt - uCloudBase) / (uCloudTop - uCloudBase), 0.0, 1.0);
  float prof = heightProfile(h, wx.x, wx.y, wx.z);
  if (prof <= 0.0) return 0.0;

  // Wind shear: a cumulus top lags downwind of its base, which is the cue that
  // says "this is a volume in a moving airmass" rather than an extruded decal.
  vec3 q = p + vec3(uWindT * 3.1 + 260.0 * h, 0.0, uWindT * 1.1 + 90.0 * h);
  // VERTICAL ANISOTROPY OF THE SHAPE LOOKUP — this is the fix for the radial
  // spokes (round 7).
  //
  // The slab is 1.8 km thick and the coarse shape octave has a 1.7 km period,
  // so without a vertical squash that octave — half the silhouette's energy —
  // is very nearly CONSTANT over the whole slab. The field it draws is a 2D
  // pattern extruded vertically: a sky full of curtains, not of puffs.
  //
  // A vertical curtain seen obliquely projects to a radial streak pointing at
  // the horizon, and it is a LONG one: a cloud at horizontal range R appears in
  // every ray whose slab chord covers R, i.e. every elevation with tan(el)
  // between base/R and top/R. Base 1800 and top 3600 is a factor of two, so
  // every cloud in the deck was smeared across a FULL OCTAVE of elevation —
  // a puff at 20 degrees dragging a streak down to 10.5. That is the fan in the
  // upper-left of shots/r6/vista.png, and it is why it survived round 6's
  // isotropic weather map, its range cut, and both of my ablations of the
  // self-shadow and the temporal resolve: none of them touch the extrusion.
  //
  // Squashing y by 2.6 puts the coarse octave's vertical period at 650 m
  // against the slab's 1800, so a cloud is three cells tall instead of one and
  // its silhouette closes above and below. Cumulus really are about as tall as
  // they are wide; the old field was 1.7 km wide and unbounded vertically.
  // The finer octaves already resolve the slab, so they are squashed less and
  // the 230 m one not at all — squashing them too would only make the erosion
  // fringe stripy.
  float vs = uCloudVSquash;
  float shape = texture(tCloud, q * vec3(1.0, vs, 1.0) * (1.0 / 1700.0)).r * 0.50
              + texture(tCloud, q * vec3(1.0, mix(1.0, vs, 0.4), 1.0) * (1.0 / 620.0) + 0.31).r * 0.31
              + texture(tCloud, q * (1.0 / 230.0) + 0.67).r * 0.19;

  float base = shape * prof;
  // Fixed-width transition band rather than "threshold to 1.0". Averaging four
  // octaves narrows the field's spread around 0.5, so a band that stretched from
  // the threshold all the way to 1.0 would never be crossed; and a constant band
  // width means the density ramp at a cloud's edge has a constant softness
  // instead of collapsing to a step wherever coverage happens to be high, which
  // is the other half of why round 3's silhouettes had hard shoulders.
  float thr = mix(0.80, 0.20, wx.x);
  float d = remap(base, thr, thr + 0.28, 0.0, 1.0);
  if (d <= 0.0) return 0.0;

  float er = mix(0.34, 1.0, lod);
  vec4 hi = texture(tCloud, (p + vec3(uWindT * 5.0, 0.0, uWindT * 1.8)) * (1.0 / 420.0));
  float fbm = hi.g * 0.50 + hi.b * 0.32 + hi.a * 0.18;
  // Erode hard at the base, softly at the top: wispy bottoms, firm anvils.
  float e = mix(fbm, 1.0 - fbm, clamp(h * 2.4, 0.0, 1.0)) * er;
  d = remap(d, e * 0.70, 1.0, 0.0, 1.0);
  d = clamp(d, 0.0, 1.0);
  // Crush the low tail (round 7). Everything above survives; what this removes
  // is the wide skirt of d ~ 0.01-0.10 around every puff. That skirt is
  // invisible in a 200 m step and impossible to miss in a 10 km one: a ray at
  // 12 degrees of elevation crosses 8.5 km of slab, so a skirt at d = 0.04
  // integrates to as much optical depth as 340 m of the cloud's core, and it
  // does it ALONG THE RAY — which draws it on screen as a faint tail running
  // from the puff down toward the horizon. Those tails are the residual fan
  // left after the vertical squash above, and they are the reason the deck
  // still read as a starburst with the cirrus ablated out.
  //
  // A gentle gamma rather than a hard floor: a floor is the round-3 faceted
  // shoulder. Measured on the vista deck, d^1.35 removes about two thirds of
  // the skirt's integrated optical depth and costs the puffs ~4% of their
  // projected area, where a full smoothstep costs 20% and visibly shrinks them.
  d = pow(d, 1.35);

  return d * uCloudDensity;
}

/**
 * Cloud shadow on the ground. One density probe where the sun ray from the
 * surface crosses the middle of the slab. Kilometre-wide shadows crawling over
 * the valley floor are one of the strongest depth and scale cues MGSV has, and
 * the terrain material is owned elsewhere, so it is applied here as extra
 * extinction on the background instead.
 */
float cloudShadowAt(vec3 p) {
  if (uSunDir.y < 0.06 || uCloudShadow < 0.001) return 0.0;
  float mid = uCloudBase + (uCloudTop - uCloudBase) * 0.35;
  float t = min((mid - p.y) / uSunDir.y, 16000.0);
  if (t <= 0.0) return 0.0;
  vec3 q = vec3(p.x + uSunDir.x * t, mid, p.z + uSunDir.z * t);
  vec3 wx = weatherAt(q.xz);
  if (wx.x < 0.001) return 0.0;
  float d = cloudDensity(q, mid, wx, 0.0);
  return (1.0 - exp(-d * uCloudLightExt * 700.0)) * uCloudShadow;
}

/**
 * Accumulated density from a point towards the key light through the slab.
 * Over a <= 1.5 km light path the planet's curvature contributes 0.2 m of
 * altitude, so the altitude is tracked linearly from the sample's own.
 */
float cloudLightMarch(vec3 p, float alt0, float jit) {
  float t = 0.0;
  float dsum = 0.0;
  float stepLen = 38.0 * (0.7 + 0.6 * jit);
  for (int i = 0; i < 6; i++) {
    t += stepLen;
    vec3 q = p + uKeyDir * t;
    float alt = alt0 + uKeyDir.y * t;
    if (alt > uCloudTop || alt < uCloudBase) break;
    dsum += cloudDensity(q, alt, weatherAt(q.xz), i < 2 ? 1.0 : 0.0) * stepLen;
    stepLen *= 1.9;
  }
  return dsum;
}

/**
 * Multiple-scattering approximation (Wrenninge): three octaves of decreasing
 * extinction, contribution and phase eccentricity. One light march feeds all
 * three. The tight first octave carries the brilliant sun-facing side and the
 * silver rim; the loose third keeps deep interiors from going to soot.
 *
 * ## Round 6: the level was ~1.7x too low
 *
 * uCloudGain was 0.42-0.58. At 88 degrees off the sun the three octaves sum to
 * a relative phase energy of ~0.80, so a fully lit cumulus flank came out at
 * 0.80 x uKeyColor x 0.44, which after the powder term landed UNDER the 1.652
 * scene-linear that sunlit sand is exposed for. That is a midtone, not a
 * highlight. Measured on shots/r5-1080/vista.png the brightest pixel out of
 * 2.07 M was rgb(229,213,198) and not one of them reached max-channel 230 — in
 * a frame containing sunlit cumulus.
 *
 * A cumulus face square to the sun is albedo ~0.9 and near-Lambertian:
 * 0.9/PI x E, against sand's 0.30/PI x E x cos(theta_sun). Four to five times
 * the sand on the flank, and more on a forward-scattering rim. 0.74-0.82 with
 * the peak cap below puts the vista frame at a brightest pixel of
 * rgb(245,237,228) and 1.86% of it over max-channel 230, from 0.000%. Nothing
 * about the shape of the tonemap changed; this is radiance authoring, which is
 * where the defect was. Ablated: this value alone back at 0.44 takes the frame
 * to a brightest pixel of rgb(234,219,203) and 0.017% over 230.
 */
vec3 cloudScatter(float dsum, float cosT, float density) {
  float energy = 0.0;
  float a = 1.0, b = 1.0, c = 1.0;
  for (int o = 0; o < 3; o++) {
    // Dual-lobe: a tight forward lobe (the silver lining) plus a mild backward
    // one (the glow you get looking away from the sun through a thin deck).
    float ph = mix(hgRel(cosT, -0.28 * c), hgRel(cosT, 0.88 * c), 0.74);
    energy += b * exp(-dsum * uCloudLightExt * a) * ph;
    a *= 0.38;
    b *= 0.44;
    c *= 0.60;
  }
  // Cap the summed forward peak. Round 6: raising uCloudGain to get the
  // highlights back (see above) also multiplied the near-solar lobe, and the
  // three octaves sum to 10.3x isotropic within a degree of the sun against
  // 0.80 at 88 degrees off it — a 13:1 spread. At a gain chosen so a cloud in a
  // side-lit frame reaches white, a cloud NEAR the sun goes twelve times past
  // it: the outpost frame, which looks along the sun, clipped 2.18% of its
  // pixels against a 0.6% budget while the vista frame clipped none.
  //
  // 2.7 is not arbitrary — it is where singly-scattered HG stops describing a
  // real cumulus. The diffraction peak that gives HG its 10x is one scattering
  // event; inside an optically thick cloud the light has scattered dozens of
  // times before it leaves, which smears that peak out. The three-octave sum is
  // meant to model exactly that and does it for the BODY of the phase function,
  // but the first octave still carries the raw peak.
  energy = min(energy, 2.7);
  // Powder: darkens the optically thin fringes seen against the light, which is
  // the cue that tells the eye a cloud is a volume and not a decal. Round 4
  // deepened the floor from 0.18 to 0.07 — measured, the fringes and the cores
  // were landing within one display code value of each other (a flat 247 plateau
  // in ground.png), and a cumulus with no internal range is a paper cut-out.
  float powder = 1.0 - exp(-density * 11.0);
  return uKeyColor * energy * (0.07 + 0.93 * powder) * uCloudGain;
}

void main() {
  vec2 uv = vUv;
  float rawDepth = texture2D(tDepth, uv).x;
  vec3 farPoint = worldFromDepth(uv, 1.0, uInvViewProj);
  vec3 rd = normalize(farPoint - uCamPos);
  bool isSky = rawDepth >= 0.999995;

  float sceneDist = 1e6;
  vec3 scenePos = vec3(0.0);
  float groundShadow = 0.0;
  if (!isSky) {
    scenePos = worldFromDepth(uv, rawDepth, uInvViewProj);
    sceneDist = length(scenePos - uCamPos);
    groundShadow = cloudShadowAt(scenePos);
  }

  float cosT = dot(rd, uSunDir);
  float jitA = jitter1(gl_FragCoord.xy, uFrame);
  float jitB = jitter2(gl_FragCoord.xy, uFrame);

  // ---- crepuscular shafts -------------------------------------------------
  // ONLY the phase energy above isotropic. The aerial-perspective block below
  // already integrates the smooth, unshadowed in-scatter with a flattened phase,
  // so the isotropic part is accounted for there; what is missing from a
  // closed-form integral is the sharp forward lobe and its ridge-shadow
  // modulation. Subtracting the isotropic floor keeps the two from
  // double-counting AND makes this term identically zero more than ~50 deg off
  // the sun, which is what stops it becoming a second veil.
  vec3 inscatter = vec3(0.0);
  float lobe = max(0.0, hgRel(cosT, uPhaseG) - 1.0) * uSunScatter;
  if (lobe > 0.0005 && uSunDir.y > 0.0) {
    // DEPTH MASK. sceneDist is 1e6 on a sky pixel, so this used to march 7 km
    // of medium through a shadow field that only spans the 4 km terrain
    // footprint and stamp the result over the cloud deck. A shaft is a beam
    // made visible by the stuff it passes through; once the ray has climbed out
    // of the dust there is nothing left to make it visible, so that is where it
    // stops. Ground pixels are unaffected — they stop at the surface.
    float marchEnd = min(sceneDist, 7000.0);
    if (isSky && rd.y > 0.002) {
      marchEnd = min(marchEnd, max(0.0, (uShaftHeight * 5.0 - uCamPos.y) / rd.y));
    }
    float Ta = 1.0;
    float t = 0.0;
    // Geometric schedule, per-pixel randomised in BOTH offset and step length.
    // A schedule shared by every pixel puts every segment boundary at the same
    // world distance; because the closed-form optical depth depends only on
    // rd.y, that boundary is constant along a screen row, and the quantisation
    // error then draws the horizontal iso-distance bands round 1 shipped.
    // Round 5: 16 steps at 1.44x -> 24 at 1.28x. Same reach (24 steps of a 1.28
    // geometric series from 6 m covers 7.4 km), but a step boundary every 28%
    // of the distance instead of every 44%, which is what stops the residual
    // quantisation showing as banding on a low-contrast shaft.
    float dt = 6.0 * (0.55 + 0.9 * jitA);
    for (int i = 0; i < 24; i++) {
      float a = t;
      float b = min(t + dt, marchEnd);
      t += dt;
      dt *= 1.28;
      if (a >= marchEnd) break;
      float Tb = exp(-shaftOD(uCamPos.y, rd.y, b));
      float w = Ta - Tb;
      Ta = Tb;
      if (w < 2e-5) continue;
      vec3 p = uCamPos + rd * mix(a, b, jitB);
      // min(), not a product: the engine's shadow map also contains the terrain,
      // so multiplying double-shadows the air inside the shadow box and stamps a
      // visible dark rectangle on the ground haze.
      float vis = min(terrainSunVis(p), mapSunVis(p));
      inscatter += w * vis * lobe * uKeyColor;
    }
  }

  // ---- aerial perspective -------------------------------------------------
  //
  // Round 4 rewrite. There is exactly one physically correct convergence target
  // for this effect and it is not an authored colour: as the view ray gets long,
  // the in-scattered light saturates at the radiance the SKY has in that same
  // direction, because it is the same air integrated the same way from the same
  // point. Round 3 converged instead onto a constant warm dust colour, which
  // measured (vista.png) as haze whose R/B *rose* with distance — 1.381 near,
  // 1.584 mid, 1.587 far — under a sky sitting at 0.916. That divergence was the
  // largest single colour defect in the build.
  //
  // So: source function = skyRadiance(rd), per pixel, out of the same integrator
  // the dome is painted with. Every directional behaviour MGSV has falls out of
  // that for free — ridges toward the sun pick up the solar aureole and glow,
  // ridges away from it are lit by the cool part of the dome, and a ridge at
  // infinity dissolves into the sky exactly rather than sitting in front of it
  // as a coloured plate.
  //
  // Three media still set HOW FAST it converges, each with its own scale height:
  //   Rayleigh  8 km    -> the long-range blue
  //   Mie       1.4 km  -> the near-sun glow
  //   dust     ~0.5 km  -> the body of the effect in a desert
  // Only the dust is missing from the sky model, so only the dust gets a chroma
  // of its own, and only as a unit-luminance tilt (uDustAlbedo) so it can shade
  // the haze warm without ever moving it off the sky's own brightness.
  float Thaze = 1.0;
  if (uHazeOwned > 0.5 && !isSky) {
    float dist = min(sceneDist, 40000.0);
    vec3 tauR, tauM, tauD;
    hazeTaus(uCamPos.y, scenePos.y, dist, tauR, tauM, tauD);
    vec3 tau = tauR + tauM + tauD;
    vec3 T = exp(-tau);

    vec3 skyD = skyRadiance(rd);
    // Optical-depth-weighted source: the air scatters the sky's own colour, the
    // dust scatters it tilted warm. Dividing by the total optical depth is what
    // makes the saturated limit independent of how thick the medium is, i.e.
    // what makes an 8 km ridge and a 3 km ridge converge to the SAME colour
    // rather than the thicker path drifting further off the sky.
    vec3 src = (tauR + tauM + tauD * uDustAlbedo) / max(tau, vec3(1e-9)) * skyD;
    src = msFlatten(src, uApDesat);

    // ONE transmittance for both halves of the composite.
    //
    // The blend carries a single scalar alpha, so the background can only be
    // extinguished achromatically. Round 4 nonetheless weighted the in-scatter
    // by the PER-CHANNEL (1 - T), and the two disagree: wherever T_channel is
    // below the scalar, that channel gets "surf * Ts + sky * (1 - T_c)", which
    // is not a convex combination of the surface and the sky and can therefore
    // land ABOVE both. That is the arithmetic behind "a distant ridge brighter
    // than the sky above it": the blue channel of a 2 km ridge was being given
    // 4% more in-scatter than the extinction had removed.
    //
    // With one scalar the result is "mix(surface, src, (1 - Ts) * uApGain)"
    // exactly, so a surface darker than the sky can only ever approach it from
    // below, at any distance, in any direction. The chromatic part of aerial
    // perspective is not lost — it lives in "src", which is the sky's own
    // colour in this direction — only the chromatic EXTINCTION is dropped, and
    // that was never representable in a one-channel alpha anyway.
    float Ts = dot(T, vec3(0.2126, 0.7152, 0.0722));
    inscatter += src * (1.0 - Ts) * uApGain;
    Thaze = Ts;
  }

  // ---- cloud decks --------------------------------------------------------
  vec3 cloudCol = vec3(0.0);
  float Tcloud = 1.0;
  // Rays that end on geometry never see the sky; sky pixels below the geometric
  // horizon are the far side of the planet, so fade the deck out there.
  //
  // ## Round 7: the deck reaches the horizon again, and the AIR is what ends it
  //
  // Round 6 removed the radial spokes by deleting the far deck — 'cloudFar' at
  // 17-20 km, plus a fade that ran from 0.7 to 3.3 degrees of elevation. It
  // worked, and it cost the frame the entire perspective cue the task is about:
  // with nothing drawn past 20 km, puff angular size never gets small, so the
  // deck reads as one band of same-sized blobs with a hard bottom edge and a
  // bare grey gap between it and the skyline. That gap is visible in the
  // upper-left of shots/r6/vista.png.
  //
  // The spokes were real, and the diagnosis was right — a ray at one degree of
  // elevation integrates a 35 km horizontal chord through a weather field whose
  // period is 46 km, neighbouring rays share almost all of it, so the residual
  // is coherent along the radial direction and incoherent across it. But the
  // conclusion was wrong. The chord is only visible if the far end of it
  // ARRIVES. Round 6's dust was 1.18e-4 per metre with a 360 m scale height, so
  // a cloud 30 km out was seen through 0.21 of an optical depth: 81% of it
  // reached the lens, spokes and all. With a mixed dust layer at 2.6e-4 to a
  // 750 m lid, the same cloud is behind 2.9 optical depths and 5% of it
  // arrives, converged onto 'skyD' per sample by the layered integral below.
  //
  // So the range cut goes out to 60-70 km, where the atmosphere has already
  // done the work, and the horizon fade drops to the last degree — it now only
  // has to hide the numerical difference between the dome's own march and this
  // pass's convergence onto the LUT, not a whole band of structure. Ablated:
  // put 'cloudFar' back to 18 km on this build and the deck regains its hard
  // bottom edge with clear sky under it; put 'dustBeta' back to 1.18e-4 with
  // cloudFar at 65 km and the spokes come back.
  float below = smoothstep(-0.020, -0.004, rd.y) * smoothstep(0.004, 0.019, rd.y);
  if (isSky && below > 0.0) {
    // Planet-relative origin. Marching a CURVED shell rather than a flat plane
    // is what makes the deck actually reach the horizon: a flat slab at 1.8 km
    // has to be clipped at some arbitrary distance, and the clip line reads as a
    // wall. On the shell the layer runs out to ~150 km and the puffs compress
    // into a continuous band, which is the perspective cue round 1 had none of.
    float camY = max(uCamPos.y, 0.0);
    float t0 = shellDist(camY, rd.y, uCloudBase);
    float t1 = shellDist(camY, rd.y, uCloudTop);
    if (t0 > 0.0 && t1 > t0) {
      float tEnd = min(t1, uCloudFar);
      float t = t0;
      // The convergence target for every sample along this ray. Constant in the
      // loop: it depends only on the view direction.
      vec3 skyD = msFlatten(skyRadiance(rd), uApDesat);
      // Round 5: 64 -> 96 iterations. The step is 1% of the current distance, so
      // 64 of them only carry the march from t0 to 1.9*t0 — for a ray at 8
      // degrees of elevation, from 13 km to 25 km, which is a fraction of the
      // deck that ray actually crosses. Under-marching a random medium in
      // perspective is what makes the residual accumulate as thin radial
      // streaks rather than as an even bank. 96 reaches 2.6*t0. Measured cost
      // of the change on the vista shot: 3.80 ms -> 3.86 ms of an 8 ms budget.
      for (int i = 0; i < 96; i++) {
        if (t > tEnd || Tcloud < 0.012) break;
        // Constant ANGULAR step: the step length grows with distance so every
        // sample covers the same solid angle. A constant world-space step wastes
        // the whole budget overhead and undersamples the horizon into aliasing.
        float dt = clamp(t * 0.010, 40.0, 1800.0);
        // Sample INSIDE the step, at a per-pixel per-frame jittered offset,
        // rather than always at its leading edge. A shared sample position puts
        // every ray's quantisation error at the same world distance, which is
        // what draws the stepped radial banding across a deck seen in
        // perspective; the temporal resolve then integrates the jitter away.
        float ts = t + dt * jitA;
        vec3 p = uCamPos + rd * ts;
        float alt = altAt(camY, rd.y, ts);
        vec3 wx = weatherAt(p.xz);
        if (wx.x < 0.02) { t += dt * 2.5; continue; }
        // Detail is only meaningful while the step is short enough to resolve it.
        float lod = 1.0 - smoothstep(420.0, 1400.0, dt);
        // Range terminator, not a taper. Round 6 ramped this from 45% of
        // cloudFar because the range cut was doing the work of the atmosphere;
        // now the atmosphere does it (2.9 optical depths at 30 km) and this only
        // has to close the march off cleanly at its end.
        float d = cloudDensity(p, alt, wx, lod) *
                  (1.0 - smoothstep(uCloudFar * 0.82, uCloudFar, ts));
        if (d > 0.0015) {
          // Aerial perspective AT THIS SAMPLE'S RANGE, evaluated FIRST: past
          // ~4 optical depths the puff has converged onto the sky and nothing
          // its own lighting could say survives, so the six-tap light march is
          // skipped outright. On the vista frame with the deck running to 65 km
          // that is most of the samples in the bottom four degrees, and it is
          // what pays for the extra range.
          float Tas = dot(exp(-hazeTau(uCamPos.y, alt, ts)), vec3(0.2126, 0.7152, 0.0722));
          float dT = exp(-d * uCloudAbsorb * dt);
          float wgt = Tcloud * (1.0 - dT);
          Tcloud *= dT;
          if (Tas < 0.018) { cloudCol += wgt * skyD; t += dt; continue; }
          float dsum = cloudLightMarch(p, alt, jitB);
          float h = clamp((alt - uCloudBase) / (uCloudTop - uCloudBase), 0.0, 1.0);
          // Ambient is strongly top-weighted: the sky only reaches the top and
          // the shoulders, so the base falls into its own shadow. That vertical
          // ramp, together with the sun-facing side, is the internal luminance
          // range that makes a cumulus read as a solid lit object.
          // Round 4 pushed the base of this ramp from 0.16 to 0.05. A cumulus
          // base is genuinely dark — it sees almost none of the sky and none of
          // the sun — and the flat, uniformly bright decks the critics measured
          // were as much this pedestal as they were the gain.
          // Round 5: the top of the ramp was "uSkyZenith * 1.30". The zenith is
          // the DIMMEST part of the dome — at afternoon it measures Rec.709
          // 0.21 against a whole-sky mean of 0.74 — so lighting a cloud top
          // with it under-lit the one surface that sees the entire upper
          // hemisphere, and the puff ended up with its top and its base within
          // a stop of each other. uSkyAmb is that hemispheric mean; the base
          // still only sees the zenith fraction, which is what opens the
          // internal range up.
          vec3 amb = mix(uSkyZenith * 0.05, uSkyAmb * 1.15, h * h * 0.72 + h * 0.28);
          // The desert kicks a lot of warm light back up into cloud bases.
          amb += uGroundBounce * (1.0 - h) * (1.0 - h);
          vec3 L = cloudScatter(dsum, cosT, d) + amb * uCloudAmbGain;
          // Aerial perspective AT THIS SAMPLE'S RANGE. Round 5 evaluated it once
          // for the whole ray, at the transmittance-weighted mean distance, and
          // that mean is dominated by the NEAREST puff the ray hits — so every
          // puff behind it inherited the near puff's (high) transmittance and
          // arrived at full contrast. Along a ray at 8 degrees of elevation the
          // shell crossing is 13 km of chord, i.e. six or seven puffs, and the
          // furthest of them was being drawn as crisply as the first. Neighbouring
          // elevations share most of that chord, so the error is coherent in the
          // radial direction and incoherent across it: the radial spokes.
          //
          // Per sample it is the correct layered integral — each cloud element is
          // seen through its own column of air and relaxes onto the sky at its own
          // rate — and the far half of a grazing chord now converges to the sky
          // individually instead of riding in on the near half's transmittance.
          cloudCol += wgt * (L * Tas + skyD * (1.0 - Tas));
        }
        t += dt;
      }

      // The composite this leaves is exactly the layered one:
      //
      //   pixel = dome * (1 - opacity)          <- gaps: the dome already
      //         + cloudRadiance * Tair             contains all of the air
      //         + skyRadiance * opacity * (1 - Tair)
      //
      // which tends to dome as Tair -> 0. That is the property that makes the
      // horizon join up: an opaque deck 100 km out IS the sky, not a lid in
      // front of it. Round 5 established that shape but evaluated Tair once for
      // the whole ray; round 6 evaluates it per sample inside the loop above, so
      // the last two lines hold at every depth along the chord rather than only
      // on average. Nothing is re-opened in the alpha — the deck occludes what
      // it occludes, and it is its COLOUR that converges.
      Tcloud = mix(1.0, Tcloud, below);
      cloudCol *= below;
    }

    // Cirrus: a cheap analytic high sheet. Full raymarching for something that
    // is one pixel thick is wasted budget. Plane-projected at its own altitude,
    // so it converges toward the horizon independently of the cumulus deck.
    if (rd.y > 0.012 && uCirrus > 0.001) {
      float tc = shellDist(max(uCamPos.y, 0.0), rd.y, uCirrusAlt);
      vec3 cp = uCamPos + rd * max(tc, 0.0);
      vec2 cw = cp.xz * (1.0 / 78000.0) + vec2(uWindT * 0.0000075, 0.0);
      float f = texture2D(tWeather, cw).r * 0.60 + texture2D(tWeather, cw * 2.7 + 0.4).g * 0.40;
      // Mild anisotropy only: heavy stretching converges to a point overhead and
      // reads as a lens starburst rather than fibrous cirrus.
      float streak = texture2D(tWeather, cw * vec2(0.85, 2.0) + 0.4).b;
      // FOOTPRINT DISSOLVE (round 7). This sheet is read on a plane 8 km up, so
      // the world distance between two neighbouring pixels grows as 1/sin(el)^2:
      // at 20 degrees one screen row already spans 350 m of the weather map and
      // by 8 degrees it spans 2.4 km. Point-sampling a pattern whose footprint
      // is that anisotropic draws it STRETCHED along the radial direction —
      // which is the second, finer fan still visible under the cumulus in
      // shots/r7-b/vista.png once the cloud extrusion was fixed. A mip-mapped
      // lookup with the right footprint would return the local mean, so that is
      // what is returned: the sheet keeps its brightness and loses its
      // structure exactly where its structure is not resolvable.
      float foot = smoothstep(0.44, 0.10, rd.y);
      f = mix(f, 0.5, foot);
      streak = mix(streak, 0.5, foot);
      float a = smoothstep(0.55, 0.93, f * 0.66 + streak * 0.46) * uCirrus;
      // Round 6: 0.012 -> 0.055 at the bottom of the ramp. This sheet is
      // PLANE-projected, so at 0.7 degrees of elevation it is being read 650 km
      // out and one texel of the weather map covers the whole lower sky —
      // the same radial smear the cumulus deck had, at ten times the range.
      a *= smoothstep(0.055, 0.17, rd.y) * Tcloud;
      // Ice crystals forward-scatter hard: cirrus near the sun is far brighter
      // than cirrus away from it, and that gradient is most of what sells it.
      // Aerial perspective applies here too: a sheet at 8 km read at 2 degrees
      // of elevation is 200 km away, and the net brightening it adds
      // (a * (ccol - 0.72 * dome)) has to fall to zero out there or it lays a
      // veil along the whole horizon. 0.72 is the fraction of the dome the
      // alpha below removes, so that is the value it converges onto.
      float Tcirr = dot(exp(-hazeTau(uCamPos.y, uCirrusAlt, max(tc, 0.0))), vec3(0.30, 0.45, 0.25));
      vec3 ccol = mix(
        skyRadiance(rd) * 0.72,
        uKeyColor * (0.030 + 0.075 * max(0.0, hgRel(cosT, 0.72) - 1.0)) + skyRadiance(rd) * 0.9,
        Tcirr);
      cloudCol += ccol * a;
      Tcloud *= (1.0 - a * 0.72);
    }
  }

  // ---- heat shimmer over hot ground ---------------------------------------
  // Refraction needs the scene colour, which is unavailable while we are being
  // drawn into it. Taking the *difference* of last frame's buffer at the warped
  // and unwarped positions and adding it is a stable first-order stand-in.
  vec3 heat = vec3(0.0);
  if (uHeatHaze > 0.001 && !isSky && sceneDist > 55.0) {
    float grazing = 1.0 - smoothstep(0.0, 0.22, abs(rd.y));
    float amt = uHeatHaze * grazing * smoothstep(55.0, 240.0, sceneDist);
    if (amt > 0.002) {
      vec2 q = gl_FragCoord.xy * 0.035;
      float n1 = sin(q.y * 1.7 + uTime * 5.1 + hash12(floor(q)) * 6.28);
      float n2 = sin(q.x * 1.1 - uTime * 3.7 + q.y * 0.6);
      vec2 offs = vec2(n2 * 0.35, n1 + n2 * 0.25) * amt * 0.006;
      vec3 warped = texture2D(tPrevColor, uv + offs).rgb;
      vec3 here = texture2D(tPrevColor, uv).rgb;
      heat = clamp(warped - here, vec3(-0.6), vec3(0.6)) * 0.75;
    }
  }

  // dst * (1 - a) + rgb.  For a clear-sky pixel alpha is EXACTLY 0 and rgb is
  // EXACTLY 0, so the sky dome passes through bit-for-bit and keeps every bit of
  // its chroma gradient. That is the whole fix for the round-1 grey veil.
  vec3 rgb = cloudCol + inscatter + heat;
  float alpha = 1.0 - Tcloud * Thaze * (1.0 - groundShadow);
  gl_FragColor = vec4(rgb, clamp(alpha, 0.0, 1.0));
}
`;

/** Temporal resolve: reproject, variance-clip, blend. */
export const RESOLVE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tDepth;      // linear view depth, full res
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec3 uCamPos;
uniform vec3 uCamFwd;
uniform vec2 uTexel;
uniform float uBlend;
uniform float uReset;

${COMMON}

void main() {
  vec4 c = texture2D(tCurrent, vUv);
  vec4 n0 = texture2D(tCurrent, vUv + vec2(uTexel.x, 0.0));
  vec4 n1 = texture2D(tCurrent, vUv - vec2(uTexel.x, 0.0));
  vec4 n2 = texture2D(tCurrent, vUv + vec2(0.0, uTexel.y));
  vec4 n3 = texture2D(tCurrent, vUv - vec2(0.0, uTexel.y));

  // Variance clipping rather than a min/max box. A min/max box over five taps is
  // dominated by its outliers, so on a noisy estimate it barely constrains the
  // history at all and lets a stale, differently-quantised sample survive — one
  // of the ways step boundaries used to persist as visible structure.
  vec4 m1 = (c + n0 + n1 + n2 + n3) * 0.2;
  vec4 m2 = (c * c + n0 * n0 + n1 * n1 + n2 * n2 + n3 * n3) * 0.2;
  vec4 sigma = sqrt(max(m2 - m1 * m1, 0.0));
  vec4 lo = m1 - sigma * 1.6;
  vec4 hi = m1 + sigma * 1.6;

  // A light spatial pre-blur; the temporal pass then only has to remove the
  // residual, which keeps the accumulation short enough to avoid smearing.
  vec4 cur = mix(c, (n0 + n1 + n2 + n3) * 0.25, 0.22);

  vec3 farP = worldFromDepth(vUv, 1.0, uInvViewProj);
  vec3 rd = normalize(farP - uCamPos);
  float vz = texture2D(tDepth, vUv).r;
  // anchor sky pixels at a representative cloud distance so rotation reprojects
  float dist = vz > 9000.0 ? 9000.0 : vz / max(0.05, dot(rd, uCamFwd));
  vec3 wp = uCamPos + rd * min(dist, 20000.0);

  vec4 pc = uPrevViewProj * vec4(wp, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  float valid = (puv.x > 0.0 && puv.x < 1.0 && puv.y > 0.0 && puv.y < 1.0 && pc.w > 0.0) ? 1.0 : 0.0;
  valid *= 1.0 - uReset;

  vec4 hist = clamp(texture2D(tHistory, puv), lo, hi);
  gl_FragColor = mix(cur, mix(hist, cur, uBlend), valid);
}
`;

/**
 * In-scene composite. Drawn as a full-screen triangle with premultiplied
 * blending so one pass performs both the extinction of the background and the
 * addition of in-scattered light: dst*(1-a) + src.
 */
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tVol;
uniform sampler2D tDepth;
uniform vec2 uTexel;      // texel size of the half-res volumetric buffer

void main() {
  // Joint bilateral upsample. The volumetric buffer is half res, so a plain
  // bilinear fetch bleeds cloud across terrain silhouettes. Gather the exact
  // four texels that surround this pixel and weight the bilinear footprint by
  // how well each tap's depth agrees with the full-res depth here.
  float d = texture2D(tDepth, vUv).r;
  vec2 res = 1.0 / uTexel;
  vec2 st = vUv * res - 0.5;
  vec2 base = floor(st);
  vec2 f = st - base;
  vec2 uv0 = (base + 0.5) * uTexel;

  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(float(i & 1), float(i >> 1));
    vec2 suv = uv0 + o * uTexel;
    float bw = (o.x > 0.5 ? f.x : 1.0 - f.x) * (o.y > 0.5 ? f.y : 1.0 - f.y);
    float sd = texture2D(tDepth, suv).r;
    // Relative depth difference, so a gently receding slope keeps its full
    // bilinear weight and only a real silhouette rejects the tap. An absolute
    // metric produces a visible grid wherever the ground is seen edge-on.
    float rel = abs(sd - d) / max(d, 1.0);
    float w = bw * exp(-rel * 26.0) + 1e-4;
    acc += texture2D(tVol, suv) * w;
    wsum += w;
  }
  vec4 v = acc / max(wsum, 1e-5);
  gl_FragColor = vec4(max(v.rgb, 0.0), clamp(v.a, 0.0, 1.0));
}
`;
