import * as THREE from 'three';
import {
  FULLSCREEN_VERT,
  DEPTH_LINEARIZE_FRAG,
  VOLUMETRIC_FRAG,
  RESOLVE_FRAG,
  COMPOSITE_FRAG,
} from './shaders.js';
import { buildCloudVolume, buildWeatherMap } from './noise.js';
import { SkyLut } from './SkyLut.js';
import { PALETTE } from '../../config/ArtDirection.js';

/**
 * VolumetricPass — the atmosphere renderer.
 *
 * Integration constraint: RenderPipeline is owned elsewhere and cannot be
 * modified, so this hooks in from both ends instead.
 *
 *   during step()      three private full-screen passes render the atmosphere
 *                      into half-res targets, reading LAST frame's HDR depth
 *                      and colour (safe: we are not bound to that framebuffer)
 *   during render()    a single in-scene quad with premultiplied blending
 *                      applies `dst*(1-a) + rgb`, i.e. extinction of everything
 *                      behind it plus the in-scattered light, in one draw call
 *
 * Everything is written in linear HDR. No tonemapping happens here.
 *
 * ## Division of labour with RenderPipeline (do NOT stack two hazes)
 *
 * RenderPipeline's `prepare` pass also implements aerial perspective. Running
 * both is exactly the round-1 over-application, so `claimHaze()` turns that one
 * off at install and this pass owns the distance haze outright — it is the only
 * place the haze, the cloud deck and the shafts can share one set of atmosphere
 * numbers. `ownsHaze` follows `pipeline.enabled.aerial` every frame, so setting
 * that flag back to true hands ownership straight back with no code change and,
 * critically, never leaves both running.
 */

/**
 * Per time-of-day atmosphere tuning. Read by name from the ToD preset.
 *
 * `sunScatter` is now a gain on the *excess over isotropic* phase energy, i.e.
 * purely the crepuscular lobe, so the values are much larger than round 1's
 * whole-sky fog gains and still cover far less of the frame.
 *
 * ## Round 4
 *
 * `apSun`/`apAmb` are gone. They were the two gains on a haze whose colour was
 * authored; the haze now takes its colour from the sky per pixel (see SkyLut.js
 * and the aerial-perspective block in shaders.js), so there is one gain left —
 * `apGain`, how completely a ray at infinity converges onto the sky. 1.0 is
 * physically exact and makes a far ridge vanish outright; the shipped values sit
 * just under it so the silhouette survives as a whisper.
 *
 * `dustWarm` is how far the dust's in-scatter chroma is pulled off the sky's own
 * toward the colour of the sunlit ground beneath it, 0 = no tilt at all. It is
 * the ONLY authored colour left in the distance haze and it is a unit-luminance
 * tilt, so it can never move the haze off the sky's brightness — only its hue.
 * Round 3's equivalent (a dust albedo of 1.25/1.02/0.70, R/B 1.79, applied to a
 * warm ground-lit source) is what measured as sepia.
 *
 * `apDesat` is the multiple-scattering flattening of that chroma, and it is
 * large at dawn and dusk for a physical reason: those are the frames whose sky
 * carries a hard, saturated solar aureole, and a dense low haze re-scatters its
 * photons several times before they arrive, mixing the aureole back toward the
 * rest of the dome. Converging the dusk ridge onto the raw aureole measured the
 * whole frame at R/B 1.83, which is the sunset postcard the art direction
 * forbids; at 0.40 it lands at 1.64 with the distance gradient intact.
 */
export const ATMOS = {
  dawn: {
    shaftDensity: 0.00120, shaftHeight: 170, sunScatter: 0.055, phaseG: 0.80, dustBand: 2.0,
    cloudCoverage: 0.46, cloudDensity: 1.05, cloudGain: 0.56, cloudAmb: 0.50, cirrus: 0.50,
    cloudBase: 1500, cloudTop: 3000, cirrusAlt: 7600, heatHaze: 0.0, cloudShadow: 0.22,
    bounce: 0.40, cloudExt: 0.034, cloudLightExt: 0.052,
    dustBeta: 4.2e-4, dustHeight: 330, apGain: 0.94, dustWarm: 0.04, apDesat: 0.48,
  },
  noon: {
    shaftDensity: 0.00042, shaftHeight: 260, sunScatter: 0.020, phaseG: 0.74, dustBand: 0.7,
    cloudCoverage: 0.30, cloudDensity: 1.0, cloudGain: 0.42, cloudAmb: 0.42, cirrus: 0.24,
    cloudBase: 1900, cloudTop: 3800, cirrusAlt: 8200, heatHaze: 1.0, cloudShadow: 0.30,
    bounce: 0.28, cloudExt: 0.040, cloudLightExt: 0.078,
    dustBeta: 4.4e-4, dustHeight: 420, apGain: 0.97, dustWarm: 0.05, apDesat: 0.12,
  },
  afternoon: {
    shaftDensity: 0.00058, shaftHeight: 250, sunScatter: 0.026, phaseG: 0.76, dustBand: 1.0,
    cloudCoverage: 0.32, cloudDensity: 1.0, cloudGain: 0.44, cloudAmb: 0.44, cirrus: 0.28,
    cloudBase: 1800, cloudTop: 3600, cirrusAlt: 8000, heatHaze: 0.85, cloudShadow: 0.28,
    bounce: 0.34, cloudExt: 0.038, cloudLightExt: 0.075,
    dustBeta: 4.4e-4, dustHeight: 360, apGain: 0.97, dustWarm: 0.05, apDesat: 0.14,
  },
  dusk: {
    shaftDensity: 0.00135, shaftHeight: 165, sunScatter: 0.060, phaseG: 0.81, dustBand: 2.2,
    cloudCoverage: 0.44, cloudDensity: 1.05, cloudGain: 0.58, cloudAmb: 0.48, cirrus: 0.52,
    cloudBase: 1500, cloudTop: 3100, cirrusAlt: 7800, heatHaze: 0.0, cloudShadow: 0.20,
    bounce: 0.44, cloudExt: 0.034, cloudLightExt: 0.052,
    dustBeta: 4.2e-4, dustHeight: 320, apGain: 0.94, dustWarm: 0.03, apDesat: 0.52,
  },
  night: {
    shaftDensity: 0.00060, shaftHeight: 200, sunScatter: 0.0, phaseG: 0.72, dustBand: 0.9,
    cloudCoverage: 0.36, cloudDensity: 0.95, cloudGain: 1.1, cloudAmb: 0.48, cirrus: 0.22,
    cloudBase: 1700, cloudTop: 3300, cirrusAlt: 7800, heatHaze: 0.0, cloudShadow: 0.0,
    bounce: 0.02, cloudExt: 0.034, cloudLightExt: 0.050,
    dustBeta: 5.0e-4, dustHeight: 480, apGain: 0.95, dustWarm: 0.0, apDesat: 0.10,
  },
};

function quad(material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  const m = new THREE.Mesh(g, material);
  m.frustumCulled = false;
  return m;
}

const _v3 = new THREE.Vector3();
const HORIZON = [0, 0, 0];

/**
 * Fraction of the air that reddens the beam which sits BELOW the cloud base —
 * i.e. how much of the camera-level solar reddening a cumulus at ~1.8 km
 * actually sees. See `_keyLight`.
 */
const DECK_AIRMASS = 0.5;

export class VolumetricPass {
  constructor(world, fields) {
    this.world = world;
    this.engine = world.engine;
    this.renderer = world.engine.renderer;
    this.fields = fields;
    this.order = 400; // after lighting (-50), before the free-fly camera (1000)

    this.cloudTex = buildCloudVolume(48);
    this.weatherTex = buildWeatherMap(256);
    this.skyLut = new SkyLut(world.sky);

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.blitQuad = quad(null);
    this.quadScene.add(this.blitQuad);

    this._prevViewProj = new THREE.Matrix4();
    this._viewProj = new THREE.Matrix4();
    this._invViewProj = new THREE.Matrix4();
    this._reset = 1;
    this._hist = 0;
    this._width = 0;
    this._height = 0;
    this.ownsHaze = false;

    this._makeMaterials();
    this._resize(1, 1);

    // The in-scene compositor. renderOrder puts it after all opaque geometry
    // but before the particle layers, which are drawn through the haze.
    this.compositeMesh = quad(this.compositeMat);
    this.compositeMesh.renderOrder = 3000;
    this.compositeMesh.name = 'volumetric-composite';
    world.scene.add(this.compositeMesh);

    this.params = { ...ATMOS.afternoon };
  }

  _makeMaterials() {
    this.depthMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: DEPTH_LINEARIZE_FRAG,
      uniforms: { tDepth: { value: null }, uNear: { value: 0.1 }, uFar: { value: 6000 } },
      depthTest: false,
      depthWrite: false,
    });

    this.volMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: VOLUMETRIC_FRAG,
      uniforms: {
        tDepth: { value: null },
        tPrevColor: { value: null },
        tSunHeight: { value: this.fields.sunHeightTex },
        tShadowMap: { value: null },
        tWeather: { value: this.weatherTex },
        tSkyLut: { value: this.skyLut.texture },
        tCloud: { value: this.cloudTex },
        uInvViewProj: { value: new THREE.Matrix4() },
        uShadowMatrix: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
        uKeyColor: { value: new THREE.Vector3(5, 4.4, 3.5) },
        uSkyZenith: { value: new THREE.Vector3(0.06, 0.09, 0.16) },
        uSkyHorizon: { value: new THREE.Vector3(0.16, 0.16, 0.18) },
        uSkyAmb: { value: new THREE.Vector3(0.12, 0.14, 0.20) },
        uGroundBounce: { value: new THREE.Vector3(0.05, 0.04, 0.025) },
        uResolution: { value: new THREE.Vector2() },
        uTime: { value: 0 },
        uFrame: { value: 0 },
        uWindT: { value: 0 },
        uTerrainSize: { value: this.fields.size },
        uShadowExtent: { value: 120 },
        uShadowCenter: { value: new THREE.Vector3() },
        uShaftDensity: { value: 0.0006 },
        uShaftHeight: { value: 250 },
        uSunScatter: { value: 0.026 },
        uPhaseG: { value: 0.76 },
        uHazeOwned: { value: 0 },
        uBetaR: { value: new THREE.Vector3(5.802e-6, 13.558e-6, 33.1e-6) },
        uBetaD: { value: new THREE.Vector3(2.6e-4, 2.6e-4, 2.6e-4) },
        // Unit-luminance chroma tilt of the dust in-scatter; see _dustTint.
        uDustAlbedo: { value: new THREE.Vector3(1, 1, 1) },
        uGroundLight: { value: new THREE.Vector3(0.45, 0.34, 0.21) },
        uBetaM: { value: 8.0e-6 },
        uDustHeight: { value: 900 },
        uApGain: { value: 0.93 },
        uApDesat: { value: 0.14 },
        uSkyMean: { value: new THREE.Vector3(1, 1, 1) },
        uSkyLutValid: { value: 0 },
        uApG: { value: 0.66 },
        uCloudCoverage: { value: 0.38 },
        uCloudBase: { value: 1800 },
        uCloudTop: { value: 3600 },
        uCloudDensity: { value: 1.0 },
        uCloudAbsorb: { value: 0.038 },
        uCloudLightExt: { value: 0.058 },
        uCloudGain: { value: 1.0 },
        uCloudAmbGain: { value: 0.8 },
        uCirrus: { value: 0.32 },
        uCirrusAlt: { value: 8000 },
        uHeatHaze: { value: 0.0 },
        uCloudShadow: { value: 0.28 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.resolveMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: RESOLVE_FRAG,
      uniforms: {
        tCurrent: { value: null },
        tHistory: { value: null },
        tDepth: { value: null },
        uInvViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
        uTexel: { value: new THREE.Vector2() },
        uBlend: { value: 0.3 },
        uReset: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        tVol: { value: null },
        tDepth: { value: null },
        uTexel: { value: new THREE.Vector2() },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      fog: false,
      toneMapped: false,
    });
  }

  _resize(w, h) {
    if (w === this._width && h === this._height) return;
    this._width = w;
    this._height = h;
    const hw = Math.max(2, Math.floor(w / 2));
    const hh = Math.max(2, Math.floor(h / 2));

    const opts = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    };
    for (const rt of [this.depthRT, this.volRT, this.histRT0, this.histRT1]) rt?.dispose();
    this.depthRT = new THREE.WebGLRenderTarget(w, h, { ...opts, format: THREE.RedFormat });
    this.volRT = new THREE.WebGLRenderTarget(hw, hh, opts);
    this.histRT0 = new THREE.WebGLRenderTarget(hw, hh, opts);
    this.histRT1 = new THREE.WebGLRenderTarget(hw, hh, opts);
    this._reset = 1;

    this.resolveMat.uniforms.uTexel.value.set(1 / hw, 1 / hh);
    this.compositeMat.uniforms.uTexel.value.set(1 / hw, 1 / hh);
    this.volMat.uniforms.uResolution.value.set(hw, hh);
  }

  _blit(material, target) {
    this.blitQuad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  /**
   * The key light driving the clouds, in renderer linear units.
   *
   * Round 1 used `sun.color * sun.intensity`, which at night is the *moon*
   * preset's placeholder sun (0.46, 0.56, 0.82) x 0.95 — a full-strength light
   * from a sun 14 degrees below the horizon. That is why night shipped with
   * near-white daylight cumulus over moonlit terrain.
   *
   * `lighting.atmosphere` is the right source for the LEVEL: Lighting builds it
   * in the same units as the scene's DirectionalLight, so a lit cloud and a lit
   * ridge agree. Sky's `keyIrradiance()` supplies the CHROMA — it knows the sun
   * has reddened through 40 airmasses at dusk, and that the key is the moon at
   * night — but only as a unit-luminance tint, clamped. Taking its level too
   * would over-attenuate the deck: that irradiance is evaluated at the camera,
   * and a cloud at 2 km sits above most of the air that reddens it.
   *
   * ## Round 5: the reddening was being applied twice
   *
   * `atm.sunRadiance` is `preset.sunColor * sunIntensity` — it already carries
   * the beam's chroma. Multiplying that by `keyIrradiance`'s chroma on top of it
   * applied the atmospheric reddening a second time: measured at afternoon, the
   * preset beam is R/B 1.258, the camera-level irradiance is R/B 1.56, and the
   * product handed to the cloud shader was R/B 1.98 — a light no sun at 27
   * degrees of elevation emits. Every lit cumulus in the build inherited it, and
   * since the deck fills the sky in a low camera, so did the sky.
   *
   * The fix takes the LEVEL from `atm.sunRadiance` as before but normalises its
   * chroma out first, so the tint is applied exactly once. It is then applied at
   * `DECK_AIRMASS` strength, because that irradiance is measured at the camera
   * and a cloud base at 1.8 km sits above roughly half the dust that does the
   * reddening — the very argument the paragraph above makes about the level.
   */
  _keyLight(out) {
    const L = this.world.lighting;
    const atm = L.atmosphere;
    const dir = atm?.sunDirection ?? L.keyDirection ?? L.sunDirection;

    let r;
    let g;
    let b;
    let preTinted = false;
    if (atm?.sunRadiance && atm.sunRadiance.every(Number.isFinite)) {
      [r, g, b] = atm.sunRadiance;
      preTinted = true;
    } else {
      const c = L.sun.color;
      const i = L.sun.intensity;
      // Without the atmosphere handle there is nothing that knows the sun is
      // down, so derive it from the geometry directly.
      const night = L.night ?? (L.sunDirection.y < 0 ? 1 : 0);
      const k = night > 0.5 ? 0.004 : 1.0;
      r = c.r * i * k;
      g = c.g * i * k;
      b = c.b * i * k;
    }

    const tint = this._skyChroma();
    out.dir = dir;
    if (preTinted) {
      // Strip the chroma the level already carries, then re-apply the sky's,
      // partially: a cloud base sees a shorter path through the reddening air
      // than the camera on the valley floor does.
      const lum = Math.max(1e-6, 0.2126 * r + 0.7152 * g + 0.0722 * b);
      const k = DECK_AIRMASS;
      out.rgb = _v3.set(
        lum * (1 + k * (tint.x - 1) + (1 - k) * (r / lum - 1)),
        lum * (1 + k * (tint.y - 1) + (1 - k) * (g / lum - 1)),
        lum * (1 + k * (tint.z - 1) + (1 - k) * (b / lum - 1)),
      );
    } else {
      out.rgb = _v3.set(r * tint.x, g * tint.y, b * tint.z);
    }
    return out;
  }

  /**
   * Read a colour out of Sky's query API, whatever shape it hands back. Returns
   * null rather than throwing if that API is absent or malformed — every caller
   * here has a working fallback.
   */
  _skyQuery(name, arg) {
    const sky = this.world.sky;
    const fn = sky?.[name];
    if (typeof fn !== 'function') return null;
    let v;
    try {
      v = fn.call(sky, arg);
    } catch {
      return null;
    }
    if (!v || typeof v === 'number') return null;
    const a = Array.isArray(v) ? v : v.isColor ? [v.r, v.g, v.b] : [v.x, v.y, v.z];
    if (a.length < 3 || !a.every((n) => Number.isFinite(n) && n >= 0)) return null;
    return a;
  }

  /** Unit-luminance chroma of the key light, or white if the API is absent. */
  _skyChroma() {
    const t = (this._chroma ??= new THREE.Vector3(1, 1, 1));
    t.set(1, 1, 1);
    const a = this._skyQuery('keyIrradiance') ?? this._skyQuery('sunIrradiance');
    if (!a) return t;
    const lum = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
    if (!(lum > 1e-9)) return t;
    t.set(a[0] / lum, a[1] / lum, a[2] / lum).clampScalar(0.4, 2.5);
    return t;
  }

  /**
   * Zenith and horizon sky radiance, straight out of Sky's own integrator, so
   * the cloud ambient and the haze ambient are literally the colours the dome
   * is painted with instead of something reconstructed from an average. Cached
   * per time-of-day: these are CPU raymarches and the answer only moves when
   * the sun does.
   */
  _refreshSkyRadiance() {
    const sd = this.world.lighting.sunDirection;
    // A horizon direction on the sun's side of the sky — that is where the
    // distant cloud deck and the far ridges actually sit.
    const h = Math.hypot(sd.x, sd.z) || 1;
    const hz = this._skyQuery('radianceInDirection', { x: (sd.x / h) * 0.9987, y: 0.05, z: (sd.z / h) * 0.9987 });
    const zn = this._skyQuery('radianceInDirection', { x: 0, y: 1, z: 0 });
    this._skyRad = hz && zn ? { zenith: zn, horizon: hz } : null;

    // The per-direction table the haze converges onto. ~670 CPU raymarches; it
    // runs when the sun moves to a new preset, not per frame.
    this.volMat.uniforms.uSkyLutValid.value = this.skyLut.build(sd) ? 1 : 0;
  }

  /** Pull colours out of the active time-of-day preset. */
  syncTimeOfDay() {
    const lighting = this.world.lighting;
    const preset = lighting.preset ?? {};
    const u = this.volMat.uniforms;
    const p = this.params;

    const key = this._keyLight((this._key ??= {}));
    u.uKeyDir.value.copy(key.dir);
    u.uKeyColor.value.copy(key.rgb);
    u.uSunDir.value.copy(lighting.sunDirection);

    // Sky radiance in the same units, split into a zenith and a horizon value.
    // The horizon is Mie-dominated — brighter, and pulled toward the sun's own
    // colour — while the zenith is Rayleigh — dimmer and blue. Keeping the two
    // apart is what stops distant cloud, which is mostly near the horizon, from
    // being tinted with a cold zenith blue.
    const sky = lighting.atmosphere?.skyRadiance ?? [0.06, 0.09, 0.16];
    const sc = preset.sunColor ?? [1, 1, 1];
    const scL = Math.max(1e-4, 0.2126 * sc[0] + 0.7152 * sc[1] + 0.0722 * sc[2]);
    if (this._skyRad) {
      const z = this._skyRad.zenith;
      const h = this._skyRad.horizon;
      u.uSkyZenith.value.set(z[0], z[1], z[2]);
      u.uSkyHorizon.value.set(h[0], h[1], h[2]);
    } else {
      // No query API: reconstruct both from the hemisphere average. The horizon
      // is built from its LUMINANCE and pushed toward the sun's chroma, because
      // the raw (blue) average would tint every distant cloud cold — the same
      // mistake at a smaller scale as round 1's grey veil.
      u.uSkyZenith.value.set(sky[0] * 0.86, sky[1] * 0.95, sky[2] * 1.12);
      const skyL = 0.2126 * sky[0] + 0.7152 * sky[1] + 0.0722 * sky[2];
      const WARM = [1.10, 1.0, 0.86];
      for (let i = 0; i < 3; i++) {
        HORIZON[i] = skyL * 1.6 * (1.0 + 0.55 * (sc[i] / scL - 1.0)) * WARM[i];
      }
      u.uSkyHorizon.value.set(HORIZON[0], HORIZON[1], HORIZON[2]);
    }
    // What a cloud TOP is filled by: the whole upper hemisphere, not the one
    // direction that happens to be dimmest. The LUT's mean is that integral
    // already; without it, fall back to the midpoint of the two endpoints.
    if (this.skyLut.valid) {
      const m = this.skyLut.mean;
      u.uSkyAmb.value.set(m[0], m[1], m[2]);
    } else {
      u.uSkyAmb.value.copy(u.uSkyZenith.value).lerp(u.uSkyHorizon.value, 0.45);
    }
    // Radiance of the sunlit desert floor: albedo/PI x irradiance. This lights
    // both the underside of the cloud deck and the suspended dust, and it is
    // the term that keeps them khaki instead of sky-blue.
    const nl = Math.max(0, lighting.sunDirection.y);
    const SAND = PALETTE.sandLight;
    u.uGroundLight.value.set(
      (SAND[0] / Math.PI) * key.rgb.x * nl,
      (SAND[1] / Math.PI) * key.rgb.y * nl,
      (SAND[2] / Math.PI) * key.rgb.z * nl,
    );

    // The same sunlit floor seen from above: the fraction of it that reaches a
    // cloud base a couple of kilometres up. Small, but it is the difference
    // between a warm-white cumulus and a blue-grey one, and a whole sky of
    // blue-grey cumulus is a large part of why round 1 read cold.
    const b = p.bounce ?? 0.18;
    u.uGroundBounce.value.copy(u.uGroundLight.value).multiplyScalar(b);

    u.uShaftDensity.value = p.shaftDensity;
    u.uShaftHeight.value = p.shaftHeight;
    u.uSunScatter.value = p.sunScatter;
    u.uPhaseG.value = p.phaseG;
    u.uCloudCoverage.value = p.cloudCoverage;
    u.uCloudDensity.value = p.cloudDensity;
    u.uCloudAbsorb.value = p.cloudExt ?? 0.038;
    u.uCloudLightExt.value = p.cloudLightExt ?? 0.058;
    u.uCloudGain.value = p.cloudGain;
    u.uCloudAmbGain.value = p.cloudAmb;
    u.uCirrus.value = p.cirrus;
    u.uCirrusAlt.value = p.cirrusAlt;
    u.uCloudBase.value = p.cloudBase;
    u.uCloudTop.value = p.cloudTop;
    u.uHeatHaze.value = p.heatHaze;
    u.uCloudShadow.value = p.cloudShadow;
    u.uHazeOwned.value = this.ownsHaze ? 1 : 0;

    // Dust load rides the art-directed fog density so the look stays tunable
    // from ArtDirection.js without touching a shader.
    const dust = (preset.fogDensity ?? 0.000095) / 0.000095;
    u.uBetaD.value.setScalar(p.dustBeta * dust);
    u.uDustHeight.value = p.dustHeight;
    u.uApGain.value = p.apGain ?? 0.93;
    u.uApDesat.value = p.apDesat ?? 0.14;
    // Where multiple scattering relaxes the haze chroma TO. Round 4 relaxed it
    // toward grey, which is a desaturation of the sky, not a redistribution of
    // it: a haze flattened toward grey is warmer than the sky it sits under, and
    // that is measurable on any far ridge. The physical target is the sky's own
    // hemispheric mean, as a unit-luminance chroma so it can only move hue.
    this._unitChroma(u.uSkyMean.value, this.skyLut.valid ? this.skyLut.mean : null);
    // Chroma of the dust in-scatter, as a UNIT-LUMINANCE tilt away from the
    // sky's own colour and toward the sunlit ground under it. Unit luminance is
    // the whole point: it means the dust can only ever change the haze's hue,
    // never its level, so the far field still lands on the sky's brightness and
    // a distant ridge cannot end up brighter or darker than the sky it fades
    // into. Round 3's uDustAlbedo was an unnormalised (1.25, 1.02, 0.70) applied
    // on top of an already-warm ground-lit source; that product is what the
    // critics measured as a constant sepia in every frame.
    this._dustTint(u.uDustAlbedo.value, p.dustWarm ?? 0.18, u.uGroundLight.value);
    // Rayleigh and Mie follow the same numbers the sky dome is drawn with, so a
    // ridge that fades into the sky fades into the colour the sky actually is.
    const ray = (preset.rayleigh ?? 1.9) / 1.9;
    u.uBetaR.value.set(5.802e-6 * ray, 13.558e-6 * ray, 33.1e-6 * ray);
    u.uBetaM.value = 8.0e-6 * ((preset.mieCoefficient ?? 0.0058) / 0.0058);
    u.uApG.value = Math.min(preset.mieDirectionalG ?? 0.8, 0.82);
  }

  /**
   * Write the dust chroma tilt into `out`: white nudged `warm` of the way toward
   * the chroma of `ground`, then renormalised to luminance 1. Falls back to
   * neutral when the ground is unlit (night), where a "warm dust" tilt would be
   * describing light that does not exist.
   */
  _dustTint(out, warm, ground) {
    const gl = 0.2126 * ground.x + 0.7152 * ground.y + 0.0722 * ground.z;
    if (!(gl > 1e-6) || warm <= 0) return out.set(1, 1, 1);
    const w = Math.min(warm, 1);
    out.set(
      1 + w * (ground.x / gl - 1),
      1 + w * (ground.y / gl - 1),
      1 + w * (ground.z / gl - 1),
    );
    const l = 0.2126 * out.x + 0.7152 * out.y + 0.0722 * out.z;
    return l > 1e-6 ? out.multiplyScalar(1 / l) : out.set(1, 1, 1);
  }

  /** Write `rgb` renormalised to luminance 1 into `out`; white if unusable. */
  _unitChroma(out, rgb) {
    if (!rgb) return out.set(1, 1, 1);
    const l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    if (!(l > 1e-9)) return out.set(1, 1, 1);
    return out.set(rgb[0] / l, rgb[1] / l, rgb[2] / l).clampScalar(0.35, 2.8);
  }

  update(dt, engine) {
    const pipeline = engine.pipeline;
    if (!pipeline || !pipeline.hdr) return;
    const cam = engine.camera;
    const lighting = this.world.lighting;

    // Ownership handshake for the distance haze — exactly one of us runs it.
    //
    // We claim it once at install (see claimHaze) by clearing RenderPipeline's
    // `aerial` flag, because the haze has to agree with the cloud deck and the
    // shafts, which live here. If anything ever sets that flag back to true we
    // stand down again on the very next frame, so the failure mode is "their
    // haze" rather than "two hazes" — which is what round 1 shipped.
    const owns = !(pipeline.enabled?.aerial ?? false);
    if (owns !== this.ownsHaze) {
      this.ownsHaze = owns;
      this._reset = 1;
    }

    // The atmosphere preset follows whatever time of day Lighting is on.
    const preset = lighting.preset;
    if (preset !== this._lastPreset) {
      this._lastPreset = preset;
      const name = Object.keys(ATMOS).find(
        (k) => Math.abs((preset?.sunElevation ?? 0) - (this._todElev(k) ?? 1e9)) < 0.01,
      );
      this.params = { ...(ATMOS[name] ?? ATMOS.afternoon) };
      this._refreshSkyRadiance();
      this._reset = 1;
    }
    this.fields.updateSun(lighting.sunDirection);
    this.syncTimeOfDay();

    this._resize(pipeline.width, pipeline.height);

    // A camera teleport (shot change, cut) invalidates the history outright;
    // reprojection cannot rescue it and the ghost lingers for a dozen frames.
    if (this._lastCamPos === undefined) this._lastCamPos = cam.position.clone();
    if (this._lastCamPos.distanceToSquared(cam.position) > 25.0) this._reset = 1;
    this._lastCamPos.copy(cam.position);

    // These camera matrices are exactly the ones the previous frame rendered
    // with, which is also the frame whose depth buffer we are about to read —
    // so the reconstruction is self-consistent even though it lags by a frame.
    this._prevViewProj.copy(this._viewProj);
    this._viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const invViewProj = this._invViewProj.copy(cam.matrixWorld).multiply(cam.projectionMatrixInverse);

    const frame = engine.frame;
    const u = this.volMat.uniforms;
    u.tDepth.value = pipeline.hdr.depthTexture;
    u.tPrevColor.value = pipeline.hdr.texture;
    u.uInvViewProj.value.copy(invViewProj);
    u.uCamPos.value.copy(cam.position);
    u.uTime.value = engine.elapsed;
    u.uFrame.value = frame % 64;
    // Clouds are kilometres across; at 1 m/s of apparent drift the deck moves a
    // pixel every few seconds, which is what a real sky does. Decoupled from
    // uTime so the shimmer and the deck do not share a beat frequency.
    u.uWindT.value = engine.elapsed * 4.0;

    const shadow = lighting.sun.shadow;
    if (shadow?.map?.texture) {
      u.tShadowMap.value = shadow.map.texture;
      u.uShadowMatrix.value.copy(shadow.matrix);
      u.uShadowExtent.value = Math.abs(shadow.camera.right);
      u.uShadowCenter.value.copy(lighting.sunTarget.position);
    } else {
      u.tShadowMap.value = null;
    }

    const prevTarget = this.renderer.getRenderTarget();

    // 1. linearise last frame's depth so in-scene materials (composite, dust)
    //    can read scene depth without touching the bound framebuffer.
    this.depthMat.uniforms.tDepth.value = pipeline.hdr.depthTexture;
    this.depthMat.uniforms.uNear.value = cam.near;
    this.depthMat.uniforms.uFar.value = cam.far;
    this._blit(this.depthMat, this.depthRT);

    // 2. raymarch the atmosphere at half resolution
    this._blit(this.volMat, this.volRT);

    // 3. temporal resolve into the history ping-pong
    const src = this._hist === 0 ? this.histRT0 : this.histRT1;
    const dst = this._hist === 0 ? this.histRT1 : this.histRT0;
    const r = this.resolveMat.uniforms;
    r.tCurrent.value = this.volRT.texture;
    r.tHistory.value = src.texture;
    r.tDepth.value = this.depthRT.texture;
    r.uInvViewProj.value.copy(invViewProj);
    r.uPrevViewProj.value.copy(this._prevViewProj);
    r.uCamPos.value.copy(cam.position);
    cam.getWorldDirection(r.uCamFwd.value);
    r.uReset.value = this._reset;
    this._blit(this.resolveMat, dst);
    this._hist ^= 1;
    this._reset = 0;

    this.compositeMat.uniforms.tVol.value = dst.texture;
    this.compositeMat.uniforms.tDepth.value = this.depthRT.texture;

    this.renderer.setRenderTarget(prevTarget);
  }

  /**
   * Claim the distance haze from RenderPipeline's `prepare` pass.
   *
   * Both passes implement aerial perspective and running both stacks two
   * hazes — the round-1 over-application. This one owns it because it is the
   * only one that can keep the haze, the cloud deck and the crepuscular shafts
   * consistent (same sky radiance, same dust load, same phase function), and
   * because it can hold the effect off the near field while still washing a
   * 3 km ridge out, which a single exponential fog cannot.
   *
   * Reverting is one flag: `engine.pipeline.enabled.aerial = true` makes this
   * pass stand down automatically on the next frame.
   */
  claimHaze() {
    const pipeline = this.engine.pipeline;
    if (!pipeline?.enabled || pipeline.enabled.aerial === false) return;
    pipeline.enabled.aerial = false;
    this.ownsHaze = true;
    this._refreshSkyRadiance();
    this.syncTimeOfDay();
  }

  /** Sun elevations of the ArtDirection presets, used to identify the ToD. */
  _todElev(name) {
    return { dawn: 4, noon: 68, afternoon: 27, dusk: 2, night: -14 }[name];
  }

  dispose() {
    this.world.scene.remove(this.compositeMesh);
    for (const rt of [this.depthRT, this.volRT, this.histRT0, this.histRT1]) rt?.dispose();
    this.cloudTex.dispose();
    this.weatherTex.dispose();
    this.skyLut.dispose();
  }
}
