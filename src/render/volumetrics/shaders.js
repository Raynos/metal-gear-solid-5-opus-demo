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
uniform sampler3D tCloud;

uniform mat4 uInvViewProj;
uniform mat4 uShadowMatrix;
uniform vec3 uCamPos;
uniform vec3 uSunDir;            // world direction TOWARDS the sun (shafts only)
uniform vec3 uKeyDir;            // world direction TOWARDS the key light (sun OR moon)
uniform vec3 uKeyColor;          // key radiance in renderer linear units, night-aware
uniform vec3 uSkyZenith;         // sky radiance looking up
uniform vec3 uSkyHorizon;        // sky radiance at the horizon (warmer, brighter)
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
uniform vec3 uSkyAmbient;        // hemisphere-average sky radiance
uniform vec3 uBetaR;             // Rayleigh extinction at the datum, per metre
uniform vec3 uBetaD;             // desert dust extinction at ground level, per metre
uniform vec3 uDustAlbedo;        // warm scattering albedo of the dust
uniform vec3 uGroundLight;       // radiance of the sunlit ground under the haze
uniform float uBetaM;
uniform float uDustHeight;       // scale height of the dust layer
uniform float uApSun;
uniform float uApAmb;
uniform float uApG;

uniform float uCloudCoverage;
uniform float uCloudBase;
uniform float uCloudTop;
uniform float uCloudDensity;
uniform float uCloudAbsorb;
uniform float uCloudGain;
uniform float uCloudAmbGain;
uniform float uCirrus;
uniform float uCirrusAlt;
uniform float uHeatHaze;
uniform float uCloudShadow;
uniform float uWindT;

${COMMON}

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
  float streak = texture2D(tWeather, w * vec2(0.55, 2.3) + 0.27).b;
  float cov = s.r * 0.68 + streak * 0.32;
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
 * Density at a world point. lod fades the erosion octaves out with distance:
 * detail finer than the step length only aliases, and aliased cloud edges are
 * exactly the "shimmering popcorn" tell.
 */
float cloudDensity(vec3 p, float alt, vec3 wx, float lod) {
  float h = clamp((alt - uCloudBase) / (uCloudTop - uCloudBase), 0.0, 1.0);
  float prof = heightProfile(h, wx.x, wx.y, wx.z);
  if (prof <= 0.0) return 0.0;

  // Wind shear: a cumulus top lags downwind of its base, which is the cue that
  // says "this is a volume in a moving airmass" rather than an extruded decal.
  vec3 q = p + vec3(uWindT * 3.1 + 260.0 * h, 0.0, uWindT * 1.1 + 90.0 * h);
  float shape = texture(tCloud, q * (1.0 / 2600.0)).r;
  shape = shape * 0.70 + texture(tCloud, q * (1.0 / 900.0) + 0.31).r * 0.30;

  float base = shape * prof;
  float d = remap(base, 1.0 - wx.x, 1.0, 0.0, 1.0);
  if (d <= 0.0) return 0.0;

  if (lod > 0.01) {
    vec4 hi = texture(tCloud, (p + vec3(uWindT * 5.0, 0.0, uWindT * 1.8)) * (1.0 / 260.0));
    float fbm = hi.g * 0.58 + hi.b * 0.29 + hi.a * 0.13;
    // Erode hard at the base, softly at the top: wispy bottoms, firm anvils.
    float e = mix(fbm, 1.0 - fbm, clamp(h * 2.4, 0.0, 1.0)) * lod;
    d = remap(d, e * 0.62, 1.0, 0.0, 1.0);
  }
  return clamp(d, 0.0, 1.0) * uCloudDensity;
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
  return (1.0 - exp(-d * uCloudAbsorb * 700.0)) * uCloudShadow;
}

/**
 * Accumulated density from a point towards the key light through the slab.
 * Over a <= 1.5 km light path the planet's curvature contributes 0.2 m of
 * altitude, so the altitude is tracked linearly from the sample's own.
 */
float cloudLightMarch(vec3 p, float alt0, float jit) {
  float t = 0.0;
  float dsum = 0.0;
  float stepLen = 46.0 * (0.7 + 0.6 * jit);
  for (int i = 0; i < 5; i++) {
    t += stepLen;
    vec3 q = p + uKeyDir * t;
    float alt = alt0 + uKeyDir.y * t;
    if (alt > uCloudTop || alt < uCloudBase) break;
    dsum += cloudDensity(q, alt, weatherAt(q.xz), i < 2 ? 1.0 : 0.0) * stepLen;
    stepLen *= 2.0;
  }
  return dsum;
}

/**
 * Multiple-scattering approximation (Wrenninge): three octaves of decreasing
 * extinction, contribution and phase eccentricity. One light march feeds all
 * three. The tight first octave carries the brilliant sun-facing side and the
 * silver rim; the loose third keeps deep interiors from going to soot.
 */
vec3 cloudScatter(float dsum, float cosT, float density) {
  float energy = 0.0;
  float a = 1.0, b = 1.0, c = 1.0;
  for (int o = 0; o < 3; o++) {
    // Dual-lobe: a tight forward lobe (the silver lining) plus a mild backward
    // one (the glow you get looking away from the sun through a thin deck).
    float ph = mix(hgRel(cosT, -0.28 * c), hgRel(cosT, 0.88 * c), 0.74);
    energy += b * exp(-dsum * uCloudAbsorb * a) * ph;
    a *= 0.42;
    b *= 0.50;
    c *= 0.60;
  }
  // Powder: darkens the optically thin fringes seen against the light, which is
  // the cue that tells the eye a cloud is a volume and not a decal.
  float powder = 1.0 - exp(-density * 16.0);
  return uKeyColor * energy * (0.18 + 0.82 * powder) * uCloudGain;
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
    float marchEnd = min(sceneDist, 7000.0);
    float Ta = 1.0;
    float t = 0.0;
    // Geometric schedule, per-pixel randomised in BOTH offset and step length.
    // A schedule shared by every pixel puts every segment boundary at the same
    // world distance; because the closed-form optical depth depends only on
    // rd.y, that boundary is constant along a screen row, and the quantisation
    // error then draws the horizontal iso-distance bands round 1 shipped.
    float dt = 6.0 * (0.55 + 0.9 * jitA);
    for (int i = 0; i < 16; i++) {
      float a = t;
      float b = min(t + dt, marchEnd);
      t += dt;
      dt *= 1.44;
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
  // Real in-scattering, not a lerp to a fixed grey. Three media, each with its
  // own scale height and its own phase function:
  //
  //   Rayleigh  8 km  blue, near-isotropic  -> the cool cast on shaded ridges
  //   Mie       1.4 km neutral, forward     -> the glow around the sun
  //   dust      ~0.5 km WARM, forward       -> the khaki body of the effect
  //
  // Because the colour is (phase x sun) + (sky), a ridge facing into the sun
  // picks up the warm forward lobe and glows, while a ridge on the anti-sun
  // side is lit only by the sky term and goes cool — the directional variation
  // round 1 had none of. And because every term is an integral of exp(-y/H)
  // along the ray, a barrel 4 m away accumulates ~0.0004 optical depths and is
  // untouched, instead of being veiled by a fog that started at the lens.
  float Thaze = 1.0;
  if (uHazeOwned > 0.5 && !isSky) {
    float dist = min(sceneDist, 40000.0);
    float y1 = scenePos.y;
    // The molecular terms are referenced to the real altitude of the plateau;
    // the dust layer is referenced to the valley floor, because that is what it
    // physically settles onto.
    float IR = heightInt(uCamPos.y + 400.0, y1 + 400.0, dist, 8000.0);
    float IM = heightInt(uCamPos.y + 400.0, y1 + 400.0, dist, 1400.0);
    float ID = heightInt(uCamPos.y, y1, dist, uDustHeight);

    vec3 tauR = uBetaR * IR;
    vec3 tauM = vec3(uBetaM * IM);
    vec3 tauD = uBetaD * ID;
    vec3 T = exp(-(tauR + tauM + tauD));

    float pR = (3.0 / (16.0 * PI)) * (1.0 + cosT * cosT);
    // Multiple scattering flattens the effective phase; without this the
    // anti-sun half of the valley goes implausibly dark and the sunward half
    // blows out.
    float pM = mix(0.0796, hgPhase(cosT, uApG), 0.55);
    float pD = mix(0.0796, hgPhase(cosT, uApG * 0.78), 0.40);

    // Suspended dust sits in the bottom few hundred metres, where nearly half
    // the light arriving at it has already bounced off sunlit sand. Lighting it
    // with the sky alone is what made round 1's distance haze a cold blue-grey;
    // folding in the warm ground radiance is what makes it read as khaki dust.
    vec3 dustLight = mix(uSkyAmbient, uGroundLight, 0.45);
    vec3 sunIn = (tauR * pR + tauM * pM) * uKeyColor
               + tauD * pD * uKeyColor * uDustAlbedo;
    vec3 ambIn = (tauR + tauM) * uSkyAmbient
               + tauD * dustLight * uDustAlbedo * 0.78;
    inscatter += sunIn * uApSun + ambIn * uApAmb;

    // The composite blend carries one scalar alpha, so extinction is applied
    // achromatically; the chromatic part of aerial perspective lives in the
    // in-scatter above, which is where the eye reads it anyway.
    Thaze = dot(T, vec3(0.30, 0.45, 0.25));
  }

  // ---- cloud decks --------------------------------------------------------
  vec3 cloudCol = vec3(0.0);
  float Tcloud = 1.0;
  // Rays that end on geometry never see the sky; sky pixels below the geometric
  // horizon are the far side of the planet, so fade the deck out there.
  float below = smoothstep(-0.020, -0.004, rd.y);
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
      float tEnd = min(t1, 170000.0);
      float t = t0 + clamp(t0 * 0.010, 40.0, 1800.0) * jitA;
      for (int i = 0; i < 64; i++) {
        if (t > tEnd || Tcloud < 0.012) break;
        // Constant ANGULAR step: the step length grows with distance so every
        // sample covers the same solid angle. A constant world-space step wastes
        // the whole budget overhead and undersamples the horizon into aliasing.
        float dt = clamp(t * 0.010, 40.0, 1800.0);
        vec3 p = uCamPos + rd * t;
        float alt = altAt(camY, rd.y, t);
        vec3 wx = weatherAt(p.xz);
        if (wx.x < 0.02) { t += dt * 2.5; continue; }
        // Detail is only meaningful while the step is short enough to resolve it.
        float lod = 1.0 - smoothstep(420.0, 1400.0, dt);
        float d = cloudDensity(p, alt, wx, lod);
        if (d > 0.0015) {
          float dsum = cloudLightMarch(p, alt, jitB);
          float h = clamp((alt - uCloudBase) / (uCloudTop - uCloudBase), 0.0, 1.0);
          // Ambient is strongly top-weighted: the sky only reaches the top and
          // the shoulders, so the base falls into its own shadow. That vertical
          // ramp, together with the sun-facing side, is the internal luminance
          // range that makes a cumulus read as a solid lit object.
          vec3 amb = mix(uSkyZenith * 0.16, uSkyZenith * 1.30, h * h * 0.72 + h * 0.28);
          // The desert kicks a lot of warm light back up into cloud bases.
          amb += uGroundBounce * (1.0 - h) * (1.0 - h);
          vec3 L = cloudScatter(dsum, cosT, d) + amb * uCloudAmbGain;
          float dT = exp(-d * uCloudAbsorb * dt);
          cloudCol += Tcloud * (1.0 - dT) * L;
          Tcloud *= dT;
        }
        t += dt;
      }

      // Aerial perspective ON the deck. Weighted by the cloud's own opacity so
      // it can only ever tint cloud, never fill the gaps between clouds.
      float energy = 1.0 - Tcloud;
      if (energy > 0.001) {
        // The deck runs to ~150 km, so the far half of it is behind more air
        // than any terrain in the world. Without this it stacks up into a hard
        // white lattice along the horizon instead of dissolving into the band
        // of pale haze that tells you how far away it is.
        float hz = 1.0 - exp(-t0 * 0.000030);
        cloudCol = mix(cloudCol, uSkyHorizon * energy, hz * 0.85);
        // ...and let the sky show back through, so the horizon reads as a soft
        // edge rather than a lid.
        Tcloud = mix(Tcloud, 1.0, hz * 0.35);
      }
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
      float streak = texture2D(tWeather, cw * vec2(0.8, 3.1) + 0.4).b;
      float a = smoothstep(0.55, 0.93, f * 0.66 + streak * 0.46) * uCirrus;
      a *= smoothstep(0.012, 0.10, rd.y) * Tcloud;
      // Ice crystals forward-scatter hard: cirrus near the sun is far brighter
      // than cirrus away from it, and that gradient is most of what sells it.
      vec3 ccol = uKeyColor * (0.030 + 0.075 * max(0.0, hgRel(cosT, 0.72) - 1.0))
                + uSkyZenith * 0.9;
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
