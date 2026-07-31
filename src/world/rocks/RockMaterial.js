import * as THREE from 'three';
import { PALETTE } from '../../config/ArtDirection.js';

/**
 * Rock surface — MeshStandardMaterial + onBeforeCompile, so it keeps shadows,
 * the sky IBL and fog.
 *
 * The five things that stop procedural rock reading as grey clay:
 *  1. Baked cavity/curvature (aRock.x/.y). Crevices go dark and desaturated,
 *     convex shoulders go pale and dusty. Rock lit flat looks like putty; the
 *     albedo has to already know where the geometry folds.
 *  2. Strata in the body's *local* frame, so bedding rotates with the rock and
 *     an outcrop's layers line up with its actual geometric courses.
 *  3. Analytic normal detail at two scales, faded by distance so the far field
 *     never sparkles.
 *  4. Wind-blown dust settling on up-facing surfaces and pooling at the base —
 *     the single strongest "this rock is standing in a desert" cue.
 *  5. HUE. Measured off round 1, blue exceeded red in every daylight frame and
 *     the rocks were the coldest thing in the shot — colder than the sand they
 *     sat on, which is exactly why a critic read them as debris composited in.
 *     Every constant below is now warmer in R/B than PALETTE.sandLight (1.46).
 *     Afghan limestone is a buff-to-tan carbonate, deeply iron-stained, and it
 *     is never a cool grey outside of a wet cleaved face.
 */
export function createRockMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0.0,
    // Above 1 on purpose. The sky IBL is the *only* thing lighting a rock's
    // shaded side, and measured against the terrain the shaded flank was landing
    // at 0.47 of the sand's shadow value — a crushed silhouette, which is the
    // opposite of the reference. MGSV shadows are lifted and full of sky.
    envMapIntensity: 1.02,
    dithering: true,
  });

  // Afghan limestone in full sun is only slightly darker than the sand around
  // it — PALETTE.rock* is tuned for the terrain's *shadowed cliff* case and
  // reads as near-black on a standalone boulder. These are the sunlit values.
  // R/B ratios in the comments; sand is 1.46, so nothing here may sit below it.
  mat.userData.uniforms = {
    uRockLight: { value: new THREE.Vector3(0.512, 0.441, 0.336) },  // 1.52 buff
    uRockDark: { value: new THREE.Vector3(0.322, 0.265, 0.192) },   // 1.68 tan
    uRockDeep: { value: new THREE.Vector3(0.178, 0.139, 0.098) },   // 1.82 stain
    uRockRed: { value: new THREE.Vector3(0.47, 0.302, 0.183) },     // 2.57 iron
    uSand: { value: new THREE.Vector3(...PALETTE.sandLight) },
    // Wind dust is *lighter and warmer* than the sand it came from: the fine
    // fraction is what stays airborne, and fines are pale.
    uDust: { value: new THREE.Vector3(0.566, 0.491, 0.373) },       // 1.52
    uLichen: { value: new THREE.Vector3(0.245, 0.228, 0.138) },     // 1.78 khaki
    uDetail: { value: 1.0 },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec4 aRock;    // cavity, ao, heightFrac, skirt
         attribute vec2 aTint;    // per-instance: value shift, strata phase
         varying vec3 vWPos;
         varying vec3 vWNrm;
         varying vec3 vLPos;
         varying vec4 vRock;
         varying vec2 vTint;
         varying vec3 vBedUp;   // world-space direction of the body's bedding axis`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vLPos = position;
         vRock = aRock;
         vTint = aTint;
         {
           vec4 wp = vec4(transformed, 1.0);
           vec3 wn = objectNormal;
           vec3 bu = vec3(0.0, 1.0, 0.0);
           #ifdef USE_INSTANCING
             wp = instanceMatrix * wp;
             wn = mat3(instanceMatrix) * wn;
             bu = mat3(instanceMatrix) * bu;
           #endif
           vWPos = (modelMatrix * wp).xyz;
           vWNrm = normalize(mat3(modelMatrix) * wn);
           vBedUp = normalize(mat3(modelMatrix) * bu);
         }`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vWPos;
         varying vec3 vWNrm;
         varying vec3 vLPos;
         varying vec4 vRock;
         varying vec2 vTint;
         varying vec3 vBedUp;   // world-space direction of the body's bedding axis
         uniform vec3 uRockLight;
         uniform vec3 uRockDark;
         uniform vec3 uRockDeep;
         uniform vec3 uRockRed;
         uniform vec3 uSand;
         uniform vec3 uDust;
         uniform vec3 uLichen;
         uniform float uDetail;

         // set in <map_fragment>, consumed in later chunks
         float gRough = 0.9;
         float gAO = 1.0;
         float gBedGrad = 0.0;

         float rhash(vec2 p) {
           p = floor(p);
           return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
         }
         float rnoise(vec2 p) {
           vec2 i = floor(p);
           vec2 f = fract(p);
           vec2 u = f * f * (3.0 - 2.0 * f);
           return mix(mix(rhash(i), rhash(i + vec2(1.0, 0.0)), u.x),
                      mix(rhash(i + vec2(0.0, 1.0)), rhash(i + vec2(1.0, 1.0)), u.x), u.y);
         }
         float rfbm(vec2 p, int oct) {
           float a = 0.5, s = 0.0, n = 0.0;
           mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
           for (int i = 0; i < 6; i++) {
             if (i >= oct) break;
             s += a * rnoise(p);
             n += a;
             a *= 0.5;
             p = rot * p * 2.07;
           }
           return s / n;
         }
         // Triplanar so facets at any orientation get the same grain density.
         float triF(vec3 p, vec3 n, float sc, int oct) {
           vec3 bw = pow(abs(n), vec3(4.0));
           bw /= (bw.x + bw.y + bw.z);
           return rfbm(p.yz * sc, oct) * bw.x
                + rfbm(p.xz * sc, oct) * bw.y
                + rfbm(p.xy * sc, oct) * bw.z;
         }`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         {
           vec3 wn = normalize(vWNrm);
           float dist = length(vWPos - cameraPosition);
           float fade = 1.0 - smoothstep(45.0, 320.0, dist);

           float cavity = vRock.x;              // >0 crevice, <0 exposed edge
           float bakedAO = vRock.y;
           float hFrac = vRock.z;
           float skirt = vRock.w;               // 0 rock body, 1 outer rim of the fines apron

           // Three albedo scales. The macro one matters most: it is the only
           // variation that survives to 1 km, and without it a 30 m monolith on
           // the skyline is a flat pale block — the exact "concrete prop" tell.
           float macro = triF(vWPos, wn, 0.085, 4);
           float meso  = triF(vWPos, wn, 0.9, 4);
           float micro = triF(vWPos, wn, 6.5, 3) * fade + 0.5 * (1.0 - fade);

           // --- strata, in the body's own frame so bedding rotates with it ---
           // Discrete *beds*, not a smooth gradient: each course gets its own
           // value and hardness, with a dark contact seam between them. Smooth
           // banding reads as wood grain; sedimentary rock is stacked slabs.
           // The bedding is now cut into the *geometry* (RockGeometry.beddingLedges),
           // so the shader's job here is to tint the courses, NOT to draw the
           // contacts. Round 2's first pass left both at full strength and the
           // hairline seam wrapping a rounded body read as contour lines on a
           // topographic map — a far louder tell than no bedding at all. The
           // seam is now broad and shallow, and the courses are irregular in
           // thickness rather than evenly ruled.
           float warp = rfbm(vLPos.xz * 2.1 + vTint.y * 31.0, 3) - 0.5;
           float sCoord = vLPos.y * (5.5 + rhash(vec2(vTint.y * 37.0, 1.7)) * 5.0)
                        + warp * 1.4 + vTint.y * 13.0;
           float bedId = floor(sCoord);
           float f = fract(sCoord);
           float bedTone = rhash(vec2(bedId, 3.1));
           float bedThin = rhash(vec2(bedId, 8.7));
           // contact seam: broad and soft — a weathered recess, not a drawn line
           float seam = (1.0 - smoothstep(0.0, 0.16 + bedThin * 0.16, min(f, 1.0 - f)));
           seam *= seam;
           // harder beds stand slightly proud and catch more light
           float bandHard = bedTone;

           float tone = clamp(macro * 0.5 + meso * 0.42 + micro * 0.26 + bandHard * 0.38 - 0.28,
                              0.0, 1.0);
           vec3 albedo = mix(uRockDark, uRockLight, tone);
           // deep shading patches: weathering rind, not evenly worn
           albedo *= 0.86 + 0.26 * smoothstep(0.25, 0.8, macro * 0.6 + meso * 0.4);

           // iron / manganese staining in broad low-frequency patches
           float iron = smoothstep(0.52, 0.88, rfbm(vWPos.xz * 0.05 + vWPos.y * 0.04, 4));
           albedo = mix(albedo, uRockRed, iron * 0.34);
           albedo *= 1.0 - seam * 0.20;

           // calcite veins — thin, pale, cutting across the bedding. Cheap, and
           // the single detail that most says "limestone" rather than "grey".
           float vein = smoothstep(0.9, 0.99, rfbm(vLPos.xy * 3.4 + vTint.y * 9.0, 3));
           albedo = mix(albedo, vec3(0.47, 0.455, 0.42), vein * 0.5);

           // mineral grain, close range only (it would alias into fizz further out)
           float gritFade = 1.0 - smoothstep(3.0, 26.0, dist);
           if (gritFade > 0.004) {
             float grit = triF(vWPos, wn, 26.0, 2);
             albedo *= 1.0 + (grit - 0.5) * 0.38 * gritFade;
           }

           // per-instance value shift so a cluster is not one flat colour
           albedo *= 0.88 + vTint.x * 0.26;

           // --- cavity darkening: the term that makes geometry read ---
           // uRockDeep is a warm iron/organic stain, not a neutral black. Under
           // a blue sky IBL a neutral crevice colour turns *blue*, which is how
           // round 1 ended up with rocks reading colder than the sand.
           float crev = clamp(cavity, 0.0, 1.0);
           float edge = clamp(-cavity, 0.0, 1.0);
           float microCrev = smoothstep(0.62, 0.24, micro);      // noise-scale pits
           float darkness = clamp(crev * 1.0 + microCrev * 0.45 * fade + seam * 0.12, 0.0, 1.0);
           albedo = mix(albedo, uRockDeep, darkness * 0.50);
           // Worn shoulders are sun-bleached and grit-blasted. Bleaching a rock
           // toward its own luminance makes it grey; carbonate bleaches toward
           // pale *calcite*, which is warm.
           albedo = mix(albedo, uDust * 0.90, edge * 0.34);

           // --- lichen: only where it survives, i.e. shaded crevices facing up ---
           float lichenMask = smoothstep(0.52, 0.88, rfbm(vWPos.xz * 0.9 + vWPos.y * 0.6, 3))
                            * smoothstep(-0.05, 0.45, wn.y)
                            * smoothstep(0.05, 0.5, crev + microCrev * 0.5);
           albedo = mix(albedo, uLichen, lichenMask * 0.42);

           // --- wind-blown dust: up-facing surfaces and the base of the rock ---
           // Cranked hard relative to round 1. In a desert the sky-facing half of
           // every stone is buried under a film of the surrounding fines, which
           // is what welds the rock's colour to the ground's. It also solves the
           // hue problem structurally: the dust IS the sand, so a dusty rock can
           // never be colder than the sand.
           float up = clamp(wn.y, 0.0, 1.0);
           float dust = pow(up, 1.35) * (0.44 + 0.32 * (1.0 - hFrac))
                      + (1.0 - smoothstep(0.0, 0.30, hFrac)) * 0.42;
           dust *= 0.55 + 0.65 * smoothstep(0.20, 0.80, rfbm(vWPos.xz * 0.6, 3));
           // Capped below saturation. Fully dusted the rock takes the dust colour
           // outright and a field of them reads as a scatter of white sugar cubes
           // against the ground rather than as stone with dust on it.
           dust = clamp(dust, 0.0, 0.56);
           albedo = mix(albedo, uDust, dust);

           // --- the fines apron banked against the base ---
           // Past the collar's inner lip this is not rock at all: it is drifted
           // sand, so every rock term above has to switch itself off or the
           // apron reads as a plastic flange moulded onto the boulder.
           float sk = smoothstep(0.12, 0.62, skirt);
           if (sk > 0.002) {
             vec3 fines = uSand * (0.78 + 0.40 * meso);
             // A rind of coarse grit and rock-wash right against the stone,
             // washing out to clean windblown sand at the rim. The drift must
             // NOT be the same value as the terrain around it or it vanishes and
             // the rock is back to a hard silhouette on a flat plane — the
             // deposit is coarser, darker and stained by everything that has run
             // off the rock.
             fines = mix(fines * vec3(0.68, 0.66, 0.62), fines, smoothstep(0.0, 0.85, skirt));
             // coarse grains standing proud in the drift, close range only
             fines *= 1.0 + (triF(vWPos, wn, 9.0, 2) - 0.5) * 0.30 * fade;
             albedo = mix(albedo, fines, sk);
           }

           diffuseColor.rgb *= albedo;

           // V-groove at each bedding contact, plus a small step per bed
           gBedGrad = (f < 0.5 ? 1.0 : -1.0) * seam * 0.34 + (bedTone - 0.5) * 0.14;
           gBedGrad *= 1.0 - sk;

           gRough = clamp(mix(0.94, 0.74, edge) + (micro - 0.5) * 0.14 + crev * 0.06
                        + (bedTone - 0.5) * 0.1, 0.42, 1.0);
           gRough = mix(gRough, 0.99, sk);       // loose fines have no specular lobe
           // broad occlusion + contact darkening at the base
           // Occlusion scales the *indirect* term only, so it must not be so
           // deep that a shadowed rock crushes to black — MGSV shadows are lifted.
           gAO = clamp(1.0 - max(bakedAO, 0.0) * 0.42, 0.58, 1.0)
               * mix(0.84, 1.0, smoothstep(0.0, 0.28, hFrac));
           // The drift lies in the rock's own ambient shadow near the contact and
           // opens up to full sky at the rim. That gradient is the whole reason
           // the collar reads as *banked against* the rock rather than painted on.
           gAO *= mix(1.0, mix(0.62, 1.0, smoothstep(0.15, 0.95, skirt)), step(0.002, sk));
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
           vec3 wn = normalize(vWNrm);
           float dist = length(vWPos - cameraPosition);
           // Two ranges: coarse pitting survives much further out than the fine
           // grain, which past ~200 m only aliases.
           float fadeCoarse = 1.0 - smoothstep(140.0, 720.0, dist);
           float fadeFine = 1.0 - smoothstep(18.0, 190.0, dist);
           // The fines apron is sand: it keeps the fine grain but must not take
           // the coarse rock pitting, or the drift shades like a lumpy shell.
           float skFade = 1.0 - smoothstep(0.1, 0.6, vRock.w);
           fadeCoarse *= skFade;
           vec3 nWorld = wn;
           if (fadeCoarse > 0.003) {
             float e = 0.16;
             float h0 = triF(vWPos, wn, 1.7, 3);
             float hx = triF(vWPos + vec3(e, 0.0, 0.0), wn, 1.7, 3);
             float hy = triF(vWPos + vec3(0.0, e, 0.0), wn, 1.7, 3);
             float hz = triF(vWPos + vec3(0.0, 0.0, e), wn, 1.7, 3);
             vec3 grad = (vec3(hx, hy, hz) - h0) / e;
             grad -= wn * dot(grad, wn);          // keep it tangential
             nWorld = normalize(nWorld - grad * 0.40 * uDetail * fadeCoarse);
           }
           if (fadeFine > 0.003) {
             float e = 0.035;
             float h0 = triF(vWPos, wn, 7.5, 3);
             float hx = triF(vWPos + vec3(e, 0.0, 0.0), wn, 7.5, 3);
             float hy = triF(vWPos + vec3(0.0, e, 0.0), wn, 7.5, 3);
             float hz = triF(vWPos + vec3(0.0, 0.0, e), wn, 7.5, 3);
             vec3 grad = (vec3(hx, hy, hz) - h0) / e;
             grad -= wn * dot(grad, wn);
             nWorld = normalize(nWorld - grad * 0.09 * uDetail * fadeFine);
           }
           // Bedding relief: courses are not flush, so the contacts read as real
           // steps in the surface rather than lines painted on a smooth shell.
           vec3 bedT = vBedUp - wn * dot(vBedUp, wn);
           if (dot(bedT, bedT) > 1e-5) {
             nWorld = normalize(nWorld + normalize(bedT) * gBedGrad * 0.45 * fadeCoarse);
           }
           normal = normalize((viewMatrix * vec4(nWorld, 0.0)).xyz);
         }`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
         reflectedLight.indirectDiffuse *= gAO;
         reflectedLight.indirectSpecular *= gAO;`,
      );

    mat.userData.shader = shader;
  };

  return mat;
}
