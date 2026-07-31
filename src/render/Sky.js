import * as THREE from 'three';

/**
 * Sky — Preetham/Hosek-style analytic atmospheric scattering on an inverted
 * sphere, rendered at the far plane with depth-write off.
 *
 * Rendered into the HDR buffer at real intensities so the sun disc and horizon
 * haze feed the bloom naturally rather than being faked in post.
 */

const SKY_VERT = /* glsl */ `
uniform vec3 uSunDirection;
uniform float uRayleigh;
uniform float uTurbidity;
uniform float uMieCoefficient;

varying vec3 vWorldPosition;
varying vec3 vSunDirection;
varying float vSunfade;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;

const vec3 up = vec3(0.0, 1.0, 0.0);
const float e = 2.71828182845904523536028747135266249775724709369995957;
const float pi = 3.141592653589793238462643383279502884197169;

// Wavelength-dependent Rayleigh scattering, 680/550/450nm
const vec3 lambda = vec3(680E-9, 550E-9, 450E-9);
const vec3 totalRayleigh = vec3(5.804542996E-6, 1.3562911342E-5, 3.0265902468E-5);
const float v = 4.0;
const vec3 K = vec3(0.686, 0.678, 0.666);
const vec3 MieConst = vec3(1.8399918514E14, 2.7798023989E14, 4.0790479543E14);

const float cutoffAngle = 1.6110731556870734;
const float steepness = 1.5;
const float EE = 1000.0;

float sunIntensity(float zenithAngleCos) {
  zenithAngleCos = clamp(zenithAngleCos, -1.0, 1.0);
  return EE * max(0.0, 1.0 - pow(e, -((cutoffAngle - acos(zenithAngleCos)) / steepness)));
}

vec3 totalMie(float T) {
  float c = (0.2 * T) * 10E-18;
  return 0.434 * c * MieConst;
}

void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w; // force to far plane

  vSunDirection = normalize(uSunDirection);
  vSunE = sunIntensity(dot(vSunDirection, up));
  vSunfade = 1.0 - clamp(1.0 - exp((uSunDirection.y / 450000.0)), 0.0, 1.0);

  float rayleighCoefficient = uRayleigh - (1.0 * (1.0 - vSunfade));
  vBetaR = totalRayleigh * rayleighCoefficient;
  vBetaM = totalMie(uTurbidity) * uMieCoefficient;
}
`;

const SKY_FRAG = /* glsl */ `
varying vec3 vWorldPosition;
varying vec3 vSunDirection;
varying float vSunfade;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;

uniform float uMieDirectionalG;
uniform vec3 uSunTint;
uniform float uSkyIntensity;
uniform float uNight;
uniform float uTime;
uniform float uSkyExposure;
uniform float uSunDiscScale;

const vec3 cameraPos = vec3(0.0, 0.0, 0.0);
const float pi = 3.141592653589793238462643383279502884197169;
const float n = 1.0003;
const float N = 2.545E25;

const float rayleighZenithLength = 8.4E3;
const float mieZenithLength = 1.25E3;
const vec3 up = vec3(0.0, 1.0, 0.0);
const float sunAngularDiameterCos = 0.999956676946448443553574619906976478926848692873900859324;

const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
const float ONE_OVER_FOURPI = 0.07957747154594767;

float rayleighPhase(float cosTheta) {
  return THREE_OVER_SIXTEENPI * (1.0 + pow(cosTheta, 2.0));
}

float hgPhase(float cosTheta, float g) {
  float g2 = pow(g, 2.0);
  float inverse = 1.0 / pow(max(1e-4, 1.0 - 2.0 * g * cosTheta + g2), 1.5);
  return ONE_OVER_FOURPI * ((1.0 - g2) * inverse);
}

float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  vec3 direction = normalize(vWorldPosition - cameraPos);

  float zenithAngle = acos(max(0.0, dot(up, direction)));
  float inverse = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));
  float sR = rayleighZenithLength * inverse;
  float sM = mieZenithLength * inverse;

  vec3 Fex = exp(-(vBetaR * sR + vBetaM * sM));

  float cosTheta = dot(direction, vSunDirection);
  float rPhase = rayleighPhase(cosTheta * 0.5 + 0.5);
  vec3 betaRTheta = vBetaR * rPhase;
  float mPhase = hgPhase(cosTheta, uMieDirectionalG);
  vec3 betaMTheta = vBetaM * mPhase;

  vec3 Lin = pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * (1.0 - Fex), vec3(1.5));
  Lin *= mix(vec3(1.0),
             pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * Fex, vec3(0.5)),
             clamp(pow(1.0 - dot(up, vSunDirection), 5.0), 0.0, 1.0));

  // Sun disc with a soft limb — a hard circle reads as CG immediately.
  float sundisk = smoothstep(sunAngularDiameterCos, sunAngularDiameterCos + 0.000045, cosTheta);
  vec3 L0 = vec3(0.1) * Fex;
  L0 += (vSunE * 19000.0 * Fex) * sundisk * uSunDiscScale;

  // uSkyExposure maps the analytic model's arbitrary radiance scale into the
  // renderer's linear HDR units. Calibrated so a clear midday zenith lands near
  // 0.3 linear (~0.55 sRGB after ACES) instead of clipping to white.
  vec3 texColor = (Lin + L0) * uSkyExposure + vec3(0.0, 0.0003, 0.00075);
  texColor *= uSunTint;
  texColor *= uSkyIntensity;

  // Stars, only when the sun is below the horizon.
  if (uNight > 0.001) {
    vec3 sd = direction * 220.0;
    vec3 cell = floor(sd);
    float h = hash(cell);
    float star = smoothstep(0.9975, 1.0, h);
    if (star > 0.0) {
      vec3 local = fract(sd) - 0.5;
      float d = length(local);
      float tw = 0.65 + 0.35 * sin(uTime * 2.1 + h * 100.0);
      float pt = smoothstep(0.34, 0.0, d) * star * tw;
      float warm = hash(cell + 7.3);
      texColor += pt * uNight * 2.2 * mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.88, 0.72), warm) *
                  smoothstep(-0.05, 0.25, direction.y);
    }
    // Milky-band: a faint dusty ridge across the sky.
    float band = exp(-pow((dot(direction, normalize(vec3(0.6, 0.45, -0.66)))) * 3.4, 2.0));
    texColor += band * uNight * 0.055 * vec3(0.55, 0.62, 0.85) * smoothstep(-0.05, 0.3, direction.y);
  }

  gl_FragColor = vec4(texColor, 1.0);
}
`;

export class Sky {
  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        uSunDirection: { value: new THREE.Vector3(0.3, 0.4, -0.8) },
        uRayleigh: { value: 1.9 },
        uTurbidity: { value: 3.8 },
        uMieCoefficient: { value: 0.0058 },
        uMieDirectionalG: { value: 0.82 },
        uSunTint: { value: new THREE.Vector3(1, 1, 1) },
        uSkyIntensity: { value: 1.0 },
        uNight: { value: 0.0 },
        uTime: { value: 0.0 },
        uSkyExposure: { value: 0.0075 },
        uSunDiscScale: { value: 1.0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.scale.setScalar(1);
    this.mesh.matrixAutoUpdate = true;
  }

  /** Update from an ArtDirection time-of-day preset plus a computed sun direction. */
  apply(preset, sunDirection) {
    const u = this.material.uniforms;
    u.uSunDirection.value.copy(sunDirection);
    u.uRayleigh.value = preset.rayleigh;
    u.uTurbidity.value = preset.skyTurbidity;
    u.uMieCoefficient.value = preset.mieCoefficient;
    u.uMieDirectionalG.value = preset.mieDirectionalG;
    const night = THREE.MathUtils.smoothstep(-sunDirection.y, 0.0, 0.22);
    u.uNight.value = night;
    u.uSkyIntensity.value = THREE.MathUtils.lerp(1.0, 0.16, night);
  }

  update(dt, camera, elapsed) {
    this.mesh.position.copy(camera.position);
    this.mesh.scale.setScalar(camera.far * 0.94);
    this.material.uniforms.uTime.value = elapsed;
  }
}
