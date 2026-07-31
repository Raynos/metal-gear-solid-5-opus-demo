import * as THREE from 'three';
import { QUALITY, TIME_OF_DAY } from '../config/ArtDirection.js';

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
 * The filter is PCSS: an 8-tap blocker search sizes the penumbra, then a 16-tap
 * Vogel disc filters at that size. Contact points stay razor sharp and the
 * shadow softens with distance from the caster, which is the entire read of a
 * low sun raking across a ridge.
 *
 * NOTE for other authors: any *additional* shadow-casting DirectionalLight added
 * to the scene would be absorbed into this cascade scheme and misbehave. Use
 * SpotLight/PointLight for local shadowed lights; they are untouched.
 */

// ---------------------------------------------------------------------------
// Shader chunk overrides (installed once, before any material compiles)
// ---------------------------------------------------------------------------

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
    float blockerSum = 0.0;
    float blockerCount = 0.0;
    float search = 4.0 * texel.x;
    for ( int i = 0; i < 8; i ++ ) {
      float r = sqrt( ( float( i ) + 0.5 ) / 8.0 );
      float th = float( i ) * 2.39996323;
      vec2 o = rotM * ( vec2( cos( th ), sin( th ) ) * r * search );
      float d = unpackRGBAToDepth( texture2D( shadowMap, sc.xy + o ) );
      if ( d < z0 + dot( o, rp ) - length( o ) * curv ) { blockerSum += d; blockerCount += 1.0; }
    }
    if ( blockerCount < 0.5 ) return 1.0;

    float avgBlocker = blockerSum / blockerCount;
    float pen = clamp( ( z0 - avgBlocker ) * penumbraK, texel.x * 0.85, texel.x * 9.0 );

    float sum = 0.0;
    for ( int i = 0; i < 16; i ++ ) {
      float r = sqrt( ( float( i ) + 0.5 ) / 16.0 );
      float th = float( i ) * 2.39996323 + 0.7;
      vec2 o = rotM * ( vec2( cos( th ), sin( th ) ) * r * pen );
      float d = unpackRGBAToDepth( texture2D( shadowMap, sc.xy + o ) );
      sum += step( z0 + dot( o, rp ) - length( o ) * curv, d );
    }

    return mix( 1.0, sum * 0.0625, shadowIntensity );
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
			if ( csmW > 0.0005 && receiveShadow && directLight.visible ) {
				// Slope-scaled bias: the depth error of a shadow texel grows with
				// tan(acos(N.L)), so a constant bias either acnes grazing surfaces
				// or peter-pans everything that faces the light squarely.
				float csmNdL = clamp( dot( geometryNormal, directLight.direction ), 0.0, 1.0 );
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
			directLight.color *= csmS * csmW;
		}
`;

let _chunksPatched = false;
function installCSMChunks() {
  if (_chunksPatched) return;
  _chunksPatched = true;

  THREE.ShaderChunk.shadowmap_pars_fragment = THREE.ShaderChunk.shadowmap_pars_fragment + CSM_SHADOW_FN;

  const src = THREE.ShaderChunk.lights_fragment_begin;

  // Declare the cascade accumulator + a per-pixel rotation for the Vogel disc.
  // Interleaved gradient noise decorrelates the filter across pixels; TAA then
  // resolves it to a clean penumbra instead of a fixed dither pattern.
  const decl = `	DirectionalLight directionalLight;`;
  const declNew = `	DirectionalLight directionalLight;
	float csmRemain = 1.0;
	float csmRot = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) ) * 6.2831853;`;

  const oldShadowLine =
    'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';

  if (!src.includes(oldShadowLine) || !src.includes(decl)) {
    console.warn('Lighting: lights_fragment_begin shape changed; CSM override skipped.');
    return;
  }
  THREE.ShaderChunk.lights_fragment_begin = src
    .replace(decl, declNew)
    .replace(oldShadowLine, CSM_DIR_BLOCK);
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
    this.lightAngularSize = 0.028;

    const mapSizes = [QUALITY.shadowMapSize, QUALITY.shadowMapSize, QUALITY.shadowMapSize, 1024];
    // How often each cascade is re-rendered, in frames. The far cascades cover
    // hundreds of metres and are snapped to a coarse texel grid, so refreshing
    // them every frame costs a full scene draw for a result that is bit-identical
    // most of the time. Staggering the phases keeps any single frame cheap.
    // Phases are chosen so no two outer cascades ever land on the same frame.
    this.refreshInterval = [1, 2, 4, 8];
    this._refreshPhase = [0, 0, 1, 3];

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

    this.hemi = new THREE.HemisphereLight(0x9fb6d8, 0x6b5c46, 0.0);
    engine.scene.add(this.hemi);

    // Bounce light: sand kicks a lot of warm light back up into undersides.
    this.bounce = new THREE.DirectionalLight(0xc9a878, 0.55);
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

    this.setTimeOfDay('afternoon');
  }

  setTimeOfDay(nameOrPreset) {
    const p = typeof nameOrPreset === 'string' ? TIME_OF_DAY[nameOrPreset] : nameOrPreset;
    if (!p) return;
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

    for (const l of this.cascades) {
      l.color.setRGB(...p.sunColor, THREE.LinearSRGBColorSpace);
      l.intensity = p.sunIntensity;
    }

    this.hemi.color.setRGB(...p.ambientColor, THREE.LinearSRGBColorSpace);
    this.hemi.intensity = 0.0;
    this.hemi.groundColor.setRGB(0.3, 0.255, 0.19, THREE.LinearSRGBColorSpace);
    this.bounce.intensity = 0.4 * p.ambientIntensity;
    // Sky IBL is the *only* fill on a vertical surface (the bounce light points
    // straight up, so it reaches undersides and nothing else). At 0.8 a concrete
    // wall turned away from the sun landed at 2/255 — the one thing the art
    // direction explicitly forbids. Auto-exposure re-normalises the mean, so
    // this reads as lifted shadows rather than a brighter picture.
    this.envIntensity = 1.15 * p.ambientIntensity;
    this.engine.scene.environmentIntensity = this.envIntensity;

    this.sky.apply(p, this.sunDirection, this.moonDirection, night);

    // Distance haze is done properly in the post stack (see RenderPipeline's
    // aerial perspective). A thin exponential fog is kept only so alpha-blended
    // geometry, which the depth-driven pass cannot see, still recedes.
    const fogColor = new THREE.Color().setRGB(...p.fogColor, THREE.LinearSRGBColorSpace);
    this.engine.scene.fog = new THREE.FogExp2(fogColor, p.fogDensity * 0.12);

    if (this.engine.pipeline) this.engine.pipeline.exposure = p.exposure;
    this._envDirty = true;
    this.invalidateShadows();
    this._pushAtmosphere();
  }

  /**
   * Evaluate the atmosphere on the CPU and hand the post stack the numbers it
   * needs so its aerial perspective is the same physics as the sky dome: the
   * sun radiance surviving to ground level, and the average sky radiance.
   */
  _pushAtmosphere() {
    const p = this.preset;
    const pipeline = this.engine.pipeline;
    const skyExposure = this.sky.material.uniforms.uSkyExposure.value;
    const unit = skyExposure * SKY_SCALE;
    const sunIrradiance = this.sky.material.uniforms.uSunIrradiance.value;

    const rayScale = p.rayleigh / 1.9;
    const mieScale = (p.mieCoefficient / 0.0058) * (0.55 + 0.14 * p.skyTurbidity);
    const mieG = Math.min(p.mieDirectionalG, 0.82);

    const alt = 400;
    const ro = [0, Rg + alt, 0];
    const sd = [this.sunDirection.x, this.sunDirection.y, this.sunDirection.z];

    // Irradiance the haze is lit by, expressed in the SAME units the scene's
    // DirectionalLight uses. Deriving it from the light rather than from the
    // atmosphere model guarantees a hazy ridge and a lit ridge agree.
    const sunRad = [
      p.sunIntensity * p.sunColor[0],
      p.sunIntensity * p.sunColor[1],
      p.sunIntensity * p.sunColor[2],
    ];
    if (this.sunDirection.y <= 0.0) {
      for (let c = 0; c < 3; c++) sunRad[c] = 0;
    }

    // Average sky radiance over the upper hemisphere — the ambient term that
    // fills haze on the shadow side.
    const skyAvg = [0, 0, 0];
    const dirs = [];
    for (let a = 0; a < 8; a++) {
      const th = (a / 8) * Math.PI * 2;
      for (const elev of [0.06, 0.35]) {
        dirs.push([Math.cos(elev) * Math.sin(th), Math.sin(elev), Math.cos(elev) * Math.cos(th)]);
      }
    }
    dirs.push([0, 1, 0]);
    for (const d of dirs) {
      const s = scatterCPU(ro, d, sd, mieG, rayScale, mieScale);
      for (let c = 0; c < 3; c++) skyAvg[c] += s[c] * sunIrradiance * unit;
    }
    for (let c = 0; c < 3; c++) skyAvg[c] /= dirs.length;

    // At night the moon is the only source; scale a cool ambient off it.
    if (this.night > 0.01) {
      const m = this.night * p.sunIntensity;
      for (let c = 0; c < 3; c++) {
        sunRad[c] = Math.max(sunRad[c], [0.010, 0.016, 0.034][c] * m);
        skyAvg[c] = Math.max(skyAvg[c], [0.0026, 0.0042, 0.0092][c] * m);
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
  /** Force every cascade to redraw on the next frame (shot cut, time change). */
  invalidateShadows() {
    for (const l of this.cascades) l.shadow.needsUpdate = true;
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
      // can cast anyway, so 420 m is the honest number; beyond that the
      // volumetric sun shadow-height field carries the kilometre-scale occlusion.
      const dist = radius + 420;

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

    this._fitCascades(engine.camera);

    // The bounce light tracks the key so undersides stay filled from below.
    this.bounce.position.set(0, -1, 0);

    if (this.engine.pipeline && this.atmosphere) {
      this.engine.pipeline.setAtmosphere(this.atmosphere);
    }
  }
}
