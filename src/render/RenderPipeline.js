import * as THREE from 'three';
import { GRADE } from '../config/ArtDirection.js';

/**
 * RenderPipeline — HDR deferred-ish post stack.
 *
 *   scene -> HDR half-float RT (+ depth texture)
 *         -> SSAO (depth+normal reconstructed)      [ambient occlusion]
 *         -> bright-pass + separable blur chain     [bloom]
 *         -> composite: exposure, ACES filmic tonemap, split-tone grade,
 *            chromatic aberration, vignette, film grain, sharpen
 *         -> FXAA -> screen
 *
 * Every pass is a full-screen triangle. Buffers are half-float so highlights
 * carry real HDR energy into the bloom, which is what gives the sunlit-sand
 * "bleed" that reads as film.
 */

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

function makeQuad(material) {
  const geo = new THREE.BufferGeometry();
  // Full-screen triangle: fewer fragments than a quad, no diagonal seam.
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  return mesh;
}

export class RenderPipeline {
  constructor(renderer, width, height, pixelRatio) {
    this.renderer = renderer;
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = makeQuad(null);
    this.quadScene.add(this.quad);

    this.enabled = { ssao: true, bloom: true, fxaa: true };
    this.exposure = 0.88;
    this.grade = { ...GRADE };

    this._createTargets(width, height, pixelRatio);
    this._createMaterials();
  }

  _createTargets(width, height, dpr) {
    const w = Math.max(2, Math.floor(width * dpr));
    const h = Math.max(2, Math.floor(height * dpr));
    this.width = w;
    this.height = h;

    const opts = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
    };

    this.hdr = new THREE.WebGLRenderTarget(w, h, opts);
    this.hdr.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
    this.hdr.depthTexture.minFilter = THREE.NearestFilter;
    this.hdr.depthTexture.magFilter = THREE.NearestFilter;

    this.aoRT = new THREE.WebGLRenderTarget(Math.floor(w / 2), Math.floor(h / 2), { ...opts, depthBuffer: false });
    this.aoBlurRT = new THREE.WebGLRenderTarget(Math.floor(w / 2), Math.floor(h / 2), { ...opts, depthBuffer: false });
    this.compositeRT = new THREE.WebGLRenderTarget(w, h, { ...opts, depthBuffer: false });

    // Bloom mip chain
    this.bloomRTs = [];
    let bw = Math.floor(w / 2);
    let bh = Math.floor(h / 2);
    for (let i = 0; i < 5; i++) {
      this.bloomRTs.push({
        a: new THREE.WebGLRenderTarget(bw, bh, { ...opts, depthBuffer: false }),
        b: new THREE.WebGLRenderTarget(bw, bh, { ...opts, depthBuffer: false }),
        w: bw,
        h: bh,
      });
      bw = Math.max(2, Math.floor(bw / 2));
      bh = Math.max(2, Math.floor(bh / 2));
    }
  }

  _createMaterials() {
    this.ssaoMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tDepth;
        uniform vec2 uResolution;
        uniform mat4 uProjInv;
        uniform mat4 uProj;
        uniform float uRadius;
        uniform float uIntensity;
        uniform float uBias;

        float linearizeDepthToView(vec2 uv, float d, out vec3 viewPos) {
          vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
          vec4 v = uProjInv * clip;
          viewPos = v.xyz / v.w;
          return -viewPos.z;
        }

        void main() {
          float d = texture2D(tDepth, vUv).x;
          if (d >= 0.99999) { gl_FragColor = vec4(1.0); return; }
          vec3 P;
          linearizeDepthToView(vUv, d, P);

          vec3 dx = dFdx(P);
          vec3 dy = dFdy(P);
          vec3 N = normalize(cross(dx, dy));

          // Interleaved gradient noise for the rotation — cheap and stable.
          float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          float ang = ign * 6.2831853;
          float ca = cos(ang), sa = sin(ang);

          const int SAMPLES = 16;
          float occ = 0.0;
          for (int i = 0; i < SAMPLES; i++) {
            float fi = float(i);
            // Golden-angle spiral in the hemisphere.
            float t = (fi + 0.5) / float(SAMPLES);
            float r = sqrt(t);
            float phi = fi * 2.39996323;
            vec2 disk = vec2(cos(phi), sin(phi)) * r;
            disk = vec2(disk.x * ca - disk.y * sa, disk.x * sa + disk.y * ca);
            vec3 dir = vec3(disk, sqrt(max(0.0, 1.0 - t)));
            // Orient into the hemisphere around N.
            vec3 up = abs(N.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
            vec3 T = normalize(cross(up, N));
            vec3 B = cross(N, T);
            vec3 samplePos = P + (T * dir.x + B * dir.y + N * dir.z) * uRadius * (0.35 + 0.65 * t);

            vec4 sp = uProj * vec4(samplePos, 1.0);
            sp.xyz /= sp.w;
            vec2 suv = sp.xy * 0.5 + 0.5;
            if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
            float sd = texture2D(tDepth, suv).x;
            vec3 Q;
            linearizeDepthToView(suv, sd, Q);
            float dz = Q.z - samplePos.z;
            float rangeCheck = smoothstep(0.0, 1.0, uRadius / max(0.0001, abs(P.z - Q.z)));
            occ += (dz > uBias ? 1.0 : 0.0) * rangeCheck;
          }
          float ao = 1.0 - (occ / float(SAMPLES)) * uIntensity;
          gl_FragColor = vec4(clamp(ao, 0.0, 1.0), 0.0, 0.0, 1.0);
        }
      `,
      uniforms: {
        tDepth: { value: null },
        uResolution: { value: new THREE.Vector2() },
        uProjInv: { value: new THREE.Matrix4() },
        uProj: { value: new THREE.Matrix4() },
        uRadius: { value: 0.85 },
        uIntensity: { value: 1.05 },
        uBias: { value: 0.035 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform vec2 uDir;
        void main() {
          vec4 sum = texture2D(tDiffuse, vUv) * 0.227027;
          sum += texture2D(tDiffuse, vUv + uDir * 1.3846153846) * 0.3162162162;
          sum += texture2D(tDiffuse, vUv - uDir * 1.3846153846) * 0.3162162162;
          sum += texture2D(tDiffuse, vUv + uDir * 3.2307692308) * 0.0702702703;
          sum += texture2D(tDiffuse, vUv - uDir * 3.2307692308) * 0.0702702703;
          gl_FragColor = sum;
        }
      `,
      uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } },
      depthTest: false,
      depthWrite: false,
    });

    this.brightMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform float uThreshold;
        uniform float uSoftKnee;
        void main() {
          vec3 c = texture2D(tDiffuse, vUv).rgb;
          float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
          float knee = uThreshold * uSoftKnee + 1e-5;
          float soft = clamp(lum - uThreshold + knee, 0.0, 2.0 * knee);
          soft = soft * soft / (4.0 * knee);
          float contrib = max(soft, lum - uThreshold) / max(lum, 1e-5);
          gl_FragColor = vec4(c * contrib, 1.0);
        }
      `,
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: GRADE.bloomThreshold }, uSoftKnee: { value: 0.6 } },
      depthTest: false,
      depthWrite: false,
    });

    this.upsampleMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tLower;
        uniform sampler2D tHigher;
        uniform float uMix;
        void main() {
          gl_FragColor = vec4(texture2D(tHigher, vUv).rgb + texture2D(tLower, vUv).rgb * uMix, 1.0);
        }
      `,
      uniforms: { tLower: { value: null }, tHigher: { value: null }, uMix: { value: 0.85 } },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });

    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform sampler2D tBloom;
        uniform sampler2D tAO;
        uniform vec2 uResolution;
        uniform float uExposure;
        uniform float uTime;
        uniform float uBloomStrength;
        uniform float uGrain;
        uniform float uVignette;
        uniform float uCA;
        uniform float uSaturation;
        uniform float uContrast;
        uniform float uLift;
        uniform vec3 uShadowTint;
        uniform vec3 uMidTint;
        uniform vec3 uHighlightTint;
        uniform float uAOEnabled;

        // ACES filmic (Stephen Hill fit) — the long shoulder is what keeps
        // sunlit sand from clipping to a flat white blob.
        const mat3 ACESInput = mat3(
          0.59719, 0.07600, 0.02840,
          0.35458, 0.90834, 0.13383,
          0.04823, 0.01566, 0.83777
        );
        const mat3 ACESOutput = mat3(
           1.60475, -0.10208, -0.00327,
          -0.53108,  1.10813, -0.07276,
          -0.07367, -0.00605,  1.07602
        );
        vec3 RRTAndODTFit(vec3 v) {
          vec3 a = v * (v + 0.0245786) - 0.000090537;
          vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
          return a / b;
        }
        vec3 acesFitted(vec3 color) {
          color = ACESInput * color;
          color = RRTAndODTFit(color);
          color = ACESOutput * color;
          return clamp(color, 0.0, 1.0);
        }

        vec3 linearToSRGB(vec3 c) {
          return mix(c * 12.92, 1.055 * pow(max(c, 1e-5), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
        }

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        void main() {
          vec2 uv = vUv;
          vec2 center = uv - 0.5;
          float r2 = dot(center, center);

          // Chromatic aberration: radial, zero at centre, real lenses only.
          vec2 caOff = center * uCA * (0.4 + r2);
          vec3 color;
          color.r = texture2D(tDiffuse, uv + caOff).r;
          color.g = texture2D(tDiffuse, uv).g;
          color.b = texture2D(tDiffuse, uv - caOff).b;

          if (uAOEnabled > 0.5) {
            float ao = texture2D(tAO, uv).r;
            // AO must only darken *ambient*; applying it to direct sun looks
            // like dirt. We approximate by weighting with inverse luminance.
            float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
            float w = 1.0 - smoothstep(0.25, 1.4, lum);
            color *= mix(1.0, ao, w * 0.9);
          }

          vec3 bloom = texture2D(tBloom, uv).rgb;
          color += bloom * uBloomStrength;

          color *= uExposure;
          color = acesFitted(color);

          // ---- grade (operating in display-referred space) ----
          float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
          // split tone
          float sw = 1.0 - smoothstep(0.0, 0.45, lum);
          float hw = smoothstep(0.55, 1.0, lum);
          float mw = 1.0 - sw - hw;
          vec3 tint = uShadowTint * sw + uMidTint * mw + uHighlightTint * hw;
          color *= tint;
          // saturation
          color = mix(vec3(lum), color, uSaturation);
          // contrast around 0.42 pivot (filmic pivot, not 0.5)
          color = (color - 0.42) * uContrast + 0.42;
          // lift the blacks — MGSV shadows are never crushed
          color = color * (1.0 - uLift) + uLift;

          // vignette
          float vig = 1.0 - uVignette * smoothstep(0.15, 0.85, r2 * 2.0);
          color *= vig;

          // film grain, luminance-weighted (more in the mids, like real stock)
          float g = hash21(gl_FragCoord.xy + fract(uTime) * 431.71) - 0.5;
          float gw = 1.0 - abs(lum * 2.0 - 1.0);
          color += g * uGrain * gw;

          color = max(color, 0.0);
          gl_FragColor = vec4(linearToSRGB(color), 1.0);
        }
      `,
      uniforms: {
        tDiffuse: { value: null },
        tBloom: { value: null },
        tAO: { value: null },
        uResolution: { value: new THREE.Vector2() },
        uExposure: { value: 0.88 },
        uTime: { value: 0 },
        uBloomStrength: { value: GRADE.bloomStrength },
        uGrain: { value: GRADE.grainAmount },
        uVignette: { value: GRADE.vignette },
        uCA: { value: GRADE.chromaticAberration },
        uSaturation: { value: GRADE.saturation },
        uContrast: { value: GRADE.contrast },
        uLift: { value: GRADE.lift },
        uShadowTint: { value: new THREE.Vector3(...GRADE.shadowTint) },
        uMidTint: { value: new THREE.Vector3(...GRADE.midTint) },
        uHighlightTint: { value: new THREE.Vector3(...GRADE.highlightTint) },
        uAOEnabled: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.fxaaMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform vec2 uTexel;
        uniform float uSharpen;

        float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

        void main() {
          vec3 rgbM = texture2D(tDiffuse, vUv).rgb;
          vec3 rgbNW = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
          vec3 rgbNE = texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * uTexel).rgb;
          vec3 rgbSW = texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * uTexel).rgb;
          vec3 rgbSE = texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * uTexel).rgb;

          float lM = luma(rgbM), lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE);
          float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
          float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

          vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
          float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
          float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
          dir = clamp(dir * rcpDirMin, -8.0, 8.0) * uTexel;

          vec3 rgbA = 0.5 * (texture2D(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
                             texture2D(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
          vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tDiffuse, vUv + dir * -0.5).rgb +
                                           texture2D(tDiffuse, vUv + dir * 0.5).rgb);
          float lB = luma(rgbB);
          vec3 result = (lB < lMin || lB > lMax) ? rgbA : rgbB;

          // Unsharp mask restores the micro-detail FXAA smears — this is the
          // difference between "blurry web demo" and "console sharp".
          vec3 blur = (rgbNW + rgbNE + rgbSW + rgbSE) * 0.25;
          result += (result - blur) * uSharpen;

          gl_FragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
        }
      `,
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }, uSharpen: { value: GRADE.sharpen } },
      depthTest: false,
      depthWrite: false,
    });
  }

  setSize(width, height, dpr) {
    const w = Math.max(2, Math.floor(width * dpr));
    const h = Math.max(2, Math.floor(height * dpr));
    if (w === this.width && h === this.height) return;
    this.hdr.setSize(w, h);
    this.compositeRT.setSize(w, h);
    this.aoRT.setSize(Math.floor(w / 2), Math.floor(h / 2));
    this.aoBlurRT.setSize(Math.floor(w / 2), Math.floor(h / 2));
    let bw = Math.floor(w / 2);
    let bh = Math.floor(h / 2);
    for (const rt of this.bloomRTs) {
      rt.a.setSize(bw, bh);
      rt.b.setSize(bw, bh);
      rt.w = bw;
      rt.h = bh;
      bw = Math.max(2, Math.floor(bw / 2));
      bh = Math.max(2, Math.floor(bh / 2));
    }
    this.width = w;
    this.height = h;
  }

  _blit(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, false, false);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  render(renderer, scene, camera) {
    // ---- 1. main scene into HDR ----
    renderer.setRenderTarget(this.hdr);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    // Snapshot before the post passes inflate the counters.
    this.sceneStats = {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    };

    // ---- 2. SSAO ----
    if (this.enabled.ssao) {
      this.ssaoMat.uniforms.tDepth.value = this.hdr.depthTexture;
      this.ssaoMat.uniforms.uResolution.value.set(this.width, this.height);
      this.ssaoMat.uniforms.uProj.value.copy(camera.projectionMatrix);
      this.ssaoMat.uniforms.uProjInv.value.copy(camera.projectionMatrixInverse);
      this._blit(this.ssaoMat, this.aoRT);

      this.blurMat.uniforms.tDiffuse.value = this.aoRT.texture;
      this.blurMat.uniforms.uDir.value.set(2.0 / this.aoRT.width, 0);
      this._blit(this.blurMat, this.aoBlurRT);
      this.blurMat.uniforms.tDiffuse.value = this.aoBlurRT.texture;
      this.blurMat.uniforms.uDir.value.set(0, 2.0 / this.aoRT.height);
      this._blit(this.blurMat, this.aoRT);
    }

    // ---- 3. bloom ----
    if (this.enabled.bloom) {
      this.brightMat.uniforms.tDiffuse.value = this.hdr.texture;
      this.brightMat.uniforms.uThreshold.value = this.grade.bloomThreshold;
      this._blit(this.brightMat, this.bloomRTs[0].a);
      for (let i = 0; i < this.bloomRTs.length; i++) {
        const rt = this.bloomRTs[i];
        if (i > 0) {
          this.blurMat.uniforms.tDiffuse.value = this.bloomRTs[i - 1].a.texture;
          this.blurMat.uniforms.uDir.value.set(1 / rt.w, 0);
          this._blit(this.blurMat, rt.a);
        }
        this.blurMat.uniforms.tDiffuse.value = rt.a.texture;
        this.blurMat.uniforms.uDir.value.set(1 / rt.w, 0);
        this._blit(this.blurMat, rt.b);
        this.blurMat.uniforms.tDiffuse.value = rt.b.texture;
        this.blurMat.uniforms.uDir.value.set(0, 1 / rt.h);
        this._blit(this.blurMat, rt.a);
      }
      // upsample & accumulate back down the chain
      for (let i = this.bloomRTs.length - 1; i > 0; i--) {
        this.upsampleMat.uniforms.tLower.value = this.bloomRTs[i].a.texture;
        this.upsampleMat.uniforms.tHigher.value = this.bloomRTs[i - 1].a.texture;
        this.upsampleMat.uniforms.uMix.value = this.grade.bloomRadius + 0.25;
        this._blit(this.upsampleMat, this.bloomRTs[i - 1].b);
        // swap
        const t = this.bloomRTs[i - 1].a;
        this.bloomRTs[i - 1].a = this.bloomRTs[i - 1].b;
        this.bloomRTs[i - 1].b = t;
      }
    }

    // ---- 4. composite ----
    const u = this.compositeMat.uniforms;
    u.tDiffuse.value = this.hdr.texture;
    u.tBloom.value = this.enabled.bloom ? this.bloomRTs[0].a.texture : null;
    u.tAO.value = this.aoRT.texture;
    u.uAOEnabled.value = this.enabled.ssao ? 1 : 0;
    u.uBloomStrength.value = this.enabled.bloom ? this.grade.bloomStrength : 0;
    u.uExposure.value = this.exposure;
    u.uResolution.value.set(this.width, this.height);
    u.uGrain.value = this.grade.grainAmount;
    u.uVignette.value = this.grade.vignette;
    u.uCA.value = this.grade.chromaticAberration;
    u.uSaturation.value = this.grade.saturation;
    u.uContrast.value = this.grade.contrast;
    u.uLift.value = this.grade.lift;
    u.uShadowTint.value.set(...this.grade.shadowTint);
    u.uMidTint.value.set(...this.grade.midTint);
    u.uHighlightTint.value.set(...this.grade.highlightTint);

    if (this.enabled.fxaa) {
      this._blit(this.compositeMat, this.compositeRT);
      this.fxaaMat.uniforms.tDiffuse.value = this.compositeRT.texture;
      this.fxaaMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
      this.fxaaMat.uniforms.uSharpen.value = this.grade.sharpen;
      this._blit(this.fxaaMat, null);
    } else {
      this._blit(this.compositeMat, null);
    }
    renderer.setRenderTarget(null);
  }
}
