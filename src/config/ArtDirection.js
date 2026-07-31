/**
 * ArtDirection — the single source of truth for the game's look.
 *
 * MGSV: The Phantom Pain (Fox Engine) reference notes that drive these numbers:
 *  - Afghanistan is a HIGH-KEY, low-saturation desert. Sun is brutal and near-white.
 *    Shadows are NOT black: they are lifted, cool, and full of bounced sky light.
 *  - Aerial perspective is extremely strong. Distant ridges wash to a pale dusty
 *    blue-grey within ~2km. This is the single biggest "AAA" tell.
 *  - The grade is a subtle split-tone: cool cyan-grey shadows, warm sand/khaki
 *    midtones, slightly desaturated near-white highlights. NOT the orange-teal
 *    blockbuster look — it is far more restrained and dusty.
 *  - Film response: gentle toe, long shoulder (ACES-like), never clipping to pure
 *    white on sand. Plus permanent light grain and a mild anamorphic-ish bloom.
 *
 * Everything here is data. Renderers, sky, terrain and post all read from it so a
 * single change re-tunes the whole game coherently.
 */

export const TAU = Math.PI * 2;

/** Named times of day. `sunAngle` is elevation in degrees, `sunAzimuth` in degrees. */
export const TIME_OF_DAY = {
  dawn: {
    sunElevation: 4.0,
    sunAzimuth: 96,
    sunColor: [1.0, 0.62, 0.36],
    sunIntensity: 3.6,
    skyTurbidity: 4.2,
    rayleigh: 2.6,
    mieCoefficient: 0.009,
    mieDirectionalG: 0.86,
    ambientColor: [0.36, 0.42, 0.58],
    ambientIntensity: 0.9,
    fogColor: [0.66, 0.62, 0.62],
    fogDensity: 0.000105,
    exposure: 0.78,
  },
  noon: {
    sunElevation: 68.0,
    sunAzimuth: 152,
    sunColor: [1.0, 0.955, 0.9],
    sunIntensity: 5.6,
    skyTurbidity: 3.1,
    rayleigh: 1.35,
    mieCoefficient: 0.0042,
    mieDirectionalG: 0.8,
    ambientColor: [0.45, 0.53, 0.68],
    ambientIntensity: 1.15,
    fogColor: [0.70, 0.735, 0.80],
    fogDensity: 0.000082,
    exposure: 0.66,
  },
  afternoon: {
    sunElevation: 27.0,
    sunAzimuth: 244,
    sunColor: [1.0, 0.87, 0.70],
    sunIntensity: 5.0,
    skyTurbidity: 3.8,
    rayleigh: 1.9,
    mieCoefficient: 0.0058,
    mieDirectionalG: 0.82,
    ambientColor: [0.40, 0.47, 0.63],
    ambientIntensity: 1.0,
    fogColor: [0.72, 0.70, 0.71],
    fogDensity: 0.000095,
    exposure: 0.70,
  },
  dusk: {
    sunElevation: 2.0,
    sunAzimuth: 268,
    sunColor: [1.0, 0.45, 0.20],
    sunIntensity: 3.2,
    skyTurbidity: 5.0,
    rayleigh: 3.1,
    mieCoefficient: 0.011,
    mieDirectionalG: 0.88,
    ambientColor: [0.30, 0.34, 0.52],
    ambientIntensity: 0.85,
    fogColor: [0.60, 0.52, 0.52],
    fogDensity: 0.000118,
    exposure: 0.82,
  },
  night: {
    sunElevation: -14.0,
    sunAzimuth: 300,
    sunColor: [0.42, 0.52, 0.78],
    sunIntensity: 0.55,
    skyTurbidity: 2.2,
    rayleigh: 0.9,
    mieCoefficient: 0.003,
    mieDirectionalG: 0.78,
    ambientColor: [0.16, 0.21, 0.36],
    ambientIntensity: 0.5,
    fogColor: [0.13, 0.16, 0.24],
    fogDensity: 0.00013,
    exposure: 1.10,
  },
};

/** Post-process / grade constants. */
export const GRADE = {
  // Split-tone. Restrained: MGSV is dusty, not neon.
  shadowTint: [0.86, 0.95, 1.06],
  midTint: [1.02, 1.0, 0.955],
  highlightTint: [1.0, 0.995, 0.985],
  saturation: 0.86,
  contrast: 1.06,
  lift: 0.012,
  // Bloom
  bloomStrength: 0.42,
  bloomRadius: 0.62,
  bloomThreshold: 0.92,
  // Grain / lens
  grainAmount: 0.036,
  vignette: 0.34,
  chromaticAberration: 0.0016,
  sharpen: 0.34,
};

/** Terrain / material palette (linear-space albedo). */
export const PALETTE = {
  sandLight: [0.62, 0.545, 0.425],
  sandDark: [0.44, 0.375, 0.28],
  rockLight: [0.42, 0.40, 0.365],
  rockDark: [0.24, 0.225, 0.205],
  rockRed: [0.40, 0.30, 0.225],
  grassDry: [0.44, 0.42, 0.245],
  concrete: [0.47, 0.465, 0.44],
  metalRust: [0.30, 0.185, 0.115],
  cloth: [0.30, 0.29, 0.23],
};

export const QUALITY = {
  shadowMapSize: 2048,
  cascadeCount: 4,
  shadowDistance: 420,
  terrainSize: 4096,
  viewDistance: 6000,
};
