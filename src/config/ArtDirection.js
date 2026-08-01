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
 *
 * ROUND 5 — `exposure` CHANGED MEANING. It is no longer the absolute exposure;
 * it is a dimensionless TRIM around an exposure the pipeline now derives from
 * this preset's own sun and sky irradiance (see RenderPipeline's
 * `_updateExposure` and GRADE.exposureKey / exposureAdapt). That is what makes
 * two shots at the same time of day expose identically instead of the
 * histogram deciding: round 4 printed flat sunlit sand 0.52 stops apart between
 * the gameplay and outpost framings, and printed the afternoon 0.58 stops
 * BRIGHTER than noon, which no sun elevation can produce.
 *
 * So these five numbers are now the only place the print says how each hour
 * should read relative to the others. Measured on the shipped frames, sunlit
 * sand lands at display Y 0.53 at noon and 0.44-0.51 in the afternoon — under
 * noon, as a 27 degree sun should be — and the night frame sits 1.6 stops under
 * the day. Raising one of these raises EVERY shot at that hour by exactly the
 * same amount, which is the whole point.
 */
export const TIME_OF_DAY = {
  dawn: {
    sunElevation: 4.0,
    sunAzimuth: 96,
    // Round 4 integration: 0.62/0.36 -> 0.68/0.46, for the same reason as dusk.
    sunColor: [1.0, 0.68, 0.46],
    sunIntensity: 6.1,
    skyTurbidity: 4.2,
    rayleigh: 2.6,
    mieCoefficient: 0.009,
    mieDirectionalG: 0.86,
    ambientColor: [0.36, 0.42, 0.58],
    ambientIntensity: 0.9,
    fogColor: [0.66, 0.62, 0.62],
    fogDensity: 0.000105,
    exposure: 0.68,
  },
  noon: {
    sunElevation: 68.0,
    sunAzimuth: 152,
    // Nudged warm in round 3 to hold red above blue at noon once the cloud
    // deck and the dust in-scatter were both pulled back: the shot's margin
    // had fallen to under three counts.
    // Round 4 integration: 0.938/0.852 -> 0.925/0.812. Noon is the one daylight
    // frame with a third of its area on clear blue sky, so it carries the least
    // warmth of the set; once the print's white balance came down to fix the
    // hazy frames, the noon frame fell to R-B +6.5, under the +8 floor. This
    // puts the warmth back on the beam, where it belongs, and only at noon.
    sunColor: [1.0, 0.915, 0.782],
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
    exposure: 1.12,
  },
  afternoon: {
    sunElevation: 27.0,
    sunAzimuth: 244,
    // Round 4 integration: was [1.0, 0.87, 0.70], R/B 1.43 — a ~3300 K beam at
    // 27 degrees of elevation, which is roughly two air masses too much
    // reddening. Multiplied into sand at R/B 1.46 it made sunlit ground
    // R/B 2.08, and every afternoon frame inherited it: vista measured mean
    // R-B +27.3 and outpost +26.4 against a +8..+18 target. 4800 K instead.
    sunColor: [1.0, 0.915, 0.795],
    sunIntensity: 8.5,
    skyTurbidity: 3.8,
    rayleigh: 1.9,
    mieCoefficient: 0.0058,
    mieDirectionalG: 0.82,
    ambientColor: [0.40, 0.47, 0.63],
    ambientIntensity: 1.0,
    fogColor: [0.72, 0.70, 0.71],
    fogDensity: 0.000095,
    exposure: 0.78,
  },
  dusk: {
    sunElevation: 2.0,
    sunAzimuth: 268,
    // Round 3: was [1.0, 0.45, 0.20]. A sun that saturated turned the whole
    // dusk frame into a sunset postcard — the ridge shot measured R151/B94,
    // which is the orange blockbuster grade this file rules out on line 10.
    // Round 4 integration: 0.56/0.34 -> 0.63/0.44. The ridge frame still came
    // back at mean R-B +47 with a bottom third crushed to black; a 2 degree sun
    // is genuinely red but this is a beam, not a filter over the whole image.
    sunColor: [1.0, 0.63, 0.44],
    sunIntensity: 5.4,
    skyTurbidity: 5.0,
    rayleigh: 3.1,
    mieCoefficient: 0.011,
    mieDirectionalG: 0.88,
    ambientColor: [0.30, 0.34, 0.52],
    ambientIntensity: 1.05,
    fogColor: [0.60, 0.52, 0.52],
    fogDensity: 0.000118,
    exposure: 0.55,
  },
  night: {
    sunElevation: -14.0,
    sunAzimuth: 300,
    sunColor: [0.46, 0.56, 0.82],
    // Round 4: 0.95 -> 2.9 with the exposure cut from 1.40 to 0.72. The night
    // frame spanned 0.66 stops end to end — sky 0.0410, a moonlit wall 0.0397,
    // that wall's own shadow face 0.0505 (brighter than its lit face) and open
    // ground 0.0549. Everything was the same value because a big exposure was
    // being used to lift a weak key, which lifts the fill by exactly as much.
    // Raising the moon and stopping down instead buys real moonlight: the same
    // wall now reads, and the sky sits under it instead of level with it.
    sunIntensity: 2.9,
    skyTurbidity: 2.2,
    rayleigh: 0.9,
    mieCoefficient: 0.003,
    mieDirectionalG: 0.78,
    ambientColor: [0.18, 0.24, 0.40],
    ambientIntensity: 0.28,
    fogColor: [0.13, 0.16, 0.24],
    fogDensity: 0.00013,
    exposure: 0.175,
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
  //
  // Round 4 pulled the mid warmth back hard (midTint R/B was 1.144, now 1.055).
  // The LUT had been authored against a bug: it was applied to linear light and
  // then sRGB-encoded, which crushed its effect, so every previous round
  // compensated by pushing the tint further. With the LUT now applied in the
  // display space it was written for, that compensation arrived at full
  // strength and vista measured R-B +40 — the orange-blockbuster look the top
  // of this file rules out. These are the values that land it back at +14.
  // Round 4: 0.940/0.980/1.060 -> 0.926/0.978/1.078, alongside widening the
  // band this tint is applied over (see buildGradeLUT). The scene-side fix
  // (a sky-coloured ambient) does the heavy lifting; this is the print.
  shadowTint: [0.926, 0.978, 1.078],
  // Round 4 integration: 1.028/0.975 -> 1.022/0.982. Ablated on the shipped
  // frames (grade off / white balance off / split tone off, same scene), the
  // vista's own pixels measure R-B +4.8 and the outpost's +7.9 — the LANDSCAPE
  // is already sitting inside the +8..+18 target. The print was adding +14 on
  // top of it. Trimming the two warm terms is therefore the only honest fix;
  // cooling the ground further would have made the scene itself wrong.
  // Round 5 integration: 1.022/0.982 -> 1.030/0.974. The scene got COOLER this
  // round on purpose — the sky dome is genuinely blue, the SH probe's gradient
  // was un-inverted so shaded faces now take sky rather than ground, and the
  // shadow band is filled with that sky. All three are correct and all three
  // cost red: the shipped daylight frames measured mean R-B ground +4.9,
  // gameplay +3.1, vista +7.2 against a +8..+18 target, i.e. three of four
  // below the floor. The mid band is where a desert frame lives, so the
  // recovery goes here and in `warmth`, not into the shadow tint (which is the
  // sky, and must stay cool) or the highlights (which are the sun, and must
  // stay near-white).
  midTint: [1.030, 1.000, 0.974],
  highlightTint: [1.015, 1.0, 0.975],
  // Round 3: saturation 0.90 -> 0.86 and lift 0.034 -> 0.050. The warmth fix
  // landed (every daylight frame now measures red above blue) but it landed
  // hot: the dusk frame came back at R151/B94, which is the orange blockbuster
  // look this file explicitly rules out, and its foreground was crushed to a
  // black silhouette. Desaturating and lifting pulls both back toward "dusty"
  // without touching the white balance that fixed the cast.
  saturation: 0.86,
  contrast: 1.12,
  lift: 0.050,
  /**
   * Shadow FILL, distinct from `lift`.
   *
   * `lift` moves the black point: it is a constant added everywhere and it is
   * what puts the darkest pixel in the frame at code 11-15 instead of 0. It
   * cannot fix the round-5 dusk problem, because the dusk frame has no blacks
   * to lift — measured on ridge.png, nothing at all sits below code 26 and
   * 11.2% of the frame sits in codes 26-31, right under the L=0.12 line. What
   * that needs is a bump in the LOW SHADOWS that leaves the black point where
   * it is, so this is gated off below code ~13 and tapered out by code ~107:
   * the toe keeps its measured black, the deep-shadow band comes up ~5 counts,
   * and midtone and highlight contrast are untouched.
   *
   * Simulated over all seven shipped frames before it was written: ridge
   * 11.21% -> 0.56% of frame below L=0.12, vista 0.34 -> 0.09, outpost
   * 1.56 -> 0.54, gameplay 20.12 -> 10.15, with min/p0.1% unchanged to a tenth
   * of a code on every one of them.
   */
  shadowFill: 0.020,
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
  // Round 5: f/4.5 -> f/16. At f/4.5 and a 2.1 m subject, a 29 mm lens puts
  // EVERYTHING beyond the hero under a 4 px circle of confusion — the whole
  // playable mid-ground of the gameplay shot, measured at 5.1 px of effective
  // edge width on the building roofline against the sky. Seven engineers'
  // geometry was being blurred away before it reached the screen. At f/16 the
  // hyperfocal distance of the same lens is 1.6 m, so a shot focused on a
  // subject at arm's length is sharp from a metre to infinity, and the only
  // defocus left in the frame is the ~1 px of far-field separation MGSV
  // actually uses. Shallow depth of field is a cutscene tool, not a gameplay one.
  fStop: 16,             // aperture for the depth-of-field solve
  sensorHeight: 0.024,   // metres; 35mm-format sensor, sets CoC -> pixels
  focusEdgeSoftness: 0.25, // extra CoC in the corners (field curvature), pixels
  // Tonemap (appended round 2). `whitePoint` is the linear value that maps to
  // display 1.0; nothing can exceed it, because everything above
  // whitePoint*shoulder is folded into the remaining headroom by a rational
  // curve that only reaches the ceiling asymptotically. Round 1 had neither
  // number, which is why the vista topped out at L=0.814 across two million
  // pixels while the outpost piled its highlights on hard white.
  whitePoint: 5.2,
  shoulder: 0.30,
  /**
   * How much chroma is pulled out of the highlights before the tonemap, as a
   * multiplier on smoothstep(0.75, 1.6, maxComponent) of the linear signal.
   * Film bleaches toward white at the shoulder; a tonemapper without this
   * drives hot pixels toward their dominant primary, which is why every
   * round-3 frame clipped in red (R 255) while blue never passed 243.
   */
  highlightDesat: 0.85,
  // Global white balance applied before the split tone. MGSV Afghanistan
  // daylight has red above blue in every frame; round 1 had blue above red in
  // every frame, and no per-band tint was ever going to fix that.
  // Round 4 integration: 1.058/0.905 (a 16.9% R-over-B tilt) -> 1.042/0.938
  // (11.1%). The scene-side white balance was fixed this round — the sky is
  // genuinely blue and the sun is no longer a 3300 K filter — so the print no
  // longer has to carry the warmth on its own, and at the old value it was
  // adding ~9 counts of R-B to a mid-grey before the split tone had run.
  // Round 5 integration: 1.034/0.950 (an 8.8% R-over-B tilt) -> 1.052/0.934
  // (12.6%). See `midTint` — the scene-side white balance moved cool this round
  // and the print has to take some of it back. Held well short of the round-3
  // value (16.9%) that produced the orange cast this file rules out.
  warmth: [1.052, 1.0, 0.934],
  /**
   * Depth-of-field ceilings, in pixels at 1080p (they scale with resolution).
   * These are the seatbelt behind `fStop`: whatever the autofocus locks onto,
   * the background can never smear more than `maxCoCFar` and the foreground
   * never more than `maxCoCNear`. `cocFloor` is the point below which defocus
   * is not defocus — anything under it skips the bokeh gather entirely, so a
   * sharp frame costs nothing and cannot be softened by accident.
   */
  maxCoCFar: 2.4,
  maxCoCNear: 1.2,
  cocFloor: 0.9,
  /**
   * Exposure. `exposureKey` is the linear, post-exposure value that SUNLIT
   * SAND is placed at; the pipeline derives the stop from the sun and sky
   * irradiance so that every shot at a given time of day is exposed
   * identically, and `TIME_OF_DAY[x].exposure` is the per-hour trim around it.
   *
   * `autoExposureStops` is all the authority the histogram has left, in stops
   * either side of that physical value. Round 4 gave it -1.00 to +0.77 and it
   * spent that budget putting two frames of the same afternoon 0.52 stops
   * apart on the same sand. It is a seatbelt now, not a grade.
   */
  exposureKey: 0.763,
  exposureRefRadiance: 1.652,
  exposureAdapt: 0.62,
  meterBias: 0.62,
  autoExposureStops: 0.02,
  /**
   * Where display white sits on the shoulder, as a fraction of `whitePoint`.
   * Below 1.0 the top of the curve is a finite, reachable value instead of an
   * asymptote — see `_refreshWhitePoint`. This is the difference between a
   * frame with the sun in it having some genuinely white pixels and a frame
   * whose brightest channel anywhere is 252.
   */
  whiteReach: 0.95,
};

/** Terrain / material palette (linear-space albedo). */
export const PALETTE = {
  // Round 4 integration: sand was R/B 1.46 (light) and 1.57 (dark). Multiplied
  // by an afternoon beam it put sunlit ground at R/B 1.84, and since mean R-B
  // in 8-bit scales with LEVEL as well as with chroma, the brightest surface in
  // the game was also the one contributing most of the frame's warmth — vista
  // and outpost measured +27 against a +8..+18 target. Afghan sand is a pale
  // grey-khaki; these are R/B 1.28 / 1.37, which is still unambiguously warm.
  sandLight: [0.60, 0.545, 0.470],
  sandDark: [0.43, 0.375, 0.315],
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
  // Round 4 integration: 0.295 -> 0.345 in blue, tracking PALETTE.sandLight.
  // This is the radiance the ground bounce fills every shaded surface with, so
  // leaving it at R/B 1.83 while the ground it models moved to 1.28 would put
  // the warm pedestal back into exactly the shade faces this round just fixed.
  groundAlbedo: [0.54, 0.44, 0.345],
  /**
   * How high the surrounding ridgelines sit above the local horizon, degrees.
   * In an Afghan valley this much of the "sky" hemisphere is actually sunlit
   * rock, and it is the single biggest reason a desert shadow reads dusty
   * rather than blue. sin^2 of this angle is the fraction of a horizontal
   * surface's ambient that comes from warm terrain instead of cold sky.
   *
   * Round 4: 33 -> 11. A horizontal surface only lost 30% of its fill to this,
   * but a VERTICAL one loses far more — a vertical cosine lobe is concentrated
   * at low elevations, so a 33 degree skyline is most of what an escarpment
   * flank can see. Measured on a grey sphere under the afternoon preset, the
   * flank turned away from the sun came back at hue 19 deg (warmer than the
   * sunlit flank at 32.7) with only 12.9 degrees between them. This is the
   * single biggest cause.
   */
  ridgeElevation: 11,
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
  //
  // Round 4: 0.40 -> 0.11. This term is added ISOTROPICALLY, i.e. it lands on
  // the sky directions too, so at 0.40 it was a warm pedestal sitting on top of
  // the blue dome: the noon zenith fill measured B/R 1.018 — dead neutral under
  // a clear blue sky. Interreflection is real but it is a few per cent of the
  // budget, not forty.
  groundCoupling: 0.11,
  /**
   * Reflectivity of the ground bounce as a whole. Sand does not return the
   * albedo of a lab swatch: it is rough, it self-shadows at the grain scale,
   * and half of what a wall sees below its horizon is the wall's own footing.
   */
  bounceStrength: 0.82,
  /**
   * Fraction of the landscape a shaded surface can see that is actually taking
   * the key, as `base + slope * sin(solarElevation)`. A rough landscape
   * shadows itself; at a 27 degree sun most of the terrain is turned away from
   * the sun too, so what bounces back is sky arriving twice, not sun arriving
   * once. Round 3 lit the whole ground hemisphere with the full key, which is
   * the second reason a shade face measured warmer than the sunlit one.
   */
  terrainLitBase: 0.24,
  terrainLitSlope: 0.62,
  /**
   * How far the ground has washed toward the sky's own colour by the time it
   * reaches the horizon. A vertical surface's ambient is roughly half sky and
   * half ground, and nearly all of that ground is far away — seen through
   * kilometres of the same dust that turns a distant ridge pale blue-grey. This
   * is what lets a wall in shade go cool while the sand under it stays khaki.
   */
  groundHaze: 0.62,
  /**
   * Target key:fill contrast in linear radiance, as (key + fill) / fill on a
   * horizontal surface.
   *
   * Round 4 re-derived these from the illuminance split rather than by eye. A
   * clear midday puts ~89% of the horizontal illuminance in the direct beam and
   * ~11% in the sky, which is 9:1; a dusty one is a little flatter. Near the
   * horizon the beam is attenuated by five air masses and the sky takes over,
   * which is ~3:1. Round 3's 5.2/2.6 was under a stop and a half of separation
   * at noon and delivered a frame with no dynamic range at all.
   */
  keyFillHigh: 8.6,
  // Round 5: 2.8 -> 1.6, and this is the fix for the crushed dusk/dawn frames
  // rather than anything in the print. The ramp above bottoms out at this value
  // for any sun below ~2.3 degrees, i.e. exactly the dusk and dawn presets, and
  // at 2.8 it was asserting that a 2 degree sun still delivers 64% of the
  // horizontal illuminance. It does not: the comment above sizes the horizon
  // case at five air masses, which is a 12 degree sun; at 2 degrees the beam
  // crosses more than thirty and the sky is unambiguously the dominant source.
  // Measured on ridge.png with 2.8, the shaded near hill — 15% of the dusk hero
  // frame — sat at mean display Y 0.090 with a standard deviation of 0.002: one
  // flat black value across every piece of geometry in the nearest quarter of
  // the picture, and 26% of the frame under L=0.12. This is a fill problem, and
  // lifting it with exposure instead would only have blown the sun side.
  keyFillLow: 1.6,
  keyFillNight: 3.6,
  /**
   * Width, in N.L, of the shading-normal terminator roll-in on the key light.
   * max(0, N.L) is a kink, and on a coarse mesh the entire lit-to-shade
   * transition collapses into the two pixels where it crosses zero — measured
   * on ridge.png at y=330: 114 luminance codes across 4 pixels. A sun with a
   * real angular diameter, seen against an interpolated normal, rolls in over
   * a band; this is that band.
   */
  terminatorWidth: 0.12,
  /**
   * Angular diameter of the effective light source, radians. Much larger than
   * the true 0.53 deg sun because the circumsolar aureole in a dusty sky is
   * what actually sets the penumbra width you can see.
   */
  sunAngularSize: 0.036,
  moonAngularSize: 0.014,
  /**
   * Cloud shadows: the volumetric pass's own weather field projected onto the
   * landscape along the sun. These are fallbacks — when the volumetrics module
   * is installed, the deck altitude and the coverage are read from ITS
   * per-time-of-day numbers so the shadow and the cloud cannot disagree.
   */
  cloudDeck: 1800,
  cloudCoverage: 0.30,
  // Round 4: 0.55 -> 0.92. At half strength the patches read as a soft grade
  // rather than as cloud, and MGSV's valleys are dramatic precisely because a
  // passing deck takes the key off the ground almost completely.
  cloudShadowStrength: 0.92,
  /**
   * Optical depth of the deck at which the ground starts to lose the sun. Lower
   * puts more of the valley floor under shade; this is the one knob that sets
   * what fraction of the landscape is in cloud shadow at a given coverage.
   * Swept against the vista framing: 0.30 leaves 2% of the valley floor in
   * shade, 0.14 leaves 32%, 0.06 leaves 63%.
   */
  cloudShadowBias: 0.14,
  // The volumetric weather map wraps over 46 km; this is its uv scale in 1/m.
  // Round 3 sampled a private value-noise field at ~385 m cells, so the shade
  // on the ground belonged to no cloud in the sky.
  cloudScale: 1 / 46000,
  cloudSpeed: [9.0, 3.5],
  /** Specular-only IBL weight once the diffuse comes from the light probe. */
  specularIBL: 1.0,
};
