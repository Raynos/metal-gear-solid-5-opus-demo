import * as THREE from 'three';
import {
  FULLSCREEN_VERT,
  DEPTH_LINEARIZE_FRAG,
  VOLUMETRIC_FRAG,
  RESOLVE_FRAG,
  COMPOSITE_FRAG,
} from './shaders.js';
import { buildCloudVolume } from './noise.js';

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
 */

/** Per time-of-day atmosphere tuning. Read by name from the ToD preset. */
export const ATMOS = {
  dawn: {
    fogDensity: 0.00120, fogHeight: 150, sunScatter: 0.62, skyScatter: 0.44, dustBand: 2.0,
    cloudCoverage: 0.58, cloudDensity: 1.0, cirrus: 0.5, heatHaze: 0.0, cloudShadow: 0.30, cloudAmbient: 0.50, phaseG: 0.76,
  },
  noon: {
    fogDensity: 0.00060, fogHeight: 250, sunScatter: 0.035, skyScatter: 0.82, dustBand: 0.7,
    cloudCoverage: 0.33, cloudDensity: 1.0, cirrus: 0.24, heatHaze: 1.0, cloudShadow: 0.34, cloudAmbient: 0.58, phaseG: 0.70,
  },
  afternoon: {
    fogDensity: 0.00074, fogHeight: 245, sunScatter: 0.050, skyScatter: 0.75, dustBand: 1.0,
    cloudCoverage: 0.36, cloudDensity: 1.0, cirrus: 0.30, heatHaze: 0.85, cloudShadow: 0.32, cloudAmbient: 0.56, phaseG: 0.73,
  },
  dusk: {
    fogDensity: 0.00140, fogHeight: 145, sunScatter: 0.66, skyScatter: 0.38, dustBand: 2.2,
    cloudCoverage: 0.56, cloudDensity: 1.0, cirrus: 0.55, heatHaze: 0.0, cloudShadow: 0.30, cloudAmbient: 0.46, phaseG: 0.78,
  },
  night: {
    fogDensity: 0.00080, fogHeight: 180, sunScatter: 0.06, skyScatter: 0.22, dustBand: 1.0,
    cloudCoverage: 0.30, cloudDensity: 0.9, cirrus: 0.25, heatHaze: 0.0, cloudShadow: 0.20, cloudAmbient: 0.10, phaseG: 0.70,
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

export class VolumetricPass {
  constructor(world, fields) {
    this.world = world;
    this.engine = world.engine;
    this.renderer = world.engine.renderer;
    this.fields = fields;
    this.order = 400; // after lighting (-50), before the free-fly camera (1000)

    this.cloudTex = buildCloudVolume(48);

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
        tCloud: { value: this.cloudTex },
        uInvViewProj: { value: new THREE.Matrix4() },
        uShadowMatrix: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Vector3(1, 1, 1) },
        uHazeColor: { value: new THREE.Vector3(0.7, 0.72, 0.78) },
        uCloudAmbient: { value: new THREE.Vector3(0.4, 0.45, 0.6) },
        uResolution: { value: new THREE.Vector2() },
        uTime: { value: 0 },
        uFrame: { value: 0 },
        uTerrainSize: { value: this.fields.size },
        uShadowExtent: { value: 120 },
        uShadowCenter: { value: new THREE.Vector3() },
        uFogDensity: { value: 0.004 },
        uFogHeight: { value: 260 },
        uFogBase: { value: 0 },
        uSunScatter: { value: 0.03 },
        uSkyScatter: { value: 0.38 },
        uPhaseG: { value: 0.73 },
        uDustBand: { value: 1.0 },
        uCloudCoverage: { value: 0.5 },
        uCloudBase: { value: 2000 },
        uCloudTop: { value: 3900 },
        uCloudDensity: { value: 1.0 },
        uCloudAbsorb: { value: 0.022 },
        uCirrus: { value: 0.45 },
        uHeatHaze: { value: 0.0 },
        uCloudShadow: { value: 0.45 },
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
        uBlend: { value: 0.22 },
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

  /** Pull colours out of the active time-of-day preset. */
  syncTimeOfDay() {
    const lighting = this.world.lighting;
    const preset = lighting.preset ?? {};
    const u = this.volMat.uniforms;
    const sun = lighting.sun;
    u.uSunColor.value.set(sun.color.r, sun.color.g, sun.color.b).multiplyScalar(sun.intensity);
    u.uSunDir.value.copy(lighting.sunDirection);

    const fog = preset.fogColor ?? [0.7, 0.72, 0.78];
    const amb = preset.ambientColor ?? [0.4, 0.45, 0.6];
    const ambI = preset.ambientIntensity ?? 1.0;
    // The in-scattered haze must be BRIGHTER and COOLER than the ground it
    // covers, or distant ridges get muddier instead of washing out to pale
    // dusty blue-grey. Mixing the sky's ambient into the fog tint is what
    // supplies that blue; fogColor alone is neutral and reads as smog.
    u.uHazeColor.value
      .set(fog[0] * 0.6 + amb[0] * 0.85, fog[1] * 0.6 + amb[1] * 0.85, fog[2] * 0.6 + amb[2] * 0.85)
      .multiplyScalar(ambI);
    u.uCloudAmbient.value.set(amb[0], amb[1], amb[2]).multiplyScalar(ambI * (this.params.cloudAmbient ?? 0.55));

    const p = this.params;
    u.uFogDensity.value = p.fogDensity;
    u.uFogHeight.value = p.fogHeight;
    u.uSunScatter.value = p.sunScatter;
    u.uSkyScatter.value = p.skyScatter;
    u.uPhaseG.value = p.phaseG;
    u.uDustBand.value = p.dustBand;
    u.uCloudCoverage.value = p.cloudCoverage;
    u.uCloudDensity.value = p.cloudDensity;
    u.uCirrus.value = p.cirrus;
    u.uHeatHaze.value = p.heatHaze;
    u.uCloudShadow.value = p.cloudShadow;
  }

  update(dt, engine) {
    const pipeline = engine.pipeline;
    if (!pipeline || !pipeline.hdr) return;
    const cam = engine.camera;
    const lighting = this.world.lighting;

    // The atmosphere preset follows whatever time of day Lighting is on.
    const preset = lighting.preset;
    if (preset !== this._lastPreset) {
      this._lastPreset = preset;
      const name = Object.keys(ATMOS).find(
        (k) => Math.abs((preset?.sunElevation ?? 0) - (this._todElev(k) ?? 1e9)) < 0.01,
      );
      this.params = { ...(ATMOS[name] ?? ATMOS.afternoon) };
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
    u.uFogBase.value = 0;

    const shadow = lighting.sun.shadow;
    if (shadow?.map?.texture) {
      u.tShadowMap.value = shadow.map.texture;
      u.uShadowMatrix.value.copy(shadow.matrix);
      u.uShadowExtent.value = Math.abs(shadow.camera.right);
      u.uShadowCenter.value.copy(lighting.sunTarget.position);
    } else {
      u.tShadowMap.value = null;
    }
    u.uCloudBase.value = 2000;
    u.uCloudTop.value = 3900;

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

  /** Sun elevations of the ArtDirection presets, used to identify the ToD. */
  _todElev(name) {
    return { dawn: 4, noon: 68, afternoon: 27, dusk: 2, night: -14 }[name];
  }

  dispose() {
    this.world.scene.remove(this.compositeMesh);
    for (const rt of [this.depthRT, this.volRT, this.histRT0, this.histRT1]) rt?.dispose();
    this.cloudTex.dispose();
  }
}
