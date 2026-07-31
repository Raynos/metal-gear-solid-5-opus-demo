import * as THREE from 'three';
import { PALETTE, QUALITY } from '../config/ArtDirection.js';

/**
 * Terrain — Afghanistan-style eroded desert highland.
 *
 * Heightfield is generated on the CPU (so gameplay can raycast it cheaply via
 * `heightAt`) and shaded with a MeshStandardMaterial whose fragment stage is
 * augmented with procedural triplanar detail: multi-octave value noise supplies
 * albedo variation, a derived normal, and slope/altitude-driven material blending
 * between sand, gravel and rock. No texture files, no seams, detail at every
 * distance.
 */

// ---- CPU noise (matches the GLSL implementation closely enough for gameplay) ----
function hash2(x, y) {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}
function smoothNoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function fbm(x, y, octaves, lacunarity = 2.03, gain = 0.5) {
  let amp = 0.5;
  let freq = 1.0;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * smoothNoise(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
/** Ridged multifractal — gives the sharp eroded spines the Afghan map is built from. */
function ridged(x, y, octaves) {
  let amp = 0.5;
  let freq = 1.0;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1.0 - Math.abs(smoothNoise(x * freq, y * freq) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.52;
    freq *= 2.07;
  }
  return sum / norm;
}

export class Terrain {
  /**
   * @param {object} opts
   * @param {number} opts.size    world extent in metres
   * @param {number} opts.segments grid resolution
   */
  constructor({ size = QUALITY.terrainSize, segments = 512 } = {}) {
    this.size = size;
    this.segments = segments;
    this.order = 10;

    this.heights = new Float32Array((segments + 1) * (segments + 1));
    this._buildHeights();

    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, this.heights[i]);
    }
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    this.geometry = geo;

    this.material = this._buildMaterial();
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.mesh.name = 'terrain';
  }

  _buildHeights() {
    const n = this.segments + 1;
    const s = this.size;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const wx = (i / this.segments - 0.5) * s;
        const wz = (j / this.segments - 0.5) * s;
        this.heights[j * n + i] = this._sampleHeight(wx, wz);
      }
    }
  }

  _sampleHeight(wx, wz) {
    const x = wx / 900;
    const z = wz / 900;
    // Continental shape: big rolling basins.
    let h = (fbm(x * 0.6 + 11.3, z * 0.6 - 7.1, 4) - 0.5) * 210;
    // Ridge network — the dominant read of the landscape.
    const ridgeMask = THREE.MathUtils.smoothstep(fbm(x * 0.35 - 3.0, z * 0.35 + 5.0, 3), 0.42, 0.85);
    h += ridged(x * 1.35, z * 1.35, 6) * 240 * ridgeMask;
    // Mid-scale erosion gullies.
    h += (fbm(x * 4.1 + 31.0, z * 4.1 - 17.0, 5) - 0.5) * 34;
    // Fine bumpiness so the silhouette never reads as smooth CG.
    h += (fbm(x * 15.0, z * 15.0, 4) - 0.5) * 5.5;

    // Carve a flat-ish valley floor near the origin for the playable outpost.
    const d = Math.sqrt(wx * wx + wz * wz);
    const basin = THREE.MathUtils.smoothstep(d, 110, 460);
    h = THREE.MathUtils.lerp(-6.0 + (fbm(x * 8, z * 8, 3) - 0.5) * 3.0, h, basin);
    return h;
  }

  /** Bilinear height lookup in world space — used by gameplay + placement. */
  heightAt(wx, wz) {
    const n = this.segments;
    const fx = (wx / this.size + 0.5) * n;
    const fz = (wz / this.size + 0.5) * n;
    if (fx < 0 || fz < 0 || fx >= n || fz >= n) return this._sampleHeight(wx, wz);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const w = n + 1;
    const h00 = this.heights[j * w + i];
    const h10 = this.heights[j * w + i + 1];
    const h01 = this.heights[(j + 1) * w + i];
    const h11 = this.heights[(j + 1) * w + i + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  normalAt(wx, wz, eps = 1.5) {
    const hL = this.heightAt(wx - eps, wz);
    const hR = this.heightAt(wx + eps, wz);
    const hD = this.heightAt(wx, wz - eps);
    const hU = this.heightAt(wx, wz + eps);
    return new THREE.Vector3(hL - hR, 2 * eps, hD - hU).normalize();
  }

  _buildMaterial() {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.94,
      metalness: 0.0,
      envMapIntensity: 0.85,
      dithering: true,
    });

    mat.userData.uniforms = {
      uSandLight: { value: new THREE.Vector3(...PALETTE.sandLight) },
      uSandDark: { value: new THREE.Vector3(...PALETTE.sandDark) },
      uRockLight: { value: new THREE.Vector3(...PALETTE.rockLight) },
      uRockDark: { value: new THREE.Vector3(...PALETTE.rockDark) },
      uRockRed: { value: new THREE.Vector3(...PALETTE.rockRed) },
      uDetailScale: { value: 1.0 },
    };

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, mat.userData.uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vWorldPos;\nvarying vec3 vWorldNormal;`)
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
           vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
           vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vWorldPos;
           varying vec3 vWorldNormal;
           uniform vec3 uSandLight;
           uniform vec3 uSandDark;
           uniform vec3 uRockLight;
           uniform vec3 uRockDark;
           uniform vec3 uRockRed;
           uniform float uDetailScale;

           // Written during <map_fragment>, consumed in <roughnessmap_fragment>
           // (roughnessFactor is not declared until that chunk).
           float gTerrainRough = 0.9;

           float thash(vec2 p) {
             p = floor(p);
             float h = dot(p, vec2(127.1, 311.7));
             return fract(sin(h) * 43758.5453123);
           }
           float tnoise(vec2 p) {
             vec2 i = floor(p);
             vec2 f = fract(p);
             vec2 u = f * f * (3.0 - 2.0 * f);
             return mix(mix(thash(i), thash(i + vec2(1.0, 0.0)), u.x),
                        mix(thash(i + vec2(0.0, 1.0)), thash(i + vec2(1.0, 1.0)), u.x), u.y);
           }
           float tfbm(vec2 p, int oct) {
             float a = 0.5, s = 0.0, n = 0.0;
             mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
             for (int i = 0; i < 8; i++) {
               if (i >= oct) break;
               s += a * tnoise(p);
               n += a;
               a *= 0.5;
               p = rot * p * 2.03;
             }
             return s / n;
           }
           // Triplanar sampling of the procedural detail, blended by the
           // world normal so cliffs never smear.
           float triFbm(vec3 wp, vec3 wn, float scale, int oct) {
             vec3 bw = pow(abs(wn), vec3(4.0));
             bw /= (bw.x + bw.y + bw.z);
             return tfbm(wp.yz * scale, oct) * bw.x
                  + tfbm(wp.xz * scale, oct) * bw.y
                  + tfbm(wp.xy * scale, oct) * bw.z;
           }`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           {
             vec3 wn = normalize(vWorldNormal);
             float slope = 1.0 - clamp(wn.y, 0.0, 1.0);

             // Distance-aware detail: keep close-up crunch without aliasing far away.
             float dist = length(vWorldPos - cameraPosition);
             float fade = 1.0 - smoothstep(30.0, 260.0, dist);

             float macro = tfbm(vWorldPos.xz * 0.0022, 5);
             float meso  = triFbm(vWorldPos, wn, 0.055, 4);
             float micro = triFbm(vWorldPos, wn, 0.62, 3);
             float grain = triFbm(vWorldPos, wn, 4.1, 2);

             // Rock exposure driven by slope, altitude and macro variation.
             float rockMask = smoothstep(0.28, 0.62, slope + macro * 0.28 - 0.08);
             float altMask = smoothstep(40.0, 190.0, vWorldPos.y);
             rockMask = clamp(rockMask + altMask * 0.35, 0.0, 1.0);

             vec3 sand = mix(uSandDark, uSandLight, clamp(meso * 0.7 + micro * 0.45 + 0.15, 0.0, 1.0));
             // Wind-ripple striping in the flats — very characteristic of the map.
             float ripple = sin(vWorldPos.x * 0.85 + tfbm(vWorldPos.xz * 0.02, 3) * 9.0) * 0.5 + 0.5;
             sand *= 1.0 + (ripple - 0.5) * 0.09 * (1.0 - slope) * fade;

             vec3 rockBase = mix(uRockDark, uRockLight, clamp(meso * 0.85 + micro * 0.4, 0.0, 1.0));
             float ironBand = smoothstep(0.55, 0.85, tfbm(vWorldPos.xz * 0.006 + vWorldPos.y * 0.01, 4));
             vec3 rock = mix(rockBase, uRockRed, ironBand * 0.55);
             // Strata: horizontal banding on steep faces.
             float strata = sin(vWorldPos.y * 0.55 + macro * 12.0) * 0.5 + 0.5;
             rock *= 1.0 + (strata - 0.5) * 0.14 * slope;

             vec3 albedo = mix(sand, rock, rockMask);
             // Gravel / scree speckle accumulating in the shallow slopes.
             float scree = smoothstep(0.62, 0.95, grain) * (1.0 - rockMask) * fade;
             albedo = mix(albedo, uRockDark * 1.25, scree * 0.45);
             albedo *= 0.92 + micro * 0.16;

             diffuseColor.rgb *= albedo;

             // Roughness varies: packed sand is smoother than broken rock.
             float rgh = mix(0.86, 0.97, rockMask);
             rgh += (micro - 0.5) * 0.13;
             gTerrainRough = clamp(rgh, 0.35, 1.0);
           }`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           roughnessFactor = gTerrainRough;`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
           {
             // Derive a detail normal from the same noise field so lighting and
             // albedo agree. Two scales: meso bumps + micro grain.
             vec3 wn = normalize(vWorldNormal);
             float dist = length(vWorldPos - cameraPosition);
             float fade = 1.0 - smoothstep(25.0, 220.0, dist);
             if (fade > 0.001) {
               float e = 0.09;
               float h0 = triFbm(vWorldPos, wn, 0.62, 2) * 0.6;
               float hx = triFbm(vWorldPos + vec3(e, 0.0, 0.0), wn, 0.62, 2) * 0.6;
               float hz = triFbm(vWorldPos + vec3(0.0, 0.0, e), wn, 0.62, 2) * 0.6;
               vec3 bump = normalize(vec3((h0 - hx) / e, 1.0, (h0 - hz) / e));
               // Blend in view space via the existing normal.
               vec3 nWorld = normalize(mix(wn, normalize(wn + bump * 0.85 - vec3(0.0, 0.85, 0.0)), fade * 0.85));
               normal = normalize((viewMatrix * vec4(nWorld, 0.0)).xyz);
             }
           }`,
        );

      mat.userData.shader = shader;
    };

    return mat;
  }

  update() {}
}
