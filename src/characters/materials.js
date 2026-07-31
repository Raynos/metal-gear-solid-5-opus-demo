import * as THREE from 'three';

/**
 * Character materials.
 *
 * All three are MeshStandard/MeshPhysical + onBeforeCompile so they inherit
 * cascade shadows, the sky PMREM and exponential fog for free (the house
 * pattern from Terrain.js).
 *
 * The trick that makes procedural surfacing hold up under animation: every
 * pattern is evaluated in **bind space** (`vBind`, the pre-skinning vertex
 * position) rather than world or view space. Camo, dirt, stubble and face
 * features are therefore glued to the body and do not swim when the character
 * moves — which is exactly what a UV-mapped texture would do, without a texture.
 *
 * Per-vertex `aZone` selects a garment region (jacket / sleeve / webbing /
 * pouch / boot / …). Kit reading as separate materials is most of what makes a
 * silhouette read as a soldier rather than a mannequin.
 */

// --- cloth zone ids ------------------------------------------------------
export const Z = {
  JACKET: 0,
  SLEEVE: 1,
  TROUSER: 2,
  VEST: 3,
  WEBBING: 4,
  POUCH: 5,
  LEATHER: 6,
  GLOVE: 7,
  KNEEPAD: 8,
  PACK: 9,
  HELMCOVER: 10,
  BANDANA: 11,
  BELT: 12,
  COLLAR: 13,
  SHIRT: 14,
  CAP: 15,
  HAIR: 16,
};

// --- skin zone ids -------------------------------------------------------
export const SZ = { FACE: 0, NECK: 1, HAND: 2, ARM: 3, EYE: 4 };

// --- metal zone ids ------------------------------------------------------
export const MZ = { GUNMETAL: 0, PROSTHETIC: 1, BRASS: 2, DARKPOLY: 3, GLASS: 4 };

const NOISE = /* glsl */ `
float ch_hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float ch_noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(ch_hash(i + vec3(0,0,0)), ch_hash(i + vec3(1,0,0)), f.x),
                 mix(ch_hash(i + vec3(0,1,0)), ch_hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(ch_hash(i + vec3(0,0,1)), ch_hash(i + vec3(1,0,1)), f.x),
                 mix(ch_hash(i + vec3(0,1,1)), ch_hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float ch_fbm(vec3 p, int oct) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * ch_noise(p);
    n += a;
    a *= 0.5;
    p *= 2.03;
    p.xy = mat2(0.8, 0.6, -0.6, 0.8) * p.xy;
  }
  return s / n;
}
// Screen-space cotangent frame: works on skinned geometry with no tangent
// attribute, which is what we need since the mesh deforms every frame.
mat3 ch_frame(vec3 N, vec3 p, vec2 uvv) {
  vec3 dp1 = dFdx(p), dp2 = dFdy(p);
  vec2 duv1 = dFdx(uvv), duv2 = dFdy(uvv);
  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float im = inversesqrt(max(dot(T, T), dot(B, B)) + 1e-12);
  return mat3(T * im, B * im, N);
}
`;

const VARYINGS = /* glsl */ `
varying vec3 vBind;
varying float vZone;
varying float vAO;
varying vec2 vUvC;
`;

function injectVertex(shader) {
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
       attribute float aZone;
       attribute float aAO;
       ${VARYINGS}`,
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vBind = position;
       vZone = aZone;
       vAO = aAO;
       vUvC = uv;`,
    );
}

// -------------------------------------------------------------------------
// Cloth
// -------------------------------------------------------------------------

/** Linear-space base colours per zone. Dusty, low-saturation — MGSV Afghanistan. */
function defaultClothPalette() {
  const c = new Array(18).fill(null).map(() => new THREE.Vector3(0.3, 0.29, 0.23));
  // Reference: a sunlit sand surface is around 0.55 linear. Fatigues are much
  // darker than the ground they stand on — that value separation is most of what
  // makes a soldier pop out of an Afghan hillside instead of dissolving into it.
  c[Z.JACKET] = new THREE.Vector3(0.158, 0.145, 0.095);
  c[Z.SLEEVE] = new THREE.Vector3(0.165, 0.151, 0.099);
  c[Z.TROUSER] = new THREE.Vector3(0.138, 0.126, 0.082);
  c[Z.VEST] = new THREE.Vector3(0.044, 0.043, 0.031);
  c[Z.WEBBING] = new THREE.Vector3(0.031, 0.03, 0.024);
  c[Z.POUCH] = new THREE.Vector3(0.05, 0.047, 0.034);
  c[Z.LEATHER] = new THREE.Vector3(0.03, 0.025, 0.02);
  c[Z.GLOVE] = new THREE.Vector3(0.024, 0.021, 0.018);
  c[Z.KNEEPAD] = new THREE.Vector3(0.013, 0.013, 0.013);
  c[Z.PACK] = new THREE.Vector3(0.07, 0.066, 0.045);
  c[Z.HELMCOVER] = new THREE.Vector3(0.088, 0.084, 0.056);
  // Snake's bandana is the one saturated accent on an otherwise khaki character.
  c[Z.BANDANA] = new THREE.Vector3(0.135, 0.017, 0.012);
  c[Z.BELT] = new THREE.Vector3(0.022, 0.021, 0.017);
  c[Z.COLLAR] = new THREE.Vector3(0.134, 0.123, 0.08);
  c[Z.SHIRT] = new THREE.Vector3(0.082, 0.079, 0.066);
  c[Z.CAP] = new THREE.Vector3(0.082, 0.078, 0.052);
  c[Z.HAIR] = new THREE.Vector3(0.042, 0.032, 0.024);
  return c;
}

const CLOTH_ROUGH = (() => {
  const r = new Array(18).fill(0.9);
  r[Z.LEATHER] = 0.6;
  r[Z.GLOVE] = 0.72;
  r[Z.KNEEPAD] = 0.66;
  r[Z.BELT] = 0.68;
  r[Z.POUCH] = 0.84;
  r[Z.VEST] = 0.86;
  r[Z.BANDANA] = 0.85;
  r[Z.HAIR] = 0.78;
  return r;
})();

const CLOTH_SHEEN = (() => {
  const s = new Array(18).fill(0.5);
  s[Z.LEATHER] = 0.1;
  s[Z.GLOVE] = 0.18;
  s[Z.KNEEPAD] = 0.12;
  s[Z.BELT] = 0.15;
  s[Z.JACKET] = 0.62;
  s[Z.SLEEVE] = 0.62;
  s[Z.TROUSER] = 0.6;
  s[Z.HAIR] = 0.9;
  return s;
})();

export function makeClothMaterial(opts = {}) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0.0,
    // Cloth sheen: a broad, rough retroreflective rim instead of a specular
    // hotspot. Without it fabric reads as painted plastic.
    sheen: 1.0,
    sheenRoughness: 0.88,
    sheenColor: new THREE.Color(0.5, 0.47, 0.42),
    specularIntensity: 0.22,
    envMapIntensity: 1.0,
    dithering: true,
  });
  mat.name = 'char-cloth';

  const palette = defaultClothPalette();
  if (opts.palette) for (const k in opts.palette) palette[k] = new THREE.Vector3(...opts.palette[k]);

  const uniforms = {
    uZoneColor: { value: palette },
    uZoneRough: { value: CLOTH_ROUGH.slice() },
    uZoneSheen: { value: CLOTH_SHEEN.slice() },
    uSeed: { value: opts.seed ?? 0 },
    uDust: { value: opts.dust ?? 0.55 },
    uWeave: { value: opts.weave ?? 1.0 },
  };
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    injectVertex(shader);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         ${VARYINGS}
         ${NOISE}
         uniform vec3 uZoneColor[18];
         uniform float uZoneRough[18];
         uniform float uZoneSheen[18];
         uniform float uSeed;
         uniform float uDust;
         uniform float uWeave;
         float gRough = 0.9;
         float gSheen = 0.5;
         vec3 gSheenCol = vec3(0.5);`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         {
           int zi = int(vZone + 0.5);
           vec3 base = uZoneColor[zi];
           float rough = uZoneRough[zi];
           gSheen = uZoneSheen[zi];

           vec3 bp = vBind * 1.0 + uSeed;

           // Dye lot / sun-bleach variation: large soft patches, then a finer
           // fibre-level mottle. Uniforms are never one flat colour.
           float macro = ch_fbm(bp * 3.1, 3);
           float meso = ch_fbm(bp * 13.0, 3);
           // Subtle: field uniforms are a solid dye lot with wear, not camouflage.
           base *= 0.92 + macro * 0.15 + meso * 0.06;
           // Sun bleach lifts and desaturates the upward-facing panels.
           float bleach = smoothstep(0.15, 0.75, ch_fbm(bp * 1.7 + 4.0, 2));
           base = mix(base, mix(base, vec3(dot(base, vec3(0.33))) * 1.22, 0.5), bleach * 0.3);

           // Thread-level weave: two crossed gratings, in metres via vUvC.
           float wu = sin(vUvC.x * 620.0) * 0.5 + 0.5;
           float wv = sin(vUvC.y * 620.0) * 0.5 + 0.5;
           float weave = (wu * wv + (1.0 - wu) * (1.0 - wv));
           base *= 0.94 + weave * 0.12 * uWeave;

           // Ground-in dust: settles low on the body, in the creases, and on
           // anything that touches the ground.
           float low = smoothstep(0.95, 0.05, vBind.y);
           float dirtN = ch_fbm(bp * 6.5 + 11.0, 4);
           float dirt = clamp(low * 0.85 + (1.0 - vAO) * 0.75, 0.0, 1.0) * smoothstep(0.28, 0.8, dirtN) * uDust;
           base = mix(base, vec3(0.128, 0.108, 0.078), dirt * 0.62);
           rough = mix(rough, 0.97, dirt * 0.7);

           // Fold shadowing in albedo as well as normal: creases in worn cotton
           // hold dirt and read darker even under flat light.
           float crease = ch_fbm(bp * 62.0, 3);
           base *= 1.0 - 0.085 * smoothstep(0.6, 0.3, crease);

           // Baked contact occlusion.
           float ao = clamp(vAO, 0.0, 1.0);
           base *= mix(0.36, 1.0, pow(ao, 1.15));

           diffuseColor.rgb *= base;
           gRough = clamp(rough + (meso - 0.5) * 0.1, 0.25, 1.0);
           // Sheen is a *whisper*. Cranked up it lights the whole garment from
           // the environment and fatigues turn into pale nylon.
           gSheenCol = mix(vec3(0.018, 0.017, 0.015), vec3(0.062, 0.059, 0.054), ao) * gSheen;
         }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = gRough;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         {
           // Fabric normal: fine weave + folds. Fold amplitude is driven by the
           // baked AO, so wrinkles gather where the garment actually bunches —
           // inside elbows, behind knees, under the chest rig.
           mat3 tbn = ch_frame(normal, -vViewPosition, vUvC);
           float th = sin(vUvC.x * 620.0) * sin(vUvC.y * 620.0);
           vec2 nWeave = vec2(cos(vUvC.x * 620.0) * sin(vUvC.y * 620.0),
                              sin(vUvC.x * 620.0) * cos(vUvC.y * 620.0)) * 0.055 * uWeave;

           float foldAmp = mix(0.5, 1.6, 1.0 - clamp(vAO, 0.0, 1.0));
           vec3 fp = vBind * 26.0 + uSeed * 3.0;
           float e = 0.09;
           float h0 = ch_fbm(fp, 3);
           float hx = ch_fbm(fp + vec3(e, 0.0, 0.0), 3);
           float hy = ch_fbm(fp + vec3(0.0, e, 0.0), 3);
           vec2 nFold = vec2(h0 - hx, h0 - hy) * 13.0 * foldAmp;

           vec3 tn = normalize(vec3(nWeave + nFold, 1.0));
           normal = normalize(tbn * tn);
         }`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
         material.sheenColor = gSheenCol;
         material.sheenRoughness = 0.9;`,
      );

    mat.userData.shader = shader;
  };
  return mat;
}

// -------------------------------------------------------------------------
// Skin
// -------------------------------------------------------------------------

export function makeSkinMaterial(opts = {}) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.55,
    metalness: 0.0,
    // Skin's specular is broad and weak. A default dielectric F0 with low
    // roughness is exactly the "wet plastic doll" look we must avoid.
    specularIntensity: 0.35,
    envMapIntensity: 0.95,
    dithering: true,
  });
  mat.name = 'char-skin';

  const uniforms = {
    uSkin: { value: new THREE.Vector3(...(opts.tone ?? [0.30, 0.188, 0.138])) },
    uSSS: { value: new THREE.Vector3(...(opts.sss ?? [0.62, 0.30, 0.22])) },
    uSSSAmount: { value: opts.sssAmount ?? 0.22 },
    uSeed: { value: opts.seed ?? 0 },
    uStubble: { value: opts.stubble ?? 0.5 },
    uBrow: { value: opts.brow ?? 1.0 },
  };
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    injectVertex(shader);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         ${VARYINGS}
         ${NOISE}
         uniform vec3 uSkin;
         uniform vec3 uSSS;
         uniform float uSSSAmount;
         uniform float uSeed;
         uniform float uStubble;
         uniform float uBrow;
         float gRough = 0.55;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         {
           vec3 c = uSkin;
           vec3 bp = vBind * 1.0 + uSeed * 0.7;

           // Dermal mottling: blotchy melanin + a finer capillary red.
           float m1 = ch_fbm(bp * 9.0, 3);
           float m2 = ch_fbm(bp * 34.0, 3);
           c *= 0.9 + m1 * 0.2;
           c = mix(c, c * vec3(1.16, 0.9, 0.86), smoothstep(0.45, 0.85, m1) * 0.55);
           c *= 0.96 + m2 * 0.08;

           // Face features, keyed to bind space so they never swim.
           vec3 hp = vBind - vec3(0.0, 1.655, -0.012);
           if (vZone > 3.5) {
             // Eyeball: sclera, limbal ring, iris, pupil.
             float ax2 = abs(hp.x);
             vec2 iv = vec2(ax2 - 0.0325, hp.y - 0.006);
             float fwd = smoothstep(-0.061, -0.069, hp.z);
             float ir = length(vec2(iv.x, iv.y * 1.03));
             vec3 sclera = vec3(0.30, 0.272, 0.252) * (0.85 + 0.24 * ch_fbm(vBind * 900.0, 2));
             vec3 iris = vec3(0.055, 0.036, 0.021) * (0.7 + 0.9 * ch_fbm(vBind * 2600.0, 2));
             vec3 c2 = mix(sclera, iris, smoothstep(0.0064, 0.0048, ir) * fwd);
             c2 = mix(c2, vec3(0.005), smoothstep(0.0028, 0.0019, ir) * fwd);
             // Painted lids: outside the almond aperture the eyeball is shaded
             // as skin, so the sphere merges into the socket without needing
             // separate eyelid geometry.
             float aperture = smoothstep(0.0072, 0.0050, abs(iv.y) + max(0.0, abs(iv.x) - 0.0026) * 0.62);
             float open = aperture * fwd;
             vec3 lid = uSkin * 0.62;
             c2 = mix(lid, c2, open);
             c2 *= mix(0.22, 1.0, clamp(vAO, 0.0, 1.0));
             diffuseColor.rgb *= c2;
             gRough = mix(0.6, 0.13, open);
           } else {
           float isHead = smoothstep(-0.14, -0.06, hp.y) * step(vZone, 0.5);
           if (isHead > 0.0) {
             float ax = abs(hp.x);
             // Brow ridge shadow + eyebrow.
             // Eyebrow: a 9 mm hair band, not a mask. Too generous here and the
             // whole mid-face goes dark.
             float brow = smoothstep(0.048, 0.030, ax) *
                          smoothstep(0.013, 0.004, abs(hp.y - 0.0295 + ax * 0.12)) *
                          smoothstep(-0.055, -0.072, hp.z);
             c = mix(c, vec3(0.055, 0.04, 0.032), clamp(brow, 0.0, 1.0) * 0.8 * uBrow * isHead);
             // Soft shadow under the brow ridge.
             float browShade = smoothstep(0.055, 0.02, ax) *
                               smoothstep(0.022, 0.006, abs(hp.y - 0.021)) *
                               smoothstep(-0.05, -0.068, hp.z);
             c *= 1.0 - 0.22 * clamp(browShade, 0.0, 1.0) * isHead;
             // Lash line only — the eye itself is real geometry now. Painting a
             // 20 mm dark disc per eye on top of it turned the whole mid-face
             // into a mask.
             vec2 ev = vec2(ax - 0.032, hp.y - 0.008);
             float lash = smoothstep(0.016, 0.010, length(ev * vec2(0.8, 2.6))) *
                          smoothstep(-0.050, -0.066, hp.z);
             c = mix(c, vec3(0.05, 0.04, 0.035), clamp(lash, 0.0, 1.0) * 0.7 * isHead);
             // Nostril + philtrum shadow.
             float nose = smoothstep(0.016, 0.006, abs(ax - 0.011)) *
                          smoothstep(0.012, 0.004, abs(hp.y + 0.030)) *
                          smoothstep(-0.075, -0.09, hp.z);
             c = mix(c, vec3(0.05, 0.032, 0.026), clamp(nose, 0.0, 1.0) * 0.8 * isHead);
             // Mouth line.
             float lip = smoothstep(0.030, 0.008, ax) *
                         smoothstep(0.008, 0.001, abs(hp.y + 0.052)) *
                         smoothstep(-0.066, -0.078, hp.z);
             c = mix(c, vec3(0.13, 0.055, 0.048), clamp(lip, 0.0, 1.0) * 0.75 * isHead);
             // Stubble across the jaw and upper lip.
             float beardRegion = smoothstep(-0.020, -0.060, hp.y) * smoothstep(0.10, 0.045, ax + max(0.0, hp.z + 0.02));
             float grain = smoothstep(0.35, 0.75, ch_fbm(vBind * 420.0, 2));
             c = mix(c, c * vec3(0.52, 0.55, 0.58), clamp(beardRegion, 0.0, 1.0) * (0.35 + grain * 0.5) * uStubble * isHead);
           }

           if (vZone > 0.5 && vZone < 1.5) {
             // Neck: shaded by the collar and the jaw.
             c *= mix(0.42, 1.0, smoothstep(1.5, 1.585, vBind.y));
           }
           float ao = clamp(vAO, 0.0, 1.0);
           c *= mix(0.55, 1.0, pow(ao, 1.0));
           diffuseColor.rgb *= c;

           // Oilier on the forehead and nose, drier on the cheeks and hands.
           float oily = smoothstep(-0.02, 0.06, hp.y) * isHead;
           gRough = clamp(mix(0.62, 0.42, oily) + (m2 - 0.5) * 0.12, 0.3, 0.9);
           }
         }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = gRough;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         {
           mat3 tbn = ch_frame(normal, -vViewPosition, vUvC);
           vec3 pp = vBind * 300.0;
           float e = 0.6;
           float h0 = ch_fbm(pp, 2);
           vec2 g = vec2(h0 - ch_fbm(pp + vec3(e, 0.0, 0.0), 2), h0 - ch_fbm(pp + vec3(0.0, e, 0.0), 2));
           normal = normalize(tbn * normalize(vec3(g * 1.6, 1.0)));
         }`,
      )
      // Subsurface: wrapped diffuse with a blood-red tint in the terminator.
      // This single term is the difference between skin and painted plastic.
      .replace(
        '#include <lights_physical_pars_fragment>',
        `#include <lights_physical_pars_fragment>
         void RE_Direct_Skin(const in IncidentLight directLight, const in vec3 geometryPosition,
                             const in vec3 geometryNormal, const in vec3 geometryViewDir,
                             const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material,
                             inout ReflectedLight reflectedLight) {
           float ndl = dot(geometryNormal, directLight.direction);
           float lam = saturate(ndl);
           vec3 irradiance = lam * directLight.color;
           reflectedLight.directSpecular += irradiance * BRDF_GGX(directLight.direction, geometryViewDir, geometryNormal, material);
           reflectedLight.directDiffuse += irradiance * BRDF_Lambert(material.diffuseColor);
           // Wrapped diffuse minus lambert = the light that only exists because
           // light scattered *through* the skin. Must go through the same
           // 1/PI normalisation as the lambert lobe or it swamps it and the
           // character turns into raw meat.
           float wrapped = saturate((ndl + 0.42) / 1.42);
           reflectedLight.directDiffuse += (wrapped - lam) * directLight.color * uSSS * uSSSAmount * BRDF_Lambert(material.diffuseColor);
         }
         #undef RE_Direct
         #define RE_Direct RE_Direct_Skin`,
      );

    mat.userData.shader = shader;
  };
  return mat;
}

// -------------------------------------------------------------------------
// Metal — weapons, the prosthetic arm, buckles
// -------------------------------------------------------------------------

export function makeMetalMaterial(opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.55,
    metalness: 1.0,
    envMapIntensity: 1.0,
    dithering: true,
  });
  mat.name = 'char-metal';

  const colors = [
    new THREE.Vector3(0.052, 0.053, 0.056), // gunmetal, phosphate-black
    new THREE.Vector3(0.082, 0.021, 0.017), // prosthetic: matte oxide red
    new THREE.Vector3(0.36, 0.26, 0.11), // brass
    new THREE.Vector3(0.028, 0.028, 0.03), // polymer furniture (dielectric)
    new THREE.Vector3(0.03, 0.05, 0.06), // optic glass
  ];
  const uniforms = {
    uMetalColor: { value: colors },
    uSeed: { value: opts.seed ?? 0 },
  };
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    injectVertex(shader);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         ${VARYINGS}
         ${NOISE}
         uniform vec3 uMetalColor[5];
         uniform float uSeed;
         float gRough = 0.55;
         float gMetal = 1.0;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         {
           int zi = int(vZone + 0.5);
           vec3 base = uMetalColor[zi];
           float ao = clamp(vAO, 0.0, 1.0);

           // Anodised / phosphated finishes are MATTE — the read is a soft wide
           // highlight, never a mirror. Roughness stays high; variation comes
           // from handling wear, not from a gloss coat.
           float rough = 0.62;
           float metal = 1.0;
           if (zi == 1) { rough = 0.74; metal = 0.55; }
           if (zi == 3) { rough = 0.72; metal = 0.0; }
           if (zi == 4) { rough = 0.12; metal = 0.0; }

           float grain = ch_fbm(vBind * 900.0 + uSeed, 2);
           rough += (grain - 0.5) * 0.16;

           // Directional micro-scratches from cleaning and carry.
           float scr = ch_fbm(vec3(vBind.x * 40.0, vBind.y * 620.0, vBind.z * 40.0) + uSeed * 5.0, 3);
           rough -= smoothstep(0.62, 0.9, scr) * 0.2;

           // Edge wear: exposed geometry (high AO) polishes down to bright steel.
           float wear = smoothstep(0.86, 1.0, ao) * smoothstep(0.4, 0.75, ch_fbm(vBind * 55.0 + 3.0, 3));
           base = mix(base, vec3(0.34, 0.335, 0.325), wear * 0.55 * (zi == 4 ? 0.0 : 1.0));
           rough = mix(rough, 0.3, wear * 0.5);

           base *= mix(0.3, 1.0, pow(ao, 1.15));
           diffuseColor.rgb *= base;
           gRough = clamp(rough, 0.06, 1.0);
           gMetal = metal;
         }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = gRough;`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
         metalnessFactor = gMetal;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         {
           mat3 tbn = ch_frame(normal, -vViewPosition, vUvC);
           vec3 pp = vBind * 700.0;
           float e = 0.5;
           float h0 = ch_fbm(pp, 2);
           vec2 g = vec2(h0 - ch_fbm(pp + vec3(e, 0.0, 0.0), 2), h0 - ch_fbm(pp + vec3(0.0, e, 0.0), 2));
           normal = normalize(tbn * normalize(vec3(g * 1.1, 1.0)));
         }`,
      );

    mat.userData.shader = shader;
  };
  return mat;
}

/** Boot soles, rifle grips, kneepad rubber. */
export function makeRubberMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.026, 0.025, 0.024),
    roughness: 0.86,
    metalness: 0.0,
    envMapIntensity: 0.55,
  });
  mat.name = 'char-rubber';
  mat.onBeforeCompile = (shader) => {
    injectVertex(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${VARYINGS}\n${NOISE}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         {
           float ao = clamp(vAO, 0.0, 1.0);
           float dust = smoothstep(0.4, 0.85, ch_fbm(vBind * 40.0, 3));
           diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.14, 0.11), dust * 0.5);
           diffuseColor.rgb *= mix(0.4, 1.0, ao);
         }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         {
           mat3 tbn = ch_frame(normal, -vViewPosition, vUvC);
           vec3 pp = vBind * 220.0;
           float h0 = ch_fbm(pp, 2);
           vec2 g = vec2(h0 - ch_fbm(pp + vec3(0.6, 0.0, 0.0), 2), h0 - ch_fbm(pp + vec3(0.0, 0.6, 0.0), 2));
           normal = normalize(tbn * normalize(vec3(g * 2.4, 1.0)));
         }`,
      );
  };
  return mat;
}

export function makeMaterialSet(opts = {}) {
  return {
    cloth: makeClothMaterial(opts.cloth ?? {}),
    skin: makeSkinMaterial(opts.skin ?? {}),
    metal: makeMetalMaterial(opts.metal ?? {}),
    rubber: makeRubberMaterial(),
  };
}
