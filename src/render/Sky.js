import * as THREE from 'three';

/**
 * Sky — multiple-scattering atmosphere with precomputed transmittance and
 * multi-scatter LUTs, plus a physically-posed sun and moon.
 *
 * ## Why this shape
 *
 * Round 1 shipped a single-scattering raymarch with an isotropic "msBoost"
 * fudge bolted onto the phase function. Measured off the vista frame, the
 * result was a near-white zenith (luma 0.70, B-R only +0.12) that got *brighter
 * and yellower* toward the horizon (B-R -0.07 at y=0.25). That is the inverse of
 * a real clear sky and it is exactly what the fudge does: `msBoost * 0.28` is
 * four times the Rayleigh phase value at the zenith, so the fake isotropic term
 * swamped the real scattering everywhere and painted a grey card.
 *
 * The fix is to compute the multiple scattering instead of faking it. Two small
 * LUTs are built **on the CPU at load** (Hillaire 2020):
 *
 *  - **Transmittance** T(r, mu), 256x64. Beer-Lambert through Rayleigh + aerosol
 *    + ozone from any altitude in any direction.
 *  - **Multi-scatter** Psi(r, mu_s), 32x32. For each altitude / sun angle, the
 *    second scattering order is integrated over the whole sphere of directions,
 *    then the remaining orders are summed as a geometric series
 *    `Psi = L2 / (1 - f_ms)`. Ground albedo is part of that integral, so light
 *    bounced off sand is genuinely in the sky and in the IBL.
 *
 * They are built on the CPU rather than into render targets for one blunt
 * reason: `new Sky()` never sees the renderer (main.js owns that call), and the
 * same tables are needed on the CPU anyway for `radianceInDirection()`, which
 * Lighting and the volumetrics module query. One implementation, two consumers,
 * no ordering hazard.
 *
 * The per-pixel cost is then a 20-step march with two LUT taps per step, which
 * is *cheaper* than round 1's 16x6 nested march and enormously more correct.
 *
 * ## Why there is no green band at dusk
 *
 * Preetham is a least-squares fit to daylight and has no data below ~5 degrees
 * of solar elevation; its chromaticity fit turns the anti-solar horizon olive.
 * Here the twilight colour falls out of the physics: ozone's Chappuis band eats
 * yellow-green along the very long slant path, the planet's shadow rises through
 * the atmosphere as a real sphere intersection, and the multi-scatter term
 * carries the light that single scattering cannot reach. Warm orange near the
 * sun, magenta above it, deep blue opposite — measured, not fitted.
 *
 * ## Aerosol
 *
 * The aerosol is Afghan mineral dust, not the textbook maritime haze: scattering
 * very slightly warm-biased and absorption strongly blue-weighted (iron oxide).
 * That is what turns the horizon band warm khaki instead of grey, and it is the
 * single largest warm contribution this file makes to the IBL.
 *
 * Rendered at the far plane into the linear-HDR buffer at real radiance so the
 * sun disc and horizon haze feed bloom naturally. Never tonemapped here.
 */

// ---------------------------------------------------------------------------
// Atmosphere constants. Everything is in KILOMETRES: at 6360 km planet radius,
// float32 cannot resolve `dot(p,p) - r*r` in metres, and the horizon ends up
// quantised into visible steps.
// ---------------------------------------------------------------------------

const RG = 6360.0; // planet radius, km
const RA = 6460.0; // top of atmosphere, km
const H_RAY = 8.0; // Rayleigh scale height, km
const H_MIE = 1.2; // aerosol scale height, km

// Rayleigh scattering at 680/550/440 nm, 1/km. Standard Earth values.
const BETA_R = [0.005802, 0.013558, 0.033100];
// Mineral dust. Vertical optical depth ~0.08 at scale 1.0, single-scattering
// albedo (0.94, 0.88, 0.77) — coarse silicate with a hematite fraction.
const BETA_M_S = [0.0580, 0.0548, 0.0505];
const BETA_M_A = [0.0045, 0.0090, 0.0180];

// ---------------------------------------------------------------------------
// Delta-M truncation of the aerosol forward peak (round 4).
//
// Round 3 drew the aerosol with one Cornette-Shanks lobe at g=0.82 against the
// full scattering coefficient. Measured on the shipped frames, the resulting
// aureole was the single worst defect in the game: the outpost frame's top band
// sits 13-20 degrees off the sun and the dome put 2.8-3.1 units of radiance
// there against 0.57 for the sunlit sand it is meant to be lighting. Five times
// the ground, achromatic (B/R 0.80-0.87), and it filled the whole upper half of
// three of the seven canonical frames with a blown cream card. Two independent
// errors compound into that:
//
//  1. A coarse-mode dust aerosol puts more than half its scattered energy into a
//     diffraction peak a couple of degrees wide. Light scattered through one
//     degree is indistinguishable from light that was never scattered, so every
//     serious transfer solver removes it from BOTH the phase function and the
//     scattering coefficient before integrating — Wiscombe's delta-M scaling,
//     `beta' = beta(1-f)`, `p' = (p - f*delta)/(1-f)`. Round 3 did not, so that
//     energy was scattered a second time into the 10-40 degree band where a
//     single HG lobe still has plenty of amplitude, and the aureole inherited
//     all of it.
//  2. SKY_GAIN doubles sky radiance for art reasons. Doubling a term that is
//     already five times the subject is how a lift becomes a blowout.
//
// So the peak is truncated properly, and a deliberately *small* narrow lobe is
// added back on top: at these framings a few degrees of glare around the disc is
// resolved on screen and reads as a brutal sun, which is the look. The retained
// phase is `w*HG(gSpike) + (1-w)*HG(gBroad)`, gBroad following delta-M from the
// preset's asymmetry. Adding the spike back leaves the whole aerosol at an
// effective g of 0.85 against the 0.82 asked for — 4% too forward, deliberately,
// and the only place that shows is the first few degrees around the disc.
//
// Measured on the outpost frame's top-left ray, 15 degrees off the sun, in
// scene-linear radiance against a sunlit sand reference of 0.55:
//
//   f      radiance   B/R    x sand      (0.0 is the round-3 single lobe)
//   0.00     2.66     0.86     4.7
//   0.62     1.06     1.72     1.9
//   0.74     0.84     2.32     1.6      <- shipped
//   0.85     0.75     2.78     1.4
//
// The knee is real: below 0.74 the aureole still dominates, above it the return
// falls off because what is left is Rayleigh, which is the part that is supposed
// to be there. 0.74 is at the top of the range a 1-2 um silicate actually has
// (Mie theory puts the diffraction fraction at 0.6-0.75 for these sizes), and it
// is chosen at the top of that range on purpose. The same numbers cost the noon
// zenith 17% of its radiance and gain it 0.8 of B/R, and the horizon band gets
// *warmer and brighter* (0.86 -> 1.07 at B/R 0.79) because the energy the peak
// was hoarding comes back as multiple scattering along the long path.
const DUST_TRUNC = 0.74;
// The glare lobe is narrow on purpose — g=0.96 is 3 degrees to half amplitude,
// about where a 2 um silicate's diffraction peak has its first minimum, and it
// is 0.4% of its own peak by 15 degrees. Widening it to 0.93 at matched weight
// adds nothing on the disc and puts 4% back into the aureole.
const DUST_SPIKE_W = 0.16;
const DUST_SPIKE_G = 0.96;
/** Scattering and extinction after truncation. Everything downstream uses these. */
const BETA_M_S_EFF = BETA_M_S.map((v) => v * (1 - DUST_TRUNC));
const BETA_M_E_EFF = BETA_M_S_EFF.map((v, i) => v + BETA_M_A[i]);
// Ozone (Chappuis), 1/km at the layer peak. Tent profile, 10 km -> 25 km -> 40 km.
//
// Round 5: 0.000650/0.001881/0.000085 -> 0.000955/0.002765/0.000125, a uniform
// 1.47x. The tent integrates to 15 km of unit density, so the old triple was a
// vertical optical depth of 0.028 at 600 nm; 300 DU of ozone against the
// Chappuis cross section (~5.0e-21 cm^2) is 0.040, and Afghan-latitude spring
// column is 320-350 DU. The old numbers were a ~210 DU atmosphere — thinner
// than anywhere on Earth outside the polar hole.
//
// This is the single biggest lever on the low-sun sky and it was set 30-40%
// low. Ozone is the ONLY term that gets stronger with path length while
// absorbing orange rather than blue, so it is what stops a long horizontal path
// at dusk from turning the whole dome sepia. Measured on the dome, dusk at 15
// degrees of elevation, linear B/G:
//
//   ozone x1.00 (shipped r4)   solar 1.03   90 deg 1.20   anti-solar 1.09
//   ozone x1.47 (this)         solar 1.20   90 deg 1.42   anti-solar 1.30
//
// and the dusk zenith goes 1.69 -> 1.99. Noon is almost untouched (zenith
// 1.96 -> 1.99) because a high sun's path never crosses much ozone.
//
// The red channel is then raised again on its own, 0.000955 -> 0.001380, i.e.
// from 0.35 of the green coefficient to 0.50. Sampling the Chappuis band at
// three monochromatic wavelengths (680/550/440) badly under-weights it in RED,
// because the band's MAXIMUM is at 602 nm — inside the sRGB red primary's
// response, not the green's. Band-averaged over the primaries the honest ratio
// is nearer 1.0; 0.50 is a deliberately conservative half-step toward it. It is
// the term that decides whether a twilight sky reads blue or magenta, because
// it is the only one that takes red out of a long slant path: measured on the
// dusk dome 90 degrees off the sun at 20 degrees of elevation, linear R/G goes
// 1.11 -> 1.02, and at the zenith 1.01 -> 0.93. Below 1.0 the sky is blue;
// above it, it is violet, and three rounds of critics have called that magenta.
const BETA_O = [0.001380, 0.002765, 0.000125];
// Desert sand, linear albedo. Feeds the multi-scatter integral and the
// below-horizon dome, i.e. the warm half of the IBL.
const GROUND_ALBEDO = [0.34, 0.29, 0.21];

// ---------------------------------------------------------------------------
// Angular colour structure of the multiply-scattered field (round 5).
//
// Hillaire's Psi table is indexed by (altitude, sun angle) only: the multiply
// scattered radiance is assumed ISOTROPIC in the view direction. At a high sun
// that is a good approximation, because multiple scattering is then a small
// fraction of the signal. At a low sun it is the single reason this dome had no
// warm/cool split at all. Measured on the shipped build, the dusk dome at 15
// degrees of elevation read linear B/G 1.03 toward the sun and 1.09 opposite
// it — a 6% difference across an entire sky. It is 6% because below ~20 degrees
// of elevation at a 2 degree sun the multi-scatter term IS the sky, and it
// carries no azimuth.
//
// The field is not isotropic in colour, for a reason that needs no fudge:
// radiance arriving from close to the sun has scattered the fewest times and is
// still close to the direct beam, which at a low sun is deeply reddened;
// radiance arriving from the anti-solar half only got there by scattering
// again, and every additional event is Rayleigh, i.e. lambda^-4 weighted. So
// the multiply-scattered field gets monotonically bluer with angle from the
// sun. That is what paints a real sunset: orange behind you, and blue-violet
// over your shoulder, in the same sky, at the same time.
//
// Applied as a chroma-only tilt. Both endpoints are normalised to Rec.709
// luminance 1.0 and the interpolation is linear, so the mix is luminance 1.0
// everywhere: this moves no energy, it only redistributes it across the
// primaries. It is faded out as the sun rises, because the premise (multiple
// scattering dominating a long slant path) stops being true.
const MS_TINT_SOLAR = [1.190, 0.975, 0.700];
const MS_TINT_ANTI = [0.810, 1.010, 1.450];
/**
 * Where the warm half ends and the cool half begins, as cos(angle from the
 * light): 15 degrees and 72 degrees. NOT a linear ramp in cos — a linear ramp
 * put the halfway point at 90 degrees off the sun, which means every framing
 * that keeps the sun anywhere in shot (five of the seven canonical ones do)
 * sees only the warm half of the transition. The low-order, still-reddened part
 * of the multiply-scattered field is concentrated in the aureole and the first
 * few tens of degrees around it, because that is the width of what the aerosol
 * phase function convolved with itself puts there; beyond ~70 degrees a photon
 * has had to turn too far for anything but repeated Rayleigh events to have
 * done it. So the warm zone is tight and the sky beyond it is blue, which is
 * what a sunset actually looks like.
 */
const MS_WARM_MU = 0.966; // cos 15 deg
const MS_COOL_MU = 0.309; // cos 72 deg
/** Strength at a horizon sun; ramped to zero by ~38 degrees of elevation. */
const MS_ANISO = 0.85;

const TRANS_W = 256;
const TRANS_H = 64;
const MS_W = 32;
const MS_H = 32;

/** Solar irradiance at the top of the atmosphere, in renderer linear units. */
const E_TOA = 8.2;
/**
 * Artistic lift of sky radiance over the physical value. Real clear-sky zenith
 * sits about a stop under sunlit sand; every shipped game opens that up because
 * the sky is the frame's negative space and a dark one reads as overcast.
 *
 * Round 2 set this to hold the vista zenith at 0.45-0.60 display luminance.
 * That target is dead: 0.5 display luminance on a zenith IS the blown cream card
 * three critics rejected, and it was only ever reachable because ACES then
 * desaturated the blue out of it on the way. The zenith is now aimed at
 * 0.14-0.22 display, and the dome measures 0.11-0.21 across the daylight frames
 * without touching this number — the level was never the problem, the aerosol
 * phase was (see DUST_TRUNC). Left at 2.05 because it is also the sky's weight
 * in the IBL, and halving it here would silently cut the ambient fill in half.
 */
const SKY_GAIN = 2.05;
/**
 * Solar disc radiance as a multiple of TOA irradiance. Physically it is
 * 1/omega_sun = 14700; clamped hard because the HDR buffer is half-float
 * (65504 max) and because 14700 turns bloom into a white wipe.
 */
const SUN_DISC_GAIN = 130.0;
/** Moon irradiance at full phase, as a fraction of the sun's. */
const MOON_FULL_FRACTION = 0.062;
/** Lunar regolith reflectance slope: moonlight is ~0.15 mag redder than the Sun. */
const MOON_TINT = [1.0, 0.945, 0.855];

const SUN_ANGULAR_RADIUS = 0.004654; // 0.53 deg diameter
const MOON_ANGULAR_RADIUS = 0.004520; // 0.518 deg diameter

// Legacy scale factor: `uSunIrradiance * uSkyExposure * SKY_SCALE` is the TOA
// irradiance the dome is integrated against. tools/calibrate.mjs sweeps
// uSkyExposure, so the product has to stay the tunable.
const SKY_SCALE = 133.3333;

// ---------------------------------------------------------------------------
// Shared model, GLSL. Exported because the volumetrics pass may want the same
// densities; the LUT samplers are declared by the including shader.
// ---------------------------------------------------------------------------

export const ATMOSPHERE_GLSL = /* glsl */ `
const float RG = ${RG.toFixed(1)};
const float RA = ${RA.toFixed(1)};
const float H_RAY = ${H_RAY.toFixed(3)};
const float H_MIE = ${H_MIE.toFixed(3)};
const vec3  BETA_R = vec3(${BETA_R.join(', ')});
// Delta-M truncated: the diffraction peak is out of both of these (see the
// DUST_TRUNC block). BETA_M_S is the untruncated coefficient, kept only so a
// an including shader that wants the raw aerosol optical depth can have it.
const vec3  BETA_M_S = vec3(${BETA_M_S_EFF.join(', ')});
const vec3  BETA_M_A = vec3(${BETA_M_A.join(', ')});
const vec3  BETA_M_S_RAW = vec3(${BETA_M_S.join(', ')});
const vec3  BETA_O = vec3(${BETA_O.join(', ')});
const vec3  GROUND_ALBEDO = vec3(${GROUND_ALBEDO.join(', ')});
const float PI_ = 3.141592653589793;

/** Rayleigh, aerosol and ozone density at altitude h (km). */
void densities(float h, out float dR, out float dM, out float dO) {
  dR = exp(-max(h, 0.0) / H_RAY);
  dM = exp(-max(h, 0.0) / H_MIE);
  dO = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
}

float phaseRayleigh(float mu) { return (3.0 / (16.0 * PI_)) * (1.0 + mu * mu); }

float hg(float mu, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI_ * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}

/**
 * Retained aerosol phase after delta-M truncation: a narrow resolved glare lobe
 * plus the broad remainder. g is the preset's asymmetry for the *whole*
 * aerosol; the broad lobe's is what is left of it once the delta has been taken
 * out, which is the standard (g - f) / (1 - f). Normalised by construction, so
 * pairing it with BETA_M_S (already scaled by 1-f) conserves energy.
 */
float phaseDust(float mu, float g) {
  float gb = clamp((g - ${DUST_TRUNC.toFixed(3)}) / ${(1 - DUST_TRUNC).toFixed(3)}, 0.05, 0.80);
  return ${DUST_SPIKE_W.toFixed(3)} * hg(mu, ${DUST_SPIKE_G.toFixed(3)}) +
         ${(1 - DUST_SPIKE_W).toFixed(3)} * hg(mu, gb);
}

/**
 * Luminance-preserving chroma tilt on the multi-scatter term (see MS_TINT_*).
 * mu is the cosine between the view ray and the light; s is the strength, which
 * the caller ramps off as the light climbs.
 */
vec3 msAnisotropy(float mu, float s) {
  vec3 t = mix(vec3(${MS_TINT_SOLAR.join(', ')}), vec3(${MS_TINT_ANTI.join(', ')}),
               1.0 - smoothstep(${MS_COOL_MU.toFixed(3)}, ${MS_WARM_MU.toFixed(3)}, mu));
  return mix(vec3(1.0), t, s);
}

/** MS anisotropy strength for a light at elevation sine muY. */
float msAnisotropyStrength(float muY) {
  return ${MS_ANISO.toFixed(3)} * (1.0 - smoothstep(0.06, 0.62, muY));
}

/** Nearest positive intersection with a sphere centred at the origin; -1 if none. */
float raySphereNear(vec3 ro, vec3 rd, float rad) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - rad * rad;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  d = sqrt(d);
  float t0 = -b - d;
  float t1 = -b + d;
  if (t1 < 0.0) return -1.0;
  return t0 < 0.0 ? t1 : t0;
}

/** Far intersection; -1 if we miss. */
float raySphereFar(vec3 ro, vec3 rd, float rad) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - rad * rad;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  return -b + sqrt(d);
}

float texCoordFromUnit(float x, float n) { return 0.5 / n + x * (1.0 - 1.0 / n); }

/**
 * Bruneton's transmittance parameterisation. It distributes samples by distance
 * to the top of the atmosphere, which packs resolution exactly where the
 * gradient is: the last degree above the horizon.
 */
vec2 transmittanceUv(float r, float mu) {
  float H = sqrt(max(RA * RA - RG * RG, 0.0));
  float rho = sqrt(max((r - RG) * (r + RG), 0.0));
  float disc = r * r * (mu * mu - 1.0) + RA * RA;
  float d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  float dMin = RA - r;
  float dMax = rho + H;
  return vec2(
    texCoordFromUnit(clamp((d - dMin) / max(dMax - dMin, 1e-4), 0.0, 1.0), ${TRANS_W}.0),
    texCoordFromUnit(clamp(rho / H, 0.0, 1.0), ${TRANS_H}.0));
}

vec2 msUv(float r, float muS) {
  return vec2(
    texCoordFromUnit(clamp(muS * 0.5 + 0.5, 0.0, 1.0), ${MS_W}.0),
    texCoordFromUnit(clamp((r - RG) / (RA - RG), 0.0, 1.0), ${MS_H}.0));
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vRay;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vRay = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w; // pin to the far plane
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vRay;

uniform sampler2D uTransLUT;
uniform sampler2D uMsLUT;

uniform vec3 uSunDirection;
uniform vec3 uMoonDirection;
uniform float uMoonIntensity;   // moon TOA irradiance, renderer units
uniform float uRayleigh;        // legacy art hook, folded into uRayleighScale
uniform float uTurbidity;
uniform float uMieCoefficient;
uniform float uMieDirectionalG;
uniform vec3 uSunTint;
uniform float uSkyIntensity;
uniform float uNight;
uniform float uTime;
uniform float uSkyExposure;
uniform float uSunDiscScale;    // 0 while the IBL cube is generated
uniform float uCamAltitude;     // metres
uniform float uSunIrradiance;
uniform float uRayleighScale;
uniform float uAerosolScale;
uniform float uMoonPhaseAngle;  // radians, 0 = full
uniform float uStarIntensity;

${ATMOSPHERE_GLSL}

const float SKY_SCALE = ${SKY_SCALE};
const float SUN_R = ${SUN_ANGULAR_RADIUS};
const float MOON_R = ${MOON_ANGULAR_RADIUS};

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

/**
 * Sun/moon transmittance at a sample point, with a soft planet terminator.
 * The smoothstep is 0.5 degrees wide — the angular size of the source plus a
 * little atmospheric refraction — so the shadow of the Earth rises through the
 * atmosphere at dusk instead of snapping off.
 */
vec3 lightTransmittance(float r, float muL) {
  float muHorizon = -sqrt(max(0.0, 1.0 - (RG * RG) / (r * r)));
  float shadow = smoothstep(muHorizon - 0.0045, muHorizon + 0.0045, muL);
  if (shadow <= 0.0) return vec3(0.0);
  float mu = max(muL, muHorizon + 1e-4);
  return texture2D(uTransLUT, transmittanceUv(r, mu)).rgb * shadow;
}

struct March { vec3 L; vec3 T; float groundT; };

/**
 * The view-ray integral. Both light sources are accumulated in one pass so the
 * densities, the step transmittance and the analytic step integral are shared —
 * a second march for the moon would double the cost for a term that is four
 * stops down.
 */
March marchSky(vec3 ro, vec3 rd, vec3 sunDir, vec3 sunE, vec3 moonDir, vec3 moonE, float mieG) {
  March o;
  o.L = vec3(0.0);
  o.T = vec3(1.0);
  o.groundT = -1.0;

  float tTop = raySphereFar(ro, rd, RA);
  if (tTop <= 0.0) return o;
  float tGround = raySphereNear(ro, rd, RG);
  float tMax = tGround > 0.0 ? tGround : tTop;
  o.groundT = tGround;

  vec3 bR = BETA_R * uRayleighScale;
  vec3 bMs = BETA_M_S * uAerosolScale;
  vec3 bMe = (BETA_M_S + BETA_M_A) * uAerosolScale;

  float muSun = dot(rd, sunDir);
  float pRs = phaseRayleigh(muSun);
  float pMs = phaseDust(muSun, mieG);
  float muMoon = dot(rd, moonDir);
  float pRm = phaseRayleigh(muMoon);
  float pMm = phaseDust(muMoon, mieG);
  bool doMoon = uNight > 0.001;
  // Constant along the ray: the multi-scatter chroma only depends on the angle
  // between the view direction and the light, so it is hoisted out of the loop.
  vec3 msTintS = msAnisotropy(muSun, msAnisotropyStrength(sunDir.y));
  vec3 msTintM = msAnisotropy(muMoon, msAnisotropyStrength(moonDir.y));

  const int STEPS = 20;
  for (int i = 0; i < STEPS; i++) {
    // Quadratic distribution: the first kilometre of air carries most of the
    // signal, the last three hundred carry almost none.
    float f0 = float(i) / float(STEPS);
    float f1 = float(i + 1) / float(STEPS);
    float s0 = tMax * f0 * f0;
    float s1 = tMax * f1 * f1;
    float ds = s1 - s0;
    if (ds <= 0.0) continue;
    vec3 p = ro + rd * (0.5 * (s0 + s1));
    float r = length(p);
    float h = r - RG;

    float dR, dM, dO;
    densities(h, dR, dM, dO);
    vec3 sS = bR * dR + bMs * dM;
    vec3 sE = bR * dR + bMe * dM + BETA_O * dO * uRayleighScale;
    sE = max(sE, vec3(1e-9));

    vec3 up = p / r;
    float muS = dot(up, sunDir);
    vec3 tSun = lightTransmittance(r, muS);
    vec3 psiS = texture2D(uMsLUT, msUv(r, muS)).rgb * msTintS;
    vec3 S = ((bR * dR * pRs + bMs * dM * pMs) * tSun + sS * psiS) * sunE;

    if (doMoon) {
      float muM = dot(up, moonDir);
      vec3 tMoon = lightTransmittance(r, muM);
      vec3 psiM = texture2D(uMsLUT, msUv(r, muM)).rgb * msTintM;
      S += ((bR * dR * pRm + bMs * dM * pMm) * tMoon + sS * psiM) * moonE;
    }

    // Energy-conserving analytic integration across the step (Hillaire): with a
    // 20-step march a midpoint rule visibly under-integrates the first step,
    // which is the one that matters at the horizon.
    vec3 tStep = exp(-sE * ds);
    o.L += o.T * (S - S * tStep) / sE;
    o.T *= tStep;
  }

  // Below the horizon the dome shows lit ground. It is only ever visible in the
  // IBL cube (terrain covers it in-frame), but that is precisely the half of the
  // environment that should be warm sand rather than grey.
  if (tGround > 0.0) {
    vec3 pg = ro + rd * tGround;
    vec3 n = normalize(pg);
    float muS = dot(n, sunDir);
    vec3 lit = GROUND_ALBEDO * (lightTransmittance(RG, muS) * max(muS, 0.0) / PI_
             + texture2D(uMsLUT, msUv(RG, muS)).rgb) * sunE;
    if (doMoon) {
      float muM = dot(n, moonDir);
      lit += GROUND_ALBEDO * (lightTransmittance(RG, muM) * max(muM, 0.0) / PI_
           + texture2D(uMsLUT, msUv(RG, muM)).rgb) * moonE;
    }
    o.L += o.T * lit;
  }
  return o;
}

/**
 * Star field. The magnitude distribution follows N(<m) ~ 10^(0.6m), so a handful
 * of anchors sit in a dust of faint ones; a uniform threshold gives confetti.
 * Colour rides on an implied B-V, and the whole field is multiplied by the view
 * transmittance so stars extinguish into the horizon haze the way they must.
 */
vec3 starField(vec3 rd, vec3 T) {
  vec3 sd = rd * 380.0;
  vec3 cell = floor(sd);
  float h = hash13(cell);
  vec3 sum = vec3(0.0);
  if (h > 0.9948) {
    float u = (h - 0.9948) / 0.0052;
    vec3 jitter = vec3(hash13(cell + 3.1), hash13(cell + 5.7), hash13(cell + 9.3)) - 0.5;
    vec3 local = fract(sd) - 0.5 - jitter * 0.5;
    float d = length(local);
    // u^4 spreads three orders of magnitude of brightness across the field.
    float mag = 0.045 + 5.6 * pow(u, 4.0);
    float tw = 0.88 + 0.12 * sin(uTime * 1.6 + h * 231.0);
    float bv = hash13(cell + 7.3);
    vec3 col = mix(vec3(0.70, 0.78, 1.05), vec3(1.10, 0.86, 0.62), bv * bv);
    float prof = pow(max(0.0, 1.0 - d / 0.46), 2.4);
    sum += col * prof * mag * tw;
  }
  // Milky Way: a narrow band of unresolved stars with dark lanes cut through it.
  // Kept faint on purpose — at any brightness where it reads as a *shape* it
  // reads as overcast cloud instead, which is exactly what it did at 0.085.
  vec3 axis = normalize(vec3(0.62, 0.40, -0.68));
  float band = exp(-pow(dot(rd, axis) * 4.2, 2.0));
  float dust = fbm3(rd * 11.0 + 4.0);
  float clump = fbm3(rd * 30.0 - 2.0);
  float lane = smoothstep(0.30, 0.66, fbm3(rd * 16.0 + 21.0));
  sum += band * (0.15 + 0.9 * dust * dust) * (0.35 + 0.85 * clump) * lane *
         0.030 * vec3(0.76, 0.79, 0.95);
  return sum * T * uStarIntensity;
}

void main() {
  vec3 rd = normalize(vRay);
  vec3 ro = vec3(0.0, RG + max(uCamAltitude, 1.0) * 0.001, 0.0);
  // Kept high on purpose. Dropping g widens the lobe, which sounds gentler but
  // measures worse: at g=0.76 the sky 40 degrees off the sun clipped 5.7% of the
  // gameplay frame to white, against 4.4% at 0.82. Coarse dust diffracts into a
  // tight forward peak — a small hot glare, not a blown hemisphere.
  float mieG = clamp(uMieDirectionalG, 0.60, 0.84);

  // TOA irradiance. Kept as the legacy triple product so tools/calibrate.mjs
  // still has uSkyExposure as its tunable and Lighting reads the same numbers.
  float E = uSunIrradiance * uSkyExposure * SKY_SCALE;
  vec3 sunE = vec3(E);
  // Moonlight is sunlight off a regolith whose albedo climbs with wavelength;
  // it is about 0.15 mag redder than the Sun. Without the tint the night sky
  // integrates to a red channel of literally zero and reads as ultraviolet.
  vec3 moonE = vec3(1.0, 0.945, 0.855) * (uMoonIntensity * uSkyExposure * SKY_SCALE);

  March m = marchSky(ro, rd, uSunDirection, sunE, uMoonDirection, moonE, mieG);
  vec3 sky = m.L;

  // ---- stars (behind the whole atmosphere, so extinguished by it) ----
  // Gated with the discs so the IBL cube does not pick the Milky Way up as a
  // directional ambient term; at moonlight levels it is bright enough to matter.
  if (uNight > 0.001 && m.groundT < 0.0 && uSunDiscScale > 0.0) {
    sky += starField(rd, m.T) * uNight * uSunDiscScale;
  }

  // ---- sun disc ----
  // 0.53 degrees with wavelength-dependent limb darkening: the limb is redder
  // than the centre because blue photons escape from a shallower, cooler layer.
  float ctS = clamp(dot(rd, uSunDirection), -1.0, 1.0);
  float thS = sqrt(max(0.0, 2.0 * (1.0 - ctS)));
  if (thS < SUN_R * 1.6 && uSunDiscScale > 0.0) {
    float x = clamp(thS / SUN_R, 0.0, 1.0);
    float mup = sqrt(max(0.0, 1.0 - x * x));
    vec3 u1 = vec3(0.47, 0.55, 0.64);
    vec3 u2 = vec3(0.23, 0.22, 0.20);
    vec3 limb = max(vec3(0.0), 1.0 - u1 * (1.0 - mup) - u2 * (1.0 - mup) * (1.0 - mup));
    float edge = 1.0 - smoothstep(SUN_R - 0.00022, SUN_R + 0.00022, thS);
    sky += vec3(1.0, 0.965, 0.905) * (E * ${SUN_DISC_GAIN.toFixed(1)}) * limb * edge * m.T * uSunDiscScale;
  }

  // ---- moon ----
  if (uNight > 0.001) {
    float ctM = clamp(dot(rd, uMoonDirection), -1.0, 1.0);
    float thM = sqrt(max(0.0, 2.0 * (1.0 - ctM)));

    if (thM < MOON_R * 1.6 && uSunDiscScale > 0.0) {
      vec3 tangent = normalize(cross(uMoonDirection, vec3(0.0, 1.0, 0.0)));
      vec3 bitan = cross(tangent, uMoonDirection);
      vec2 d2 = vec2(dot(rd, tangent), dot(rd, bitan)) / MOON_R;
      float rr = clamp(length(d2), 0.0, 1.0);
      // Surface normal of the lunar sphere at this pixel.
      vec3 n = normalize(tangent * d2.x + bitan * d2.y +
                         uMoonDirection * sqrt(max(0.0, 1.0 - rr * rr)));
      // Sub-solar direction, rotated out of the disc plane by the phase angle.
      vec3 sunLocal = normalize(uMoonDirection * cos(uMoonPhaseAngle) +
                                tangent * sin(uMoonPhaseAngle));
      float ndl = dot(n, sunLocal);
      float ndv = dot(n, uMoonDirection);
      // Lommel-Seeliger, not Lambert: regolith backscatters, which is why a full
      // moon is a flat disc rather than a shaded ball.
      float ls = max(ndl, 0.0) / max(ndl + ndv, 0.08);
      float term = smoothstep(-0.06, 0.06, ndl);

      float maria = fbm3(vec3(d2 * 1.4, 0.0) + 11.0);
      float craters = fbm3(vec3(d2 * 9.0, 3.0));
      float albedo = mix(0.38, 1.0, smoothstep(0.32, 0.66, maria)) * (0.82 + 0.34 * craters);
      float edge = 1.0 - smoothstep(MOON_R - 0.00022, MOON_R + 0.00022, thM);

      // Earthshine keeps the unlit limb from being a hard bite out of the sky.
      vec3 earthshine = vec3(0.22, 0.28, 0.42) * 0.035;
      vec3 disc = (vec3(1.0, 0.975, 0.935) * ls * term * 1.30 + earthshine) * albedo;
      // Physically the disc is ~80000x the moonlit ground and would be a
      // featureless white pill at any night exposure. Held just over the white
      // point instead, so the maria and the terminator survive the tonemap and
      // only the brightest highland still clips.
      sky += disc * (E * 0.105) * edge * m.T * uSunDiscScale * uNight;
    }
    // Forward-scattered halo. Real, and it sells the moon as a light source.
    sky += vec3(0.62, 0.68, 0.88) * (E * 0.0055) *
           pow(max(0.0, ctM), 1600.0) * m.T * uNight;

    // Night-sky floor: airglow (OI 557.7 nm plus OH bands) over integrated
    // starlight and zodiacal light. Brightens toward the horizon because the
    // 90 km emitting shell is seen edge-on (van Rhijn). Nearly neutral on
    // purpose — it is what stops the moonlit blue from crushing red to zero.
    float vr = 1.0 / max(sqrt(max(0.0, 1.0 - 0.978 * (1.0 - rd.y * rd.y))), 0.30);
    sky += vec3(0.000105, 0.000095, 0.000080) * E * vr * uNight * m.T;
  }

  gl_FragColor = vec4(max(sky * uSunTint * uSkyIntensity, 0.0), 1.0);
}
`;

// ---------------------------------------------------------------------------
// CPU model — builds the LUTs and mirrors the march for the query API.
// ---------------------------------------------------------------------------

// Writes into `out` rather than returning: the multi-scatter build calls this
// half a million times and the allocations dominate otherwise.
function densitiesCPU(h, out) {
  const hh = h > 0 ? h : 0;
  out[0] = Math.exp(-hh / H_RAY);
  out[1] = Math.exp(-hh / H_MIE);
  out[2] = Math.max(0, 1 - Math.abs(h - 25) / 15);
  return out;
}

function raySphereNearCPU(ox, oy, oz, dx, dy, dz, rad) {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - rad * rad;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  const t1 = -b + s;
  if (t1 < 0) return -1;
  return t0 < 0 ? t1 : t0;
}

function raySphereFarCPU(ox, oy, oz, dx, dy, dz, rad) {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - rad * rad;
  const disc = b * b - c;
  if (disc < 0) return -1;
  return -b + Math.sqrt(disc);
}

const _d3 = [0, 0, 0];
const texCoordFromUnit = (x, n) => 0.5 / n + x * (1 - 1 / n);
const unitFromTexCoord = (u, n) => (u - 0.5 / n) / (1 - 1 / n);

/**
 * Transmittance + multi-scatter tables for one aerosol/Rayleigh configuration.
 * Cached by the Sky instance: five times of day means five builds for the whole
 * session, ~60 ms each, all at load or at a shot cut.
 */
class AtmosphereTables {
  constructor(rayleighScale, aerosolScale) {
    this.rayleighScale = rayleighScale;
    this.aerosolScale = aerosolScale;
    this.bR = BETA_R.map((v) => v * rayleighScale);
    this.bMs = BETA_M_S_EFF.map((v) => v * aerosolScale);
    this.bMe = BETA_M_E_EFF.map((v) => v * aerosolScale);
    this.bO = BETA_O.map((v) => v * rayleighScale);

    this.trans = new Float32Array(TRANS_W * TRANS_H * 3);
    this.ms = new Float32Array(MS_W * MS_H * 3);
    this._buildTransmittance();
    this._buildMultiScatter();
    this.transTexture = this._toTexture(this.trans, TRANS_W, TRANS_H);
    this.msTexture = this._toTexture(this.ms, MS_W, MS_H);
  }

  dispose() {
    this.transTexture.dispose();
    this.msTexture.dispose();
  }

  _toTexture(src, w, h) {
    // Half-float, not float: linear filtering of FloatType textures needs
    // OES_texture_float_linear, which is an extension. Half-float linear is core
    // in WebGL2 and 10 bits of mantissa is far more than a transmittance needs.
    const data = new Uint16Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = THREE.DataUtils.toHalfFloat(src[i * 3]);
      data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(src[i * 3 + 1]);
      data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(src[i * 3 + 2]);
      data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
    }
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  /** Optical depth along a ray, clipped at the ground. */
  _opticalDepth(r, mu, out) {
    const dx = Math.sqrt(Math.max(0, 1 - mu * mu));
    const dy = mu;
    let tMax = raySphereFarCPU(0, r, 0, dx, dy, 0, RA);
    const tG = raySphereNearCPU(0, r, 0, dx, dy, 0, RG);
    if (tG > 0) tMax = Math.min(tMax, tG);
    if (!(tMax > 0)) { out[0] = out[1] = out[2] = 0; return out; }
    const N = 40;
    let odR = 0;
    let odM = 0;
    let odO = 0;
    const d3 = _d3;
    for (let i = 0; i < N; i++) {
      const f0 = i / N;
      const f1 = (i + 1) / N;
      const s0 = tMax * f0 * f0;
      const s1 = tMax * f1 * f1;
      const ds = s1 - s0;
      const s = 0.5 * (s0 + s1);
      const h = Math.hypot(dx * s, r + dy * s) - RG;
      densitiesCPU(h, d3);
      odR += d3[0] * ds;
      odM += d3[1] * ds;
      odO += d3[2] * ds;
    }
    for (let c = 0; c < 3; c++) out[c] = this.bR[c] * odR + this.bMe[c] * odM + this.bO[c] * odO;
    return out;
  }

  _buildTransmittance() {
    const H = Math.sqrt(RA * RA - RG * RG);
    const od = [0, 0, 0];
    for (let j = 0; j < TRANS_H; j++) {
      const xR = unitFromTexCoord((j + 0.5) / TRANS_H, TRANS_H);
      const rho = H * Math.min(Math.max(xR, 0), 1);
      const r = Math.sqrt(rho * rho + RG * RG);
      const muHorizon = -Math.sqrt(Math.max(0, 1 - (RG * RG) / (r * r)));
      for (let i = 0; i < TRANS_W; i++) {
        const xMu = unitFromTexCoord((i + 0.5) / TRANS_W, TRANS_W);
        const dMin = RA - r;
        const dMax = rho + H;
        const d = dMin + Math.min(Math.max(xMu, 0), 1) * (dMax - dMin);
        let mu = d === 0 ? 1 : (H * H - rho * rho - d * d) / (2 * r * d);
        mu = Math.min(1, Math.max(-1, mu));
        // Rays that dive into the planet are clamped to the horizon; the shader
        // multiplies by a separate soft terminator so nothing snaps.
        mu = Math.max(mu, muHorizon + 1e-5);
        this._opticalDepth(r, mu, od);
        const k = (j * TRANS_W + i) * 3;
        for (let c = 0; c < 3; c++) this.trans[k + c] = Math.exp(-od[c]);
      }
    }
  }

  /** Bilinear transmittance lookup, matching the shader's parameterisation. */
  sampleTransmittance(r, mu, out) {
    const H = Math.sqrt(Math.max(RA * RA - RG * RG, 0));
    const rho = Math.sqrt(Math.max((r - RG) * (r + RG), 0));
    const disc = r * r * (mu * mu - 1) + RA * RA;
    const d = Math.max(0, -r * mu + Math.sqrt(Math.max(disc, 0)));
    const dMin = RA - r;
    const dMax = rho + H;
    const u = texCoordFromUnit(Math.min(1, Math.max(0, (d - dMin) / Math.max(dMax - dMin, 1e-4))), TRANS_W);
    const v = texCoordFromUnit(Math.min(1, Math.max(0, rho / H)), TRANS_H);
    return bilinear(this.trans, TRANS_W, TRANS_H, u, v, out);
  }

  samplePsi(r, muS, out) {
    const u = texCoordFromUnit(Math.min(1, Math.max(0, muS * 0.5 + 0.5)), MS_W);
    const v = texCoordFromUnit(Math.min(1, Math.max(0, (r - RG) / (RA - RG))), MS_H);
    return bilinear(this.ms, MS_W, MS_H, u, v, out);
  }

  /** Sun transmittance with the same soft terminator the shader applies. */
  lightTransmittance(r, muL, out) {
    const muHorizon = -Math.sqrt(Math.max(0, 1 - (RG * RG) / (r * r)));
    const t = (muL - (muHorizon - 0.0045)) / 0.009;
    const s = Math.min(1, Math.max(0, t));
    const shadow = s * s * (3 - 2 * s);
    if (shadow <= 0) { out[0] = out[1] = out[2] = 0; return out; }
    this.sampleTransmittance(r, Math.max(muL, muHorizon + 1e-4), out);
    for (let c = 0; c < 3; c++) out[c] *= shadow;
    return out;
  }

  /**
   * Hillaire's multi-scatter table. For each (altitude, sun angle) the second
   * scattering order is integrated over the full sphere of directions with an
   * isotropic phase, alongside `f_ms`, the fraction of an isotropic unit field
   * that scatters once more. The remaining orders are the geometric series
   * `1/(1 - f_ms)`; ground albedo enters both integrals, which is how sand
   * bounce ends up in the sky.
   */
  _buildMultiScatter() {
    const N = 32;
    const dirs = [];
    // Fibonacci sphere: low discrepancy, no pole clustering, 32 samples is
    // plenty for a term this smooth.
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (2 * i + 1) / N;
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const th = ga * i;
      dirs.push([Math.cos(th) * rad, y, Math.sin(th) * rad]);
    }
    const tmp = [0, 0, 0];
    const L2 = [0, 0, 0];
    const fms = [0, 0, 0];

    for (let j = 0; j < MS_H; j++) {
      const yUnit = unitFromTexCoord((j + 0.5) / MS_H, MS_H);
      const r0 = RG + Math.min(1, Math.max(0, yUnit)) * (RA - RG) + 1e-3;
      for (let i = 0; i < MS_W; i++) {
        const xUnit = unitFromTexCoord((i + 0.5) / MS_W, MS_W);
        const muS = Math.min(1, Math.max(-1, xUnit * 2 - 1));
        const sun = [Math.sqrt(Math.max(0, 1 - muS * muS)), muS, 0];

        L2[0] = L2[1] = L2[2] = 0;
        fms[0] = fms[1] = fms[2] = 0;

        for (const w of dirs) {
          let tMax = raySphereFarCPU(0, r0, 0, w[0], w[1], w[2], RA);
          const tG = raySphereNearCPU(0, r0, 0, w[0], w[1], w[2], RG);
          const hitsGround = tG > 0;
          if (hitsGround) tMax = tG;
          if (!(tMax > 0)) continue;

          const Tv = [1, 1, 1];
          const STEPS = 16;
          for (let k = 0; k < STEPS; k++) {
            const f0 = k / STEPS;
            const f1 = (k + 1) / STEPS;
            const s0 = tMax * f0 * f0;
            const s1 = tMax * f1 * f1;
            const ds = s1 - s0;
            if (ds <= 0) continue;
            const s = 0.5 * (s0 + s1);
            const px = w[0] * s;
            const py = r0 + w[1] * s;
            const pz = w[2] * s;
            const r = Math.hypot(px, py, pz);
            densitiesCPU(r - RG, _d3);
            const dR = _d3[0];
            const dM = _d3[1];
            const dO = _d3[2];
            const muL = (px * sun[0] + py * sun[1] + pz * sun[2]) / r;
            this.lightTransmittance(r, muL, tmp);
            for (let c = 0; c < 3; c++) {
              const sS = this.bR[c] * dR + this.bMs[c] * dM;
              const sE = Math.max(this.bR[c] * dR + this.bMe[c] * dM + this.bO[c] * dO, 1e-9);
              const step = Math.exp(-sE * ds);
              // Isotropic phase for both integrals: 1/4pi for the lit term,
              // unity for the transfer term (the phase integrates to 1).
              const lit = sS * tmp[c] * (1 / (4 * Math.PI));
              L2[c] += (Tv[c] * (lit - lit * step)) / sE;
              fms[c] += (Tv[c] * (sS - sS * step)) / sE;
              Tv[c] *= step;
            }
          }

          if (hitsGround) {
            const px = w[0] * tMax;
            const py = r0 + w[1] * tMax;
            const pz = w[2] * tMax;
            const r = Math.hypot(px, py, pz);
            const muL = (px * sun[0] + py * sun[1] + pz * sun[2]) / r;
            this.lightTransmittance(RG, muL, tmp);
            for (let c = 0; c < 3; c++) {
              L2[c] += Tv[c] * GROUND_ALBEDO[c] * Math.max(0, muL) * tmp[c] / Math.PI;
              fms[c] += Tv[c] * GROUND_ALBEDO[c];
            }
          }
        }

        const k = (j * MS_W + i) * 3;
        for (let c = 0; c < 3; c++) {
          const avgL = L2[c] / N;
          const avgF = Math.min(fms[c] / N, 0.92);
          this.ms[k + c] = avgL / (1 - avgF);
        }
      }
    }
  }
}

function bilinear(src, w, h, u, v, out) {
  const x = u * w - 0.5;
  const y = v * h - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const cx0 = Math.min(w - 1, Math.max(0, x0));
  const cx1 = Math.min(w - 1, Math.max(0, x0 + 1));
  const cy0 = Math.min(h - 1, Math.max(0, y0));
  const cy1 = Math.min(h - 1, Math.max(0, y0 + 1));
  for (let c = 0; c < 3; c++) {
    const a = src[(cy0 * w + cx0) * 3 + c];
    const b = src[(cy0 * w + cx1) * 3 + c];
    const d = src[(cy1 * w + cx0) * 3 + c];
    const e = src[(cy1 * w + cx1) * 3 + c];
    out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
  }
  return out;
}

// ---------------------------------------------------------------------------

export class Sky {
  constructor() {
    this._tableCache = new Map();
    this._tables = this._tablesFor(1.0, 1.0);

    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        uTransLUT: { value: this._tables.transTexture },
        uMsLUT: { value: this._tables.msTexture },
        uSunDirection: { value: new THREE.Vector3(0.3, 0.4, -0.8).normalize() },
        uMoonDirection: { value: new THREE.Vector3(0.3, 0.6, 0.7).normalize() },
        uMoonIntensity: { value: 0.0 },
        uRayleigh: { value: 1.9 },
        uTurbidity: { value: 3.8 },
        uMieCoefficient: { value: 0.0058 },
        uMieDirectionalG: { value: 0.80 },
        uSunTint: { value: new THREE.Vector3(1, 1, 1) },
        uSkyIntensity: { value: 1.0 },
        uNight: { value: 0.0 },
        uTime: { value: 0.0 },
        // uSunIrradiance * uSkyExposure * SKY_SCALE == the TOA irradiance the
        // dome integrates against. Held equal to E_TOA * SKY_GAIN.
        uSkyExposure: { value: (E_TOA * SKY_GAIN) / (20.0 * SKY_SCALE) },
        uSunDiscScale: { value: 1.0 },
        uCamAltitude: { value: 400.0 },
        uSunIrradiance: { value: 20.0 },
        uRayleighScale: { value: 1.0 },
        uAerosolScale: { value: 1.0 },
        uMoonPhaseAngle: { value: 0.6 },
        uStarIntensity: { value: 1.0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), this.material);
    this.mesh.frustumCulled = false;
    // Drawn after the opaque terrain so early-Z rejects the covered pixels.
    this.mesh.renderOrder = 900;
    this.mesh.matrixAutoUpdate = true;

    this.sunDirection = this.material.uniforms.uSunDirection.value;
    this.moonDirection = this.material.uniforms.uMoonDirection.value;
    /** Published for Lighting: the moon as a light source. */
    this.moon = {
      direction: this.moonDirection,
      phaseAngle: 0.6,
      illuminatedFraction: 0.82,
      angularRadius: MOON_ANGULAR_RADIUS,
      irradiance: new THREE.Color(0, 0, 0),
    };
    this.night = 0;
    this._camAltitudeKm = 0.4;
    this._scratch = [0, 0, 0];
    this._scratch2 = [0, 0, 0];
    this._scratch3 = [0, 0, 0];

    this._refresh();
  }

  /**
   * Tables for one atmosphere configuration, cached.
   *
   * The key is quantised because a build costs ~120 ms: a continuous
   * time-of-day sweep quantised to 3 decimals would rebuild every frame and
   * leak a texture pair per step. At these step sizes the difference between
   * neighbouring entries is well under a quantisation level of the output.
   */
  _tablesFor(rayleighScale, aerosolScale) {
    const key = `${rayleighScale.toFixed(2)}|${aerosolScale.toFixed(2)}`;
    let t = this._tableCache.get(key);
    if (!t) {
      t = new AtmosphereTables(rayleighScale, aerosolScale);
      if (this._tableCache.size >= 16) {
        const oldest = this._tableCache.keys().next().value;
        if (oldest !== this._activeKey) {
          this._tableCache.get(oldest).dispose();
          this._tableCache.delete(oldest);
        }
      }
      this._tableCache.set(key, t);
    }
    this._activeKey = key;
    return t;
  }

  /**
   * Update from an ArtDirection time-of-day preset plus computed directions.
   *
   * The preset's `rayleigh` is a Preetham-era fudge with no physical meaning, so
   * it is only allowed a +/-10% nudge — letting it through raw would make noon
   * (rayleigh 1.35) a *less* blue sky than dusk, which is backwards. Turbidity
   * and the Mie coefficient drive the aerosol load, which is the parameter that
   * actually is art-directable: clean at noon, thick and dusty at dusk.
   */
  apply(preset, sunDirection, moonDirection, night) {
    const u = this.material.uniforms;
    if (sunDirection) u.uSunDirection.value.copy(sunDirection).normalize();
    if (moonDirection) u.uMoonDirection.value.copy(moonDirection).normalize();
    u.uRayleigh.value = preset.rayleigh;
    u.uTurbidity.value = preset.skyTurbidity;
    u.uMieCoefficient.value = preset.mieCoefficient;
    u.uMieDirectionalG.value = Math.min(preset.mieDirectionalG, 0.82);
    this.night = night ?? 0;
    u.uNight.value = this.night;

    const rayleighScale = quantise(0.9 + 0.1 * (preset.rayleigh / 1.9), 0.02);
    // The Mie coefficient spans 2.6x across the presets, which as a linear
    // aerosol load makes dusk essentially opaque; the 0.6 power compresses it to
    // something a desert actually does between clean midday and a dusty evening.
    const aerosolScale = quantise(
      Math.min(3.0, Math.max(0.3,
        Math.pow(preset.mieCoefficient / 0.0058, 0.6) * (0.46 + 0.125 * preset.skyTurbidity))),
      0.05,
    );
    u.uRayleighScale.value = rayleighScale;
    u.uAerosolScale.value = aerosolScale;

    const tables = this._tablesFor(rayleighScale, aerosolScale);
    if (tables !== this._tables) {
      this._tables = tables;
      u.uTransLUT.value = tables.transTexture;
      u.uMsLUT.value = tables.msTexture;
    }

    u.uSkyIntensity.value = 1.0;
    this._refresh();
  }

  /** Recompute the moon phase/irradiance and the published derived values. */
  _refresh() {
    const u = this.material.uniforms;
    const sun = u.uSunDirection.value;
    const moon = u.uMoonDirection.value;

    // Phase angle is real geometry: the Sun-Moon elongation as seen from here.
    const elong = Math.acos(THREE.MathUtils.clamp(sun.dot(moon), -1, 1));
    const alpha = Math.PI - elong; // 0 = full moon
    u.uMoonPhaseAngle.value = alpha;
    this.moon.phaseAngle = alpha;
    this.moon.illuminatedFraction = 0.5 * (1 + Math.cos(alpha));

    // Lommel-Seeliger sphere phase law, normalised to 1 at full, plus a modest
    // opposition surge. Quarter moon lands near 0.2 of full, which is the
    // observed ratio once shadow-hiding is accounted for.
    const ls = ((1 - alpha / Math.PI) * Math.cos(alpha) + Math.sin(alpha) / Math.PI) / (2 / 3);
    const surge = 1 + 0.35 * Math.exp(-alpha / 0.12);
    const phaseF = Math.max(0, ls) * surge / 1.35;

    const moonE = E_TOA * MOON_FULL_FRACTION * phaseF * (this.night > 0 ? 1 : 0);
    // uMoonIntensity lives in the same units as uSunIrradiance (20 == the sun),
    // so the shader's `u * uSkyExposure * SKY_SCALE` gives the moon's TOA
    // irradiance carrying exactly the same artistic gain as the sun's.
    u.uMoonIntensity.value = (20.0 * moonE) / E_TOA;
    u.uStarIntensity.value = 1.0;

    const t = this._scratch;
    const r = RG + this._camAltitudeKm;
    this._tables.lightTransmittance(r, sun.y, t);
    this._sunIrr = [E_TOA * t[0], E_TOA * t[1], E_TOA * t[2]];
    this._tables.lightTransmittance(r, moon.y, t);
    this._moonIrr = [moonE * t[0] * MOON_TINT[0], moonE * t[1] * MOON_TINT[1], moonE * t[2] * MOON_TINT[2]];
    this.moon.irradiance.setRGB(this._moonIrr[0], this._moonIrr[1], this._moonIrr[2], THREE.LinearSRGBColorSpace);
  }

  // -------------------------------------------------------------------------
  // Query API. Lighting.js and the volumetrics pass read these; they are the
  // same physics the dome is drawn with, so a hazy ridge and a lit ridge agree.
  // -------------------------------------------------------------------------

  /**
   * Scene-linear radiance looking along `dir`, excluding the sun and moon discs
   * (they are DirectionalLights; leaving them in would double-count).
   */
  radianceInDirection(dir, target) {
    const out = target ?? new THREE.Color();
    const c = this._march(dir.x, dir.y, dir.z, this._scratch2);
    return out.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
  }

  /** Direct solar irradiance reaching the camera altitude, renderer units. */
  sunIrradiance(target) {
    const out = target ?? new THREE.Color();
    const s = this._sunIrr;
    return out.setRGB(s[0], s[1], s[2], THREE.LinearSRGBColorSpace);
  }

  /** Direct lunar irradiance, same units. Zero when the moon term is off. */
  moonIrradiance(target) {
    const out = target ?? new THREE.Color();
    const m = this._moonIrr;
    return out.setRGB(m[0], m[1], m[2], THREE.LinearSRGBColorSpace);
  }

  /** Whichever of sun/moon is actually the key light right now. */
  keyIrradiance(target) {
    return this.night > 0.5 ? this.moonIrradiance(target) : this.sunIrradiance(target);
  }

  /** Rec.709 luminance of the zenith, scene-linear. */
  zenithLuminance() {
    const c = this._march(0, 1, 0, this._scratch2);
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  /**
   * Cosine-weighted sky irradiance on a surface with the given normal — the
   * ambient term, integrated the same way the PMREM cube integrates it.
   */
  skyIrradiance(normal, target) {
    const n = normal ?? { x: 0, y: 1, z: 0 };
    const out = target ?? new THREE.Color();
    // Fibonacci hemisphere around n, cosine weighted by construction.
    const up = Math.abs(n.y) < 0.95 ? [0, 1, 0] : [1, 0, 0];
    const tx = normalize3([up[1] * n.z - up[2] * n.y, up[2] * n.x - up[0] * n.z, up[0] * n.y - up[1] * n.x]);
    const ty = [n.y * tx[2] - n.z * tx[1], n.z * tx[0] - n.x * tx[2], n.x * tx[1] - n.y * tx[0]];
    const N = 48;
    const ga = Math.PI * (3 - Math.sqrt(5));
    const acc = [0, 0, 0];
    const c = this._scratch2;
    for (let i = 0; i < N; i++) {
      const r = Math.sqrt((i + 0.5) / N);
      const th = ga * i;
      const x = r * Math.cos(th);
      const y = r * Math.sin(th);
      const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
      const dx = tx[0] * x + ty[0] * y + n.x * z;
      const dy = tx[1] * x + ty[1] * y + n.y * z;
      const dz = tx[2] * x + ty[2] * y + n.z * z;
      this._march(dx, dy, dz, c);
      for (let k = 0; k < 3; k++) acc[k] += c[k];
    }
    const w = Math.PI / N;
    return out.setRGB(acc[0] * w, acc[1] * w, acc[2] * w, THREE.LinearSRGBColorSpace);
  }

  /** View-ray transmittance to space along `dir` — for aerial perspective. */
  transmittance(dir, target) {
    const out = target ?? new THREE.Color();
    const d = normalize3([dir.x, dir.y, dir.z]);
    const t = this._scratch;
    this._tables.sampleTransmittance(RG + this._camAltitudeKm, d[1], t);
    return out.setRGB(t[0], t[1], t[2], THREE.LinearSRGBColorSpace);
  }

  /**
   * Aerial perspective along a *finite* view ray — the query the volumetrics
   * pass needs so distance haze converges to the sky instead of to an authored
   * `TIME_OF_DAY.fogColor` constant.
   *
   *   const { inscatter, transmittance } = sky.inscatterAlongRay(dir, metres);
   *   shaded = surfaceRadiance * transmittance + inscatter;
   *
   * `dir` is any object with x/y/z (need not be normalised); `distance` is in
   * SCENE METRES and is clamped to wherever the ray leaves the atmosphere or
   * hits the planet. Both results are scene-linear radiance/ratio in exactly the
   * units the dome is drawn in, computed by the same march against the same
   * transmittance and multi-scatter tables — so a ridge fading out and the sky
   * it fades into are the same numbers by construction, at any distance, in any
   * direction, at any time of day.
   *
   * As `distance` grows past the atmosphere this converges to
   * `radianceInDirection(dir)` with a transmittance of zero, which is the
   * property that makes the horizon join up. Cost is one 20-step CPU march with
   * two table taps per step: fine for a few hundred calls when the time of day
   * changes, not something to call per pixel per frame.
   *
   * Pass `out` (an object with `inscatter`/`transmittance` THREE.Color fields)
   * to avoid allocating; the same object is returned.
   */
  inscatterAlongRay(dir, distance, out) {
    const res = out ?? { inscatter: new THREE.Color(), transmittance: new THREE.Color() };
    const L = this._scratch2;
    const T = this._scratch3;
    this._march(dir.x, dir.y, dir.z, L, Math.max(0, (distance ?? 0) * 0.001), T);
    res.inscatter.setRGB(L[0], L[1], L[2], THREE.LinearSRGBColorSpace);
    res.transmittance.setRGB(T[0], T[1], T[2], THREE.LinearSRGBColorSpace);
    return res;
  }

  /**
   * CPU mirror of `marchSky`. Same tables, same steps, same numbers.
   *
   * `maxKm > 0` truncates the ray at that distance (aerial perspective); the lit
   * ground term is then skipped, because the ray stopped in mid-air rather than
   * on the planet. `outT`, if given, receives the view-ray transmittance over
   * the marched span.
   */
  _march(dx, dy, dz, out, maxKm, outT) {
    const n = normalize3([dx, dy, dz]);
    const T = this._tables;
    const u = this.material.uniforms;
    const E = u.uSunIrradiance.value * u.uSkyExposure.value * SKY_SCALE;
    const em = u.uMoonIntensity.value * u.uSkyExposure.value * SKY_SCALE;
    const Em = [em * MOON_TINT[0], em * MOON_TINT[1], em * MOON_TINT[2]];
    const doMoon = this.night > 0.001;
    const sun = u.uSunDirection.value;
    const moon = u.uMoonDirection.value;
    const mieG = THREE.MathUtils.clamp(u.uMieDirectionalG.value, 0.60, 0.84);

    const r0 = RG + this._camAltitudeKm;
    let tMax = raySphereFarCPU(0, r0, 0, n[0], n[1], n[2], RA);
    const tG = raySphereNearCPU(0, r0, 0, n[0], n[1], n[2], RG);
    if (tG > 0) tMax = tG;
    // A finite ray stops in mid-air: no ground term, and the step distribution
    // has to be renormalised onto the shorter span or the whole march collapses
    // into the first few metres.
    const truncated = maxKm > 0 && maxKm < tMax;
    if (truncated) tMax = maxKm;
    out[0] = out[1] = out[2] = 0;
    if (outT) outT[0] = outT[1] = outT[2] = 1;
    if (!(tMax > 0)) return out;

    const muSun = n[0] * sun.x + n[1] * sun.y + n[2] * sun.z;
    const pRs = (3 / (16 * Math.PI)) * (1 + muSun * muSun);
    const pMs = dustPhase(muSun, mieG);
    const muMoon = n[0] * moon.x + n[1] * moon.y + n[2] * moon.z;
    const pRm = (3 / (16 * Math.PI)) * (1 + muMoon * muMoon);
    const pMm = dustPhase(muMoon, mieG);
    const msTintS = msAnisotropy(muSun, msAnisotropyStrength(sun.y));
    const msTintM = msAnisotropy(muMoon, msAnisotropyStrength(moon.y));

    const Tv = [1, 1, 1];
    const tl = [0, 0, 0];
    const psi = [0, 0, 0];
    const STEPS = 20;
    for (let i = 0; i < STEPS; i++) {
      const f0 = i / STEPS;
      const f1 = (i + 1) / STEPS;
      const s0 = tMax * f0 * f0;
      const s1 = tMax * f1 * f1;
      const ds = s1 - s0;
      if (ds <= 0) continue;
      const s = 0.5 * (s0 + s1);
      const px = n[0] * s;
      const py = r0 + n[1] * s;
      const pz = n[2] * s;
      const r = Math.hypot(px, py, pz);
      densitiesCPU(r - RG, _d3);
      const dR = _d3[0];
      const dM = _d3[1];
      const dO = _d3[2];
      const ux = px / r;
      const uy = py / r;
      const uz = pz / r;

      const muS = ux * sun.x + uy * sun.y + uz * sun.z;
      T.lightTransmittance(r, muS, tl);
      T.samplePsi(r, muS, psi);
      const S = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const sr = T.bR[c] * dR;
        const sm = T.bMs[c] * dM;
        S[c] = ((sr * pRs + sm * pMs) * tl[c] + (sr + sm) * psi[c] * msTintS[c]) * E;
      }
      if (doMoon) {
        const muM = ux * moon.x + uy * moon.y + uz * moon.z;
        T.lightTransmittance(r, muM, tl);
        T.samplePsi(r, muM, psi);
        for (let c = 0; c < 3; c++) {
          const sr = T.bR[c] * dR;
          const sm = T.bMs[c] * dM;
          S[c] += ((sr * pRm + sm * pMm) * tl[c] + (sr + sm) * psi[c] * msTintM[c]) * Em[c];
        }
      }
      for (let c = 0; c < 3; c++) {
        const sE = Math.max(T.bR[c] * dR + T.bMe[c] * dM + T.bO[c] * dO, 1e-9);
        const step = Math.exp(-sE * ds);
        out[c] += (Tv[c] * (S[c] - S[c] * step)) / sE;
        Tv[c] *= step;
      }
    }

    if (outT) { outT[0] = Tv[0]; outT[1] = Tv[1]; outT[2] = Tv[2]; }

    if (tG > 0 && !truncated) {
      const px = n[0] * tG;
      const py = r0 + n[1] * tG;
      const pz = n[2] * tG;
      const r = Math.hypot(px, py, pz);
      const muS = (px * sun.x + py * sun.y + pz * sun.z) / r;
      T.lightTransmittance(RG, muS, tl);
      T.samplePsi(RG, muS, psi);
      for (let c = 0; c < 3; c++) {
        out[c] += Tv[c] * GROUND_ALBEDO[c] * (tl[c] * Math.max(muS, 0) / Math.PI + psi[c]) * E;
      }
      if (doMoon) {
        const muM = (px * moon.x + py * moon.y + pz * moon.z) / r;
        T.lightTransmittance(RG, muM, tl);
        T.samplePsi(RG, muM, psi);
        for (let c = 0; c < 3; c++) {
          out[c] += Tv[c] * GROUND_ALBEDO[c] * (tl[c] * Math.max(muM, 0) / Math.PI + psi[c]) * Em[c];
        }
      }
    }
    return out;
  }

  update(dt, camera, elapsed) {
    this.mesh.position.copy(camera.position);
    this.mesh.scale.setScalar(camera.far * 0.94);
    this.material.uniforms.uTime.value = elapsed;
    // 400 m is a plausible altitude for the Afghan highland; the camera's own
    // height rides on top of it so mountain-top views thin the air slightly.
    const alt = 400.0 + Math.max(0, camera.position.y);
    this.material.uniforms.uCamAltitude.value = alt;
    this._camAltitudeKm = alt * 0.001;
  }

  dispose() {
    for (const t of this._tableCache.values()) t.dispose();
    this._tableCache.clear();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

function hgPhase(mu, g) {
  const g2 = g * g;
  return (1 - g2) / (4 * Math.PI * Math.pow(Math.max(1 + g2 - 2 * g * mu, 1e-4), 1.5));
}

/** CPU mirror of the shader's `phaseDust`. */
function dustPhase(mu, g) {
  const gb = Math.min(0.80, Math.max(0.05, (g - DUST_TRUNC) / (1 - DUST_TRUNC)));
  return DUST_SPIKE_W * hgPhase(mu, DUST_SPIKE_G) + (1 - DUST_SPIKE_W) * hgPhase(mu, gb);
}

/** CPU mirrors of the shader's `msAnisotropy` / `msAnisotropyStrength`. */
function msAnisotropy(mu, s) {
  const x = Math.min(1, Math.max(0, (mu - MS_COOL_MU) / (MS_WARM_MU - MS_COOL_MU)));
  const t = 1 - x * x * (3 - 2 * x);
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const tint = MS_TINT_SOLAR[c] + (MS_TINT_ANTI[c] - MS_TINT_SOLAR[c]) * t;
    out[c] = 1 + (tint - 1) * s;
  }
  return out;
}

function msAnisotropyStrength(muY) {
  const x = Math.min(1, Math.max(0, (muY - 0.06) / 0.56));
  return MS_ANISO * (1 - x * x * (3 - 2 * x));
}

function normalize3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function quantise(v, step) {
  return Math.round(v / step) * step;
}
