import * as THREE from 'three';

/**
 * Sky — single-scattering atmosphere, raymarched.
 *
 * The previous implementation was the Preetham analytic fit. Preetham is a
 * least-squares fit to daylight only: below ~5 degrees of solar elevation its
 * chromaticity fit falls apart and the anti-solar horizon turns olive-green.
 * There is no tuning that removes that — the model simply has no data there.
 *
 * This replaces it with an actual raymarch of the Rayleigh/Mie/**ozone**
 * atmosphere. Ozone is the term everyone leaves out and the reason it matters
 * here: at low sun elevation the sunlight reaching the anti-solar sky has
 * travelled a very long path through the Chappuis absorption band, which eats
 * the yellow-green and leaves the deep blue-violet that real dusk has. Rayleigh
 * alone (or a fit to Rayleigh alone) gives you the green band. With ozone the
 * gradient runs warm orange -> magenta -> deep blue, which is what we want.
 *
 * The planet is a real sphere, so the Earth's shadow rises through the
 * atmosphere as the sun sets and twilight terminates correctly instead of
 * snapping to black.
 *
 * Rendered at the far plane into the linear-HDR buffer at real radiance so the
 * sun disc and horizon haze feed bloom naturally. Drawn LAST among opaques with
 * depth-test on, so the expensive raymarch only runs on visible sky pixels.
 */

const SKY_VERT = /* glsl */ `
varying vec3 vRay;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vRay = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w; // pin to the far plane
}
`;

/**
 * Shared atmosphere constants + the scattering integrator. Also used verbatim
 * by the CPU mirror in Lighting.js, so the sun/ambient colours the scene is lit
 * with are the same numbers the sky is drawn with.
 */
export const ATMOSPHERE_GLSL = /* glsl */ `
const float Rg = 6371000.0;          // planet radius
const float Ra = 6471000.0;          // top of atmosphere
const float Hr = 8000.0;             // Rayleigh scale height
const float Hm = 1400.0;             // Mie scale height
const vec3  BETA_R = vec3(5.802e-6, 13.558e-6, 33.100e-6);
const float BETA_M = 3.996e-6;
const float BETA_M_ABS = 4.40e-6;    // Mie absorption (haze is not lossless)
const vec3  BETA_O = vec3(0.650e-6, 1.881e-6, 0.085e-6); // ozone (Chappuis)

const float PI_ = 3.141592653589793;

float phaseRayleigh(float mu) { return (3.0 / (16.0 * PI_)) * (1.0 + mu * mu); }

float phaseMie(float mu, float g) {
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * mu;
  return (3.0 / (8.0 * PI_)) * ((1.0 - g2) * (1.0 + mu * mu)) /
         ((2.0 + g2) * pow(max(d, 1e-4), 1.5));
}

/** Far intersection with a sphere centred at the origin; -1 if we miss. */
float sphereFar(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  return -b + sqrt(d);
}

/** Near positive intersection; -1 if none in front of us. */
float sphereNear(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  d = sqrt(d);
  float t0 = -b - d;
  float t1 = -b + d;
  if (t1 < 0.0) return -1.0;
  return t0 < 0.0 ? t1 : t0;
}

void densities(float h, out float dr, out float dm, out float doz) {
  dr = exp(-max(h, 0.0) / Hr);
  dm = exp(-max(h, 0.0) / Hm);
  // Ozone lives in a shell around 25 km; a triangle profile is within a few
  // percent of the real one and costs nothing.
  doz = max(0.0, 1.0 - abs(h - 25000.0) / 15000.0);
}

/**
 * Single scattering with a multiple-scattering fudge (msBoost). Returns
 * radiance for a unit-irradiance sun; the transmittance out-param is the
 * view-ray extinction, used for the sun/moon disc.
 */
vec3 scatter(vec3 ro, vec3 rd, vec3 sunDir, float mieG, float rayleighScale,
             float mieScale, float msBoost, out vec3 transmittance) {
  float tMax = sphereFar(ro, rd, Ra);
  if (tMax <= 0.0) { transmittance = vec3(1.0); return vec3(0.0); }
  float tg = sphereNear(ro, rd, Rg - 1000.0);
  if (tg > 0.0) tMax = min(tMax, tg);

  const int STEPS = 16;
  const int LSTEPS = 6;
  float dt = tMax / float(STEPS);

  vec3 bR = BETA_R * rayleighScale;
  float bM = BETA_M * mieScale;
  float bMe = (BETA_M + BETA_M_ABS) * mieScale;

  float mu = dot(rd, sunDir);
  float pR = phaseRayleigh(mu);
  float pM = phaseMie(mu, mieG);

  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  float odR = 0.0, odM = 0.0, odO = 0.0;

  for (int i = 0; i < STEPS; i++) {
    // Quadratic step distribution: dense near the camera where the air is,
    // sparse at altitude. Halves the step count for the same quality.
    float f0 = float(i) / float(STEPS);
    float f1 = float(i + 1) / float(STEPS);
    float s0 = tMax * f0 * f0;
    float s1 = tMax * f1 * f1;
    float ds = s1 - s0;
    vec3 p = ro + rd * (0.5 * (s0 + s1));

    float h = length(p) - Rg;
    float dr, dm, doz;
    densities(h, dr, dm, doz);
    dr *= ds; dm *= ds; doz *= ds;
    odR += dr; odM += dm; odO += doz;

    // Soft planet shadow: distance from the planet centre to the light ray.
    float proj = dot(p, sunDir);
    float perp = length(p - sunDir * proj);
    float lit = proj > 0.0 ? 1.0 : smoothstep(Rg - 4000.0, Rg + 12000.0, perp);

    vec3 att = vec3(0.0);
    if (lit > 0.001) {
      float tl = sphereFar(p, sunDir, Ra);
      float dtl = tl / float(LSTEPS);
      float lR = 0.0, lM = 0.0, lO = 0.0;
      for (int j = 0; j < LSTEPS; j++) {
        float g0 = float(j) / float(LSTEPS);
        float g1 = float(j + 1) / float(LSTEPS);
        float q0 = tl * g0 * g0;
        float q1 = tl * g1 * g1;
        float dq = q1 - q0;
        vec3 q = p + sunDir * (0.5 * (q0 + q1));
        float hl = length(q) - Rg;
        float lr, lm, lo;
        densities(hl, lr, lm, lo);
        lR += lr * dq; lM += lm * dq; lO += lo * dq;
      }
      vec3 tau = bR * (odR + lR) + vec3(bMe) * (odM + lM) + BETA_O * (odO + lO);
      att = exp(-tau) * lit;
    }
    sumR += att * dr;
    sumM += att * dm;
  }

  transmittance = exp(-(bR * odR + vec3(bMe) * odM + BETA_O * odO));

  // msBoost stands in for the 2nd+ scattering orders: it is what keeps the
  // zenith from going unnaturally dark and gives twilight its lift.
  return sumR * bR * (pR + msBoost * 0.28) + sumM * bM * (pM + msBoost * 0.10);
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vRay;

uniform vec3 uSunDirection;
uniform vec3 uMoonDirection;
uniform float uMoonIntensity;
uniform float uRayleigh;
uniform float uTurbidity;
uniform float uMieCoefficient;
uniform float uMieDirectionalG;
uniform vec3 uSunTint;
uniform float uSkyIntensity;
uniform float uNight;
uniform float uTime;
uniform float uSkyExposure;
uniform float uSunDiscScale;
uniform float uCamAltitude;
uniform float uSunIrradiance;

${ATMOSPHERE_GLSL}

// Radiance scale: maps the physical integrator into renderer linear units.
// Chosen so uSkyExposure = 0.0075 (the calibrated value) is a x1.0 multiplier,
// which keeps tools/calibrate.mjs sweeping a meaningful range.
const float SKY_SCALE = 133.3333;

float hash13(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.13));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1, 0, 0));
  float n010 = hash13(i + vec3(0, 1, 0));
  float n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1));
  float n101 = hash13(i + vec3(1, 0, 1));
  float n011 = hash13(i + vec3(0, 1, 1));
  float n111 = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

float fbm3(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise3(p); p *= 2.07; a *= 0.5; }
  return s;
}

void main() {
  vec3 rd = normalize(vRay);
  vec3 ro = vec3(0.0, Rg + max(uCamAltitude, 1.0), 0.0);

  float mieScale = uMieCoefficient / 0.0058 * (0.55 + 0.14 * uTurbidity);
  float rayScale = uRayleigh / 1.9;

  vec3 T;
  vec3 sky = scatter(ro, rd, uSunDirection, uMieDirectionalG, rayScale, mieScale, 1.0, T);
  sky *= uSunIrradiance;

  // ---- sun disc ----
  // A real solar disc is 0.53 deg with limb darkening; a hard-edged circle is
  // one of the loudest CG tells there is.
  float muS = dot(rd, uSunDirection);
  float cosR = 0.99996;             // ~0.5 deg
  float disc = smoothstep(cosR - 0.00004, cosR + 0.00002, muS);
  float limb = sqrt(max(0.0, 1.0 - pow(clamp((1.0 - muS) / (1.0 - cosR), 0.0, 1.0), 2.0)));
  vec3 sunRad = vec3(255.0, 244.0, 226.0) / 255.0 * 320.0 * uSunIrradiance / 20.0;
  sky += sunRad * disc * (0.35 + 0.65 * limb) * T * uSunDiscScale;

  // ---- moon + night sky ----
  if (uNight > 0.001) {
    float muM = dot(rd, uMoonDirection);
    // Moonlit air: Rayleigh-blue, brighter toward the moon and along the
    // horizon where the path through the atmosphere is longest.
    float horizonThick = 0.45 + 0.55 * exp(-max(rd.y, 0.0) * 2.6);
    vec3 moonAir = vec3(0.030, 0.052, 0.115) * uMoonIntensity * horizonThick *
                   (0.55 + 0.75 * max(0.0, muM));
    sky += moonAir * uNight;

    // Stars — brightness distribution, not uniform dots. Cull below horizon.
    float above = smoothstep(-0.02, 0.14, rd.y);
    if (above > 0.0) {
      vec3 sd = rd * 340.0;
      vec3 cell = floor(sd);
      float h = hash13(cell);
      if (h > 0.9955) {
        vec3 local = fract(sd) - 0.5 - (vec3(hash13(cell + 3.1), hash13(cell + 5.7), hash13(cell + 9.3)) - 0.5) * 0.55;
        float d = length(local);
        float mag = pow((h - 0.9955) / 0.0045, 2.2);
        float tw = 0.72 + 0.28 * sin(uTime * 2.6 + h * 231.0);
        float warm = hash13(cell + 7.3);
        vec3 col = mix(vec3(0.72, 0.80, 1.0), vec3(1.0, 0.86, 0.68), warm * warm);
        sky += col * smoothstep(0.30, 0.0, d) * (0.25 + 3.2 * mag) * tw * above * uNight;
      }
      // Milky Way: a dusty band with real structure, not a gaussian smear.
      vec3 axis = normalize(vec3(0.62, 0.40, -0.68));
      float band = exp(-pow(dot(rd, axis) * 3.1, 2.0));
      float dust = fbm3(rd * 9.0 + 4.0);
      float clump = fbm3(rd * 24.0 - 2.0);
      float mw = band * (0.35 + 0.9 * dust) * (0.5 + 0.7 * clump);
      sky += mw * 0.055 * vec3(0.62, 0.68, 0.92) * above * uNight;
    }

    // Moon disc. Slightly larger than the sun's apparent size reads better.
    float cosMR = 0.99988;
    float mdisc = smoothstep(cosMR - 0.00008, cosMR + 0.00004, muM);
    if (mdisc > 0.0) {
      // Maria + craters so it is not a white pill.
      vec3 tangent = normalize(cross(uMoonDirection, vec3(0.0, 1.0, 0.0)));
      vec3 bitan = cross(uMoonDirection, tangent);
      vec2 disc2 = vec2(dot(rd, tangent), dot(rd, bitan)) / 0.0155;
      float r = clamp(length(disc2), 0.0, 1.0);
      float maria = fbm3(vec3(disc2 * 1.6, 0.0) + 11.0);
      float craters = fbm3(vec3(disc2 * 7.0, 3.0));
      float shade = mix(0.55, 1.0, smoothstep(0.32, 0.72, maria)) * (0.85 + 0.3 * craters);
      float lambert = sqrt(max(0.0, 1.0 - r * r)) * 0.35 + 0.65;
      sky += vec3(1.0, 0.97, 0.90) * 4.6 * uMoonIntensity * mdisc * shade * lambert;
    }
    // Glow halo around the moon (atmospheric forward scatter).
    sky += vec3(0.55, 0.63, 0.85) * uMoonIntensity * 0.16 *
           pow(max(0.0, muM), 320.0) * uNight;
  }

  vec3 texColor = sky * uSkyExposure * SKY_SCALE * uSunTint * uSkyIntensity;

  gl_FragColor = vec4(max(texColor, 0.0), 1.0);
}
`;

export class Sky {
  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        uSunDirection: { value: new THREE.Vector3(0.3, 0.4, -0.8) },
        uMoonDirection: { value: new THREE.Vector3(0.3, 0.6, 0.7) },
        uMoonIntensity: { value: 0.0 },
        uRayleigh: { value: 1.9 },
        uTurbidity: { value: 3.8 },
        uMieCoefficient: { value: 0.0058 },
        uMieDirectionalG: { value: 0.78 },
        uSunTint: { value: new THREE.Vector3(1, 1, 1) },
        uSkyIntensity: { value: 1.0 },
        uNight: { value: 0.0 },
        uTime: { value: 0.0 },
        // Calibrated so the dome's radiance is physically consistent with the
        // scene's DirectionalLight intensity (~5). The integrator carries a
        // sun irradiance of 20, hence the 1/4 ratio.
        uSkyExposure: { value: 0.0019 },
        uSunDiscScale: { value: 1.0 },
        uCamAltitude: { value: 400.0 },
        uSunIrradiance: { value: 20.0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), this.material);
    this.mesh.frustumCulled = false;
    // Drawn after the opaque terrain so early-Z rejects the covered pixels —
    // the raymarch is far too expensive to run behind the whole landscape.
    this.mesh.renderOrder = 900;
    this.mesh.matrixAutoUpdate = true;
  }

  /** Update from an ArtDirection time-of-day preset plus computed directions. */
  apply(preset, sunDirection, moonDirection, night) {
    const u = this.material.uniforms;
    u.uSunDirection.value.copy(sunDirection);
    if (moonDirection) u.uMoonDirection.value.copy(moonDirection);
    u.uRayleigh.value = preset.rayleigh;
    u.uTurbidity.value = preset.skyTurbidity;
    u.uMieCoefficient.value = preset.mieCoefficient;
    u.uMieDirectionalG.value = Math.min(preset.mieDirectionalG, 0.82);
    u.uNight.value = night;
    u.uMoonIntensity.value = night;
    // Nights are lit by the moon, not by a dimmed sun — do not scale the whole
    // dome down, the raymarch already terminates twilight correctly.
    u.uSkyIntensity.value = 1.0;
  }

  update(dt, camera, elapsed) {
    this.mesh.position.copy(camera.position);
    this.mesh.scale.setScalar(camera.far * 0.94);
    this.material.uniforms.uTime.value = elapsed;
    // 400 m is a plausible altitude for the Afghan highland; the camera's own
    // height rides on top of it so mountain-top views thin the air slightly.
    this.material.uniforms.uCamAltitude.value = 400.0 + Math.max(0, camera.position.y);
  }
}
