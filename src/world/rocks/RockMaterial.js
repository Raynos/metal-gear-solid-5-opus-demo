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
 * Terrain.js bakes its ripple set as `sin((u*27 + v*10) * 2pi)` over a 64 m
 * wrapping field, so the phase gradient — and therefore the wind that built it,
 * because a ripple's crests lie across the flow — is along (27, 10) in world
 * XZ. Deriving it from those two integers rather than writing down an azimuth
 * means the rocks cannot drift out of agreement with the sand if the terrain
 * author retunes the field: a stone with its drift banked against the wrong
 * face is a louder error than a stone with no drift at all.
 */
const WIND_AZIMUTH = Math.atan2(10, 27);
export const WIND_DIR = [Math.cos(WIND_AZIMUTH), Math.sin(WIND_AZIMUTH)];

export function createRockMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0.0,
    // Above 1 on purpose. The sky IBL is the *only* thing lighting a rock's
    // shaded side, and measured against the terrain the shaded flank was landing
    // at 0.47 of the sand's shadow value — a crushed silhouette, which is the
    // opposite of the reference. MGSV shadows are lifted and full of sky.
    envMapIntensity: 1.20,
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
  mat.userData.uniforms = {
    uRockLight: { value: new THREE.Vector3(0.518, 0.440, 0.362) },  // 1.43 buff
    uRockDark: { value: new THREE.Vector3(0.356, 0.291, 0.234) },   // 1.52 tan
    uRockDeep: { value: new THREE.Vector3(0.232, 0.179, 0.142) },   // 1.63 stain
    uRockRed: { value: new THREE.Vector3(0.47, 0.302, 0.222) },     // 2.12 iron
    uSand: { value: new THREE.Vector3(...PALETTE.sandLight) },
    // Wind dust is *lighter and warmer* than the sand it came from: the fine
    // fraction is what stays airborne, and fines are pale.
    uDust: { value: new THREE.Vector3(0.571, 0.487, 0.404) },       // 1.41
    uLichen: { value: new THREE.Vector3(0.245, 0.228, 0.156) },     // 1.57 khaki
    uDetail: { value: 1.0 },
    // Warm ground-bounce multiplier applied to the indirect term on faces that
    // look away from the sky. Derived from LIGHT_TRANSPORT.groundAlbedo's hue
    // (0.54, 0.44, 0.345) normalised so the green channel carries the lift.
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
         attribute vec2 aTint;    // per-instance: value shift, strata phase
         varying vec3 vWPos;
         varying vec3 vWNrm;
         varying vec3 vLPos;
         varying vec4 vRock;
         varying vec2 vTint;
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
                 transformed.y += (bank * 0.16 - scour * 0.085) * rim;
                 transformed.xz *= 1.0 + (bank * 0.26 - scour * 0.17) * rim;
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
         varying vec2 vTint;
         varying vec3 vBedUp;   // world-space direction of the body's bedding axis
         varying vec3 vOrg;     // world-space origin of this instance
         uniform vec2 uWind;
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
           albedo = mix(albedo, vec3(0.545, 0.505, 0.435), vein * 0.45);

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
           dust = clamp(dust, 0.0, 0.60);
           albedo = mix(albedo, uDust, dust);

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
             fines *= 1.0 + bank * 0.12 - scour * 0.13;
             fines = mix(fines, uDust * 1.02, bank * 0.34);
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
