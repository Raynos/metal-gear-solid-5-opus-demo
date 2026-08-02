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
/**
 * World-space wind, matched to the terrain's blown-sand relief.
 *
 * ROUND 5: THIS WAS 48 DEGREES OUT AND HAD BEEN SINCE IT WAS WRITTEN.
 *
 * The old derivation came from a ripple field Terrain.js no longer has — it read
 * `sin((u*27 + v*10)*2pi)` off a 64 m wrapping tile and concluded the wind ran
 * along (27, 10), i.e. 20.3 degrees measured from +X. Terrain now bakes its
 * ripples into a 1.6 m tile that the ground shader samples in a rotated frame:
 * `rw = rot(vWPos.xz, WIND_SC)` with `WIND_SC = (cos W, sin W)`, `W = 0.38 rad`,
 * and the ripple phase advances along `rw.y`. Crests lie ACROSS the flow, so the
 * wind runs along the ripple wave vector, which in world XZ is
 * `(sin W, cos W)` — 68.2 degrees from +X, not 20.3.
 *
 * Measured against the shipped ground: the two vectors have a dot product of
 * 0.67, so every drift in the game was banked 48 degrees off the sand ripple it
 * was supposed to agree with, which is worse than having no drift at all. These
 * two lines are now derived from Terrain's own `WIND` constant and its own
 * rotation convention, so a retune there moves the rocks with it.
 */
const TERRAIN_WIND = 0.38;   // rad; Terrain.js `const WIND`
export const WIND_DIR = [Math.sin(TERRAIN_WIND), Math.cos(TERRAIN_WIND)];

/**
 * Talus apron surface — the material for the WEDGE, not for the blocks on it.
 *
 * A scree slope is not a rock and it is not sand. It is a graded mass of angular
 * fragments, and the two things that make it read as one are (a) the grain-size
 * gradient down its length — silt and chips banked at the head, blocks at the
 * toe, which is the most recognisable property of a talus slope after its angle
 * — and (b) that it is a shade or two DARKER and warmer than the pediment it
 * runs out onto. A scree apron the same value as the plain is a smooth fillet
 * with a texture on it, which is exactly what the round-4 range foot was.
 *
 * `aTal` carries (t along the fall line, lobe weight, per-site random), so the
 * grain scale, the value and the normal amplitude are all driven by position on
 * the apron rather than by a world noise that knows nothing about the landform.
 */
export function createTalusMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.96,
    metalness: 0.0,
    // Same argument as the rock body: the shaded half of a scree slope is lit by
    // the sky and nothing else, and MGSV shadows are lifted and full of it.
    envMapIntensity: 1.22,
    dithering: true,
  });

  mat.userData.uniforms = {
    // Broken limestone: the same buff as the boulders, a little darker because a
    // scree surface is all shadowed interstice, and warmer than the sand it
    // meets so the apron never reads cool against the pediment.
    // Measured against the shipped terrain: the first pass ran these ~25%
    // brighter and the apron boundary read as a pale scar across the hillside.
    // A scree slope is a mass of shadowed interstices — it is a little DARKER
    // than the rock it came off and distinctly warmer than the pediment it runs
    // out onto, never lighter than either.
    uTalLight: { value: new THREE.Vector3(0.322, 0.252, 0.152) },   // R/B 2.12
    uTalDark: { value: new THREE.Vector3(0.186, 0.136, 0.077) },    // R/B 2.42
    uTalDust: { value: new THREE.Vector3(0.430, 0.348, 0.226) },    // R/B 1.90
    uDetail: { value: 1.0 },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec3 aTal;   // (t head->toe, lobe, site random)
         varying vec3 vTal;
         varying vec3 vTWPos;
         varying vec3 vTWNrm;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         vTal = aTal;
         vTWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
         vTWNrm = normalize(mat3(modelMatrix) * objectNormal);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vTal;
         varying vec3 vTWPos;
         varying vec3 vTWNrm;
         uniform vec3 uTalLight;
         uniform vec3 uTalDark;
         uniform vec3 uTalDust;
         uniform float uDetail;
         float gTalRough = 0.96;

         float thash(vec2 p) {
           p = floor(p);
           return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
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
           for (int i = 0; i < 5; i++) {
             if (i >= oct) break;
             s += a * tnoise(p); n += a; a *= 0.5; p = rot * p * 2.09;
           }
           return s / n;
         }`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         {
           float dist = length(vTWPos - cameraPosition);
           float head = vTal.x;    // 1 deep against the rock, 0 at the thin toe
           float margin = vTal.y;  // 0 at the outer edge of the pile
           float rnd = vTal.z;
           // RAGGED MARGIN. The apron mesh ends on a grid diagonal, and since
           // the pile is a different material from the ground it lands on, that
           // boundary rendered as a row of sawtooth teeth across the hillside —
           // the single most obvious artefact in the first render of this pass.
           // Stippling it out against a world-space noise turns the mesh edge
           // into a scree margin: a scatter of thinning patches, which is what
           // the outer metre of a real apron looks like.
           float edgeN = tfbm(vTWPos.xz * 0.55 + rnd * 19.0, 3) * 0.72
                       + tnoise(vTWPos.xz * 2.6) * 0.28;
           if (margin < edgeN * 0.92) discard;
           // GRAIN SIZE GRADIENT. Fines lodge where the pile is deep — that is
           // the head, banked against the rock — and a block that survived the
           // fall kept its momentum to the toe. The clast cell therefore runs
           // from ~1.3 m at the toe to ~12 cm at the head, and that gradient is
           // what says "scree" rather than "gravel texture".
           float cell = mix(0.75, 8.0, head);
           vec2 q = vTWPos.xz + vec3(vTWPos.y * 1.7).xx * vec2(0.31, -0.19);
           float clast = tfbm(q * cell, 3);
           float band = tfbm(q * cell * 0.24 + rnd * 37.0, 3);
           float tone = clamp(clast * 0.62 + band * 0.52 - 0.12, 0.0, 1.0);
           vec3 albedo = mix(uTalDark, uTalLight, tone);
           // Fines wash: the head of an apron is half silt, and silt is pale.
           albedo = mix(albedo, uTalDust, smoothstep(0.30, 0.95, head) * (0.20 + 0.26 * band));
           // Blown dust on the up-facing half, exactly as on a rock body.
           float up = clamp(vTWNrm.y, 0.0, 1.0);
           albedo = mix(albedo, uTalDust, pow(up, 1.6) * 0.20 * (0.5 + 0.5 * band));
           // Per-apron value shift; two aprons in one frame must not match.
           albedo *= 0.90 + rnd * 0.22;
           diffuseColor.rgb *= albedo;
           gTalRough = clamp(0.99 - tone * 0.16, 0.60, 1.0);
         }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = gTalRough;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         {
           float dist = length(vTWPos - cameraPosition);
           // Two octaves at the local grain size. The amplitude is written as the
           // tangent of the bump angle it produces, the same convention the rock
           // body uses, so a 12 degree scree relief stays 12 degrees whatever the
           // cell size is. Faded out by 420 m, past which it only aliases.
           float fade = 1.0 - smoothstep(120.0, 420.0, dist);
           if (fade > 0.004) {
             float cell = mix(0.75, 8.0, vTal.x);
             vec3 n = normalize(vTWNrm);
             float e = 0.35 / cell;
             vec2 q = vTWPos.xz;
             float h0 = tfbm(q * cell, 3);
             float hx = tfbm((q + vec2(e, 0.0)) * cell, 3);
             float hz = tfbm((q + vec2(0.0, e)) * cell, 3);
             vec3 grad = vec3((hx - h0) / e, 0.0, (hz - h0) / e);
             grad -= n * dot(grad, n);
             n = normalize(n - grad * 0.21 * uDetail * fade);
             normal = normalize((viewMatrix * vec4(n, 0.0)).xyz);
           }
         }`,
      );
    mat.userData.shader = shader;
  };

  return mat;
}

export function createRockMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0.0,
    // Above 1 on purpose. The sky IBL is the *only* thing lighting a rock's
    // shaded side, and measured against the terrain the shaded flank was landing
    // at 0.47 of the sand's shadow value — a crushed silhouette, which is the
    // opposite of the reference. MGSV shadows are lifted and full of sky.
    // Round 5: 1.20 -> 1.34. The shade side of a clast is lit by the indirect
    // term and nothing else, and measured against the ground it covers, a third
    // of every rock pixel was landing under 0.40 of its own sand.
    envMapIntensity: 1.34,
    dithering: true,
  });

  // Afghan limestone in full sun is only slightly darker than the sand around
  // it — PALETTE.rock* is tuned for the terrain's *shadowed cliff* case and
  // reads as near-black on a standalone boulder. These are the sunlit values.
  // R/B ratios in the comments; sand is 1.46, so nothing here may sit below it.
  //
  // Round 4 raised the whole ramp and, crucially, raised its FLOOR. Measured on
  // the round-3 field, a shaded rock flank landed at linear luminance 0.024
  // against sand at 0.19 — eight times darker — and at B/R 0.57-0.70 against
  // sand's 0.39-0.41, i.e. both far too dark and visibly colder, which is the
  // "debris composited in" read three critics reported. The albedo could not
  // survive it: `uRockDeep` at 0.178 is a 3:1 swing away from `uRockLight`, and
  // the shader was applying it over a 15 cm noise field, so the body was a
  // black-and-white splotch before a single photon arrived.
  //
  // The ramp was then trimmed ~7% back down once the shading was fixed: with
  // the noise gone the lit face measured brighter than the sand it stands on
  // (0.61 against 0.34 on a shadowed slope, 0.67 against 0.63 in full sun), and
  // a rock field brighter than its ground reads as a scatter of sugar cubes.
  // Limestone is a little darker than quartz sand and a good deal warmer, which
  // is where these land: 0.508 against PALETTE.sandLight's 0.62, at R/B 1.55
  // against the sand's 1.46.
  // Round 4 integration: the whole ramp was rebalanced against the new sand.
  // "Nothing here may sit below sand's R/B" is still the rule, but sand moved
  // from 1.46 to 1.28 when the round-1 blue-cast compensation came out of the
  // palette, and leaving limestone at 1.62-2.57 would have made every boulder
  // in the valley the reddest object in the frame. Values are the old ones with
  // the blue channel raised; luminance is unchanged to within half a percent,
  // so none of the lit/shade calibration above moves.
  // Round 5 re-derived the whole ramp against a MEASUREMENT of the shipped
  // frame rather than against the palette. The rule in this file has always been
  // "never cooler in R/B than the sand", and it was being checked against
  // PALETTE.sandLight's albedo (R/B 1.28). But the number a critic reads off a
  // PNG is not albedo, it is albedo times illuminant times grade, and measured
  // with an ID mask over 6,000 paired pixels the sand comes back at image R/B
  // 1.79 while the rock came back at 1.65 — 69% of rock pixels COOLER than the
  // exact ground they covered. Two causes, both fixed: the ground-bounce tint
  // below was never applied (see uBounce), and the ramp itself was only ~1.45,
  // which after a shaded facet's sky-dominated fill lands under the sand.
  // Blue is 7% of luminance, so a 12% blue cut is a 0.8% value change and a
  // 15% hue change; that is the whole trade and it is why it is done in blue.
  //
  // uRockDeep is also lifted 23% in luminance. It is the target of the cavity
  // mix, and with the round-5 varnish on top of it a third of every clast pixel
  // was landing under 0.40 of its own ground — charcoal, not limestone.
  //
  // ROUND 8 measured the real game instead of arguing from the palette, and the
  // ramp's chroma turns out to be right — mgi-8's lit rock slab renders at lin
  // 0.490/0.367/0.204 (R/B 2.40) and mgi-1's far rock at 0.291/0.225/0.131
  // (2.22), which is exactly this ramp. So the light and dark ends do not move.
  //
  // The DEEP end does, by -20%. Round 5's lift was made against a "charcoal, not
  // limestone" read; the nine reference frames say the failure we are actually in
  // is the opposite one — black point 16-28 against 8.2, p0.1 32-59 against 18.4,
  // 6.0 stops against 7.31. uRockDeep is the target of the cavity mix, i.e. it is
  // the material inside every crack and under every overhang in the near field,
  // and it is the only thing in this module that can put a genuinely dark pixel
  // beside a sunlit one at conversational distance. 0.149 luminance is a stained,
  // shaded limestone cavity; the round-3 disaster value was 0.117 flat across
  // whole bodies, which is a different mistake at a different scale.
  mat.userData.uniforms = {
    uRockLight: { value: new THREE.Vector3(0.534, 0.440, 0.299) },  // 1.79 buff
    uRockDark: { value: new THREE.Vector3(0.370, 0.291, 0.192) },   // 1.93 tan
    uRockDeep: { value: new THREE.Vector3(0.230, 0.160, 0.086) },   // 2.67 stain
    uRockRed: { value: new THREE.Vector3(0.48, 0.302, 0.198) },     // 2.42 iron
    uSand: { value: new THREE.Vector3(...PALETTE.sandLight) },
    // Wind dust is *lighter and warmer* than the sand it came from: the fine
    // fraction is what stays airborne, and fines are pale.
    uDust: { value: new THREE.Vector3(0.588, 0.487, 0.336) },       // 1.75
    uLichen: { value: new THREE.Vector3(0.245, 0.228, 0.156) },     // 1.57 khaki
    /**
     * Desert varnish. Round 5: the single term that makes a small clast read as
     * an object rather than a stain on the sand.
     *
     * Measured on r4/outpost.png with a paired mask (render the frame, render it
     * with the rock group hidden, difference the two), the rock pixels averaged
     * display luminance 0.2518 against 0.2562 for the exact sand pixels they
     * covered — a ratio of 0.983, and 77% of every rock pixel in the frame sat
     * within +/-12% of the ground behind it. A field of objects that measures
     * within 2% of its own background is a decal.
     *
     * The physical answer is on the ground already: Terrain.js paints its own
     * near-field lag as varnished clasts on unvarnished sand, with the comment
     * "desert pavement is mostly DARKER than the matrix it sits on". Manganese
     * and iron oxide build on stable clast faces over millennia; the sand
     * between them is turned over constantly and never darkens. This is that
     * stain. Terrain's own uVarnish is R/B 1.32; this is 2.21, and it has to be,
     * because the rule is "never cooler than the sand" and the sand MEASURES
     * R/B 1.91 in the ground shot once the afternoon beam is on it. A stain
     * that is only as warm as the rock it darkens cannot raise the rock's hue,
     * and 39% of the clasts came back cooler than their own ground at 1.67.
     * Manganese-iron desert varnish is genuinely a red-brown-black.
     */
    // Round 5, second pass: 0.175/0.120/0.076 -> 0.138/0.090/0.050, and the
    // coat weight below 0.38 -> 0.56. Measured by ablation with the exposure
    // locked, hiding one family at a time and comparing each family's pixels
    // with the exact ground pixels behind them, the small clasts came back at
    //   chips   0.4253 against sand 0.4429  = 0.960 (outpost)
    //   chips   0.4454 against sand 0.4558  = 0.977 (vista)
    //   chips   0.4296 against sand 0.4004  = 1.073 (ground, i.e. BRIGHTER)
    // A field of objects that measures within 2-7% of its own background — and
    // brighter than it at noon — is not a field of objects, it is a stain, which
    // is precisely the "flat decals" the critique named. Manganese-iron varnish
    // is a genuinely dark red-brown-black and it is the one term that separates
    // a stable clast from the sand that is turned over around it.
    uVarnish: { value: new THREE.Vector3(0.138, 0.090, 0.050) },    // 2.76
    uDetail: { value: 1.0 },
    /**
     * Warm ground-bounce TINT applied to the indirect term on faces that look
     * away from the sky.
     *
     * ROUND 5: THIS UNIFORM WAS DECLARED, DOCUMENTED AND NEVER USED. It was in
     * the uniform block and in the fragment shader's declaration list, and the
     * string "uBounce" appeared nowhere else in the file, so the warm bounce
     * every comment in here assumes has never once been applied. That is the
     * mechanical reason a rock's shaded flank goes blue: the ONLY thing lighting
     * it was the sky IBL, and the sky is blue. Measured on the round-5 field
     * before this was wired up, 70% of rock pixels were cooler in R/B than the
     * exact ground pixels they covered.
     *
     * It is a TINT, not a gain: normalised by its own green channel so it moves
     * hue without moving the brightness the AO calibration above was set
     * against. The values still track LIGHT_TRANSPORT.groundAlbedo's hue.
     */
    uBounce: { value: new THREE.Vector3(2.35, 1.80, 1.32) },
    uWind: { value: new THREE.Vector2(WIND_DIR[0], WIND_DIR[1]) },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec4 aRock;    // cavity, ao, heightFrac, skirt
         // per-instance: value shift, strata phase, clast weight.
         // .z is 1 for a pebble and 0 for a butte — see Scatter's CLAST table.
         attribute vec3 aTint;
         varying vec3 vWPos;
         varying vec3 vWNrm;
         varying vec3 vLPos;
         varying vec4 vRock;
         varying vec3 vTint;
         varying vec3 vBedUp;   // world-space direction of the body's bedding axis
         varying vec3 vOrg;     // world-space origin of this instance
         uniform vec2 uWind;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vLPos = position;
         vRock = aRock;
         vTint = aTint;
         {
           vec3 org = vec3(0.0);
           #ifdef USE_INSTANCING
             org = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
             // --- wind-deposited fines on the collar ---------------------
             // Every stone in a blown-sand desert has a pale crescent banked
             // against the face the wind hits and a scoured hollow behind it.
             // The collar is a shared ring mesh, so the crescent cannot be baked
             // into the geometry — but it can be evaluated here, off the WORLD
             // azimuth of the vertex, which means one mesh serves every stone
             // and every one of them agrees with the sand ripples.
             if (aRock.w > 0.02) {
               vec3 wv = (instanceMatrix * vec4(position, 1.0)).xyz;
               vec2 off = wv.xz - org.xz;
               float l = length(off);
               if (l > 1e-5) {
                 float wd = dot(off / l, uWind);       // -1 upwind face, +1 lee
                 float bank = smoothstep(0.15, -1.0, wd);
                 float scour = smoothstep(-0.15, 1.0, wd);
                 float rim = aRock.w;
                 // Local +Y is the ground normal and local XZ is the ground
                 // plane, both by construction of the collar's transform, so
                 // this is a world-space displacement written in local units.
                 // Round 5 roughly doubled the asymmetry. With the wind vector
                 // itself 48 degrees wrong there was no point measuring the
                 // amplitude, and at the old values the crescent moved the rim
                 // by 16% of a drift that is itself ~30% of the stone's
                 // footprint radius — under a pixel at any range the stone is
                 // legible from. A real lee scour is a visible hollow.
                 transformed.y += (bank * 0.26 - scour * 0.15) * rim;
                 transformed.xz *= 1.0 + (bank * 0.42 - scour * 0.30) * rim;
               }
             }
           #endif
           vOrg = (modelMatrix * vec4(org, 1.0)).xyz;

           vec4 wp = vec4(transformed, 1.0);
           vec3 wn = objectNormal;
           vec3 bu = vec3(0.0, 1.0, 0.0);
           #ifdef USE_INSTANCING
             wp = instanceMatrix * wp;
             // Instance scale is mildly NON-UNIFORM (Scatter clamps the ratio to
             // 1.32), so a normal cannot be pushed through the same basis as a
             // position: it needs the inverse transpose. For R*S with S diagonal
             // that is R*S^-1, and S is just the column lengths.
             vec3 isc = vec3(length(instanceMatrix[0].xyz),
                             length(instanceMatrix[1].xyz),
                             length(instanceMatrix[2].xyz));
             wn = mat3(instanceMatrix) * (wn / max(isc * isc, vec3(1e-6)));
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
         varying vec3 vTint;
         varying vec3 vBedUp;   // world-space direction of the body's bedding axis
         varying vec3 vOrg;     // world-space origin of this instance
         uniform vec2 uWind;
         uniform vec3 uVarnish;
         uniform vec3 uRockLight;
         uniform vec3 uRockDark;
         uniform vec3 uRockDeep;
         uniform vec3 uRockRed;
         uniform vec3 uSand;
         uniform vec3 uDust;
         uniform vec3 uLichen;
         uniform float uDetail;
         uniform vec3 uBounce;

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

           float tone = clamp(macro * 0.54 + meso * 0.44 + micro * 0.16 + bandHard * 0.30 - 0.24,
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
           // Warm: a cool-grey vein on a buff rock is a grey stripe, and grey
           // stripes are what made the family read cold next to the sand.
           float vein = smoothstep(0.9, 0.99, rfbm(vLPos.xy * 3.4 + vTint.y * 9.0, 3));
           albedo = mix(albedo, vec3(0.560, 0.505, 0.392), vein * 0.45);

           // mineral grain, close range only (it would alias into fizz further out)
           float gritFade = 1.0 - smoothstep(3.0, 26.0, dist);
           if (gritFade > 0.004) {
             float grit = triF(vWPos, wn, 26.0, 2);
             albedo *= 1.0 + (grit - 0.5) * 0.18 * gritFade;
           }

           // per-instance value shift so a cluster is not one flat colour
           albedo *= 0.88 + vTint.x * 0.26;

           // --- cavity darkening: the term that makes geometry read ---
           // uRockDeep is a warm iron/organic stain, not a neutral black. Under
           // a blue sky IBL a neutral crevice colour turns *blue*, which is how
           // round 1 ended up with rocks reading colder than the sand.
           //
           // Round 4 halved the noise-driven half of this and left the
           // GEOMETRY-driven half alone. That split is the whole point: crev
           // comes from the baked curvature of the mesh, so it darkens the
           // places the body actually folds and makes the form read, whereas
           // microCrev is a 15 cm noise field that was mixing a 3:1 dark
           // toward uRockDeep across half the surface — a splotch camouflage
           // pattern with no relation to the shape under it.
           float crev = clamp(cavity, 0.0, 1.0);
           float edge = clamp(-cavity, 0.0, 1.0);
           float microCrev = smoothstep(0.62, 0.30, micro);      // noise-scale pits
           float darkness = clamp(crev * 1.15 + microCrev * 0.12 * fade + seam * 0.14, 0.0, 1.0);
           albedo = mix(albedo, uRockDeep, darkness * 0.44);
           // Worn shoulders are sun-bleached and grit-blasted. Bleaching a rock
           // toward its own luminance makes it grey; carbonate bleaches toward
           // pale *calcite*, which is warm.
           albedo = mix(albedo, uDust * 0.94, edge * 0.38);

           // --- lichen: only where it survives, i.e. shaded crevices facing up ---
           // Round 4 dropped the frequency and the strength. At 0.9 the mask
           // cell was 1.1 m with three octaves on top, so on a 1.5 m boulder it
           // was 20 cm blotches of a colour half the rock's value: the same
           // splotch-camouflage failure as the cavity channel, from a second
           // source. Lichen is a low-frequency crust that follows the shelter,
           // not a spray pattern.
           float lichenMask = smoothstep(0.56, 0.90, rfbm(vWPos.xz * 0.35 + vWPos.y * 0.22, 2))
                            * smoothstep(-0.05, 0.45, wn.y)
                            * smoothstep(0.08, 0.5, crev);
           albedo = mix(albedo, uLichen, lichenMask * 0.26);

           // --- wind-blown dust: up-facing surfaces and the base of the rock ---
           // Cranked hard relative to round 1. In a desert the sky-facing half of
           // every stone is buried under a film of the surrounding fines, which
           // is what welds the rock's colour to the ground's. It also solves the
           // hue problem structurally: the dust IS the sand, so a dusty rock can
           // never be colder than the sand.
           // Round 4 also gives the settled film a WINDWARD bias: fines pile
           // against the face the wind hits and are stripped off the lee, the
           // same asymmetry the collar geometry carries, so the two agree.
           float up = clamp(wn.y, 0.0, 1.0);
           float windSide = dot(normalize(vec3(wn.x, 0.0, wn.z) + vec3(1e-5)).xz, uWind);
           // The 0.11 pedestal is not a fudge: in a blown-sand desert even a
           // vertical face is grit-blasted and carries a film. Without it the
           // only surfaces that ever took the sand's colour were the sky-facing
           // ones, so a rock's flanks stayed a different material from its top.
           float dust = 0.11
                      + pow(up, 1.25) * (0.48 + 0.34 * (1.0 - hFrac))
                      + (1.0 - smoothstep(0.0, 0.32, hFrac)) * 0.44
                      - windSide * 0.11 * (1.0 - up);
           dust *= 0.58 + 0.62 * smoothstep(0.20, 0.80, rfbm(vWPos.xz * 0.6, 3));
           // Capped below saturation. Fully dusted the rock takes the dust colour
           // outright and a field of them reads as a scatter of white sugar cubes
           // against the ground rather than as stone with dust on it.
           //
           // Round 5: the cap is now a function of clast size, and that is the
           // whole reason the small families were invisible. A chip lies on a LAG
           // pavement — a surface that exists precisely because the wind has
           // taken every fine grain off it — so the one body in the scene that
           // was being given the most dust (flat, sky-facing, hFrac near zero, so
           // all three terms saturate) is the body that in reality carries the
           // least. At 0.60 the pebble was 60% uDust, whose luminance is within
           // 4% of the sand's, which is why it measured a ratio of 0.98 against
           // the ground it sat on.
           float clast = clamp(vTint.z, 0.0, 1.0);
           dust = clamp(dust, 0.0, mix(0.60, 0.20, clast));
           albedo = mix(albedo, uDust, dust);

           // --- desert varnish on the clast families -------------------------
           // Not a value trim: a real mineral coat, applied where it forms.
           // Manganese-iron varnish builds on the stable, sky-facing, unscoured
           // faces of a clast that has not moved in centuries, so it tracks the
           // up-facing normal and the absence of a crevice, and it is absent on
           // the buried underside. "pale" leaves a fifth of the population
           // unvarnished quartzite: a field where every stone is the same value
           // reads as a pattern, which is the failure the terrain's own grit
           // shader calls out.
           if (clast > 0.003) {
             // ROUND 7: the quartzy exemption was the loudest thing in the frame.
             // smoothstep(0.62, 0.88) leaves 38% of every clast family partly and
             // 12% wholly unvarnished, and since the exemption also cancelled 85%
             // of the coat AND most of the value cut below, one stone in eight
             // rendered as bare pale rock. That is the near-white boulder sitting
             // beside the player in the gameplay frame, and with an ablation mask
             // it is also why the family's MEAN came back at 1.011 of the sand it
             // sat on: the pale minority is bright enough to cancel the majority's
             // separation. A desert quartzite pebble is buff, not white; the
             // minority is now 1 in 25 and it only buys back half the coat.
             float pale = smoothstep(0.80, 0.97, vTint.x);            // quartzy minority
             float coat = clast * (1.0 - pale * 0.55)
                        * (0.42 + 0.58 * pow(up, 0.7))
                        * (0.55 + 0.45 * smoothstep(0.15, 0.75, hFrac))
                        * (0.70 + 0.60 * smoothstep(0.30, 0.85, rfbm(vWPos.xz * 1.7 + 5.1, 3)));
             albedo = mix(albedo, uVarnish, clamp(coat, 0.0, 1.0) * 0.68);
             // And a flat value cut on top of the coat, which the varnish alone
             // could not deliver because it is gated on up-facing, uncrevassed,
             // unpale surfaces and a pebble is small enough that half its pixels
             // fail one of those gates. Measured with the exposure locked and a
             // stability mask, hiding every chip, stone and talus block in the
             // outpost frame changed 145 pixels by more than 8 code values, and
             // on those pixels the clasts read 1.003 of the sand they covered.
             // A body that alters its own background by three parts in a
             // thousand is, by definition, a stain and not an object. The cut is
             // applied in a way that RAISES R/B (the blue channel takes twice
             // the cut of the red), because the other half of the same finding
             // is that the family must never read cooler than the sand.
             // Round 7: 0.72/0.65/0.55 -> 0.62/0.55/0.44, and the pale exemption
             // on the cut drops from 0.7 to 0.35. Ablated against the exact sand
             // pixels each clast covered, round 6 shipped ratios of 1.011
             // (outpost), 0.965 (vista) and 1.003 (ground) — a field of objects
             // measuring within 4% of its own background in every frame, i.e.
             // still a stain. The blue channel keeps taking twice the red's cut,
             // because the second half of the same finding is that 46-54% of
             // clast pixels were COOLER in R/B than the ground they sat on and
             // the rule in this file is that they never may be.
             float sep = clast * (1.0 - pale * 0.35);
             albedo *= mix(vec3(1.0), vec3(0.62, 0.55, 0.44), sep);
           }

           // --- the fines apron banked against the base ---
           // Past the collar's inner lip this is not rock at all: it is drifted
           // sand, so every rock term above has to switch itself off or the
           // apron reads as a plastic flange moulded onto the boulder.
           float sk = smoothstep(0.06, 0.55, skirt);
           if (sk > 0.002) {
             vec3 fines = uSand * (0.82 + 0.38 * meso);
             // A rind of coarse grit and rock-wash right against the stone,
             // washing out to clean windblown sand at the rim. The drift must
             // NOT be the same value as the terrain around it or it vanishes and
             // the rock is back to a hard silhouette on a flat plane — the
             // deposit is coarser, darker and stained by everything that has run
             // off the rock.
             fines = mix(fines * vec3(0.70, 0.675, 0.63), fines, smoothstep(0.0, 0.85, skirt));
             // --- windward crescent / lee scour ---------------------------
             // Deposition sorts by grain size: the bank on the upwind face is
             // fresh airborne SILT and reads distinctly paler than the ground,
             // while the lee has been deflated down to the coarse residue and
             // reads darker. Getting the two the same value is the difference
             // between a drift and a ring of sand.
             vec2 woff = vWPos.xz - vOrg.xz;
             float wl = length(woff);
             float wd = wl > 1e-4 ? dot(woff / wl, uWind) : 0.0;
             float bank = smoothstep(0.15, -1.0, wd);
             float scour = smoothstep(-0.15, 1.0, wd);
             fines *= 1.0 + bank * 0.19 - scour * 0.18;
             fines = mix(fines, uDust * 1.04, bank * 0.50);
             // coarse grains standing proud in the drift, close range only
             fines *= 1.0 + (triF(vWPos, wn, 9.0, 2) - 0.5) * 0.22 * fade;
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
           // Round 4 pulled both terms back. Measured on a boulder in
           // afternoon sun, the sky-facing-away flank landed at display 0.104
           // against sand-in-shadow at 0.215 and at B/R 1.09 against the sand's
           // 0.87: half the value and visibly bluer, which is the "cool and
           // flat" read three critics returned. Occlusion this deep on a body
           // whose only fill IS the indirect term is what crushed it.
           gAO = clamp(1.0 - max(bakedAO, 0.0) * 0.28, 0.74, 1.0)
               * mix(0.90, 1.0, smoothstep(0.0, 0.28, hFrac));
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
           // STRENGTH IS SCALE-NORMALISED. The previous constants (0.40 and
           // 0.09) were written as if grad were a unit-scale slope, but it is
           // a derivative of a field whose cell is 1/sc metres, so the coarse
           // term delivered tan(34 deg) and the fine one tan(35 deg) of normal
           // perturbation. A near-Lambertian surface under a 5:1 key:fill with
           // its normal randomised by 35 degrees is not "pitting": it is a
           // black-and-white splotch, and that is exactly what a rock at 9 m
           // measured as. Dividing by the noise scale makes the constant read
           // directly as the tangent of the bump angle it will produce.
           //
           // The FREQUENCY matters as much as the amplitude. Measured by
           // ablation (uDetail = 0), the detail was adding 0.0158 of local
           // 2-pixel contrast on top of the 0.0098 the geometry produces, on a
           // ground whose own local contrast is 0.0089 — i.e. two thirds of what
           // the eye reads as "speckle" came from here. Both octaves are now
           // roughly two-thirds of an octave lower, so the same surface
           // roughness lands as relief the eye can resolve rather than as
           // per-pixel sandpaper.
           //
           // The AMPLITUDE then had to come down more than four-fold on top of
           // that, and the reason is the sun angle, not the noise. At an
           // afternoon elevation of 27 deg an up-facing rock face sits at
           // N.L = 0.45, so a +/-15 deg normal perturbation swings its incidence
           // between sin(12) and sin(42) — a 3.3x luminance swing, which is why
           // the boulders came out as black-and-white blotch camouflage rather
           // than as pitted stone. At +/-6.5 deg the same field swings 1.6x and
           // reads as surface.
           vec3 nWorld = wn;
           if (fadeCoarse > 0.003) {
             float sc = 1.15;
             float e = 0.22;
             float h0 = triF(vWPos, wn, sc, 3);
             float hx = triF(vWPos + vec3(e, 0.0, 0.0), wn, sc, 3);
             float hy = triF(vWPos + vec3(0.0, e, 0.0), wn, sc, 3);
             float hz = triF(vWPos + vec3(0.0, 0.0, e), wn, sc, 3);
             vec3 grad = (vec3(hx, hy, hz) - h0) / e;
             grad -= wn * dot(grad, wn);          // keep it tangential
             nWorld = normalize(nWorld - grad * (0.13 / sc) * uDetail * fadeCoarse);
           }
           if (fadeFine > 0.003) {
             float sc = 4.2;
             float e = 0.062;
             float h0 = triF(vWPos, wn, sc, 3);
             float hx = triF(vWPos + vec3(e, 0.0, 0.0), wn, sc, 3);
             float hy = triF(vWPos + vec3(0.0, e, 0.0), wn, sc, 3);
             float hz = triF(vWPos + vec3(0.0, 0.0, e), wn, sc, 3);
             vec3 grad = (vec3(hx, hy, hz) - h0) / e;
             grad -= wn * dot(grad, wn);
             nWorld = normalize(nWorld - grad * (0.075 / sc) * uDetail * fadeFine);
           }
           // Round 5 integration: a third octave, near-field only.
           //
           // The finest octave above has a 24 cm cell, so a 60 cm chip lying
           // three metres from a third-person camera has no surface variation
           // across a whole facet. Measured on gameplay.png: the nearest rock
           // occupies 90x55 px, is fourteen flat facets, and each facet's own
           // standard deviation is under two code values — it reads as untextured
           // placeholder geometry in the one shot that is supposed to read as
           // the game. A 5 cm cell at tan 4.9 deg breaks the facet without
           // touching the silhouette or the shape's own read, and it is gone by
           // 16 m, which is about where a 5 cm feature stops resolving.
           float fadeMicro = 1.0 - smoothstep(5.0, 16.0, dist);
           if (fadeMicro > 0.003) {
             float sc = 19.0;
             float e = 0.014;
             float h0 = triF(vWPos, wn, sc, 2);
             float hx = triF(vWPos + vec3(e, 0.0, 0.0), wn, sc, 2);
             float hy = triF(vWPos + vec3(0.0, e, 0.0), wn, sc, 2);
             float hz = triF(vWPos + vec3(0.0, 0.0, e), wn, sc, 2);
             vec3 grad = (vec3(hx, hy, hz) - h0) / e;
             grad -= wn * dot(grad, wn);
             nWorld = normalize(nWorld - grad * (0.085 / sc) * uDetail * fadeMicro);
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
         {
           // Warm ground bounce. A rock's shaded flank sees no sky worth
           // speaking of and a great deal of sunlit sand, so the indirect
           // arriving at it is the GROUND's colour, not the dome's. Weighted by
           // how far the normal points below the horizon, and normalised by its
           // own green channel so it is a hue shift and not a second light.
           // Weighted by how little SKY the facet sees, not by how far it
           // points down: LIGHT_TRANSPORT.ridgeElevation makes the same point
           // about the terrain — a vertical face's cosine lobe is concentrated
           // at low elevations, which in a valley is sunlit rock and sand, not
           // dome. A vertical flank therefore takes the bounce at full weight.
           // Round 5, second pass: the weight has a floor now. Measured with
           // the same paired mask, 54-59% of every rock pixel in the outpost
           // frame was COOLER in R/B than the exact ground pixel behind it,
           // against a rule in this file that says never cooler than the sand.
           // A rock's TOP is not lit by the dome alone either — in a valley a
           // quarter of what an up-facing facet sees is sunlit rock and sand at
           // low elevation (LIGHT_TRANSPORT.ridgeElevation makes the same point
           // about the terrain), so the tint cannot be zero at n.y = 1.
           float bDown = 1.0 - clamp(normalize(vWNrm).y, 0.0, 1.0);
           vec3 bTint = mix(vec3(1.0), uBounce / max(uBounce.g, 1e-4), 0.26 + bDown * 0.68);
           reflectedLight.indirectDiffuse *= gAO * bTint;
           reflectedLight.indirectSpecular *= gAO;
         }`,
      );

    mat.userData.shader = shader;
  };

  return mat;
}
