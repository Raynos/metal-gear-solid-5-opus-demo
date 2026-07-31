/**
 * GLSL for the volumetric stack.
 *
 * All of these run as full-screen passes into private render targets *before*
 * the main scene render, so they may freely sample `pipeline.hdr.depthTexture`
 * and `pipeline.hdr.texture` (last frame's) without forming a feedback loop.
 * The result is composited back into the HDR buffer by an in-scene quad.
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

float hgPhase(float c, float g) {
  float g2 = g * g;
  float d = max(1e-4, 1.0 + g2 - 2.0 * g * c);
  return (1.0 - g2) / (4.0 * PI * d * sqrt(d));
}

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
uniform sampler3D tCloud;

uniform mat4 uInvViewProj;
uniform mat4 uShadowMatrix;
uniform vec3 uCamPos;
uniform vec3 uSunDir;            // world direction TOWARDS the sun
uniform vec3 uSunColor;          // radiance, physical units
uniform vec3 uHazeColor;         // ambient in-scatter colour of the near volume
uniform vec3 uCloudAmbient;      // sky light reaching the cloud slab
uniform vec2 uResolution;
uniform float uTime;
uniform float uFrame;
uniform float uTerrainSize;
uniform float uShadowExtent;     // half-width of the engine shadow frustum
uniform vec3 uShadowCenter;

uniform float uFogDensity;       // extinction at the reference altitude
uniform float uFogHeight;        // scale height of the haze layer
uniform float uFogBase;          // reference altitude
uniform float uSunScatter;       // gain on sun in-scatter (shaft strength)
uniform float uSkyScatter;       // gain on ambient in-scatter (aerial perspective)
uniform float uPhaseG;
uniform float uDustBand;         // extra density hugging the ground

uniform float uCloudCoverage;
uniform float uCloudBase;
uniform float uCloudTop;
uniform float uCloudDensity;
uniform float uCloudAbsorb;
uniform float uCirrus;
uniform float uHeatHaze;
uniform float uCloudShadow;

${COMMON}

// ---------------------------------------------------------------- haze volume

// Exponential height fog has a closed-form optical depth. Using it for
// transmittance (instead of accumulating the raymarch) means the aerial
// perspective is perfectly smooth and only the *shaft* term carries noise.
float opticalDepth(float y0, float dy, float t) {
  float k = 1.0 / uFogHeight;
  float s = uFogDensity * exp(-(y0 - uFogBase) * k);
  if (abs(dy) < 1e-4) return s * t;
  return s * (1.0 - exp(-dy * k * t)) / (dy * k);
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
// 240 m shadow box; fade the query out at its edge so nothing pops.
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

float cloudHeightGradient(float h, float cov) {
  // flat, eroded base and a billowing top that spreads with coverage
  float bottom = smoothstep(0.0, 0.16, h);
  float top = smoothstep(1.0, 0.32 + cov * 0.35, h);
  return bottom * top;
}

float cloudCoverageAt(vec2 xz) {
  vec2 w = xz * 0.000042 + vec2(uTime * 0.00030, uTime * 0.00010);
  // Two scales of weather map: the coarse one opens and closes whole regions of
  // sky so the field has clear lanes instead of an even sprinkle of popcorn.
  float region = texture(tCloud, vec3(w * 0.26 + 0.13, 0.83)).r;
  float a = texture(tCloud, vec3(w, 0.31)).r;
  float b = texture(tCloud, vec3(w * 2.4 + 0.37, 0.62)).g;
  float m = a * 0.62 + b * 0.38;
  float cov = remap(m, 0.28, 0.94, 0.0, 1.0) * mix(0.4, 1.0, smoothstep(0.15, 0.78, region));
  return clamp(cov * uCloudCoverage * 1.7, 0.0, 1.0);
}

float cloudDensity(vec3 p, float cov, bool detail) {
  float h = clamp((p.y - uCloudBase) / (uCloudTop - uCloudBase), 0.0, 1.0);
  vec3 wind = vec3(uTime * 2.6, 0.0, uTime * 0.9);
  // shear: the top of a cumulus lags downwind of its base
  vec3 q = p + wind + vec3(320.0 * h, 0.0, 110.0 * h);
  float shape = texture(tCloud, q * 0.00029).r;
  shape = shape * 0.72 + texture(tCloud, q * 0.00082 + 0.31).r * 0.28;
  float base = shape * cloudHeightGradient(h, cov);
  float d = remap(base, 1.0 - cov, 1.0, 0.0, 1.0);
  if (d <= 0.0) return 0.0;
  if (detail) {
    // Detail frequency is matched to the primary step length; finer than that
    // and it simply aliases away, leaving the smooth blobs that read as CG.
    vec4 hi = texture(tCloud, (p + wind * 2.2) * 0.0013);
    float fbm = hi.g * 0.6 + hi.b * 0.27 + hi.a * 0.13;
    // erode hard at the base, softly at the top: wispy bottoms, firm anvils
    float e = mix(fbm, 1.0 - fbm, clamp(h * 2.4, 0.0, 1.0));
    d = remap(d, e * 0.45, 1.0, 0.0, 1.0);
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
  if (uSunDir.y < 0.04 || uCloudShadow < 0.001) return 0.0;
  float mid = uCloudBase + (uCloudTop - uCloudBase) * 0.4;
  float t = min((mid - p.y) / uSunDir.y, 14000.0);
  if (t <= 0.0) return 0.0;
  vec3 q = p + uSunDir * t;
  q.y = mid;
  float cov = cloudCoverageAt(q.xz);
  if (cov < 0.001) return 0.0;
  float d = cloudDensity(q, cov, false);
  return (1.0 - exp(-d * uCloudAbsorb * 620.0)) * uCloudShadow;
}

/** Accumulated density from a point towards the sun through the slab. */
float cloudLightMarch(vec3 p, float cov) {
  float t = 0.0;
  float dsum = 0.0;
  float stepLen = 70.0;
  for (int i = 0; i < 5; i++) {
    t += stepLen;
    vec3 q = p + uSunDir * t;
    if (q.y > uCloudTop || q.y < uCloudBase) break;
    dsum += cloudDensity(q, cov, i < 2) * stepLen;
    stepLen *= 1.85;
  }
  return dsum;
}

/**
 * Multiple-scattering approximation (Wrenninge): three octaves of decreasing
 * extinction, contribution and phase eccentricity. One light march feeds all
 * three, and the low-extinction octaves are what produce the bright silver
 * fringe on sun-facing edges and stop the interiors going to soot.
 */
vec3 cloudScatter(float dsum, float cosT, float density) {
  float energy = 0.0;
  float a = 1.0, b = 1.0, c = 1.0;
  for (int o = 0; o < 3; o++) {
    float ph = mix(hgPhase(cosT, -0.32 * c), hgPhase(cosT, 0.84 * c), 0.7) * 4.0 * PI;
    energy += b * exp(-dsum * uCloudAbsorb * a) * ph;
    a *= 0.45;
    b *= 0.52;
    c *= 0.62;
  }
  // Powder: darkens the optically thin fringes seen against the light, which is
  // the cue that tells the eye a cloud is a volume and not a decal.
  float powder = 1.0 - exp(-density * 14.0);
  return uSunColor * energy * (0.28 + 0.72 * powder);
}

void main() {
  vec2 uv = vUv;
  float rawDepth = texture2D(tDepth, uv).x;
  vec3 farPoint = worldFromDepth(uv, 1.0, uInvViewProj);
  vec3 rd = normalize(farPoint - uCamPos);
  bool isSky = rawDepth >= 0.999995;

  float sceneDist = 40000.0;
  vec3 scenePos = vec3(0.0);
  float groundShadow = 0.0;
  if (!isSky) {
    scenePos = worldFromDepth(uv, rawDepth, uInvViewProj);
    sceneDist = length(scenePos - uCamPos);
    groundShadow = cloudShadowAt(scenePos);
  }

  float cosT = dot(rd, uSunDir);
  // Temporal + spatial jitter. The golden-ratio frame offset keeps successive
  // frames maximally decorrelated so 20 steps accumulate to look like 200.
  float jitter = fract(ign(gl_FragCoord.xy) + uFrame * 0.6180339887);

  // ---- near volume: aerial perspective + light shafts ----
  float marchEnd = min(sceneDist, 9000.0);
  float phase = hgPhase(cosT, uPhaseG) * 4.0 * PI;
  float phaseBack = hgPhase(cosT, -0.18) * 4.0 * PI;
  float sunPhase = mix(phaseBack, phase, 0.82) * uSunScatter;

  vec3 inscatter = vec3(0.0);
  float Ta = 1.0;
  const int STEPS = 20;
  // Geometric step schedule in ABSOLUTE distance. Deriving the schedule from
  // each pixel's own scene depth (the obvious approach) makes the sample
  // positions a function of depth, and the estimator error then draws visible
  // iso-distance contours across the terrain. A shared schedule turns that
  // structured error into per-pixel noise, which the temporal pass eats.
  // ...and scale that schedule per pixel. A schedule shared by every pixel puts
  // every segment boundary at the same world distance, so where the ground is
  // near-grazing (the whole mid-ground of a valley shot) the quantised estimate
  // draws hard horizontal iso-distance stripes across the frame. Randomising the
  // step size decorrelates the boundaries; the temporal resolve then averages
  // them back to a smooth gradient instead of a ladder.
  float t = 0.0;
  float dt = 4.5 * (0.72 + 0.56 * jitter);
  for (int i = 0; i < STEPS; i++) {
    float a = t;
    float b = min(t + dt, marchEnd);
    t += dt;
    dt *= 1.40;
    if (a >= marchEnd) break;
    float Tb = exp(-opticalDepth(uCamPos.y, rd.y, b));
    float w = Ta - Tb;
    Ta = Tb;
    if (w < 2e-5) continue;
    vec3 p = uCamPos + rd * mix(a, b, jitter);
    // min(), not a product: the engine's shadow map also contains the terrain,
    // so multiplying double-shadows the air inside the 240 m box and stamps a
    // visible dark rectangle on the ground haze.
    float vis = min(terrainSunVis(p), mapSunVis(p));
    // dust suspended in the first few tens of metres scatters much harder
    float ground = exp(-max(0.0, p.y - uFogBase) / 46.0) * uDustBand;
    vec3 L = uSunColor * vis * (sunPhase * (1.0 + ground * 0.9))
           + uHazeColor * uSkyScatter * (1.0 + ground * 0.30);
    inscatter += w * L;
  }
  float Tfog = exp(-opticalDepth(uCamPos.y, rd.y, marchEnd));

  // ---- cloud slab ----
  vec3 cloudCol = vec3(0.0);
  float Tcloud = 1.0;
  if (isSky && rd.y > -0.02) {
    float t0 = max(0.0, (uCloudBase - uCamPos.y) / max(rd.y, 0.0015));
    float t1 = max(0.0, (uCloudTop - uCamPos.y) / max(rd.y, 0.0015));
    float tEnd = min(t1, t0 + 26000.0);
    if (t0 < 90000.0) {
      float cov = cloudCoverageAt(uCamPos.xz + rd.xz * (t0 + (tEnd - t0) * 0.35));
      if (cov > 0.001) {
        const int CSTEPS = 30;
        float stepLen = (tEnd - t0) / float(CSTEPS);
        float t = t0 + stepLen * jitter;
        for (int i = 0; i < CSTEPS; i++) {
          if (Tcloud < 0.02) break;
          vec3 p = uCamPos + rd * t;
          float d = cloudDensity(p, cov, true);
          if (d > 0.001) {
            float dsum = cloudLightMarch(p, cov);
            float h = clamp((p.y - uCloudBase) / (uCloudTop - uCloudBase), 0.0, 1.0);
            // ambient darkens sharply towards the base: the shadowed underside
            // is most of what makes a cumulus read as a solid, lit object
            vec3 amb = uCloudAmbient * mix(0.22, 1.35, h * h * 0.6 + h * 0.4);
            vec3 L = cloudScatter(dsum, cosT, d) + amb;
            float dT = exp(-d * uCloudAbsorb * stepLen);
            cloudCol += Tcloud * (1.0 - dT) * L;
            Tcloud *= dT;
          }
          t += stepLen;
        }
        float energy = 1.0 - Tcloud;
        // haze the cloud layer towards the horizon so it sits in the same air
        float hz = 1.0 - exp(-(t0 * 0.5 + tEnd * 0.5) * 0.000045);
        cloudCol = mix(cloudCol, uHazeColor * uSkyScatter * 2.2 * energy, hz * 0.75);
      }
    }

    // Cirrus: a cheap analytic high sheet. Full raymarching for something that
    // is one pixel thick is wasted budget.
    if (rd.y > 0.03) {
      float tc = (6200.0 - uCamPos.y) / rd.y;
      vec3 cp = uCamPos + rd * tc;
      vec2 cw = cp.xz * 0.0000135 + vec2(uTime * 0.00018, 0.0);
      float f = texture(tCloud, vec3(cw, 0.77)).r * 0.62 + texture(tCloud, vec3(cw * 2.6, 0.21)).g * 0.38;
      // mild anisotropy only: heavy stretching converges to a point overhead and
      // reads as a lens starburst rather than fibrous cirrus
      float streak = texture(tCloud, vec3(cw * vec2(0.9, 2.6) + 0.4, 0.5)).b;
      float a = smoothstep(0.62, 0.95, f * 0.7 + streak * 0.42) * uCirrus;
      a *= smoothstep(0.03, 0.22, rd.y) * Tcloud;
      vec3 ccol = uSunColor * hgPhase(cosT, 0.55) * 4.0 * PI * 0.11 + uCloudAmbient * 1.1;
      cloudCol += ccol * a;
      Tcloud *= (1.0 - a * 0.8);
    }
  }

  // ---- heat shimmer over hot ground ----
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

  // final = scene * (Tfog * Tcloud) + (cloud * Tfog + fogInscatter)
  vec3 rgb = cloudCol * Tfog + inscatter + heat;
  float alpha = 1.0 - Tfog * Tcloud * (1.0 - groundShadow);
  gl_FragColor = vec4(rgb, clamp(alpha, 0.0, 1.0));
}
`;

/** Temporal resolve: reproject, neighbourhood-clamp, blend. */
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
  vec4 lo = min(min(min(n0, n1), min(n2, n3)), c);
  vec4 hi = max(max(max(n0, n1), max(n2, n3)), c);
  // a light spatial pre-blur; the temporal pass then only has to remove the
  // residual, which keeps the accumulation short enough to avoid smearing
  vec4 cur = mix(c, (n0 + n1 + n2 + n3) * 0.25, 0.3);

  vec3 farP = worldFromDepth(vUv, 1.0, uInvViewProj);
  vec3 rd = normalize(farP - uCamPos);
  float vz = texture2D(tDepth, vUv).r;
  // anchor sky pixels at a representative cloud distance so rotation reprojects
  float dist = vz > 9000.0 ? 6000.0 : vz / max(0.05, dot(rd, uCamFwd));
  vec3 wp = uCamPos + rd * min(dist, 12000.0);

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
