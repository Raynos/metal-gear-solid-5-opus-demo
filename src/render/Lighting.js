import * as THREE from 'three';
import { QUALITY, TIME_OF_DAY, LIGHT_TRANSPORT } from '../config/ArtDirection.js';
// Read-only: the cloud shadow has to be cast by the SAME weather field the
// volumetric pass renders, or a patch of shade on the ground belongs to no
// cloud in the sky. A namespace import so a rename over there degrades to
// "no cloud shadows" instead of a link error that takes the build down.
import * as VolNoise from './volumetrics/noise.js';

/**
 * Lighting — sun/moon, cascaded shadow maps, IBL, and the atmosphere numbers
 * that the post stack's aerial perspective is driven from.
 *
 * ## Cascaded shadow maps
 *
 * three.js gives one shadow map per light. A single 2048 map stretched over the
 * 240 m box we had before is ~12 cm per texel — mush at arm's length and a hard
 * cutoff at the box edge. So we run N DirectionalLights that share direction,
 * colour and intensity, each fitted to one slice of the view frustum, and pick
 * between them per fragment.
 *
 * Rather than patch every material (which would mean reaching into files owned
 * by other authors) we override the shared `lights_fragment_begin` and
 * `shadowmap_pars_fragment` chunks once, at module load. Everything that uses
 * the standard lighting path — terrain, rocks, characters, props — inherits
 * CSM with no changes on their side.
 *
 * Cascade selection needs no extra uniforms: cascades are nested and ordered
 * small-to-large, so a fragment belongs to the first cascade whose shadow
 * coordinate contains it. Weights are carried down the unrolled light loop and
 * cross-faded at the borders, so transitions are invisible instead of popping.
 *
 * The filter is PCSS: a 16-tap blocker search sizes the penumbra, then a 20-tap
 * Vogel disc filters at that size. Contact points stay razor sharp and the
 * shadow softens with distance from the caster, which is the entire read of a
 * low sun raking across a ridge.
 *
 * ## Ambient
 *
 * Diffuse ambient is a `LightProbe` carrying an L2 spherical-harmonic
 * projection of the sky dome plus the ground bounce (see `_computeSkySH`), NOT
 * a constant. The diffuse contribution of the environment cube is deliberately
 * removed from the shared `lights_fragment_maps` chunk so the two can never
 * double-count; the PMREM cube survives as specular IBL only. The practical
 * consequence is that a cast shadow's colour is the sky's colour by
 * construction — round 1 shipped a white sky casting navy shadows because the
 * two numbers lived in different files.
 *
 * The probe is *unoccluded* by construction, so on its own it lights the inside
 * of a crevice exactly as brightly as the open ground next to it. Two terms fix
 * that, both applied to the ambient and to nothing else:
 *
 *  - a half-resolution GTAO pass (`_renderAO`) whose result multiplies
 *    `irradiance` in `lights_fragment_maps`. It reads last frame's depth
 *    attachment out of the post stack, so it costs one extra fullscreen pass
 *    and no extra scene draw.
 *  - a sun-gated ground-bounce lobe. The lower half of the probe is the ground
 *    a surface sees *when that surface is in shadow* — which is its own
 *    footing, in its own shade. The extra bounce a surface standing in the sun
 *    gets is added back per fragment, weighted by the cascade shadow term, so
 *    a barrel in the open has a hot warm underside and the same barrel in a
 *    building's shade does not.
 *
 * NOTE for other authors: any *additional* shadow-casting DirectionalLight added
 * to the scene would be absorbed into this cascade scheme and misbehave. Use
 * SpotLight/PointLight for local shadowed lights; they are untouched.
 */

// ---------------------------------------------------------------------------
// Shader chunk overrides (installed once, before any material compiles)
// ---------------------------------------------------------------------------

/**
 * Cloud shadow at a world point.
 *
 * The receiver is projected up the sun ray onto the cloud deck and the deck is
 * sampled there, so the patches skew correctly under a low sun, stay locked to
 * the world as the camera moves, and keep working far beyond the last shadow
 * cascade (which is where they matter most).
 *
 * Round 3 sampled a private value-noise field at a private frequency, so the
 * shade on the ground was uncorrelated with the cloud you could see — a grading
 * error with a wind speed. This is the volumetric pass's own weather map, read
 * with the volumetric pass's own wrap scale, wind clock, streak squash and
 * coverage remap, so a shadow belongs to a cloud.
 *
 * ROUND 4: this is now evaluated ONCE per screen pixel in the AO pass and read
 * back out of that buffer's alpha, instead of four weather fetches in every lit
 * material. It is the same function on the same field — but it costs the
 * material one sampler fewer, and `terrain-L0` was sitting on exactly the 16
 * the driver allows, so the AO map had nowhere to go until this moved.
 */
const CLOUD_SHADOW_FN = /* glsl */ `
  //   uSkyCloudPan  : xy = weather-map uv pan, z = coverage, w = strength
  //   uSkyCloudDeck : x = deck base altitude (m), y = weather uv scale (1/m),
  //                   z = terminator softening width (in N.L),
  //                   w = cloud-shade threshold (the deck's optical depth at
  //                       which the ground starts to lose the sun)
  uniform vec4 uSkyCloudPan;
  uniform vec4 uSkyCloudDeck;
  uniform sampler2D uSkyCloudWeather;

  float csmCloudShadow( vec3 wp, vec3 L ) {
    if ( uSkyCloudPan.w <= 0.001 ) return 1.0;
    float t = ( uSkyCloudDeck.x - wp.y ) / max( L.y, 0.12 );
    vec2 w = ( wp.xz + L.xz * t ) * uSkyCloudDeck.y + uSkyCloudPan.xy;
    // The front: which airmass you are under. The volumetric pass's own
    // coverage lookup, verbatim, wrapping over the same 46 km.
    float base = texture2D( uSkyCloudWeather, w ).r;
    float streak = texture2D( uSkyCloudWeather, w * vec2( 0.55, 2.3 ) + 0.27 ).b;
    float front = clamp( ( base * 0.68 + streak * 0.32 - 0.26 ) / 0.60, 0.0, 1.0 );
    // Individual clouds. At a 46 km wrap the front alone says which airmass you
    // are under, not which cloud is over you, and a valley three kilometres
    // across sits inside a single weather cell. The volumetric pass breaks the
    // front into cumulus with a 3D shape volume at 2.6 km and 900 m; a
    // sampler3D is not available here, so this takes finer octaves of the SAME
    // weather field at the shape volume's own two periods. The patch scale on
    // the ground is then the patch scale in the sky, moving on the same wind,
    // thickening under the same front.
    float cell = texture2D( uSkyCloudWeather, w * 17.7 + 0.13 ).g * 0.62
               + texture2D( uSkyCloudWeather, w * 51.1 - 0.37 ).a * 0.38;
    float d = ( 0.45 + 0.55 * front ) * cell * uSkyCloudPan.z * 3.0;
    // A kilometre-wide occluder two kilometres up has an enormous penumbra, so
    // the transfer is deliberately soft — hard-edged cloud shade reads as a decal.
    float shade = smoothstep( uSkyCloudDeck.w, uSkyCloudDeck.w + 0.42, d );
    return 1.0 - uSkyCloudPan.w * shade;
  }
`;

const CSM_SHADOW_FN = /* glsl */ `
#ifdef USE_SHADOWMAP

  /**
   * PCSS with a Vogel-disc filter. penumbraK is smuggled in through the
   * per-light shadowRadius uniform: it converts a receiver/blocker depth
   * difference (shadow-map depth units) into a filter radius in UV, and is
   * computed per cascade on the CPU from that cascade's world extent.
   */
  /**
   * Receiver-plane depth bias. A wide PCF/PCSS kernel compares one depth value
   * against taps up to a dozen texels away; on any sloped surface that is
   * simply the wrong comparison and the surface shadows itself. Tracking the
   * local depth gradient makes the comparison correct per tap, which is what
   * lets the penumbra be wide without acne — a constant bias cannot do both.
   */
  vec2 csmReceiverPlaneBias( vec3 dx, vec3 dy ) {
    float det = dx.x * dy.y - dx.y * dy.x;
    if ( abs( det ) < 1e-9 ) return vec2( 0.0 );
    vec2 b;
    b.x = dy.y * dx.z - dx.y * dy.z;
    b.y = dx.x * dy.z - dy.x * dx.z;
    return b / det;
  }

  float getShadowCSM( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity,
                      float shadowBias, float penumbraK, vec3 sc, float rot ) {

    if ( sc.z <= 0.0 || sc.z >= 1.0 ) return 1.0;
    if ( sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 ) return 1.0;

    vec2 texel = 1.0 / shadowMapSize;
    vec2 rp = csmReceiverPlaneBias( dFdx( sc ), dFdy( sc ) );
    // Derivatives are meaningless across a silhouette; cap the slope at what a
    // near-grazing surface inside this cascade could plausibly produce.
    rp = clamp( rp, vec2( -0.35 ), vec2( 0.35 ) );

    float z0 = sc.z + shadowBias;
    // The plane bias is exact for a flat receiver; curved ones (rocks, dunes)
    // still fall away from their own tangent plane across a wide kernel, so add
    // a slack term that grows with both the tap distance and the local slope.
    float curv = length( rp ) * 0.85;
    float cr = cos( rot ), sr = sin( rot );
    mat2 rotM = mat2( cr, sr, -sr, cr );

    // ---- blocker search ----
    // The search radius is the hard ceiling on the penumbra: a filter can only
    // widen as far as it found a blocker. Round 1 searched 4 texels and then
    // allowed a 9-texel filter, so every penumbra past ~10 cm silently
    // collapsed to a hard edge and a barrel and a warehouse looked identical.
    // 11 texels of search buys ~32 cm of penumbra in the near cascade, which is
    // an 9 m occluder at the sun's effective angular size.
    //
    // Round 4 widened both. The 10-to-90 ramp of a boot's contact shadow and of
    // a building's cast edge measured the same width, because the ceiling was
    // 13 texels and every occluder taller than about two metres already hit it.
    // 16 taps over 16 texels of search, feeding a filter allowed out to 22, is
    // a 0.5-to-22 texel range — a boot at 2 cm and a warehouse eave at 6 m no
    // longer land in the same bucket.
    const float SEARCH_TEXELS = 16.0;
    const float MAX_PEN_TEXELS = 22.0;
    float blockerSum = 0.0;
    float blockerCount = 0.0;
    float search = SEARCH_TEXELS * texel.x;
    for ( int i = 0; i < 16; i ++ ) {
      float r = sqrt( ( float( i ) + 0.5 ) / 16.0 );
      float th = float( i ) * 2.39996323;
      vec2 o = rotM * ( vec2( cos( th ), sin( th ) ) * r * search );
      float d = unpackRGBAToDepth( texture2D( shadowMap, sc.xy + o ) );
      if ( d < z0 + dot( o, rp ) - length( o ) * curv ) {
        // Weight the average toward blockers found close in: a distant tap that
        // happens to catch a tall wall must not inflate the penumbra of a
        // contact point right next to it.
        float w = 1.0 - 0.55 * r;
        blockerSum += d * w;
        blockerCount += w;
      }
    }
    if ( blockerCount < 0.001 ) return 1.0;

    float avgBlocker = blockerSum / blockerCount;
    float pen = clamp( ( z0 - avgBlocker ) * penumbraK,
                       texel.x * 0.5, texel.x * MAX_PEN_TEXELS );

    float sum = 0.0;
    for ( int i = 0; i < 20; i ++ ) {
      float r = sqrt( ( float( i ) + 0.5 ) / 20.0 );
      float th = float( i ) * 2.39996323 + 0.7;
      vec2 o = rotM * ( vec2( cos( th ), sin( th ) ) * r * pen );
      float d = unpackRGBAToDepth( texture2D( shadowMap, sc.xy + o ) );
      sum += step( z0 + dot( o, rp ) - length( o ) * curv, d );
    }

    return mix( 1.0, sum * 0.05, shadowIntensity );
  }

#endif
`;

/**
 * Declarations for the two ambient terms that are not in the light probe:
 * screen-space occlusion and the sun-gated ground bounce. Appended to
 * `lights_pars_begin`, which every lit built-in shader includes.
 *
 * A shader that never received these uniforms leaves them at the GLSL default
 * of zero, and `uAmbAO.x < 0.5` is the "off" path — the sampler is then never
 * read, which is the only safe thing to do with an unbound sampler.
 */
const AMB_PARS = /* glsl */ `
uniform sampler2D uAmbAOMap;
uniform vec4 uAmbAO;
uniform vec4 uAmbScreen;
uniform vec3 uAmbBounce;
// The cloud deck's numbers survive in the material because .z is the
// terminator roll-in width, which the key light needs; the deck's own weather
// sampler does not, because the cloud shade now arrives in uAmbAOMap.a.
uniform vec4 uSkyCloudDeck;
/** Occlusion (r) and cloud shade (a) at this fragment; 1,1 when unavailable. */
vec2 ambScreenLookup() {
	if ( uAmbAO.x < 0.5 ) return vec2( 1.0 );
	vec4 t = texture2D( uAmbAOMap, gl_FragCoord.xy * uAmbScreen.xy );
	return vec2( clamp( t.r, 0.0, 1.0 ), clamp( t.a, 0.0, 1.0 ) );
}
`;

/**
 * Appended to `lights_fragment_maps`, which is the one point in the standard
 * pipeline where `irradiance` is complete and has not yet been handed to
 * RE_IndirectDiffuse. Occlusion belongs HERE and nowhere else: the sun is a
 * point source with a shadow map of its own and multiplying it by a hemisphere
 * visibility term would be counting the same occluder twice.
 */
const AMB_APPLY = /* glsl */ `
#if defined( RE_IndirectDiffuse )
	{
		// Sun visibility at this point — the shadow map's answer, deliberately
		// NOT N.L. The ground under a wall's shaded face is in the wall's
		// shadow whether or not that face is turned away from the sun.
		float ambSun = 1.0;
		#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct ) && defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
			ambSun = clamp( csmSunVis, 0.0, 1.0 ) * csmCloud;
		#endif

		float ambVis = 1.0;
		if ( uAmbAO.x > 0.5 ) {
			ambVis = pow( ambScreenLookup().x, uAmbAO.w );
			// Jimenez's multi-bounce fit, evaluated against this fragment's own
			// albedo. Single-scatter visibility over-darkens a bright surface:
			// light that leaves a crevice wall lands on the opposite wall and
			// comes back out, and sand is bright enough for that to matter — a
			// crevice in sand at ao 0.5 is only about a stop down, not two.
			vec3 ambA = 2.0404 * diffuseColor.rgb - 0.3324;
			vec3 ambB = -4.7951 * diffuseColor.rgb + 0.6417;
			vec3 ambC = 2.7552 * diffuseColor.rgb + 0.6903;
			vec3 ambMB = max( vec3( ambVis ), ( ( ambVis * ambA + ambB ) * ambVis + ambC ) * ambVis );
			ambMB = clamp( mix( vec3( 1.0 ), ambMB, uAmbAO.y ), 0.0, 1.0 );
			irradiance *= ambMB;
			ambVis = dot( ambMB, vec3( 0.3333 ) );
		}

		// Ground bounce. A uniform lower hemisphere of radiance L lays
		// L * pi * ((1 + cos t) / 2)^2 on a normal t off straight down, and that
		// closed form is exact, cheap, and sharper in the vertical than the L2
		// probe can be — which is the whole point, since it is the underside of
		// things that has to pick up the warmth off the sand.
		vec3 ambNW = geometryNormal * mat3( viewMatrix );
		float ambDown = ( 1.0 - ambNW.y ) * 0.5;
		irradiance += uAmbBounce * ( ambDown * ambDown ) * ambSun * ambVis;

		#if defined( RE_IndirectSpecular ) && defined( USE_ENVMAP ) && defined( STANDARD )
			// Horizon occlusion on the specular lobe. A rough surface's lobe is
			// wide enough to be blocked by the same geometry the diffuse one is,
			// but a mirror looking straight out of a pit still sees the sky, so
			// this is scaled well under the diffuse term.
			radiance *= mix( 1.0, ambVis, uAmbAO.z * material.roughness );
			// The same pocket, on the specular side. Below the horizon the env
			// map holds the open landscape, and a rough surface facing down is
			// not looking at the open landscape — it is looking at its own
			// footing, with most of that footing's sky taken away by the body
			// standing over it. uAmbScreen.z is the identical sky-visibility the
			// diffuse model uses (AMBIENT.nearSkyBlock), so the two terms cannot
			// disagree; a fragment the shadow map says is in the sun keeps its
			// full lobe, because then the pocket really is lit.
			radiance *= mix( 1.0, mix( uAmbScreen.z, 1.0, ambSun ), ambDown * ambDown );
		#endif
	}
#endif
`;

const CSM_DIR_BLOCK = /* glsl */ `
		{
			vec4 csmC4 = vDirectionalShadowCoord[ i ];
			vec3 csmC = csmC4.xyz / csmC4.w;
			float csmW;
			#if ( UNROLLED_LOOP_INDEX + 1 >= NUM_DIR_LIGHT_SHADOWS )
				csmW = csmRemain;
			#else
				vec2 csmD = abs( csmC.xy - 0.5 );
				float csmIn = ( csmC.z > 0.0 && csmC.z < 1.0 )
					? ( 1.0 - smoothstep( 0.40, 0.487, max( csmD.x, csmD.y ) ) ) : 0.0;
				csmW = csmRemain * csmIn;
				csmRemain -= csmW;
			#endif
			float csmS = 1.0;
			float csmNdL = clamp( dot( geometryNormal, directLight.direction ), 0.0, 1.0 );
			if ( csmW > 0.0005 && receiveShadow && directLight.visible ) {
				// Slope-scaled bias: the depth error of a shadow texel grows with
				// tan(acos(N.L)), so a constant bias either acnes grazing surfaces
				// or peter-pans everything that faces the light squarely.
				float csmSlope = clamp( sqrt( 1.0 - csmNdL * csmNdL ) / max( csmNdL, 0.1 ), 0.0, 8.0 );
				csmS = getShadowCSM( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize,
					directionalLightShadow.shadowIntensity,
					directionalLightShadow.shadowBias * ( 1.0 + csmSlope * 2.0 ),
					directionalLightShadow.shadowRadius, csmC, csmRot );
				#if ( UNROLLED_LOOP_INDEX + 1 >= NUM_DIR_LIGHT_SHADOWS )
					vec2 csmE = abs( csmC.xy - 0.5 );
					float csmFade = 1.0 - smoothstep( 0.34, 0.50, max( csmE.x, csmE.y ) );
					csmS = mix( 1.0, csmS, csmFade );
				#endif
			}
			// Shading-normal terminator softening. max(0, N.L) is a kink: on a
			// coarse mesh — a terrain clipmap ring at 1.5 km, a rock LOD — the
			// whole 3.5 stops between the lit face and the shade face collapse
			// into the two pixels where N.L crosses zero, and that razor line is
			// the loudest "polygon" tell in a wide shot. A sun with a real
			// angular diameter, seen against a normal that is itself an
			// interpolation, rolls in over a band instead. Rolling the key in
			// with a smoothstep replaces the kink with a C1 ramp whose width in
			// N.L is fixed, so the ramp is many pixels wide exactly where the
			// normal turns slowly — which is where the hard line was.
			float csmTerm = smoothstep( 0.0, max( uSkyCloudDeck.z, 1e-4 ), csmNdL );
			// Cloud shade rides on the key light only. Summed over the cascades
			// the weights are 1, so applying it in every iteration scales the
			// total exactly once.
			directLight.color *= csmS * csmW * csmCloud * csmTerm;
			// Carried out of the loop for the ambient's ground-bounce term: the
			// cascade weights sum to 1, so this ends up as the plain shadow
			// visibility, free of the terminator roll-in and of N.L.
			csmSunVis += csmS * csmW;
		}
`;

/**
 * Shared uniform values. `cloneUniforms` copies plain objects **by reference**
 * (only THREE types and arrays are deep-copied), so a single object here is
 * genuinely shared by every material's uniform set and can be updated once per
 * frame instead of walked across the scene graph.
 */
export const SHARED_UNIFORMS = {
  uSkyCloudPan: { x: 0, y: 0, z: LIGHT_TRANSPORT.cloudCoverage, w: 0 },
  uSkyCloudDeck: {
    x: LIGHT_TRANSPORT.cloudDeck,
    y: LIGHT_TRANSPORT.cloudScale,
    z: LIGHT_TRANSPORT.terminatorWidth,
    w: LIGHT_TRANSPORT.cloudShadowBias,
  },
  /**
   * x = 1 once the AO buffer holds a frame (0 both before that and, crucially,
   *     in any shader that never received these uniforms — a raw ShaderMaterial
   *     including <lights_pars_begin> reads them as zero and takes the no-AO
   *     path rather than sampling an unbound sampler);
   * y = how far AO is allowed to close down the ambient;
   * z = the same for the specular IBL lobe;
   * w = exponent on the raw visibility.
   */
  uAmbAO: { x: 0, y: 1.0, z: 0.8, w: 1.25 },
  /**
   * xy = 1 / main render-target size, so gl_FragCoord maps to the AO buffer.
   * z  = fraction of the sky the ground DIRECTLY UNDER a surface still sees
   *      (1 - AMBIENT.nearSkyBlock), used by the specular pocket term.
   */
  uAmbScreen: { x: 1 / 1920, y: 1 / 1080, z: 1, w: 0 },
  /**
   * pi * (radiance of sunlit ground - radiance of the ground in its own shade).
   * The lobe this drives is the difference between the two, so a fragment the
   * shadow map says is lit gets the whole warm kick and one in shade gets none.
   */
  uAmbBounce: { x: 0, y: 0, z: 0 },
};

/**
 * Screen-space ambient occlusion buffer, shared by every lit material.
 *
 * It has to be a `FramebufferTexture` and not the render target's own texture:
 * `cloneUniforms` — which is how a MeshStandardMaterial gets its copy of the
 * ShaderLib uniforms — refuses to clone a render-target texture and substitutes
 * null. A FramebufferTexture clones like any other texture, and clones share
 * one `Source` and therefore one GL object, so `copyFramebufferToTexture` into
 * this one propagates to every material at once with no per-frame scene walk.
 *
 * Fixed size on purpose. The Source can never be replaced once materials hold
 * clones of it, so it cannot track a resize; it is a fullscreen buffer sampled
 * in normalised coordinates, so a viewport of any aspect still lands on it.
 */
const AO_W = 960;
const AO_H = 540;
const AO_TEXTURE = new THREE.FramebufferTexture(AO_W, AO_H);
AO_TEXTURE.minFilter = THREE.LinearFilter;
AO_TEXTURE.magFilter = THREE.LinearFilter;
AO_TEXTURE.generateMipmaps = false;

/**
 * Ambient transport constants owned by this file.
 *
 * They are not in ArtDirection.js because that file is being edited by several
 * authors at once and this is a round-4 experiment surface, not settled art
 * direction. `LIGHT_TRANSPORT` wins if a value is ever promoted over there.
 * Exposed on the instance as `lighting.ambientModel` so tools can sweep them.
 */
const AMBIENT = {
  /**
   * Fraction of the ground DIRECTLY UNDER a surface that is taking the key.
   *
   * This is the number that decides whether anything out of the sun has form.
   * Round 3 had one lit fraction for the whole ground hemisphere — the
   * landscape average, 0.82 at noon — so the probe said a downward-facing
   * normal receives 1.74 and an upward-facing one 1.08, i.e. the ambient got
   * BRIGHTER toward the ground and a shaded curved surface came out flat.
   *
   * A surface standing on the ground shadows its own footing. What the belly of
   * a sandbag can see is the sand between and beneath the bags, and that sand
   * is in the sandbag wall's shadow, lit by the sky at the fill level — not by
   * the sun. The remainder is the light that leaks into that pocket off the
   * sunlit sand a metre away, which is what this small number is.
   */
  // Round 6: 0.03 -> 0.015. At noon the key is 8x the sky, so a 3% leak of it
  // was 43% of the radiance of that pocket and set the floor the probe sphere's
  // belly could not get under. A pocket under a body at a 68 degree sun is
  // fully shadowed; 1.5% is the light bending in round the edges of it.
  litNear: 0.015,
  /** The same fraction for a surface the shadow map says is standing in the sun. */
  litSun: 0.86,
  /**
   * How much of the SKY that near-field footing loses to the surface standing
   * on it. ROUND 6: this is the fix for the missing sky-to-ground gradient.
   *
   * `litNear` already says the sand under a barrel gets almost none of the KEY.
   * What round 5 still missed is that it gets much less of the SKY as well: the
   * barrel is what is standing over it. A body of any size a metre off the sand
   * subtends most of that sand's upper hemisphere, and the sand's radiance is
   * albedo times whatever irradiance survives. Round 5 lit that pocket with the
   * FULL sky dome and then handed it back as the whole lower hemisphere of the
   * probe, which is why a shaded sphere measured only 0.74 stops between its
   * crown and its belly where a real sky over real ground gives 1.5-2.0.
   *
   * Measured by ablating this one number on a 0.5-grey probe sphere in full
   * cast shadow, binned by normal Y (tools/probes/sphere.js), crown over belly.
   * The LINEAR-HDR column is the one to trust — it is a radiance ratio, whereas
   * the display column also depends on where the tonemap toe happens to sit and
   * moves by a quarter of a stop between runs of the same build:
   *              linear HDR        presented frame
   *   afternoon  0.60 -> 1.53      1.05 -> 2.09
   *   noon       0.54 -> 1.47      0.70 -> 1.73
   *   dusk       0.43 -> 1.06      0.52 -> 1.22
   *   night      0.74 -> 1.58      0.85 -> 1.81
   * It is deliberately applied to the sunlit footing as well, so the sun-gated
   * bounce lobe — which is the DIFFERENCE between the two — does not move and
   * nothing standing in the open changes.
   */
  nearSkyBlock: 0.80,
  /**
   * How far down you have to look before the ground you see stops being your
   * own footing, as -normal.y.
   *
   * Round 3 put the crossover at 0.62, i.e. half the lower hemisphere was
   * treated as distant landscape. Geometry says otherwise: a surface a metre
   * off the ground looking down at 15 degrees of depression is looking at sand
   * five metres away, still well inside its own contact shade. Only the last
   * few degrees above the ground horizon are genuinely far.
   */
  nearBand: [0.010, 0.18],
  /**
   * How much of the isotropic interreflection pedestal survives on the DOWNWARD
   * directions. The pedestal stands in for the sunlit environment a shaded
   * point can see — neighbouring dunes, walls, vehicles — and all of that
   * sticks UP out of the ground. Applying it in full below the horizon put a
   * quarter of a downward normal's fill back and cost most of the contrast this
   * function exists to create.
   */
  pedestalDown: 0.10,
  /** GTAO world-space radius, metres. */
  aoRadius: 1.2,
  /** Thin-occluder heuristic: how much a receding sample re-opens the horizon. */
  aoThickness: 0.12,
  /**
   * TWILIGHT AMBIENT. Round 6 — the fix for "dusk has no cool colour anywhere,
   * for the third round running".
   *
   * A dusk frame is a WARM KEY AGAINST A COOL AMBIENT; that opposition is the
   * whole look, and rounds 3-5 had 62% of the dusk frame warm and 0.33% of it
   * cool. The cause is in the atmosphere model, not in the print: the dome is
   * projected from a SINGLE-SCATTERING integrator, and single scattering is
   * exactly the term that collapses at low sun. What makes a real twilight sky
   * blue overhead and away from the sun is light that has bounced two and three
   * times through the Rayleigh column; a single-scattering dome at a 2 degree
   * sun is one enormous forward-scattered Mie lobe and very little else, so
   * every direction of it comes back orange and the shadows fill orange.
   *
   * This rotates the CHROMA of the sky's ambient toward a twilight dome, at
   * CONSTANT LUMINANCE, weighted away from the sun. Constant luminance on
   * purpose: the exposure the whole print is calibrated against is derived from
   * this same sky irradiance (RenderPipeline's `_updateExposure` reads
   * `atmosphere.skyRadiance`, which is this), so adding energy here would move
   * every dusk and dawn frame's exposure as a side effect of a hue fix.
   *
   * It is applied to the sky radiance BEFORE the SH projection, so the light
   * probe, the ground bounce that is derived from it and the post stack's
   * aerial perspective all take the same number and cannot disagree.
   */
  twilight: {
    /** sin(solar elevation) over which the term fades out: ~3 deg to ~14 deg. */
    band: [0.05, 0.24],
    /** How far the chroma is rotated, at the anti-solar point. */
    amount: 1.0,
    /**
     * How much of that survives looking straight AT the key. Not zero: the
     * aureole round a setting sun is genuinely orange and washing it out would
     * trade one monochrome frame for another, but the whole sky within 90
     * degrees of the sun is not the aureole.
     */
    sunward: 0.70,
    /** Chroma of a twilight dome, ~11000 K. Only its ratios matter. */
    chroma: [0.35, 0.50, 0.85],
    /**
     * The same for the night presets, where the model's own moonlit-air term is
     * the thing being corrected rather than a low sun. Bluer, because a
     * moonlit sky is Rayleigh scattering with no aureole in it at all.
     */
    nightChroma: [0.24, 0.50, 1.20],
  },
  /**
   * Key:fill at night, overriding LIGHT_TRANSPORT.keyFillNight.
   *
   * That number was set in round 4 against a moon three times brighter than the
   * one NIGHT_RIG now runs (see there). Fill is tied to the key by this ratio,
   * so dropping the moon and leaving the ratio alone drops the fill with it and
   * pushes another 2.3% of the night frame onto the print's black floor. The
   * fill at night is starlight, airglow and the Rayleigh column — none of which
   * dim when the moon does — so the honest response to a dimmer moon is a
   * flatter ratio, not a darker sky.
   */
  nightKeyFill: 2.10,
};

/**
 * NIGHT RIG. Round 6 — the fix for "night reads as a moonlit snowfield".
 *
 * Round 5's night preset drove the moon at an intensity that put open ground at
 * display L 0.3301 with a saturation of 0.056 — 2.25x BRIGHTER than the sky it
 * is lit by, and neutral grey. Ground brighter than its own source is not a
 * grading choice, it is a rig error, and the neutrality follows from it: the
 * print's black lift is a fixed pedestal, so the higher a night surface floats
 * the more of it is pedestal and the less of it is moonlight.
 *
 * The preset is shared and read by Sky.js for the moon disc and the star field,
 * so it is not edited here. The KEY is rigged separately instead: a real
 * directional light, dimmer, and unambiguously cool. `_computeSkySH` derives
 * the fill from the same two numbers, so the ambient carries the same hue.
 */
const NIGHT_RIG = {
  /** Multiplier on the preset's moon intensity. */
  keyScale: 0.38,
  /** Moon colour, linear. Moonlight is sunlight, but the eye at scotopic
   *  adaptation reads it blue and every night frame in the reference is blue. */
  keyColor: [0.17, 0.42, 1.0],
};

/**
 * The volumetric pass's weather map, rebuilt here. It is a pure function of a
 * seed, so this is the same field byte for byte — the cloud casting the shadow
 * is the cloud you can see. Since round 4 it is read by exactly one material,
 * the AO pass's, so nothing depends on when it is created any more.
 */
let _weatherTex;
function weatherTexture() {
  if (_weatherTex !== undefined) return _weatherTex;
  _weatherTex = null;
  if (typeof VolNoise.buildWeatherMap === 'function') {
    try {
      _weatherTex = VolNoise.buildWeatherMap(256);
    } catch (err) {
      console.warn('Lighting: weather map unavailable; cloud shadows off.', err);
    }
  }
  return _weatherTex;
}

let _chunksPatched = false;
function installCSMChunks() {
  if (_chunksPatched) return;
  _chunksPatched = true;

  THREE.ShaderChunk.shadowmap_pars_fragment = THREE.ShaderChunk.shadowmap_pars_fragment + CSM_SHADOW_FN;
  THREE.ShaderChunk.lights_pars_begin = THREE.ShaderChunk.lights_pars_begin + AMB_PARS;

  // Every lit built-in shader gets the shared ambient uniforms. Materials that
  // predate this (or raw ShaderMaterials) simply leave them at their GLSL
  // default of zero, and uAmbAO.x = 0 is the "no screen-space terms" path —
  // which matters, because that is the only safe thing to do with a sampler
  // nobody bound.
  //
  // Exactly ONE sampler is added here, and the cloud weather map that used to
  // be a second one is gone: `terrain-L0` compiles with 16 active texture units
  // against a driver limit of 16, so a net addition would have failed to link.
  for (const id of ['physical', 'standard', 'lambert', 'phong', 'toon']) {
    const lib = THREE.ShaderLib[id];
    if (!lib) continue;
    lib.uniforms.uSkyCloudDeck = { value: SHARED_UNIFORMS.uSkyCloudDeck };
    lib.uniforms.uAmbAOMap = { value: AO_TEXTURE };
    lib.uniforms.uAmbAO = { value: SHARED_UNIFORMS.uAmbAO };
    lib.uniforms.uAmbScreen = { value: SHARED_UNIFORMS.uAmbScreen };
    lib.uniforms.uAmbBounce = { value: SHARED_UNIFORMS.uAmbBounce };
  }

  // Diffuse irradiance now comes from the sky SH light probe. Leaving the
  // environment cube's diffuse term in as well would double-count it and
  // decouple the shadow colour from the sky again.
  const maps = THREE.ShaderChunk.lights_fragment_maps;
  const iblLine = '\t\tiblIrradiance += getIBLIrradiance( geometryNormal );';
  if (maps.includes(iblLine)) {
    THREE.ShaderChunk.lights_fragment_maps = maps.replace(
      iblLine,
      '\t\t// diffuse IBL intentionally dropped: the sky SH light probe owns it (Lighting.js)',
    );
  } else {
    console.warn('Lighting: lights_fragment_maps shape changed; diffuse IBL not suppressed.');
  }
  const src = THREE.ShaderChunk.lights_fragment_begin;

  // Declare the cascade accumulator + a per-pixel rotation for the Vogel disc.
  // Interleaved gradient noise decorrelates the filter across pixels; TAA then
  // resolves it to a clean penumbra instead of a fixed dither pattern.
  //
  // The cloud term is evaluated ONCE here rather than per cascade: reconstruct
  // the world position from the view-space one (viewMatrix is rigid, so its
  // inverse rotation is a transposed multiply) and the world sun direction from
  // cascade 0, which by construction shares its direction with every cascade.
  const decl = `	DirectionalLight directionalLight;`;
  const declNew = `	DirectionalLight directionalLight;
	float csmRemain = 1.0;
	float csmRot = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) ) * 6.2831853;
	// Cloud shade is evaluated once per screen pixel in the AO pass (Lighting's
	// _renderAO) and read back here, rather than four weather-map fetches in
	// every lit material. It is a kilometre-scale, deliberately soft signal, so
	// a half-resolution screen-space carrier costs it nothing.
	float csmCloud = ambScreenLookup().y;
	float csmSunVis = 0.0;`;

  const oldShadowLine =
    'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';

  if (!src.includes(oldShadowLine) || !src.includes(decl)) {
    console.warn('Lighting: lights_fragment_begin shape changed; CSM override skipped.');
    return;
  }
  THREE.ShaderChunk.lights_fragment_begin = src
    .replace(decl, declNew)
    .replace(oldShadowLine, CSM_DIR_BLOCK);

  // Only now: occlusion and the ground bounce close out the indirect term, and
  // the bounce reads `csmSunVis`, which the block above is what declares. If the
  // CSM override ever bails, this must bail with it rather than emit a shader
  // that will not compile.
  THREE.ShaderChunk.lights_fragment_maps = THREE.ShaderChunk.lights_fragment_maps + AMB_APPLY;
}

installCSMChunks();

// ---------------------------------------------------------------------------
// CPU mirror of the atmosphere in Sky.js
// ---------------------------------------------------------------------------

const Rg = 6371000.0;
const Ra = 6471000.0;
const Hr = 8000.0;
const Hm = 1400.0;
const BETA_R = [5.802e-6, 13.558e-6, 33.1e-6];
const BETA_M = 3.996e-6;
const BETA_M_ABS = 4.4e-6;
const BETA_O = [0.65e-6, 1.881e-6, 0.085e-6];
const SKY_SCALE = 133.3333;

function sphereFar(ro, rd, r) {
  const b = ro[0] * rd[0] + ro[1] * rd[1] + ro[2] * rd[2];
  const c = ro[0] * ro[0] + ro[1] * ro[1] + ro[2] * ro[2] - r * r;
  const d = b * b - c;
  if (d < 0) return -1;
  return -b + Math.sqrt(d);
}

function densities(h) {
  const hh = Math.max(h, 0);
  return [
    Math.exp(-hh / Hr),
    Math.exp(-hh / Hm),
    Math.max(0, 1 - Math.abs(h - 25000) / 15000),
  ];
}

/** Optical depth from a point along a direction to the top of the atmosphere. */
function opticalDepth(p, dir, steps = 8) {
  const t = sphereFar(p, dir, Ra);
  if (t <= 0) return [0, 0, 0];
  let odR = 0;
  let odM = 0;
  let odO = 0;
  for (let j = 0; j < steps; j++) {
    const g0 = j / steps;
    const g1 = (j + 1) / steps;
    const q0 = t * g0 * g0;
    const q1 = t * g1 * g1;
    const dq = q1 - q0;
    const s = 0.5 * (q0 + q1);
    const q = [p[0] + dir[0] * s, p[1] + dir[1] * s, p[2] + dir[2] * s];
    const h = Math.hypot(q[0], q[1], q[2]) - Rg;
    const [dr, dm, doz] = densities(h);
    odR += dr * dq;
    odM += dm * dq;
    odO += doz * dq;
  }
  return [odR, odM, odO];
}

/** Single-scattered radiance along a view ray, matching Sky.js's integrator. */
function scatterCPU(ro, rd, sunDir, mieG, rayScale, mieScale) {
  let tMax = sphereFar(ro, rd, Ra);
  if (tMax <= 0) return [0, 0, 0];
  // clip against the planet
  {
    const b = ro[0] * rd[0] + ro[1] * rd[1] + ro[2] * rd[2];
    const c = ro[0] * ro[0] + ro[1] * ro[1] + ro[2] * ro[2] - (Rg - 1000) * (Rg - 1000);
    const d = b * b - c;
    if (d >= 0) {
      const t0 = -b - Math.sqrt(d);
      if (t0 > 0) tMax = Math.min(tMax, t0);
    }
  }
  const bR = BETA_R.map((v) => v * rayScale);
  const bM = BETA_M * mieScale;
  const bMe = (BETA_M + BETA_M_ABS) * mieScale;

  const mu = rd[0] * sunDir[0] + rd[1] * sunDir[1] + rd[2] * sunDir[2];
  const pR = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g2 = mieG * mieG;
  const dd = 1 + g2 - 2 * mieG * mu;
  const pM = (3 / (8 * Math.PI)) * ((1 - g2) * (1 + mu * mu)) / ((2 + g2) * Math.pow(Math.max(dd, 1e-4), 1.5));

  const sumR = [0, 0, 0];
  const sumM = [0, 0, 0];
  let odR = 0;
  let odM = 0;
  let odO = 0;
  const STEPS = 16;
  for (let i = 0; i < STEPS; i++) {
    const f0 = i / STEPS;
    const f1 = (i + 1) / STEPS;
    const s0 = tMax * f0 * f0;
    const s1 = tMax * f1 * f1;
    const ds = s1 - s0;
    const s = 0.5 * (s0 + s1);
    const p = [ro[0] + rd[0] * s, ro[1] + rd[1] * s, ro[2] + rd[2] * s];
    const h = Math.hypot(p[0], p[1], p[2]) - Rg;
    const [dr0, dm0, doz0] = densities(h);
    const dr = dr0 * ds;
    const dm = dm0 * ds;
    const doz = doz0 * ds;
    odR += dr;
    odM += dm;
    odO += doz;

    const proj = p[0] * sunDir[0] + p[1] * sunDir[1] + p[2] * sunDir[2];
    const px = p[0] - sunDir[0] * proj;
    const py = p[1] - sunDir[1] * proj;
    const pz = p[2] - sunDir[2] * proj;
    const perp = Math.hypot(px, py, pz);
    const lit = proj > 0 ? 1 : THREE.MathUtils.smoothstep(perp, Rg - 4000, Rg + 12000);
    if (lit <= 0.001) continue;

    const [lR, lM, lO] = opticalDepth(p, sunDir, 6);
    for (let c = 0; c < 3; c++) {
      const tau = bR[c] * (odR + lR) + bMe * (odM + lM) + BETA_O[c] * (odO + lO);
      const att = Math.exp(-tau) * lit;
      sumR[c] += att * dr;
      sumM[c] += att * dm;
    }
  }
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    out[c] = sumR[c] * bR[c] * (pR + 0.28) + sumM[c] * bM * (pM + 0.1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sky -> spherical harmonics
// ---------------------------------------------------------------------------

/** Unit directions spread evenly over the sphere (Fibonacci spiral). */
function fibonacciSphere(n) {
  const dirs = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    dirs.push(new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r));
  }
  return dirs;
}

/**
 * 384 directions is well past the point where an L2 projection stops changing
 * (the basis cannot resolve anything sharper than a ~60 degree lobe) but it
 * keeps the *irradiance sums* used for the key:fill calibration quiet.
 */
const SH_DIRS = fibonacciSphere(384);
const SH_BASIS = new Array(9).fill(0);

const LUMA = [0.2126, 0.7152, 0.0722];
const lum3 = (c) => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];

/** Accept whatever shape Sky.js hands back: array, Vector3 or Color. */
function readRGB(v) {
  if (!v) return null;
  let c;
  if (Array.isArray(v)) c = [v[0], v[1], v[2]];
  else if (v.isColor) c = [v.r, v.g, v.b];
  else if (typeof v.x === 'number') c = [v.x, v.y, v.z];
  else return null;
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(c[i]) || c[i] < 0) return null;
  }
  return c;
}

/**
 * Lighting system.
 */
export class Lighting {
  constructor(engine, sky) {
    this.engine = engine;
    this.sky = sky;
    this.order = -50;

    this.cascadeCount = Math.max(1, Math.min(4, QUALITY.cascadeCount ?? 4));
    this.shadowDistance = QUALITY.shadowDistance ?? 420;
    // Angular size of the light source as seen from the ground, in radians.
    // Larger than the real sun on purpose: it is what makes the penumbra grow
    // visibly along a 40 m shadow instead of staying pin-sharp.
    this.lightAngularSize = LIGHT_TRANSPORT.sunAngularSize;

    // Every cascade gets a full-size map. A round tried 2048/1536/1024 to buy
    // milliseconds and it leaked: a roofed interior at ~200 m in the vista shot
    // went from L=80.6 to 105.7 (+31%) — daylight through a roof — while
    // controls in the same frame moved ~1 code. A 1536 map over cascade 1's
    // 160 m extent is a 10.5 cm texel, and a 10 cm gap in a roof is exactly the
    // hole light came through. The refresh schedule below is where the
    // measurable saving actually was, and it costs no resolution at all.
    const mapSizes = [QUALITY.shadowMapSize, QUALITY.shadowMapSize, QUALITY.shadowMapSize, 1024];
    // How often each cascade is re-rendered, in frames. The far cascades cover
    // hundreds of metres and are snapped to a coarse texel grid, so refreshing
    // them every frame costs a full scene draw for a result that is bit-identical
    // most of the time. Measured (tools/probes/cascades.js, gameplay, 1080p):
    // the scene itself is 242 draws / 2.31 M triangles, and the three cascades
    // add 520 draws / 4.01 M triangles on a frame where they all refresh — the
    // shadow pass is bigger than the scene it shadows. Amortised over [1,2,4]
    // that was 299 shadow draws a frame; over [1,3,6] it is 255.
    //
    // The >3 m camera-move guard in update() forces every cascade to refresh, so
    // this saving lands on standing and slow movement, not on a sprint. In a
    // stealth game that is most of the play time.
    //
    // Phases are chosen so no two cascades above 0 ever land on the same frame:
    // cascade 1 fires at f mod 3 == 1, cascade 2 at f mod 6 == 3 (which is
    // always f mod 3 == 0), cascade 3 at f mod 12 == 5 (f mod 3 == 2,
    // f mod 6 == 5). No frame ever pays for two cascade refits at once.
    this.refreshInterval = [1, 3, 6, 12];
    this._refreshPhase = [0, 1, 3, 5];

    /**
     * How far up-sun a caster can be and still matter, in metres.
     *
     * The shadow camera is pushed back `radius + casterReach` along the light
     * and its near plane sits at 1, so this is literally the depth of the
     * column three frustum-culls casters against. It was 420 — the far edge of
     * the terrain's shadow-casting clipmap rings measured from the CAMERA — but
     * a cascade is fitted to a slice of the view frustum whose centre already
     * sits well down-range, so 420 on top of that reaches hundreds of metres
     * past anything that can cast at all.
     *
     * Shrinking it is free of visual consequence by construction: the PCSS
     * penumbra uniform is `depthRange * angularSize / (2 * radius)`, a
     * conversion from normalised depth units to UV, and normalised depth
     * differences scale by exactly the same depthRange. The two cancel.
     */
    this.casterReach = 420;

    /** @type {THREE.DirectionalLight[]} */
    this.cascades = [];
    for (let i = 0; i < this.cascadeCount; i++) {
      const l = new THREE.DirectionalLight(0xffffff, 5.0);
      l.castShadow = true;
      const size = mapSizes[Math.min(i, mapSizes.length - 1)];
      l.shadow.mapSize.set(size, size);
      l.shadow.camera.near = 1;
      l.shadow.camera.far = 1000;
      l.shadow.bias = -0.0005;
      l.shadow.normalBias = 0.03;
      l.shadow.radius = 1.0;
      // Driven manually below; three's own per-frame refresh is too eager for
      // the outer cascades.
      l.shadow.autoUpdate = i === 0;
      l.shadow.needsUpdate = true;
      l.shadow.camera.updateProjectionMatrix();
      l.target = new THREE.Object3D();
      l.matrixAutoUpdate = true;
      engine.scene.add(l, l.target);
      this.cascades.push(l);
    }
    // Shadow-casting lights sort first in three's light arrays, so the cascades
    // always occupy directionalLights[0..N-1] regardless of scene-graph order.
    this.sun = this.cascades[0];
    this.sunTarget = this.cascades[0].target;

    // Kept at zero and kept around: several tools (tools/calibrate.mjs) drive
    // `lighting.hemi.intensity`, and a stray hemisphere light on top of the SH
    // probe would double-count the sky.
    this.hemi = new THREE.HemisphereLight(0x9fb6d8, 0x6b5c46, 0.0);
    engine.scene.add(this.hemi);

    /**
     * Diffuse ambient. Every coefficient is a projection of the sky dome plus
     * the ground bounce, recomputed on each time-of-day change, so the fill
     * light's colour is the sky's colour and cannot drift from it.
     */
    this.probe = new THREE.LightProbe(new THREE.SphericalHarmonics3(), 1.0);
    engine.scene.add(this.probe);

    // Bounce light: sand kicks a lot of warm light back up into undersides.
    // The hemispherical part of that now lives in the SH probe; this survives
    // as a small extra kick straight up, which reads on the flat undersides of
    // vehicles and crates where an L2 probe is too smooth to make an edge.
    this.bounce = new THREE.DirectionalLight(0xc9a878, 0.0);
    this.bounce.position.set(0, -1, 0);
    engine.scene.add(this.bounce);

    this.sunDirection = new THREE.Vector3(0.4, 0.5, -0.75).normalize();
    this.moonDirection = new THREE.Vector3(0.3, 0.6, 0.7).normalize();
    /** Direction of the actual key light (sun by day, moon by night). */
    this.keyDirection = this.sunDirection.clone();
    this.preset = { ...TIME_OF_DAY.afternoon };

    this.pmrem = new THREE.PMREMGenerator(engine.renderer);
    this.pmrem.compileEquirectangularShader();
    this._envScene = new THREE.Scene();
    this._envDirty = true;
    this._envTarget = null;

    this._splits = new Float32Array(this.cascadeCount + 1);
    this._tmp = {
      m: new THREE.Matrix4(),
      mi: new THREE.Matrix4(),
      v: new THREE.Vector3(),
      center: new THREE.Vector3(),
      corners: Array.from({ length: 8 }, () => new THREE.Vector3()),
      fwd: new THREE.Vector3(),
      right: new THREE.Vector3(),
      up: new THREE.Vector3(),
      eye: new THREE.Vector3(),
    };

    /** Sweepable ambient-transport knobs; see the AMBIENT block up top. */
    this.ambientModel = { ...AMBIENT, nearBand: AMBIENT.nearBand.slice() };
    this._ao = null;

    this.setTimeOfDay('afternoon');
  }

  setTimeOfDay(nameOrPreset) {
    const p = typeof nameOrPreset === 'string' ? TIME_OF_DAY[nameOrPreset] : nameOrPreset;
    if (!p) return;
    // Remembered so the cloud shadow can look up the volumetric pass's own
    // per-time-of-day cloud coverage and deck altitude by name.
    if (typeof nameOrPreset === 'string') this.todName = nameOrPreset;
    this.preset = { ...p };
    this.engine.timeOfDay = this.preset;

    const el = THREE.MathUtils.degToRad(p.sunElevation);
    const az = THREE.MathUtils.degToRad(p.sunAzimuth);
    this.sunDirection.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();

    // How far below the horizon the sun is, mapped to a night blend.
    const night = THREE.MathUtils.smoothstep(-this.sunDirection.y, 0.0, 0.12);
    this.night = night;

    // A negative solar elevation in the preset means "this is a night preset":
    // the key light becomes the moon, placed high and across the sky from the
    // sun so it rakes the terrain rather than sitting behind it.
    const mel = THREE.MathUtils.degToRad(46);
    const maz = az + Math.PI * 0.82;
    this.moonDirection.set(Math.cos(mel) * Math.sin(maz), Math.sin(mel), Math.cos(mel) * Math.cos(maz)).normalize();
    this.keyDirection.copy(night > 0.5 ? this.moonDirection : this.sunDirection);
    // The moon has no aureole worth speaking of, so its shadows stay crisp.
    this.lightAngularSize =
      night > 0.5 ? LIGHT_TRANSPORT.moonAngularSize : LIGHT_TRANSPORT.sunAngularSize;

    // The key light's own colour and level, which at night are NOT the preset's
    // (see NIGHT_RIG). Everything downstream — the cascades, the SH fill, the
    // ground bounce, the haze — reads these two and never the preset again, so
    // the fill cannot drift from the key it is supposed to be balanced against.
    if (night > 0.5) {
      this.keyColor = NIGHT_RIG.keyColor.slice();
      this.keyIntensity = p.sunIntensity * NIGHT_RIG.keyScale;
    } else {
      this.keyColor = p.sunColor.slice();
      this.keyIntensity = p.sunIntensity;
    }

    for (const l of this.cascades) {
      l.color.setRGB(...this.keyColor, THREE.LinearSRGBColorSpace);
      l.intensity = this.keyIntensity;
    }

    this.hemi.color.setRGB(...p.ambientColor, THREE.LinearSRGBColorSpace);
    this.hemi.intensity = 0.0;
    this.hemi.groundColor.setRGB(0.3, 0.255, 0.19, THREE.LinearSRGBColorSpace);
    // The environment cube is specular-only now (its diffuse term is stripped
    // out of lights_fragment_maps), so this no longer sets the fill level.
    this.envIntensity = LIGHT_TRANSPORT.specularIBL;
    this.engine.scene.environmentIntensity = this.envIntensity;

    this.sky.apply(p, this.sunDirection, this.moonDirection, night);

    // Sky must be applied first: `radianceInDirection` (when Sky.js provides it)
    // reads the uniforms we just wrote.
    this._computeSkySH();

    // Distance haze is done properly in the post stack (see RenderPipeline's
    // aerial perspective). A thin exponential fog is kept only so alpha-blended
    // geometry, which the depth-driven pass cannot see, still recedes.
    const fogColor = new THREE.Color().setRGB(...p.fogColor, THREE.LinearSRGBColorSpace);
    this.engine.scene.fog = new THREE.FogExp2(fogColor, p.fogDensity * 0.12);

    if (this.engine.pipeline) this.engine.pipeline.exposure = p.exposure;
    this._envDirty = true;
    this.invalidateShadows();
    this._pushAtmosphere();
    // The cloud uniforms are per-time-of-day now, so they cannot wait for the
    // first update(): a still frame captured before one ran would have the
    // previous preset's coverage.
    this._updateCloudShadow(this.engine.elapsed ?? 0);
  }

  /**
   * Radiance of the sky dome in one direction, in the same linear units the
   * scene's DirectionalLight uses.
   *
   * Prefers `sky.radianceInDirection` when Sky.js exposes it, and falls back to
   * the CPU mirror of the same raymarch otherwise. Either way the key:fill
   * calibration below re-normalises the overall level, so only the *shape* and
   * *colour* of the dome need to agree — a unit mismatch cannot break the look.
   */
  _skyRadiance(dir, ctx) {
    if (ctx.useApi) {
      const c = readRGB(this.sky.radianceInDirection(dir));
      if (c) return c;
      // One bad answer is enough: stop asking, do not spend 384 try/catches.
      ctx.useApi = false;
    }
    const s = scatterCPU(ctx.ro, [dir.x, dir.y, dir.z], ctx.sd, ctx.mieG, ctx.rayScale, ctx.mieScale);
    const k = ctx.sunIrr * ctx.unit;
    const out = [s[0] * k, s[1] * k, s[2] * k];
    if (ctx.night > 0.001) {
      // Mirror of Sky.js's moonlit-air term: Rayleigh blue, thicker toward the
      // horizon, brighter toward the moon. Without it a night preset projects to
      // an all-black probe and every unlit surface crushes.
      const thick = 0.45 + 0.55 * Math.exp(-Math.max(dir.y, 0) * 2.6);
      const muM = dir.dot(this.moonDirection);
      const g = ctx.night * thick * (0.55 + 0.75 * Math.max(0, muM)) * ctx.unit;
      out[0] += 0.030 * g;
      out[1] += 0.052 * g;
      out[2] += 0.115 * g;
    }
    return out;
  }

  /**
   * Project the sky dome (plus the ground bounce it causes) into L2 spherical
   * harmonics and hand the result to the scene's LightProbe.
   *
   * ROUND 4 — this function was the number-one reason the game did not look
   * like MGSV. Measured on a neutral grey sphere under the afternoon preset,
   * the sunlit flank came back at hue 32.7 deg and the flank turned AWAY from
   * the sun at hue 19.0 deg: the shade was *warmer* than the light, and only
   * 12 degrees of hue separated them. In Fox Engine's Afghanistan that split is
   * the entire look — a surface out of the sun is lit by a blue dome and swings
   * hue dramatically. Three things were producing a warm shade:
   *
   *  1. `groundCoupling` added 40% of the ground's own (sun-coloured) radiance
   *     isotropically over the WHOLE sphere, including the sky directions. That
   *     is a warm pedestal on the blue, and it is why the noon zenith fill
   *     measured B/R 1.02 — dead neutral under a blue sky.
   *  2. `ridgeElevation` at 33 degrees turned the bottom third of the sky dome
   *     into sunlit rock. A horizontal surface loses sin^2(33) = 30% of its
   *     fill to that, but a VERTICAL one loses far more, because a vertical
   *     surface's cosine lobe is concentrated at low elevations. That is
   *     precisely the escarpment flank the critics measured.
   *  3. The ground hemisphere was lit by the *full* key. A rough landscape
   *     shadows itself; at a 27 degree sun most of the terrain a shaded wall
   *     can see is turned away from the sun too, so what comes back is sky
   *     bounced twice, not sun bounced once.
   *
   * What survives, because it is true and because MGSV shows it: the lower
   * hemisphere is not black, it is warm bounced ground, and that warm kick is
   * what gives a barrel's shade side any form at all. It is now the minority
   * term it should be, it fades toward the sky's colour as it recedes toward
   * the horizon (distant ground is seen through kilometres of dust), and the
   * skyline band above the horizon is thin.
   *
   * The projection is then scaled by ONE scalar so the key:fill ratio lands on
   * the art-directed value. Scaling cannot change the hue, so the shadow colour
   * stays the sky's colour by construction while the contrast is dialled.
   */
  _computeSkySH() {
    const p = this.preset;
    const LT = LIGHT_TRANSPORT;
    const N = SH_DIRS.length;
    const dOmega = (4 * Math.PI) / N;

    const ctx = {
      useApi: typeof this.sky.radianceInDirection === 'function',
      ro: [0, Rg + 400, 0],
      sd: [this.sunDirection.x, this.sunDirection.y, this.sunDirection.z],
      rayScale: p.rayleigh / 1.9,
      mieScale: (p.mieCoefficient / 0.0058) * (0.55 + 0.14 * p.skyTurbidity),
      mieG: Math.min(p.mieDirectionalG, 0.82),
      unit: this.sky.material.uniforms.uSkyExposure.value * SKY_SCALE,
      sunIrr: this.sky.material.uniforms.uSunIrradiance.value,
      night: this.night,
    };

    // --- pass 1: sky radiance, and the irradiance it lays on flat ground -----
    const AM = this.ambientModel;
    // Twilight chroma rotation (see AMBIENT.twilight). Off entirely above ~14
    // degrees of solar elevation; at night it runs at full strength against its
    // own, bluer, target.
    const TW = AM.twilight ?? AMBIENT.twilight;
    const twGate = Math.max(
      this.night,
      1 - THREE.MathUtils.smoothstep(this.sunDirection.y, TW.band[0], TW.band[1]),
    );
    const twAmt = TW.amount * twGate;
    const twTarget = this.night > 0.5 ? TW.nightChroma : TW.chroma;
    const twLum = Math.max(lum3(twTarget), 1e-6);
    // Normalised to unit luminance, so mixing toward it cannot change the level.
    const twC = twTarget.map((v) => v / twLum);
    const twSun = TW.sunward ?? 0;
    const twKey = this.night > 0.5 ? this.moonDirection : this.sunDirection;

    const skyL = new Array(N);
    const eSky = [0, 0, 0];
    for (let i = 0; i < N; i++) {
      const d = SH_DIRS[i];
      if (d.y <= 0) continue;
      const c = this._skyRadiance(d, ctx);
      if (twAmt > 0.001) {
        // Strongest opposite the key, weakest (but not zero) straight at it.
        const mu = d.dot(twKey);
        const w = twAmt * (0.5 * (1 + twSun) - 0.5 * (1 - twSun) * mu);
        const cl = lum3(c);
        for (let k = 0; k < 3; k++) c[k] = c[k] * (1 - w) + twC[k] * cl * w;
      }
      skyL[i] = c;
      for (let k = 0; k < 3; k++) eSky[k] += c[k] * d.y * dOmega;
    }

    // --- the key light, and therefore the ground's own radiance --------------
    const keyDir = this.night > 0.5 ? this.moonDirection : this.sunDirection;
    const eKey = [0, 0, 0];
    const cosKey = Math.max(0, keyDir.y);
    for (let k = 0; k < 3; k++) eKey[k] = this.keyIntensity * this.keyColor[k] * cosKey;

    // Cloud cover shades a fair share of the landscape, so the *average* ground
    // is dimmer than a sunlit patch. Using the average here keeps the bounce
    // consistent with what the cloud-shadow term actually does to the sun.
    const cloudMean = 1 - LT.cloudShadowStrength * LT.cloudCoverage;
    // A rough landscape shadows itself. At a grazing sun only the facets that
    // face it are lit and everything else is filled by sky, so the *average*
    // radiance of the terrain a shaded surface can see is nowhere near
    // albedo * full key. This one number is most of the difference between a
    // shade face that reads as dim sunlight and one that reads as sky.
    const litFrac = THREE.MathUtils.clamp(LT.terrainLitBase + LT.terrainLitSlope * cosKey, 0.18, 0.95);
    const alb = LT.groundAlbedo;
    /**
     * Radiance of ground taking a given fraction of the key, and seeing a given
     * fraction of the sky. `skyVis` is what separates the open plain from the
     * pocket of sand directly under a surface: the surface itself is standing
     * over that pocket and takes most of its dome away.
     */
    const groundAt = (lit, skyVis = 1) => {
      const out = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        out[k] =
          ((alb[k] * (eKey[k] * cloudMean * lit + eSky[k] * skyVis)) / Math.PI) * LT.bounceStrength;
      }
      return out;
    };
    const nearSkyVis = THREE.MathUtils.clamp(1 - AM.nearSkyBlock, 0.02, 1);
    // Published to the shader so the specular pocket term (AMB_APPLY) uses the
    // same number this function builds the diffuse pocket from.
    SHARED_UNIFORMS.uAmbScreen.z = nearSkyVis;
    // The ground a surface sees DIRECTLY BENEATH IT. A surface standing on the
    // ground shadows its own footing, so this is sand at the fill level, not at
    // the key level — dim, and only as warm as the light leaking in off the
    // sunlit sand beside it. This is what an underside is filled by, and making
    // it the whole landscape average is what flattened everything out of the sun.
    const groundNear = groundAt(AM.litNear, nearSkyVis);
    // The open landscape: a real mix of lit facets and self-shadowed ones.
    const groundOpen = groundAt(litFrac);
    // ...seen through kilometres of the same dust that turns a distant ridge
    // pale blue-grey, so it has washed most of the way to the sky's own colour.
    const groundFar = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const skyMean = eSky[k] / Math.PI;
      groundFar[k] = groundOpen[k] + (skyMean - groundOpen[k]) * LT.groundHaze;
    }
    const groundL = groundOpen;
    // The interreflection pedestal keeps the shade warm and its level was
    // measured and signed off in round 3, so it stays on the sky directions
    // exactly as it was. Below the horizon it is mostly wrong: the things that
    // throw warm light at you — dunes, walls, vehicles — stick UP out of the
    // ground, so very little of that pedestal is visible looking down.
    const pedestal = groundOpen.map((v) => v * LT.groundCoupling);
    const pedestalDown = pedestal.map((v) => v * AM.pedestalDown);
    const sinRidge = Math.sin(THREE.MathUtils.degToRad(LT.ridgeElevation));

    // --- pass 2: full-sphere radiance -> SH, and the up-facing irradiance ----
    const sh = this.probe.sh;
    sh.zero();
    const coeff = sh.coefficients;
    const eUp = [0, 0, 0];
    const L = [0, 0, 0];
    for (let i = 0; i < N; i++) {
      const d = SH_DIRS[i];
      if (d.y > 0) {
        // The skyline: the last few degrees above the horizon are the most
        // distant terrain there is, so they take the hazed ground colour.
        const t = THREE.MathUtils.smoothstep(d.y, 0, sinRidge);
        const s = skyL[i];
        for (let k = 0; k < 3; k++) L[k] = groundFar[k] + (s[k] - groundFar[k]) * t + pedestal[k];
        for (let k = 0; k < 3; k++) eUp[k] += L[k] * d.y * dOmega;
      } else {
        // Straight down is the sand under your boots, in your own shade;
        // grazing-down is the plain two kilometres out. The crossover is much
        // closer to the horizon than it looks: a surface a metre up, looking
        // down at 15 degrees, is looking at sand five metres away — still its
        // own contact shade, not the landscape.
        const nearW = THREE.MathUtils.smoothstep(-d.y, AM.nearBand[0], AM.nearBand[1]);
        for (let k = 0; k < 3; k++) {
          L[k] = groundFar[k] + (groundNear[k] - groundFar[k]) * nearW + pedestalDown[k];
        }
      }
      THREE.SphericalHarmonics3.getBasisAt(d, SH_BASIS);
      for (let j = 0; j < 9; j++) {
        const w = SH_BASIS[j] * dOmega;
        coeff[j].x += L[0] * w;
        coeff[j].y += L[1] * w;
        coeff[j].z += L[2] * w;
      }
    }

    // --- key:fill calibration ------------------------------------------------
    // A hazy desert midday sits about two stops between lit sand and its own
    // cast shadow. Low sun flattens toward the sky taking over.
    let ratio;
    if (this.night > 0.5) ratio = AM.nightKeyFill ?? LT.keyFillNight;
    else {
      // Round 3 saturated this by a 33 degree sun, so a 27 degree afternoon and
      // a 68 degree noon were handed nearly the same contrast — which is why
      // the shots at the same nominal ratio measured a stop apart. The clear-sky
      // physics is a smooth ride from ~3:1 at the horizon (the sky takes over)
      // to ~9:1 overhead (direct beam carries ~89% of the illuminance), so the
      // ramp now spans the whole range of solar elevations.
      const t = THREE.MathUtils.smoothstep(cosKey, 0.04, 0.90);
      ratio = LT.keyFillLow + (LT.keyFillHigh - LT.keyFillLow) * t;
    }
    const targetUp = lum3(eKey) / Math.max(ratio - 1, 0.25);
    const rawUp = Math.max(lum3(eUp), 1e-6);
    // The clamp is a seatbelt, not a knob. If it engages, the sky dome's
    // exposure and the sun's intensity disagree by more than a factor of six and
    // that is a bug worth knowing about, not something to quietly grade around.
    const scale = THREE.MathUtils.clamp(targetUp / rawUp, 0.16, 6.0);
    for (let j = 0; j < 9; j++) coeff[j].multiplyScalar(scale);
    for (let k = 0; k < 3; k++) eUp[k] *= scale;

    this.probe.intensity = 1.0;

    // --- the sun-gated half of the ground bounce -----------------------------
    // The probe's lower hemisphere is the ground a surface sees when that
    // surface is in shade. A surface the shadow map says is standing in the sun
    // is standing on sunlit sand instead, and the difference between the two is
    // a large, warm, strongly downward-facing lobe. Handing it to the shader as
    // a lobe rather than folding it into the probe is what keeps the two cases
    // apart: the same barrel reads hot underneath in the open and dead
    // underneath in a building's shade, which is the whole tell.
    // Same pocket, same missing sky: the difference between the two is then
    // purely the key, so the sun-gated lobe is unchanged by `nearSkyBlock` and
    // nothing standing in the open moves when that number is swept.
    const groundSun = groundAt(AM.litSun, nearSkyVis);
    const ub = SHARED_UNIFORMS.uAmbBounce;
    const bounce = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      bounce[k] = Math.max(0, groundSun[k] - groundNear[k]) * Math.PI * scale;
    }
    ub.x = bounce[0];
    ub.y = bounce[1];
    ub.z = bounce[2];

    /**
     * Published so the post stack, the AO tint and the harness all read the same
     * ambient the geometry is lit by. `irradianceUp` is what a flat unoccluded
     * patch of ground in shadow receives; `skyRadiance` is its radiance form.
     */
    this.ambient = {
      irradianceUp: eUp,
      radiance: eUp.map((v) => v / Math.PI),
      keyIrradiance: eKey,
      groundRadiance: groundL,
      /** Radiance of the ground an underside in shade sees, post-calibration. */
      groundShadeRadiance: groundNear.map((v) => v * scale),
      /** The extra irradiance a straight-down normal in full sun picks up. */
      bounceIrradiance: bounce,
      ratio,
      scale,
      blueOverRed: eUp[2] / Math.max(eUp[0], 1e-6),
      /**
       * What the *haze* is lit by, as opposed to what surfaces are filled by.
       *
       * Two deliberate differences from `radiance`. It is not rescaled by the
       * key:fill scalar — that scalar is a statement about surface contrast, not
       * about how much light is in the air, and aerial perspective has to match
       * the sky dome it dissolves into or a ridge stops fading into the sky
       * behind it. And it is the *sky only*: no ridge lift, no ground pedestal.
       * A surface is filled by the sky plus everything warm around it, but the
       * dust column between the camera and a ridge two kilometres out is lit by
       * the sky, and that is precisely why distant ridges in Afghanistan wash
       * to pale dusty blue-grey while the sand at your feet stays khaki.
       */
      hazeRadiance: eSky.map((v) => v / Math.PI),
    };
  }

  /**
   * Evaluate the atmosphere on the CPU and hand the post stack the numbers it
   * needs so its aerial perspective is the same physics as the sky dome: the
   * sun radiance surviving to ground level, and the average sky radiance.
   */
  _pushAtmosphere() {
    const p = this.preset;
    const pipeline = this.engine.pipeline;
    const rayScale = p.rayleigh / 1.9;
    const mieScale = (p.mieCoefficient / 0.0058) * (0.55 + 0.14 * p.skyTurbidity);
    const mieG = Math.min(p.mieDirectionalG, 0.82);

    // Irradiance the haze is lit by, expressed in the SAME units the scene's
    // DirectionalLight uses. Deriving it from the light rather than from the
    // atmosphere model guarantees a hazy ridge and a lit ridge agree.
    const kc = this.keyColor ?? p.sunColor;
    const ki = this.keyIntensity ?? p.sunIntensity;
    const sunRad = [ki * kc[0], ki * kc[1], ki * kc[2]];
    if (this.sunDirection.y <= 0.0) {
      for (let c = 0; c < 3; c++) sunRad[c] = 0;
    }

    // Ambient radiance the haze is filled by. This is the SAME number the
    // geometry's fill light is built from (the SH probe's up-facing irradiance
    // over pi), so a hazy ridge and the shadow at your feet cannot disagree
    // about what colour the sky is — which is exactly how round 1 ended up with
    // a white sky and navy shadows.
    const skyAvg = this.ambient
      ? this.ambient.hazeRadiance.slice()
      : [0.09, 0.11, 0.16];

    // At night the moon is the only source; scale a cool ambient off it. The
    // floors ride on the rigged key (NIGHT_RIG), not on the preset, so dropping
    // the moon drops the haze it lights by the same amount instead of leaving a
    // bright neutral airglow standing over a darkened landscape.
    if (this.night > 0.01) {
      const m = this.night * ki;
      for (let c = 0; c < 3; c++) {
        sunRad[c] = Math.max(sunRad[c], [0.010, 0.016, 0.034][c] * m);
        skyAvg[c] = Math.max(skyAvg[c], [0.0022, 0.0040, 0.0098][c] * m);
      }
    }

    this.atmosphere = {
      sunDirection: this.night > 0.5 ? this.moonDirection : this.sunDirection,
      sunRadiance: sunRad,
      skyRadiance: skyAvg,
      rayleighScale: rayScale,
      mieScale,
      mieG,
      // Dust: a low, thick, warm-grey haze layer that only the desert has. Its
      // strength rides on the art-directed fog density so the look stays tunable.
      dustDensity: p.fogDensity / 0.000095,
      night: this.night,
    };
    if (pipeline && pipeline.setAtmosphere) pipeline.setAtmosphere(this.atmosphere);
  }

  // -------------------------------------------------------------------------
  // Ambient occlusion
  // -------------------------------------------------------------------------

  /**
   * Build the GTAO pass. Two half-res targets, a horizon-search material and a
   * separable depth-aware blur, plus the one fullscreen triangle they share.
   *
   * It reads the depth attachment the post stack already renders, so it costs
   * no extra scene draw — only two fullscreen passes on 0.5 MP. The depth it
   * gets is last frame's, which is exact for a static camera and one frame
   * stale for a moving one; a hemisphere visibility term is the last thing in
   * the frame that a 16 ms lag shows up in.
   */
  _buildAO() {
    const renderer = this.engine.renderer;
    const rt = () =>
      new THREE.WebGLRenderTarget(AO_W, AO_H, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
        colorSpace: THREE.NoColorSpace,
      });

    const VERT = /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }
    `;
    // Depth reconstruction and a 16-bit pack, shared by both passes. The pack
    // is there because the blur has to reject neighbours across a silhouette,
    // and 8 bits of view depth cannot tell a barrel from the sand behind it.
    const COMMON = /* glsl */ `
      uniform sampler2D tDepth;
      uniform mat4 uProjInv;
      uniform float uFar;
      vec3 viewAt( vec2 uv, float d ) {
        vec4 c = uProjInv * vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
        return c.xyz / c.w;
      }
      vec3 worldAt( vec2 uv, float d, mat4 invVP ) {
        vec4 c = invVP * vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
        return c.xyz / c.w;
      }
      vec2 packZ( float z ) {
        float v = clamp( z / uFar, 0.0, 1.0 );
        vec2 e = vec2( v, fract( v * 255.0 ) );
        return vec2( e.x - e.y / 255.0, e.y );
      }
      float unpackZ( vec2 e ) { return ( e.x + e.y / 255.0 ) * uFar; }
    `;

    const aoMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDepth: { value: null },
        uProjInv: { value: new THREE.Matrix4() },
        uFar: { value: 2048 },
        uDepthTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uProjScaleY: { value: 1 },
        uRadius: { value: AMBIENT.aoRadius },
        uThickness: { value: AMBIENT.aoThickness },
        uFrame: { value: 0 },
        uInvViewProj: { value: new THREE.Matrix4() },
        uSunW: { value: new THREE.Vector3(0, 1, 0) },
        uSkyCloudPan: { value: SHARED_UNIFORMS.uSkyCloudPan },
        uSkyCloudDeck: { value: SHARED_UNIFORMS.uSkyCloudDeck },
        uSkyCloudWeather: { value: weatherTexture() },
      },
      fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      ${COMMON}
      ${CLOUD_SHADOW_FN}
      uniform vec2 uDepthTexel;
      uniform float uProjScaleY;
      uniform float uRadius;
      uniform float uThickness;
      uniform float uFrame;
      uniform mat4 uInvViewProj;
      uniform vec3 uSunW;

      const float PI_ = 3.14159265359;
      const float HALF_PI = 1.57079632679;
      const float SKY_D = 0.9999995;

      float ign( vec2 p ) {
        return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
      }

      void main() {
        float d = texture2D( tDepth, vUv ).x;
        // The sky writes 1,0,0,1: full visibility, zero depth (which the blur
        // reads as "no sample here"), and a cloud term of 1 that nothing sees.
        if ( d >= SKY_D ) { gl_FragColor = vec4( 1.0, 0.0, 0.0, 1.0 ); return; }
        vec3 P = viewAt( vUv, d );
        float cloud = csmCloudShadow( worldAt( vUv, d, uInvViewProj ), uSunW );

        // Geometric normal from the DEPTH buffer, not from the shading normal:
        // occlusion is a property of the geometry, and a normal map that tilts
        // a flat wall must not tilt the hemisphere the wall is occluded over.
        // Pick the closer neighbour of each pair so a silhouette does not smear
        // a false normal across the depth step.
        vec2 tx = vec2( uDepthTexel.x, 0.0 );
        vec2 ty = vec2( 0.0, uDepthTexel.y );
        vec3 pr = viewAt( vUv + tx, texture2D( tDepth, vUv + tx ).x );
        vec3 pl = viewAt( vUv - tx, texture2D( tDepth, vUv - tx ).x );
        vec3 pu = viewAt( vUv + ty, texture2D( tDepth, vUv + ty ).x );
        vec3 pd = viewAt( vUv - ty, texture2D( tDepth, vUv - ty ).x );
        vec3 ddx = abs( pr.z - P.z ) < abs( P.z - pl.z ) ? ( pr - P ) : ( P - pl );
        vec3 ddy = abs( pu.z - P.z ) < abs( P.z - pd.z ) ? ( pu - P ) : ( P - pd );
        vec3 N = normalize( cross( ddx, ddy ) );
        vec3 V = normalize( -P );
        if ( dot( N, V ) < 0.0 ) N = -N;

        // World radius -> pixels. Clamped at the bottom so a distant surface
        // still searches a couple of texels (otherwise the whole far field
        // reports "unoccluded" and the horizon line pops), and at the top so a
        // surface at arm's length does not turn the search into a measurement
        // of how open the room is.
        float pixR = uRadius * uProjScaleY * 0.5 * ${AO_H}.0 / max( -P.z, 0.05 );
        pixR = clamp( pixR, 2.0, 48.0 );
        vec2 aoTexel = vec2( 1.0 / ${AO_W}.0, 1.0 / ${AO_H}.0 );

        float rot = ign( gl_FragCoord.xy + uFrame * 7.13 );
        float noff = fract( ign( gl_FragCoord.yx * 1.61 ) + uFrame * 0.618 );

        float vis = 0.0;
        for ( int s = 0; s < 4; s ++ ) {
          float phi = ( float( s ) + rot ) * PI_ * 0.25;
          vec2 omega = vec2( cos( phi ), sin( phi ) );
          // The slice plane: it contains the view vector and the search
          // direction, and the visibility integral inside it is 1-D.
          vec3 sliceN = cross( vec3( omega, 0.0 ), V );
          float sl = length( sliceN );
          if ( sl < 1e-5 ) continue;
          sliceN /= sl;
          vec3 projN = N - sliceN * dot( N, sliceN );
          float pn = length( projN );
          if ( pn < 1e-4 ) continue;
          vec3 tangent = cross( V, sliceN );
          float n = sign( dot( projN, tangent ) ) * acos( clamp( dot( projN, V ) / pn, -1.0, 1.0 ) );

          float hA = -1.0;
          float hB = -1.0;
          for ( int k = 0; k < 5; k ++ ) {
            float t = ( float( k ) + noff ) / 5.0;
            // Quadratic step spacing: contact darkening lives in the first
            // few texels and a linear walk spends four of its five taps
            // measuring the room instead of the crease.
            vec2 off = omega * max( t * t * pixR, 1.0 ) * aoTexel;
            for ( int side = 0; side < 2; side ++ ) {
              vec2 suv = side == 0 ? vUv + off : vUv - off;
              float sd = texture2D( tDepth, suv ).x;
              if ( sd >= SKY_D ) continue;
              vec3 D = viewAt( suv, sd ) - P;
              float l2 = dot( D, D );
              if ( l2 < 1e-8 ) continue;
              float l = sqrt( l2 );
              float cosH = dot( D, V ) / l;
              // Range falloff plus a thickness heuristic, so a fence wire does
              // not shadow the whole hillside behind it.
              float w = clamp( 1.0 - ( l - uRadius * 0.6 ) / ( uRadius * 0.4 ), 0.0, 1.0 );
              if ( side == 0 ) hB = cosH > hB ? mix( hB, cosH, w ) : mix( hB, cosH, uThickness );
              else hA = cosH > hA ? mix( hA, cosH, w ) : mix( hA, cosH, uThickness );
            }
          }

          // Jimenez et al's closed-form cosine-weighted visibility between the
          // two horizons. Taking max(sin(horizon)) instead — the HBAO
          // approximation — under-reads creases, because the integral is
          // dominated by the ARC between the horizons and not by the deepest one.
          float h1 = n + max( -acos( clamp( hA, -1.0, 1.0 ) ) - n, -HALF_PI );
          float h2 = n + min(  acos( clamp( hB, -1.0, 1.0 ) ) - n,  HALF_PI );
          float sn = sin( n );
          vis += pn * 0.25 * (
            ( h1 * 2.0 * sn - cos( 2.0 * h1 - n ) ) +
            ( h2 * 2.0 * sn - cos( 2.0 * h2 - n ) ) + 2.0 * cos( n ) );
        }

        gl_FragColor = vec4( clamp( vis * 0.25, 0.0, 1.0 ), packZ( -P.z ), cloud );
      }
      `,
    });

    const blurMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDepth: { value: null },
        uProjInv: { value: new THREE.Matrix4() },
        uFar: { value: 2048 },
        tAO: { value: null },
        uDir: { value: new THREE.Vector2() },
      },
      fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      ${COMMON}
      uniform sampler2D tAO;
      uniform vec2 uDir;
      void main() {
        vec4 c = texture2D( tAO, vUv );
        float z = unpackZ( c.gb );
        // Sky. Its cloud term is meaningless but its AO must stay at 1, or the
        // blur would drag a dark halo down every silhouette against the sky.
        if ( z <= 0.0 ) { gl_FragColor = c; return; }
        // Local depth slope, so the plane the surface is on is not itself read
        // as a discontinuity. Without this every ground plane seen at a grazing
        // angle — which is most of a first-person desert — rejects its own
        // neighbours and the blur does nothing where it is needed most.
        float zp = unpackZ( texture2D( tAO, vUv + uDir ).gb );
        float zm = unpackZ( texture2D( tAO, vUv - uDir ).gb );
        float slope = ( zp > 0.0 && zm > 0.0 ) ? ( zp - zm ) * 0.5 : 0.0;
        float sum = c.r;
        float wsum = 1.0;
        for ( int i = 1; i <= 5; i ++ ) {
          float fi = float( i );
          float gw = exp( -fi * fi * 0.11 );
          for ( int s = 0; s < 2; s ++ ) {
            float sg = s == 0 ? 1.0 : -1.0;
            vec4 t = texture2D( tAO, vUv + uDir * fi * sg );
            float tz = unpackZ( t.gb );
            if ( tz <= 0.0 ) continue;
            float dw = exp( -abs( tz - ( z + slope * fi * sg ) ) / ( z * 0.02 + 0.05 ) );
            float w = gw * dw;
            sum += t.r * w;
            wsum += w;
          }
        }
        gl_FragColor = vec4( sum / wsum, c.gb, c.a );
      }
      `,
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    const quad = new THREE.Mesh(geo, aoMat);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);

    this._ao = {
      a: rt(),
      b: rt(),
      aoMat,
      blurMat,
      quad,
      scene,
      cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
      renderer,
      ready: false,
    };
  }

  /**
   * Run the GTAO pass and publish the result to every lit material.
   *
   * `copyFramebufferToTexture` into the shared FramebufferTexture is what makes
   * this one write instead of a scene walk: every material's cloned uniform
   * points at the same GL object (see AO_TEXTURE).
   */
  _renderAO(engine) {
    const pipeline = engine.pipeline;
    const depth = pipeline && pipeline.hdr && pipeline.hdr.depthTexture;
    // Nothing to read until a frame has actually been drawn — systems run
    // before the render, so the depth attachment is empty on the first update.
    // Leaving uAmbAO.x at 0 keeps every material on the unoccluded path rather
    // than multiplying the ambient by garbage. Counted here rather than off the
    // pipeline's own frame number so a rename over there degrades to nothing.
    if (!depth || (this._frame ?? 0) < 2) return;
    if (!this._ao) this._buildAO();
    const ao = this._ao;
    const renderer = engine.renderer;
    const cam = engine.camera;

    // The scene is rasterised into the pipeline's HDR target, which is the
    // drawing buffer only while renderScale is 1. Materials turn gl_FragCoord
    // into a UV with this, so it has to be the size they are actually being
    // rasterised at or every AO lookup lands in the wrong place at reduced scale.
    const size = renderer.getDrawingBufferSize(this._tmp.v2 || (this._tmp.v2 = new THREE.Vector2()));
    const us = SHARED_UNIFORMS.uAmbScreen;
    us.x = 1 / Math.max(pipeline.width || size.x, 1);
    us.y = 1 / Math.max(pipeline.height || size.y, 1);

    const au = ao.aoMat.uniforms;
    au.tDepth.value = depth;
    au.uProjInv.value.copy(cam.projectionMatrixInverse);
    au.uDepthTexel.value.set(us.x, us.y);
    au.uProjScaleY.value = cam.projectionMatrix.elements[5];
    au.uFar.value = cam.far;
    au.uRadius.value = this.ambientModel.aoRadius;
    au.uThickness.value = this.ambientModel.aoThickness;
    au.uFrame.value = (this._frame ?? 0) % 64;
    // Cloud shade rides in the alpha channel; it needs world positions and the
    // world sun, both of which this pass already has to hand.
    cam.updateMatrixWorld();
    au.uInvViewProj.value
      .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
      .invert();
    au.uSunW.value.copy(this.keyDirection);

    const bu = ao.blurMat.uniforms;
    bu.tDepth.value = depth;
    bu.uProjInv.value.copy(cam.projectionMatrixInverse);
    bu.uFar.value = cam.far;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    ao.quad.material = ao.aoMat;
    renderer.setRenderTarget(ao.a);
    renderer.render(ao.scene, ao.cam);

    ao.quad.material = ao.blurMat;
    bu.tAO.value = ao.a.texture;
    bu.uDir.value.set(1 / AO_W, 0);
    renderer.setRenderTarget(ao.b);
    renderer.render(ao.scene, ao.cam);

    bu.tAO.value = ao.b.texture;
    bu.uDir.value.set(0, 1 / AO_H);
    renderer.setRenderTarget(ao.a);
    renderer.render(ao.scene, ao.cam);

    // ao.a is still the bound framebuffer, which is what this reads from.
    renderer.copyFramebufferToTexture(AO_TEXTURE);

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    SHARED_UNIFORMS.uAmbAO.x = 1;
    ao.ready = true;
  }

  _rebuildEnv() {
    // Render the sky dome alone into a PMREM cube for IBL.
    const skyMesh = this.sky.mesh;
    const prevParent = skyMesh.parent;
    // The sun is already a DirectionalLight; leaving its disc in the IBL would
    // double-count it as a colossal ambient term.
    const prevDisc = this.sky.material.uniforms.uSunDiscScale.value;
    const prevAlt = this.sky.material.uniforms.uCamAltitude.value;
    this.sky.material.uniforms.uSunDiscScale.value = 0.0;
    this.sky.material.uniforms.uCamAltitude.value = 400.0;
    this._envScene.add(skyMesh);
    skyMesh.position.set(0, 0, 0);
    skyMesh.scale.setScalar(500);
    if (this._envTarget) this._envTarget.dispose();
    this._envTarget = this.pmrem.fromScene(this._envScene, 0.02, 0.1, 1000);
    this.engine.scene.environment = this._envTarget.texture;
    this.engine.scene.environmentIntensity = this.envIntensity ?? 0.8;
    this.sky.material.uniforms.uSunDiscScale.value = prevDisc;
    this.sky.material.uniforms.uCamAltitude.value = prevAlt;
    if (prevParent) prevParent.add(skyMesh);
    this._envDirty = false;
  }

  /**
   * Fit each cascade to its slice of the view frustum.
   *
   * The extent is derived from the slice's bounding *sphere*, not its box, so
   * it is invariant under camera rotation — a box would breathe as you turn and
   * every shadow edge would crawl. The centre is then snapped to whole shadow
   * texels, which removes the remaining shimmer under translation.
   */
  // -------------------------------------------------------------------------
  // Shadow-caster tiers — the API src/world/ uses to keep clutter out of the
  // far cascades.
  // -------------------------------------------------------------------------

  /**
   * Register `object` as a NEAR-TIER shadow caster.
   *
   *     world.lighting.addNearShadowCaster(mesh);              // near split
   *     world.lighting.addNearShadowCaster(mesh, 45);          // explicit metres
   *     world.lighting.removeNearShadowCaster(mesh);
   *
   * A near-tier caster is a caster only while the camera is within `distance`
   * of it; past that its `castShadow` is cleared and it disappears from every
   * cascade. That is the per-cascade filter this scheme can actually offer:
   * three.js resolves object visibility in the shadow pass against the MAIN
   * camera's layer mask, not the shadow camera's (WebGLShadowMap.renderObject
   * tests `object.layers.test( camera.layers )` with the render camera), so a
   * true per-cascade mask is not expressible without hand-driving the shadow
   * pass. Distance from the camera is equivalent in effect: the near split is
   * exactly the range cascade 0 covers, so an object dropped past it was only
   * ever appearing in cascades 1 and 2.
   *
   * WHAT TO REGISTER: anything whose shadow is at most a couple of texels at
   * 30 m — small rocks, scrub, ground clutter, loose props, debris. Each one
   * costs a draw call plus its triangles in EVERY refresh of EVERY cascade it
   * falls inside, and a 4 cm pebble at 200 m contributes nothing that survives
   * the aerial perspective. Do NOT register anything a player reads as cover,
   * or anything tall enough to throw a shadow across a path.
   *
   * The default distance is the first cascade's far split, which is derived
   * from the view frustum, so it tracks `QUALITY.shadowDistance` rather than
   * being a second number to keep in sync.
   *
   * Registration is idempotent, survives the object being re-parented, and the
   * per-frame cost is one squared-distance test per registered object — so
   * register the InstancedMesh or the cluster root, not ten thousand leaves.
   */
  addNearShadowCaster(object, distance) {
    if (!object) return;
    const near = this._nearCasters || (this._nearCasters = []);
    const existing = near.find((e) => e.o === object);
    if (existing) {
      existing.d = distance ?? null;
      return;
    }
    near.push({ o: object, d: distance ?? null, was: object.castShadow });
  }

  removeNearShadowCaster(object) {
    const near = this._nearCasters;
    if (!near) return;
    const i = near.findIndex((e) => e.o === object);
    if (i < 0) return;
    // Hand it back the way it arrived: a module that unregisters mid-session
    // must not inherit whichever state the distance test happened to leave.
    near[i].o.castShadow = near[i].was;
    near.splice(i, 1);
  }

  /** Range of the first cascade — what "near tier" means, in metres. */
  get nearShadowDistance() {
    // Zero until the first fit; a registered caster must not be culled on the
    // strength of a split that has not been solved yet.
    const s = this._splits && this._splits.length > 1 ? this._splits[1] : 0;
    return s > 0 ? s : 30;
  }

  /**
   * Clear `castShadow` on near-tier casters the camera has left behind.
   *
   * Runs every fourth frame: the cutoff is a soft one (nothing pops, the object
   * is 30+ m away and its shadow was a texel), so paying a full pass over the
   * registry at 60 Hz would cost more CPU than the draw calls it removes.
   */
  _updateNearCasters(camera) {
    const near = this._nearCasters;
    if (!near || near.length === 0) return;
    if ((this._frame ?? 0) % 4 !== 0) return;
    const dflt = this.nearShadowDistance;
    const p = this._tmp.v;
    for (let i = 0; i < near.length; i++) {
      const e = near[i];
      const o = e.o;
      if (!o.parent && o !== this.engine.scene) continue;
      o.getWorldPosition(p);
      const r = (e.d ?? dflt) + (o.geometry?.boundingSphere?.radius ?? 0);
      o.castShadow = e.was && p.distanceToSquared(camera.position) <= r * r;
    }
  }

  /** Force every cascade to redraw on the next frame (shot cut, time change). */
  invalidateShadows() {
    for (const l of this.cascades) l.shadow.needsUpdate = true;
    // Local lights are allowed to cache their shadow map (a lamp on a mast over
    // a compound that does not move re-rasterises the same depth every frame).
    // Anything that opted out of three's per-frame refresh still has to redraw
    // when the key light moves, or a shot cut leaves a stale pool of shadow.
    this.engine.scene.traverse((o) => {
      if (o.isLight && o.castShadow && o.shadow && o.shadow.autoUpdate === false) o.shadow.needsUpdate = true;
    });
    this._frame = 0;
  }

  _fitCascades(camera) {
    const t = this._tmp;
    const N = this.cascadeCount;
    const near = 1.0;
    const far = this.shadowDistance;
    const lambda = 0.82;
    for (let i = 0; i <= N; i++) {
      const f = i / N;
      const logSplit = near * Math.pow(far / near, f);
      const uniSplit = near + (far - near) * f;
      this._splits[i] = lambda * logSplit + (1 - lambda) * uniSplit;
    }

    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    t.right.set(e[0], e[1], e[2]).normalize();
    t.up.set(e[4], e[5], e[6]).normalize();
    t.fwd.set(-e[8], -e[9], -e[10]).normalize();
    const camPos = camera.position;

    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const tanH = tanV * camera.aspect;
    const dir = this.keyDirection;

    for (let c = 0; c < N; c++) {
      const light = this.cascades[c];
      // A cascade that is not being redrawn this frame must not be moved: its
      // shadow matrix is only refreshed inside the shadow pass, so moving the
      // light would desync the stale map from the coordinates sampling it.
      if (c > 0) {
        const due = this._frame % this.refreshInterval[c] === this._refreshPhase[c];
        if (!due && !light.shadow.needsUpdate) continue;
        light.shadow.needsUpdate = true;
      }
      const dn = this._splits[c];
      const df = this._splits[c + 1];

      let k = 0;
      for (const d of [dn, df]) {
        const hy = d * tanV;
        const hx = d * tanH;
        for (const sy of [-1, 1]) {
          for (const sx of [-1, 1]) {
            t.corners[k++]
              .copy(camPos)
              .addScaledVector(t.fwd, d)
              .addScaledVector(t.up, hy * sy)
              .addScaledVector(t.right, hx * sx);
          }
        }
      }

      t.center.set(0, 0, 0);
      for (let i = 0; i < 8; i++) t.center.add(t.corners[i]);
      t.center.multiplyScalar(1 / 8);
      let radius = 0;
      for (let i = 0; i < 8; i++) radius = Math.max(radius, t.center.distanceTo(t.corners[i]));
      // Quantise the radius too, otherwise the texel size itself changes every
      // frame and re-introduces the crawl that snapping is meant to remove.
      radius = Math.ceil(radius * 8) / 8;

      const mapSize = light.shadow.mapSize.x;
      const texel = (2 * radius) / mapSize;
      // The light has to sit far enough back that everything which could cast
      // INTO this cascade is still in front of the shadow camera's near plane.
      // It is also the whole cost of a low sun: the shadow frustum is a box
      // 2r wide and `dist` long, so at a 2 deg dusk sun a 1.6 km extension lies
      // flat across the map and every bounding sphere in the valley intersects
      // it — dusk cost 2.3 M triangles in cascade 0 alone where noon cost 0.8 M.
      // Nothing further than the terrain's shadow-casting clipmap rings (±192 m)
      // can cast anyway; beyond that the volumetric sun shadow-height field
      // carries the kilometre-scale occlusion. `casterReach` is that number and
      // it is also the only per-cascade caster cull available without taking the
      // shadow pass away from three — see the field's comment.
      const dist = radius + this.casterReach;

      // Snap the centre to the shadow texel grid in light space.
      t.eye.copy(t.center).addScaledVector(dir, dist);
      t.m.lookAt(t.eye, t.center, THREE.Object3D.DEFAULT_UP);
      t.m.setPosition(t.eye);
      t.mi.copy(t.m).invert();
      t.v.copy(t.center).applyMatrix4(t.mi);
      t.v.x = Math.round(t.v.x / texel) * texel;
      t.v.y = Math.round(t.v.y / texel) * texel;
      t.v.applyMatrix4(t.m);

      light.position.copy(t.v).addScaledVector(dir, dist);
      light.target.position.copy(t.v);
      light.updateMatrixWorld();
      light.target.updateMatrixWorld();

      const cam = light.shadow.camera;
      cam.left = -radius;
      cam.right = radius;
      cam.top = radius;
      cam.bottom = -radius;
      cam.near = 1;
      cam.far = dist + radius + 40;
      cam.updateProjectionMatrix();

      const depthRange = cam.far - cam.near;
      // Depth bias scaled to this cascade's texel footprint; a constant bias
      // either acnes the near cascade or peter-pans the far one.
      light.shadow.bias = -(0.05 + texel * 2.2) / depthRange;
      light.shadow.normalBias = texel * 2.6 + 0.035;
      // shadowRadius carries the PCSS penumbra scale (see getShadowCSM).
      light.shadow.radius = (depthRange * this.lightAngularSize) / (2 * radius);
    }
  }

  update(dt, engine) {
    if (this._envDirty) this._rebuildEnv();
    this._frame = (this._frame ?? 0) + 1;

    // A big camera move invalidates every cached cascade at once.
    if (!this._lastCamPos) this._lastCamPos = engine.camera.position.clone();
    if (this._lastCamPos.distanceToSquared(engine.camera.position) > 9.0) {
      for (const l of this.cascades) l.shadow.needsUpdate = true;
      this._lastCamPos.copy(engine.camera.position);
    }

    // Propagate whatever the first cascade holds (tools/calibrate.mjs drives
    // `lighting.sun`, which is cascade 0) to the rest of the set.
    const key = this.cascades[0];
    for (let i = 1; i < this.cascades.length; i++) {
      this.cascades[i].intensity = key.intensity;
      this.cascades[i].color.copy(key.color);
      this.cascades[i].visible = key.visible;
    }

    // Before the cascades are fitted and rasterised, not after: a caster the
    // camera has left behind has to be gone from the map this frame draws.
    this._updateNearCasters(engine.camera);

    this._fitCascades(engine.camera);

    // Systems run before the frame is drawn, so the depth attachment this reads
    // is the one the post stack left behind last frame — and the camera has not
    // moved yet this frame either (the fly camera is order 1000), so the two
    // agree exactly rather than approximately.
    this._renderAO(engine);

    this._updateCloudShadow(engine.elapsed);

    if (this.engine.pipeline && this.atmosphere) {
      this.engine.pipeline.setAtmosphere(this.atmosphere);
    }
  }

  /**
   * Drift the cloud deck. The uniform objects are shared by reference across
   * every material's uniform set (see SHARED_UNIFORMS), so one write here moves
   * the shade patches on the terrain, the outpost and the characters at once.
   */
  _updateCloudShadow(elapsed) {
    const LT = LIGHT_TRANSPORT;
    const u = SHARED_UNIFORMS.uSkyCloudPan;
    const s = SHARED_UNIFORMS.uSkyCloudDeck;
    // Everything here mirrors the volumetric cloud pass exactly: its weather
    // map (rebuilt above from the same generator), its 46 km wrap, its wind
    // clock (uWindT = elapsed * 4) and its per-time-of-day coverage and deck
    // base, read defensively from the registry so this still works if the
    // module failed to install.
    const vol = globalThis.__WORLD?.registry?.volumetrics;
    const atm = vol?.ATMOS?.[this.todName];
    const windT = elapsed * 4.0;
    s.x = atm?.cloudBase ?? LT.cloudDeck;
    s.y = LT.cloudScale;
    s.z = LT.terminatorWidth;
    s.w = LT.cloudShadowBias;
    u.x = windT * 0.000021;
    u.y = windT * 0.0000071;
    u.z = atm?.cloudCoverage ?? LT.cloudCoverage;
    // No sun below the horizon means no cloud shadows to cast; the moon's are
    // far too weak to read and would only mottle the night grade.
    u.w = this.night > 0.5 || !weatherTexture() ? 0.0 : LT.cloudShadowStrength * (1 - this.night);
  }
}
