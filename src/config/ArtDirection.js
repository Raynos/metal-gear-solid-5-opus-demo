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

/**
 * Named times of day. `sunAngle` is elevation in degrees, `sunAzimuth` in degrees.
 *
 * Round 2: the daylight `sunIntensity` values were all raised by 1.7x. They had
 * been set against a constant ambient; once the ambient became a real projection
 * of the sky dome, the honest key:fill calibration needed the sky irradiance
 * scaled down by ~4x to reach two stops of shadow contrast, which is another way
 * of saying the sun was four times too weak for the sky it was standing under.
 * Raising the sun instead of only cutting the fill also pulls the sky out of the
 * blown-white it sat in: the scene brightens, auto-exposure stops down, and the
 * dome comes back into the shoulder where its cloud modelling is readable.
 */
export const TIME_OF_DAY = {
  dawn: {
    sunElevation: 4.0,
    sunAzimuth: 96,
    sunColor: [1.0, 0.62, 0.36],
    sunIntensity: 6.1,
    skyTurbidity: 4.2,
    rayleigh: 2.6,
    mieCoefficient: 0.009,
    mieDirectionalG: 0.86,
    ambientColor: [0.36, 0.42, 0.58],
    ambientIntensity: 0.9,
    fogColor: [0.66, 0.62, 0.62],
    fogDensity: 0.000105,
    exposure: 1.00,
  },
  noon: {
    sunElevation: 68.0,
    sunAzimuth: 152,
    // Nudged warm in round 3 to hold red above blue at noon once the cloud
    // deck and the dust in-scatter were both pulled back: the shot's margin
    // had fallen to under three counts.
    sunColor: [1.0, 0.938, 0.852],
    sunIntensity: 9.5,
    // Afghan noon is DUSTY, not alpine. Round 1's clean low-turbidity blue was
    // the last daylight frame still measuring blue above red; raising the
    // aerosol load whitens the dome and warms the sky-derived ambient with it.
    skyTurbidity: 4.6,
    rayleigh: 1.55,
    mieCoefficient: 0.0072,
    mieDirectionalG: 0.8,
    ambientColor: [0.45, 0.53, 0.68],
    ambientIntensity: 1.15,
    fogColor: [0.70, 0.735, 0.80],
    fogDensity: 0.000082,
    exposure: 0.74,
  },
  afternoon: {
    sunElevation: 27.0,
    sunAzimuth: 244,
    sunColor: [1.0, 0.87, 0.70],
    sunIntensity: 8.5,
    skyTurbidity: 3.8,
    rayleigh: 1.9,
    mieCoefficient: 0.0058,
    mieDirectionalG: 0.82,
    ambientColor: [0.40, 0.47, 0.63],
    ambientIntensity: 1.0,
    fogColor: [0.72, 0.70, 0.71],
    fogDensity: 0.000095,
    exposure: 0.95,
  },
  dusk: {
    sunElevation: 2.0,
    sunAzimuth: 268,
    // Round 3: was [1.0, 0.45, 0.20]. A sun that saturated turned the whole
    // dusk frame into a sunset postcard — the ridge shot measured R151/B94,
    // which is the orange blockbuster grade this file rules out on line 10.
    sunColor: [1.0, 0.56, 0.34],
    sunIntensity: 5.4,
    skyTurbidity: 5.0,
    rayleigh: 3.1,
    mieCoefficient: 0.011,
    mieDirectionalG: 0.88,
    ambientColor: [0.30, 0.34, 0.52],
    ambientIntensity: 1.05,
    fogColor: [0.60, 0.52, 0.52],
    fogDensity: 0.000118,
    exposure: 1.00,
  },
  night: {
    sunElevation: -14.0,
    sunAzimuth: 300,
    sunColor: [0.46, 0.56, 0.82],
    sunIntensity: 0.95,
    skyTurbidity: 2.2,
    rayleigh: 0.9,
    mieCoefficient: 0.003,
    mieDirectionalG: 0.78,
    ambientColor: [0.18, 0.24, 0.40],
    ambientIntensity: 1.0,
    fogColor: [0.13, 0.16, 0.24],
    fogDensity: 0.00013,
    exposure: 1.40,
  },
};

/** Post-process / grade constants. */
export const GRADE = {
  // Split-tone. Restrained: MGSV is dusty, not neon.
  //
  // Round 3 pushed the shadow band's blue/red ratio from 1.115 to 1.17 and the
  // mid band's warmth up to match. Measured on the shipped frames, a cast
  // shadow on sunlit sand was landing at B/R 1.00 — dead neutral. The target is
  // 1.10-1.20: a shadow that is visibly filled by sky against a lit surface at
  // B/R 0.60. The extra mid warmth is there so cooling a fifth of the pixels
  // does not cost the frame its measured red-over-blue.
  shadowTint: [0.922, 0.976, 1.078],
  midTint: [1.055, 1.002, 0.922],
  highlightTint: [1.030, 1.0, 0.950],
  // Round 3: saturation 0.90 -> 0.86 and lift 0.034 -> 0.050. The warmth fix
  // landed (every daylight frame now measures red above blue) but it landed
  // hot: the dusk frame came back at R151/B94, which is the orange blockbuster
  // look this file explicitly rules out, and its foreground was crushed to a
  // black silhouette. Desaturating and lifting pulls both back toward "dusty"
  // without touching the white balance that fixed the cast.
  saturation: 0.86,
  contrast: 1.12,
  lift: 0.050,
  // Bloom
  bloomStrength: 0.28,
  bloomRadius: 0.62,
  bloomThreshold: 1.15,
  // Grain / lens
  grainAmount: 0.036,
  vignette: 0.26,
  chromaticAberration: 0.0016,
  sharpen: 0.22,
  // Photographic finish (appended)
  anamorphic: 0.10,      // horizontal streak off the bright pass
  lensDirt: 0.10,        // veiling glare through the front-element dirt map
  barrel: 0.035,         // barrel distortion; perfectly rectilinear reads as CG
  // f/2.4 is a portrait aperture. Once the gameplay camera moved to a real
  // over-the-shoulder rig its subject sat at 2.4 m, and at f/2.4 that threw the
  // entire outpost behind him into a tilt-shift blur — the shot stopped being
  // gameplay and became a product photograph. f/4.5 keeps the separation and
  // leaves the scene readable; the landscape shots focus past 100 m and are
  // unaffected either way.
  fStop: 4.5,            // aperture for the depth-of-field solve
  sensorHeight: 0.024,   // metres; 35mm-format sensor, sets CoC -> pixels
  focusEdgeSoftness: 1.2, // extra CoC in the corners (field curvature), pixels
  // Tonemap (appended round 2). `whitePoint` is the linear value that maps to
  // display 1.0; nothing can exceed it, because everything above
  // whitePoint*shoulder is folded into the remaining headroom by a rational
  // curve that only reaches the ceiling asymptotically. Round 1 had neither
  // number, which is why the vista topped out at L=0.814 across two million
  // pixels while the outpost piled its highlights on hard white.
  whitePoint: 5.2,
  shoulder: 0.30,
  // Global white balance applied before the split tone. MGSV Afghanistan
  // daylight has red above blue in every frame; round 1 had blue above red in
  // every frame, and no per-band tint was ever going to fix that.
  warmth: [1.058, 1.0, 0.905],
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
  cascadeCount: 3,
  shadowDistance: 380,
  terrainSize: 4096,
  viewDistance: 6000,
};

/**
 * Light transport (appended round 2).
 *
 * Round 1 lit the scene with a constant ambient colour, which is why its cast
 * shadows measured 48:1 under key and rendered navy under a white sky. The
 * ambient is now the sky dome projected into L2 spherical harmonics, so the
 * shadow colour IS the sky colour by construction. These are the knobs that
 * shape that projection.
 */
export const LIGHT_TRANSPORT = {
  /**
   * Effective diffuse albedo of the landscape, linear. Sand plus gravel plus
   * rock, warm-tilted. Drives the ground-bounce radiance that fills undersides.
   */
  groundAlbedo: [0.54, 0.44, 0.295],
  /**
   * How high the surrounding ridgelines sit above the local horizon, degrees.
   * In an Afghan valley this much of the "sky" hemisphere is actually sunlit
   * rock, and it is the single biggest reason a desert shadow reads dusty
   * rather than blue. sin^2 of this angle is the fraction of a horizontal
   * surface's ambient that comes from warm terrain instead of cold sky.
   */
  ridgeElevation: 33,
  /**
   * Rough-ground interreflection. A flat Lambertian plane cannot see itself,
   * but sand and gravel have micro-relief and every point sees lit neighbours.
   * Adds a warm isotropic pedestal proportional to the ground's own radiance.
   * It also stands in for the rest of the sunlit environment a shaded point can
   * see — neighbouring dunes, walls, vehicles — all of which is warm. Measured
   * against the target: at 0.50 a noon cast shadow lands at B/R 1.17, at 0.34 it
   * lands at 1.39, which is the navy the critics flagged.
   */
  // Round 3: 0.50 -> 0.40. Measured on the shipped frames, a noon cast shadow
  // was landing at B/R 1.00 — neutral grey, not the cool sky-filled shadow the
  // target calls for. Less warm interreflection pedestal puts more of the fill
  // back on the sky, which is where the 1.10-1.20 band comes from.
  groundCoupling: 0.40,
  /**
   * Target key:fill contrast in linear radiance. A hazy desert midday is about
   * 5:1 (two stops); near the horizon the sky takes over and it flattens out.
   */
  keyFillHigh: 5.2,
  keyFillLow: 2.6,
  keyFillNight: 3.2,
  /**
   * Angular diameter of the effective light source, radians. Much larger than
   * the true 0.53 deg sun because the circumsolar aureole in a dusty sky is
   * what actually sets the penumbra width you can see.
   */
  sunAngularSize: 0.036,
  moonAngularSize: 0.014,
  /** Cloud shadows: a scrolling deck projected onto the landscape along the sun. */
  cloudDeck: 1600,
  cloudCoverage: 0.46,
  cloudShadowStrength: 0.55,
  // 1/scale is the size of one noise cell in metres: 0.0026 puts the base
  // octave at ~385 m, which lands three or four distinct patches across a
  // valley at this framing. The round-1-sized 1300 m cells simply put the whole
  // foreground in one shadow and read as a grading error.
  cloudScale: 0.0026,
  cloudSpeed: [9.0, 3.5],
  /** Specular-only IBL weight once the diffuse comes from the light probe. */
  specularIBL: 1.0,
};
