import * as THREE from 'three';
import { PALETTE } from '../../config/ArtDirection.js';

/**
 * Outpost surface shading.
 *
 * One MeshStandardMaterial family, specialised by an `OP_MODE` define, injected
 * through onBeforeCompile so every surface keeps shadows, IBL and fog. The point
 * of the whole file is that *nothing is a flat colour*: a Soviet outpost that has
 * baked in Afghanistan for thirty years reads as CG the instant its concrete is
 * uniform. So every mode layers the same four cues:
 *
 *   1. large-scale patchiness   (weather + repaint history)
 *   2. downward streaking       (water carries dirt/rust down from every edge)
 *   3. a base splash zone       (rain kick-up, vehicle spray, rising damp)
 *   4. a shared sand dust film  (accumulates on up-facing surfaces)
 *
 * (4) is the coherence trick — one dust colour over every material in the scene
 * is what makes a pile of separately-authored props look like one location.
 *
 * Height-in-object comes from the baked `aWeather.x` attribute (0 at the object's
 * base, 1 at its top), which is what lets streaks fade downward from the top edge
 * and damp rise from the ground without knowing anything about the geometry.
 */

export const MODE = {
  CONCRETE: 0,
  METAL: 1,
  CORRUGATED: 2,
  WOOD: 3,
  CLOTH: 4,
  GROUND: 5,
  MASONRY: 6,
  SAND: 7,
};

/**
 * Prevailing wind, world space, as the direction the wind BLOWS TOWARD.
 *
 * This has to agree with `WIND` in src/world/Terrain.js (0.38 rad), which is
 * what the terrain's ripple crests are set out perpendicular to. A drift banked
 * against an object at one angle while the sand around it ripples at another is
 * worse than having no drifts at all — two contradictory wind directions in one
 * frame is a thing no photograph has ever contained.
 */
export const WIND_RAD = 0.38;
export const WIND_DIR = [Math.cos(WIND_RAD), Math.sin(WIND_RAD)];

export const NOISE_GLSL = /* glsl */ `
float ophash(vec2 p){ p = floor(p); return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float opn2(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(ophash(i), ophash(i + vec2(1.0, 0.0)), u.x),
             mix(ophash(i + vec2(0.0, 1.0)), ophash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float opfbm(vec2 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * opn2(p); n += a; a *= 0.5; p = r * p * 2.03; }
  return s / n;
}
float optri(vec3 wp, vec3 wn, float sc, int oct){
  vec3 b = pow(abs(wn), vec3(4.0)); b /= (b.x + b.y + b.z + 1e-5);
  return opfbm(wp.yz * sc, oct) * b.x + opfbm(wp.xz * sc, oct) * b.y + opfbm(wp.xy * sc, oct) * b.z;
}
`;

const VARY = /* glsl */ `
varying vec3 vOPP;
varying vec3 vOPN;
varying vec3 vOPW;
varying vec3 vOPV;
#if OP_MODE == 5
varying vec4 vOPT;
varying vec3 vOPC;
// Compound-LOCAL xz. The pad mesh is authored in the compound's own frame and
// the group carries the yaw, so object space is exactly the (u, v) the wear
// field is rasterised in — no inverse rotation per fragment.
varying vec2 vOPL;
#endif
`;

const UNIFORMS = /* glsl */ `
uniform vec3 uBase;
uniform vec3 uBase2;
uniform vec3 uBase3;
uniform vec3 uRust;
uniform vec3 uDust;
uniform float uWear;
uniform float uDustAmt;
uniform float uScale;
uniform float uMetal;
uniform float uCorrFreq;
uniform float uCorrAmp;
uniform vec3 uDadoCol;
uniform vec2 uDado;
uniform vec3 uBounce;
// Authored specular. Round 6: every mode used to hard-code its own roughness
// constant, and the material's own roughness property was dead code: the
// injected roughnessFactor = gRough overwrote it unconditionally. That is why
// round-5 ablation that forced every material in the scene to roughness 1.0
// measured no change: on this half of the scene it was not ablating anything.
//   x = clean/painted roughness   y = fully corroded roughness
//   z = polished-arris roughness  w = how much the dust film matts it (0..1)
uniform vec4 uRgh;
// Bare metal showing through a chipped edge. A metal's specular colour IS its
// albedo, so this has to be a real reflectance (steel ~0.56) rather than the
// dark rust tint the chip used to inherit, or metalness 1 makes it darker
// instead of shinier.
uniform vec3 uF0;
// Specular ablation, in place: 1 forces roughness 1 / metalness 0 on every
// outpost surface, which deletes the specular lobe and nothing else.
uniform float uAbl;
// The baked lamp pool. Shared by EVERY mode, not just the ground: see the
// lights_fragment_end injection.
uniform sampler2D uLampMap;
uniform vec4 uWearOrg;    // (u0, v0, 1/extentU, 1/extentV)
uniform vec2 uTheta;      // (cos, sin) of the compound yaw, local -> world
uniform vec3 uLampGain;   // pool radiance scale, driven by time of day
#if OP_MODE == 5
uniform sampler2D uWearMap;
uniform vec2 uWearTexel;  // (1/width, 1/height) in texture uv
// (amount, debug). Amount 0 ablates the whole authored-wear layer in place,
// which is how this feature is measured: render twice, diff. Debug 1 dumps the
// three masks straight to albedo.
uniform vec3 uWearCtl;
#endif
`;

/** Shared prologue: fetch the cues every mode needs. */
const PROLOGUE = /* glsl */ `
  vec3 wn = normalize(vOPN);
  #ifdef DOUBLE_SIDED
    wn *= (float(gl_FrontFacing) * 2.0 - 1.0);
  #endif
  float up = clamp(wn.y, 0.0, 1.0);
  float side = 1.0 - up;
  float y01 = clamp(vOPW.x, 0.0, 1.0);
  // Wear arrives from three places — the material, the object's bake, and the
  // per-instance variation — and round 1 simply summed them. On a container
  // that came to 1.6, which drives every rust threshold negative and paints the
  // whole compound the same uniform orange. The baked and per-instance terms are
  // MODULATION, not addition, so they are scaled down: the point of them is that
  // no two objects match, not that everything is maximally corroded.
  float wear = clamp(uWear + vOPW.y * 0.55 + vOPV.x * 0.60, 0.0, 1.25);
  // Pick the horizontal axis that runs ALONG the face so streaks stay thin.
  float sx = abs(wn.x) > abs(wn.z) ? vOPP.z : vOPP.x;

  float m1 = optri(vOPP, wn, 0.30 * uScale, 4);
  float m2 = optri(vOPP, wn, 1.9 * uScale, 3);
  float m3 = optri(vOPP, wn, 7.5 * uScale, 2);

  // Streaks: noise stretched ~30:1 vertically, only on near-vertical faces,
  // strongest just under the top edge and fading out before the ground.
  float st = opn2(vec2(sx * 3.1 * uScale, vOPP.y * 0.10));
  float streak = smoothstep(0.42, 0.86, st * 0.76 + m1 * 0.45);
  streak *= smoothstep(1.05, 0.24, y01) * side;
  // Narrow hard-edged runs. Thirty years of monsoon off one bracket makes a
  // 40mm stripe with a crisp boundary, not a soft wash — and it is the crisp
  // ones the eye reads as history rather than as a noise texture.
  float rn = opn2(vec2(sx * 13.0 * uScale, 7.3));
  float run = smoothstep(0.80, 0.94, rn) * smoothstep(1.02, 0.10, y01) * side;
  run *= 0.35 + 0.9 * smoothstep(0.30, 0.75, opn2(vec2(sx * 2.0, vOPP.y * 0.07)));
  // Water sheeting off an unguttered roof soaks a dark band right under the eave.
  float topWash = smoothstep(0.80, 1.0, y01) * side * (0.5 + 0.9 * m2);
  float splash = smoothstep(0.16, 0.0, y01) * side;
  // South elevations take twice the UV dose. Bleaching one side of every
  // building is what stops a compound reading as a single flat-lit maquette.
  float southFace = clamp(-wn.z * 0.72 + wn.x * 0.38, 0.0, 1.0);
  // Arris mask, baked per vertex on every chamfered box (see geo.js). 1 on the
  // 32mm bevel facets, 0 on the flat faces. Interpolation across the facet is
  // exactly what is wanted: the wear feathers a centimetre or two onto the face
  // either side of the edge, which is what a knocked corner actually looks like.
  float arris = clamp(vOPW.z, 0.0, 1.0);
  vec3 nrm = wn;
`;

/** Shared epilogue: the unifying desert dust film + gentle value jitter. */
const EPILOGUE = /* glsl */ `
  float dustMask = uDustAmt * (0.28 + 0.42 * up) * (0.40 + 0.85 * m1);
  dustMask += uDustAmt * splash * 0.7;
  c = mix(c, uDust * (0.8 + 0.4 * m2), clamp(dustMask, 0.0, 0.85));
  // Dust matts a surface, but it does not matt it uniformly and it does not
  // matt a vertical panel at all — a drum that has stood in the yard for a
  // decade still has a wiped, glossy belly where hands and sleeves go past it.
  // uRgh.w lets steel keep its lobe where flat concrete legitimately loses one.
  gRough = clamp(mix(gRough, 0.96, clamp(dustMask, 0.0, 1.0) * uRgh.w), 0.05, 1.0);
  gMetal = gMetal * (1.0 - clamp(dustMask, 0.0, 1.0) * 0.6 * uRgh.w);
  c *= 0.90 + 0.19 * vOPV.z;
  diffuseColor.rgb *= max(c, vec3(0.0));
  gNorm = normalize(nrm);
  // In-place specular ablation (see uAbl). Last, so it beats every mode.
  gRough = mix(gRough, 1.0, uAbl);
  gMetal = mix(gMetal, 0.0, uAbl);
`;

/**
 * The painted socle. Every Soviet institutional building on earth has a band of
 * oil paint — ochre, sage or that particular municipal blue — from the ground to
 * about 1.4m, with a hard line where the painter's roller stopped. It is the
 * single most recognisable thing about the interior *and* exterior of these
 * buildings, and it costs one lerp. `uDado` is (top height as a fraction of the
 * object, strength); strength 0 leaves the wall bare.
 */
const DADO = /* glsl */ `
  if (uDado.y > 0.001) {
    // The line wavers by a couple of centimetres — it was cut in by hand.
    float wob = (opn2(vec2(sx * 1.7, 4.0)) - 0.5) * 0.035;
    float band = smoothstep(uDado.x + wob + 0.012, uDado.x + wob - 0.012, y01) * side;
    vec3 dc = uDadoCol * (0.82 + 0.34 * m2);
    // Oil paint on a damp masonry wall blisters off from the bottom up.
    float lost = smoothstep(0.52, 0.86, m2 * 0.7 + m3 * 0.5 + splash * 0.5 + 0.2 * wear);
    dc = mix(dc, c * 1.05, lost * 0.75);
    dc *= 1.0 - 0.30 * streak;
    c = mix(c, dc, band * uDado.y);
    // A gloss band reads as paint rather than as a differently-coloured wall.
    gRough = mix(gRough, 0.62, band * uDado.y * (1.0 - lost) * 0.7);
  }
`;

const BODY = {
  [MODE.CONCRETE]: /* glsl */ `
    // Patch history first: pours from different decades, different cement.
    float pourAge = optri(vOPP, wn, 0.055 * uScale, 3);
    vec3 c = mix(uBase, uBase3, smoothstep(0.38, 0.80, pourAge) * 0.72);
    c = mix(c, uBase2, clamp(m1 * 1.70 - 0.26, 0.0, 1.0));
    c *= 0.76 + 0.46 * m2;
    // Shuttering board seams every 850mm.
    float seam = 1.0 - smoothstep(0.0, 0.030, abs(fract(vOPP.y / 0.85 + 0.5) - 0.5));
    c *= 1.0 - 0.20 * seam * side;
    // Dirt washing down the face — the single strongest "this is not CG" cue.
    c *= 1.0 - 0.52 * streak * (0.45 + wear);
    // Splash zone: mud and salt at the bottom of every wall. Deliberately dark —
    // a compound whose every value sits inside a 30-level band reads as fog, and
    // the base of a wall is the one place a real photograph always has a black.
    c = mix(c, uBase * 0.30 * (0.6 + 0.6 * m3), splash * 0.95);
    // Sun-bleached tops.
    c = mix(c, c * 1.22 + 0.02, up * 0.5);
    // Spalled edges: exposed aggregate near the top, with rust bleed from rebar.
    float chip = smoothstep(0.70, 0.94, m3) * (smoothstep(0.82, 1.0, y01) * 1.7 + 0.24 * wear);
    chip = clamp(chip, 0.0, 1.0);
    c = mix(c, uBase * 0.55 + vec3(0.02, 0.017, 0.014), chip * 0.7);
    c = mix(c, uRust * 0.8, clamp(chip * streak * 1.6, 0.0, 0.6));
    // Water sheeting off the roof edge, and the hard rust runs off fixings.
    c *= 1.0 - 0.30 * topWash;
    c = mix(c, uRust * 0.85 * (0.6 + 0.5 * m2), clamp(run * (0.35 + 0.9 * wear), 0.0, 0.72));
    // Sun-bleached south elevation: chalked, lower contrast, slightly warmer.
    c = mix(c, c * 1.20 + vec3(0.028, 0.024, 0.014), southFace * 0.42);
    // Fine pinholing and aggregate at arm's length.
    float fine = optri(vOPP, wn, 26.0 * uScale, 2);
    c *= 0.93 + 0.14 * fine;
    gRough = clamp(uRgh.x + (m2 - 0.5) * 0.18, 0.5, 1.0);
    gMetal = 0.0;
    // Chipped arris. This is the payoff for baking the bevel mask: the cement
    // skin has gone off every edge in the compound, so the edge is a PALE,
    // ROUGH, aggregate-showing line that is a different material from the face
    // — not merely a slightly differently-lit sliver of the same one. It is
    // broken along its length (the m3 term) because a continuous chip is a
    // moulding, and it bleeds rust wherever the cover was thin.
    //
    // Round 4: two changes, both measured. The albedo lift went from 0.62 to
    // 0.80 of the way to the aggregate colour, and the ROUGHNESS now goes DOWN
    // rather than up — 0.44 against the face's 0.90. That sign was simply
    // wrong: an arris is the one part of a concrete elevation that is
    // continuously burnished, by shoulders, kit, doorframes and truck mirrors,
    // and a rough edge on a rough face cannot produce the specular rim the
    // brief asks for. It is worth doing now because the chamfer facets on the
    // silhouette corners are 106mm wide instead of 46mm (see cornerPier), i.e.
    // 5-6 px instead of 1.6, so the response finally has somewhere to land.
    float chipE = arris * (0.35 + 0.65 * smoothstep(0.30, 0.78, m3 * 0.7 + m2 * 0.5));
    c = mix(c, uBase3 * 1.42 + vec3(0.034, 0.030, 0.023), clamp(chipE * 0.80, 0.0, 0.84));
    c = mix(c, uRust * 0.85, clamp(chipE * (streak * 1.1 + 0.18 * wear), 0.0, 0.32));
    gRough = mix(gRough, uRgh.z, chipE * 0.62);
    ${DADO}
    // Relief so a shaded facade still catches a gradient from the sky.
    nrm = normalize(wn + vec3(m3 - 0.5, m2 - 0.5, m2 - 0.5) * 0.22 * (0.4 + chip)
                       - vec3(0.0, seam * side * 0.12, 0.0));
    // Round 5 integration: near-field fracture relief.
    //
    // The line above offsets the normal by a noise VALUE, which tilts a whole
    // facet uniformly instead of breaking it up. That is fine on a wall seen
    // from 20 m and it is not fine on rubble: the op-debris material puts a 0.7 m broken
    // slab 4.3 m from the gameplay camera, where it occupies 90x55 px as ten
    // dead-flat faces meeting at hard arrises — measured per-facet standard
    // deviation under 2 code values. It is the one piece of geometry in the
    // hero shot that reads as an untextured placeholder.
    //
    // A GRADIENT-driven 30 mm aggregate field fixes it, because a gradient
    // varies across a face where a value offset does not. Faded out entirely by
    // 12 m so it costs nothing on the ~130 pilasters and the perimeter, which
    // are never that close to the camera.
    float dcamK = length(vOPP - cameraPosition);
    float kFade = 1.0 - smoothstep(4.0, 12.0, dcamK);
    if (kFade > 0.004) {
      float ks = 34.0;
      float ke = 0.006;
      float q0 = optri(vOPP, wn, ks, 2);
      float qx = optri(vOPP + vec3(ke, 0.0, 0.0), wn, ks, 2);
      float qy = optri(vOPP + vec3(0.0, ke, 0.0), wn, ks, 2);
      float qz = optri(vOPP + vec3(0.0, 0.0, ke), wn, ks, 2);
      vec3 grd = (vec3(qx, qy, qz) - q0) / ke;
      grd -= wn * dot(grd, wn);
      nrm = normalize(nrm - grd * (0.16 / ks) * kFade);
    }
  `,
  [MODE.MASONRY]: /* glsl */ `
    // Rendered/whitewashed blockwork: 390x190 blocks under a lime skim that has
    // been patched and re-limed for decades and is now failing in big flakes.
    vec2 mw = vec2(sx, vOPP.y);
    float course = floor(mw.y / 0.20);
    float stagger = mod(course, 2.0) * 0.20;
    float bx = fract((mw.x + stagger) / 0.40);
    float by = fract(mw.y / 0.20);
    float joint = max(
      1.0 - smoothstep(0.0, 0.022, min(by, 1.0 - by) * 0.20),
      1.0 - smoothstep(0.0, 0.011, min(bx, 1.0 - bx) * 0.40));
    joint *= side;
    float blockVar = ophash(vec2(floor((mw.x + stagger) / 0.40), course));

    vec3 lime = uBase3 * (0.92 + 0.16 * m2);
    vec3 block = uBase2 * (0.86 + 0.30 * blockVar);
    // Where the lime has come off: big soft-edged patches, worst low down and
    // under the eave where the wall stays wet. Kept to a minority of the wall —
    // a fully exposed course pattern reads as decorative ashlar, not as a
    // painted building that is losing its paint.
    float fail = smoothstep(0.50, 0.82, m1 * 0.70 + m2 * 0.40 + splash * 0.45 + topWash * 0.30 + 0.18 * wear);
    vec3 c = mix(lime, block, clamp(fail, 0.0, 0.78));
    // The joint only shows where the lime has gone; a limewashed wall skims it.
    c *= 1.0 - 0.34 * joint * (0.25 + 0.75 * fail);
    c *= 0.88 + 0.26 * m3;
    c *= 1.0 - 0.44 * streak * (0.4 + wear);
    c *= 1.0 - 0.34 * topWash;
    c = mix(c, uRust * 0.9, clamp(run * (0.3 + 0.8 * wear), 0.0, 0.7));
    c = mix(c, uBase * 0.45 * (0.7 + 0.6 * m3), splash * 0.85);
    c = mix(c, c * 1.24 + vec3(0.03, 0.026, 0.014), southFace * 0.48);
    // Knocked corners: the lime and the render are both off the arris and the
    // block below is showing, which on a whitewashed building is the DARKER
    // material — the opposite sign to bare concrete, and the reason the two
    // shells stop looking like the same wall in two tints.
    // Round 4: the block showing through is the darker material, but the
    // knocked edge itself is polished, so the value goes DOWN and the gloss goes
    // UP. Dark, shiny, narrow: on a whitewashed wall in low sun that reads as a
    // rim just as strongly as a pale one does on bare concrete, and with the
    // opposite sign, which is what stops the two shells looking alike.
    float chipE = arris * (0.30 + 0.70 * smoothstep(0.28, 0.75, m3 * 0.7 + m2 * 0.5));
    c = mix(c, uBase2 * 0.80, clamp(chipE * 0.82, 0.0, 0.86));
    gRough = clamp(uRgh.x + (m2 - 0.5) * 0.16 + joint * 0.08, 0.5, 1.0);
    gRough = mix(gRough, uRgh.z, chipE * 0.58);
    gMetal = 0.0;
    ${DADO}
    nrm = normalize(wn
      + tangentFromGrain(wn, 0.5, joint * 0.40 * (0.3 + 0.7 * fail))
      + vec3(m3 - 0.5, m2 - 0.5, m3 - 0.5) * 0.16 * fail);
  `,
  [MODE.METAL]: /* glsl */ `
    vec3 pal = vOPV.y < 0.34 ? uBase : (vOPV.y < 0.67 ? uBase2 : uBase3);
    vec3 paint = pal * (0.90 + 0.20 * m2);
    // Thirty summers of UV: paint chalks and lightens, worst on up-facing panels.
    paint = mix(paint, mix(paint, vec3(dot(paint, vec3(0.33))), 0.45) * 1.30 + 0.02, up * 0.65 + 0.25 * m1);
    float rustM = smoothstep(0.66 - 0.40 * wear, 0.90 - 0.22 * wear, m1 * 0.55 + m2 * 0.55);
    rustM = clamp(rustM + streak * 1.05 * wear + splash * 0.75 * wear, 0.0, 1.0);
    vec3 rust = mix(uRust, uRust * 0.45, m3) * (0.82 + 0.42 * m2);
    vec3 c = mix(paint, rust, rustM);
    // Hard runs bleeding down out of every bolt, bracket and seam.
    c = mix(c, uRust * 1.05 * (0.55 + 0.6 * m2), clamp(run * (0.4 + wear), 0.0, 0.85));
    c *= 1.0 - 0.22 * topWash;
    c = mix(c, c * 1.16 + vec3(0.02, 0.017, 0.01), southFace * 0.34);
    // Paint never survives on an edge: every folded arris in the compound is
    // bare steel going to rust, which is a bright specular line on a matt body.
    float chipE = arris * (0.40 + 0.60 * smoothstep(0.25, 0.80, m3));
    // Paint is a DIELECTRIC film over the steel: the panel's specular is the 4%
    // Fresnel lobe of the varnish and its diffuse is the pigment underneath.
    // Authoring the whole drum as metalness 0.62 over a dark khaki albedo — which
    // is what this did — gets the worst of both ends: two thirds of the diffuse
    // is deleted AND the F0 that replaces it is a near-black 0.08, i.e. a
    // specular lobe with nothing in it. Only the bare steel showing through a
    // chipped arris is actually metal, and it gets a real steel reflectance.
    float bare = chipE * 0.62;
    c = mix(c, mix(uRust * 1.15, uF0, 0.45) * (0.72 + 0.46 * m2), clamp(chipE * 0.65, 0.0, 0.78));
    c = mix(c, uF0 * (0.86 + 0.28 * m2), clamp(bare * 0.55, 0.0, 0.55));
    gRough = clamp(mix(uRgh.x, uRgh.y, rustM) + (m3 - 0.5) * 0.06 + run * 0.30, 0.06, 1.0);
    gRough = mix(gRough, uRgh.z, chipE * 0.55);
    gMetal = mix(uMetal, 0.02, max(rustM, run * 0.8));
    gMetal = mix(gMetal, 1.0, clamp(bare * 0.75, 0.0, 0.75));
    nrm = normalize(wn + vec3(m3 - 0.5, 0.0, m2 - 0.5) * 0.14 * rustM);
    ${DADO}
  `,
  [MODE.CORRUGATED]: /* glsl */ `
    // Corrugation runs perpendicular to the horizontal ridge line of the face,
    // which is the right answer for both a pitched roof and a clad wall.
    vec3 tdir = cross(wn, vec3(0.0, 1.0, 0.0));
    float tl = length(tdir);
    tdir = tl > 0.08 ? tdir / tl : vec3(1.0, 0.0, 0.0);
    float ph = dot(vOPP, tdir) * uCorrFreq;
    float prof = sin(ph);
    vec3 pal = vOPV.y < 0.34 ? uBase : (vOPV.y < 0.67 ? uBase2 : uBase3);
    vec3 paint = pal * (0.90 + 0.20 * m2);
    paint = mix(paint, mix(paint, vec3(dot(paint, vec3(0.33))), 0.5) * 1.32 + 0.02, up * 0.7);
    // Rust pools in the valleys and creeps out of every fixing.
    float valley = 0.5 - 0.5 * prof;
    float rustM = smoothstep(0.58 - 0.40 * wear, 0.86 - 0.24 * wear, m1 * 0.5 + m2 * 0.5 + valley * 0.22);
    rustM = clamp(rustM + streak * 1.1 * wear, 0.0, 1.0);
    vec3 rust = mix(uRust, uRust * 0.45, m3) * (0.82 + 0.42 * m2);
    vec3 c = mix(paint, rust, rustM);
    c *= 0.86 + 0.30 * (0.5 + 0.5 * prof);
    // Fixings every 6th rib: a bright washer with a rust tail under it.
    float fixRow = 1.0 - smoothstep(0.0, 0.09, abs(fract(vOPP.y / 0.90 + 0.5) - 0.5) * 0.90);
    float fixCol = smoothstep(0.55, 0.95, valley);
    float fix = fixRow * fixCol * side;
    c = mix(c, uRust * 1.15 * (0.5 + 0.6 * m2),
            clamp(smoothstep(0.0, 0.55, y01) * fixCol * smoothstep(0.55, 0.0, fract(vOPP.y / 0.90)) * (0.35 + wear) * 0.9, 0.0, 0.8));
    c = mix(c, c * 1.5 + 0.02, fix * 0.35);
    c *= 1.0 - 0.20 * topWash;
    c = mix(c, c * 1.18 + vec3(0.02, 0.017, 0.009), southFace * 0.36);
    // Profiled sheet is factory-coated steel: the coating is the dielectric, and
    // the valleys hold enough dirt to matt them while the ridge crowns stay
    // wiped clean by every rainstorm. That gloss DIFFERENCE along the profile is
    // most of what makes corrugated iron legible at 60 m — a uniformly matt
    // sheet is a striped painting of a sheet.
    gRough = clamp(mix(uRgh.x, uRgh.y, rustM) + valley * 0.10 - fix * 0.20, 0.08, 1.0);
    gMetal = mix(uMetal, 0.02, rustM);
    nrm = normalize(wn + tdir * cos(ph) * uCorrAmp);
  `,
  [MODE.WOOD]: /* glsl */ `
    // Plank axis: boards run along the face's horizontal, grain along the boards.
    vec2 pw = up > 0.6 ? vOPP.xz : vec2(sx, vOPP.y);
    float plankW = 0.165;
    float bIdx = floor(pw.y / plankW);
    float bvar = ophash(vec2(bIdx, 3.7));
    float bvar2 = ophash(vec2(bIdx, 11.3));
    // Grain: long fibres along the board, at a scale you can actually see.
    float grain = opn2(vec2(pw.x * 1.4 + opn2(pw * 2.1) * 0.7, pw.y * 130.0));
    float fibre = opn2(vec2(pw.x * 7.0, pw.y * 46.0));
    vec3 c = mix(uBase, uBase2, clamp(grain * 0.55 + fibre * 0.35 + bvar * 0.55 - 0.15, 0.0, 1.0));
    // Sun-greyed, split, dried-out timber. Almost all of it goes silver-grey.
    c = mix(c, uBase3, clamp(0.34 + up * 0.34 + bvar2 * 0.30 + m1 * 0.5 * wear, 0.0, 0.9));
    c *= 0.86 + 0.28 * fibre;
    // Board joints: a real 8mm shadow gap, not a hairline.
    float f = fract(pw.y / plankW);
    float gap = 1.0 - smoothstep(0.0, 0.055, min(f, 1.0 - f));
    c *= 1.0 - 0.62 * gap;
    // Knots.
    float knot = smoothstep(0.86, 0.99, opn2(vec2(pw.x * 3.2, pw.y * 3.2)));
    c = mix(c, uBase * 0.5, knot * 0.7);
    c *= 1.0 - 0.34 * streak * wear;
    c = mix(c, uBase * 0.42, splash * 0.7);
    gRough = clamp(uRgh.x + (grain - 0.5) * 0.2 + gap * 0.1, 0.5, 1.0);
    gMetal = 0.0;
    nrm = normalize(wn + tangentFromGrain(wn, grain, gap) + vec3(0.0, (bvar - 0.5) * 0.06, 0.0));
  `,
  [MODE.CLOTH]: /* glsl */ `
    // Every bag in a revetment was filled by a different pair of hands out of a
    // different pallet of hessian: vOPV.y picks the bolt of cloth, so no two
    // adjacent bags are the same value even before the weathering runs.
    vec3 pal = vOPV.y < 0.30 ? uBase : (vOPV.y < 0.62 ? uBase2 : uBase3);
    vec3 c = mix(pal, uBase2, clamp(m1 * 1.2 - 0.15, 0.0, 1.0));
    // Hessian: a real 3mm warp/weft, faded out well before it can alias. Beyond
    // about 12m a woven bag is a smooth bag, and pretending otherwise produces
    // the crawling moire that gives procedural cloth away instantly.
    float dcamC = length(vOPP - cameraPosition);
    float wfade = 1.0 - smoothstep(4.0, 13.0, dcamC);
    if (wfade > 0.01) {
      vec3 tw = cross(wn, vec3(0.0, 1.0, 0.0));
      float twl = length(tw);
      tw = twl > 0.10 ? tw / twl : vec3(1.0, 0.0, 0.0);
      vec3 bw = cross(wn, tw);
      float wu = dot(vOPP, tw) * 330.0;
      float wv = dot(vOPP, bw) * 330.0;
      float weave = 0.5 + 0.5 * (sin(wu) * 0.6 + sin(wv) * 0.6 + sin(wu) * sin(wv) * 0.5);
      c *= 1.0 + 0.20 * (weave - 0.5) * wfade;
      // Slubs and pulled threads.
      c *= 1.0 - 0.16 * smoothstep(0.72, 0.95, opn2(vec2(wu * 0.09, wv * 0.09))) * wfade;
      nrm = normalize(wn + (tw * cos(wu) + bw * cos(wv)) * 0.10 * wfade);
    }
    float fold = optri(vOPP, wn, 0.9 * uScale, 3);
    c *= 0.84 + 0.34 * fold;
    // Sun-rot: the up-facing half of a bag goes pale and brittle, the underside
    // stays dark and damp. That vertical value gradient is what makes a stacked
    // course read as rounded volumes rather than a printed brick pattern. Kept
    // deliberately restrained — a revetment that ends up brighter than the
    // gravel it stands on reads as polystyrene, which is what the first pass did.
    c = mix(c, uBase3 * 1.02, clamp(up * 0.34 + smoothstep(0.55, 0.95, m2) * 0.22, 0.0, 0.62));
    c = mix(c, pal * 0.34, clamp((1.0 - up) * 0.55 * (1.0 - y01 * 0.6), 0.0, 0.72));
    // Ambient occlusion between courses: the crack between two bags never sees
    // the sky, and putting a dark line there is most of what separates them.
    c *= 0.72 + 0.28 * smoothstep(0.0, 0.35, y01);
    // Split seams weep sand down the face of the course.
    c = mix(c, uDust * 1.25, clamp(run * 0.85 + streak * 0.35 * wear, 0.0, 0.7));
    gRough = uRgh.x;
    gMetal = 0.0;
    nrm = normalize(nrm + vec3(fold - 0.5, 0.0, m2 - 0.5) * 0.50);
  `,
  [MODE.SAND]: /* glsl */ `
    // Wind-deposited fines: the wedge of sand that banks up against the upwind
    // face of anything that obstructs the wind. It is NOT the same material as
    // the graded ground it sits on — it is the finest fraction, sorted out of
    // the load, so it is paler, smoother, and it carries the ripple set at the
    // same heading as the terrain's own.
    vec2 wd = vec2(${Math.cos(0.38).toFixed(5)}, ${Math.sin(0.38).toFixed(5)});
    vec2 wp = vec2(dot(vOPP.xz, wd), dot(vOPP.xz, vec2(-wd.y, wd.x)));
    // Crests every ~18cm, made sinuous by warping the phase along the crest
    // line. A straight-crested ripple at constant amplitude is a corrugated
    // sheet, which is exactly what the first attempt looked like.
    float rip = sin(wp.x * 34.0 + opn2(vec2(wp.y * 1.9, wp.x * 0.6)) * 7.0) * 0.5 + 0.5;
    rip *= 0.40 + 0.60 * opn2(vec2(wp.y * 2.4, wp.x * 0.5));
    float n1s = opfbm(vOPP.xz * 0.55, 3);
    float n2s = opfbm(vOPP.xz * 4.5, 2);
    vec3 c = mix(uBase, uBase3, clamp(n1s * 0.8 + n2s * 0.35, 0.0, 1.0));
    // The crest of the drift is scoured and pale; the toe is shaded and coarse.
    // The toe of the drift has to BE the ground it lies on, or the join reads
    // as the edge of a decal. Only the crest, where the fines are actively
    // being sorted and scoured, is paler than the surround.
    c = mix(c, uBase2, smoothstep(0.62, 0.02, y01) * 0.90);
    c = mix(c, uBase3 * 1.06, up * 0.30 * smoothstep(0.15, 0.65, y01));
    c *= 0.95 + 0.10 * rip;
    // Ripple relief only — a drift has no other structure, and giving it any
    // reads as rubble.
    float ampR = 0.030 * (0.4 + 0.6 * up) * (0.35 + 0.65 * smoothstep(0.05, 0.5, y01));
    nrm = normalize(wn + vec3(wd.x, 0.0, wd.y) * cos(wp.x * 46.0) * ampR);
    gRough = clamp(uRgh.x + (n2s - 0.5) * 0.08, 0.6, 1.0);
    gMetal = 0.0;
  `,
  [MODE.GROUND]: /* glsl */ `
    float road = clamp(vOPT.x, 0.0, 1.0);
    float lat = vOPT.y;
    float along = vOPT.z;
    float hard = clamp(vOPT.w, 0.0, 1.0);
    float oil = clamp(vOPW.y, 0.0, 1.0);
    float path = clamp(vOPW.z, 0.0, 1.0);
    // Graded ground vs undisturbed desert. Everything below keys off this, and
    // until round 4 it did not exist: the platform and the plain were drawn by
    // the same code with the same statistics, so the compound read as PLACED on
    // the sand rather than cut into it.
    float grade = clamp(vOPW.x, 0.0, 1.0);
    float churn = clamp(vOPC.x, 0.0, 1.0);

    // ---- authored wear: the record of traffic (see wear.js) ---------------
    //
    // Footpaths, wheel ruts, spill and scorch arrive as distance fields in a
    // 0.5 m texture rather than as vertex attributes on a 1.7 m mesh, which is
    // the whole reason any of them are visible at all. Every boundary is then
    // broken into fingers by a 0.4 m fbm before it is thresholded: a clean
    // iso-contour is the loudest possible tell that a mask was authored, and
    // MGSV's ground has no clean edges anywhere on it.
    vec2 wuv = (vOPL - uWearOrg.xy) * uWearOrg.zw;
    vec4 WR = texture2D(uWearMap, wuv);
    vec4 LPM = texture2D(uLampMap, wuv);
    WR.r *= uWearCtl.x; WR.b *= uWearCtl.x; WR.a *= uWearCtl.x;
    LPM.a *= uWearCtl.x;
    float fbA = opfbm(vOPP.xz * 2.7, 3);
    float fbB = opfbm(vOPP.xz * 0.62, 3);
    float edgeN = (fbA - 0.5) * 0.21 + (fbB - 0.5) * 0.15;

    float footRaw = WR.r + edgeN;
    float foot = smoothstep(0.46, 0.64, footRaw);
    float footCore = smoothstep(0.60, 0.94, footRaw);
    float corridor = smoothstep(0.44, 0.63, WR.b + edgeN * 0.85);
    // Metres across the vehicle line, with that vehicle's own wander already
    // removed on the CPU — so the pair of ruts moves together, the way one
    // lorry's line does, instead of breathing independently.
    float latS = (WR.g - 0.5) * 12.0;
    float alat = abs(latS);
    float ra = (alat - 1.06) * 3.5;
    float rb = (alat - 2.68) * 3.0;
    float bshape = (alat - 3.55) / 0.78;
    float rutW = 0.45 + 0.90 * opfbm(vOPP.xz * vec2(0.9, 0.9) + vec2(latS * 2.0, 0.0), 2);
    float rutE = exp(-ra * ra) + 0.64 * exp(-rb * rb);
    float rut = clamp(rutE, 0.0, 1.0) * corridor * rutW;
    float crownE = exp(-latS * latS / 0.44);
    float bermE = exp(-bshape * bshape);
    float spillRaw = WR.a + edgeN * 0.55;
    float spill = smoothstep(0.10, 0.62, spillRaw);
    float scorchRaw = LPM.a + edgeN * 0.60;
    float scorch = smoothstep(0.12, 0.64, scorchRaw);

    float dcam = length(vOPP - cameraPosition);
    float near = 1.0 - smoothstep(6.0, 78.0, dcam);
    float n0 = opfbm(vOPP.xz * 0.011, 3);
    float n1 = opfbm(vOPP.xz * 0.055, 4);
    float n2 = opfbm(vOPP.xz * 0.42, 3);
    float n3 = opfbm(vOPP.xz * 2.6, 2);
    float n4 = opfbm(vOPP.xz * 13.0, 2);

    vec3 sand = mix(uBase2, uBase, clamp(n0 * 0.5 + n1 * 0.8 + n2 * 0.45 - 0.15, 0.0, 1.0));
    sand *= 0.88 + 0.26 * n3;
    // Undisturbed desert carries the same wind ripple as the terrain outside.
    // Putting it ONLY on the ungraded fraction is half of what makes the pad
    // read as engineered: a graded surface has had its ripple bladed off.
    vec2 wdG = vec2(${Math.cos(0.38).toFixed(5)}, ${Math.sin(0.38).toFixed(5)});
    float ripG = sin(dot(vOPP.xz, wdG) * 24.0 + opfbm(vOPP.xz * 0.9, 2) * 9.0) * 0.5 + 0.5;
    float wild = (1.0 - grade) * (1.0 - max(road, corridor));
    sand *= 1.0 + 0.085 * (ripG - 0.5) * wild;
    // Drifted fines catch on the lee of every bump — big, soft, low-contrast.
    sand = mix(sand, uBase * 1.12, smoothstep(0.55, 0.9, n1) * 0.35);

    // COMPACTED FILL: the whole graded platform, not just the hardstanding.
    // Imported borrow material, bladed and rolled — so it is a different rock
    // from the wind-sorted sand around it: greyer, flatter, higher in fines,
    // with the odd bit of stone rolled proud. This is the "apron" the critics
    // said the site did not have, and it has to be a MATERIAL break rather than
    // a shading one or it stops existing at low sun.
    vec3 fill = mix(uBase2 * 0.94, uBase3 * 1.06, 0.45 + 0.45 * n2);
    fill = mix(fill, uBase3 * 1.45, smoothstep(0.70, 0.94, n4) * 0.30);
    fill *= 0.93 + 0.15 * n3;
    // Round 5 standing finding, third round running: "material junctions are
    // hard steps with no transitional third material". Both of these masks used
    // to break up only at n1's 18 m period, which at 5 m from the camera is not
    // a break at all — it is a smooth ramp, i.e. an airbrushed edge. Adding the
    // 0.4 m octave (fbA) and a 0.8 m one turns every fill/sand and gravel/fill
    // boundary into interlocking fingers a boot-width across, which is what the
    // toe of a bladed surface actually does as it loses itself in the sand.
    float fineE = (opfbm(vOPP.xz * 1.25, 3) - 0.5);
    // Only the BOUNDARY is broken up. Applying the fine octaves to the whole
    // mask sprinkles patches of borrow material across undisturbed desert;
    // 4k(1-k) is 1 in the transition band and 0 either side of it.
    // Round 6, and the fourth round this has been raised: "material junctions
    // step with no transitional third material". Two separate defects were
    // hiding under that one sentence and only one of them was noise.
    //
    // (1) WIDTH. Both masks arrive as VERTEX attributes on a 1.9 m mesh, so a
    //     hardstanding edge authored as a 2.6 m ramp is interpolated out to
    //     4-5 m before the shader ever sees it. Breaking a 5 m ramp with a
    //     0.4 m fbm does nothing you can see: the fingers are a twentieth of
    //     the amplitude of the ramp they are perturbing. Re-contrasting the
    //     mask about its own half-value pulls the transition back to ~1.4 m,
    //     which is what a bladed toe actually measures, and only THEN is the
    //     0.4 m octave big enough to break it into fingers a boot wide.
    // (2) THE THIRD MATERIAL. Even a perfect fingered boundary is still a
    //     boundary between exactly two materials. Real ground has a verge: the
    //     metre at the toe of a bladed surface where the plant has kicked the
    //     stone out and the wind has blown the fines back in, which is coarser
    //     than the hardstanding AND paler than the desert. hEdge and gEdge are
    //     1 in the transition band and 0 either side of it, so they are exactly
    //     the weight that material wants.
    // uWearCtl.z is the ablation for exactly this: 1 restores the round-5
    // junction — the raw vertex ramp, the weaker break, and no verge — so the
    // work can be diffed in place against itself.
    float jAbl = uWearCtl.z;
    float gradeS = mix(clamp((grade - 0.48) * 2.10 + 0.5, 0.0, 1.0),
                       clamp(grade * 1.35 - 0.30, 0.0, 1.0), jAbl);
    float hardS = mix(clamp((hard - 0.46) * 3.60 + 0.5, 0.0, 1.0),
                      clamp(hard * 1.25 - 0.25, 0.0, 1.0), jAbl);
    float gEdge = 4.0 * gradeS * (1.0 - gradeS);
    float hEdge = 4.0 * hardS * (1.0 - hardS);
    float gradeN = clamp(gradeS + (n1 - 0.5) * mix(0.34, 0.50, jAbl)
                         + (fineE * mix(0.78, 0.60, jAbl)
                            + (fbA - 0.5) * mix(0.52, 0.36, jAbl)) * gEdge, 0.0, 1.0);
    vec3 c = mix(sand, fill, gradeN * 0.78);

    // Graded gravel hardstanding: cooler, coarser, crushed rock through the fines.
    vec3 gravel = mix(uBase * 0.58, uBase3, 0.5 + 0.4 * n2);
    gravel = mix(gravel, uBase3 * 1.9, smoothstep(0.60, 0.95, n4) * 0.45);
    gravel = mix(gravel, uBase * 0.82, smoothstep(0.62, 0.30, n3) * 0.4);
    gravel *= 0.90 + 0.20 * n4;
    float hardN = clamp(hardS + (n1 - 0.5) * mix(0.34, 0.55, jAbl)
                        + (fineE * mix(0.86, 0.66, jAbl)
                           + (fbA - 0.5) * mix(0.58, 0.40, jAbl)) * hEdge, 0.0, 1.0);
    c = mix(c, gravel, hardN);
    // The verge. Coarse, kicked-over, half-buried: the stone of the surface it
    // came off with the fines of the desert blown through it, and markedly more
    // loose stone standing proud than either neighbour has.
    // It has to be a real THIRD VALUE, not an average of its two neighbours —
    // an interpolated colour in the transition band is what a plain crossfade
    // already produced, and a crossfade is the thing being complained about.
    // A bladed toe is the pale end of the site: the fines that the blade pushed
    // off the surface are the finest fraction there is, they dry out first, and
    // the stone standing proud in them is picked out on both sides of the
    // surround's value.
    vec3 verge = mix(gravel, sand, 0.42) * (1.22 + 0.34 * (n4 - 0.5));
    verge = mix(verge, uBase3 * 2.05, smoothstep(0.52, 0.86, n4) * 0.55);
    verge = mix(verge, uBase2 * 0.52, smoothstep(0.68, 0.92, 1.0 - n3) * 0.42);
    // Broken along its length: a continuous rim is a kerb, and a kerb is worse
    // than a step.
    float vergeBreak = 0.35 + 0.85 * smoothstep(0.25, 0.75, opfbm(vOPP.xz * 0.85, 3));
    float vergeK = clamp((hEdge * 0.78 + gEdge * 0.52) * vergeBreak, 0.0, 0.82) * (1.0 - jAbl);
    c = mix(c, verge, vergeK);
    // Big, slow tonal drift across the platform: fill from different borrow pits.
    c *= 0.80 + 0.42 * n0;

    // VEHICLE CORRIDOR. Compacted fines are markedly darker and smoother than
    // the surround, and that value break is what makes a track read as a track
    // from 100 m up. Structure, from the centreline out: a crown of loose
    // material thrown up between the wheels, a rut, the compacted running
    // surface, the outer rut, and a spoil ridge on the shoulder that outlines
    // the whole thing when the sun is low.
    // Round 5 measured the first pass of this at a mean on/off ratio of 1.00 on
    // the pixels it touched — i.e. it did NOTHING net. the dirt colour at 0.46x uBase
    // came out at 0.243 against a graded-fill surround of 0.269: a 7% break,
    // which is a tenth of a stop and invisible under a desert sun. Compacted
    // track is soaked in fines, diesel and rubber and it is roughly 0.7x the
    // loose material either side of it — half a stop, and legible from the air.
    vec3 dirt = uBase * (0.30 + 0.20 * n2) * (0.88 + 0.24 * n3);
    c = mix(c, dirt, corridor * 0.78);
    c *= 1.0 - 0.62 * rut;
    // Spoil pushed up by the tyre and left standing on the rut's outer lip. It
    // is the pale line immediately beside the dark one that makes a rut read as
    // a GROOVE rather than as a painted stripe.
    float lipE = exp(-(alat - 1.62) * (alat - 1.62) * 5.5) + 0.5 * exp(-(alat - 0.5) * (alat - 0.5) * 8.0);
    c = mix(c, sand * 1.14, clamp(crownE * corridor * 0.38 + bermE * corridor * 0.46
                                  + lipE * corridor * rutW * 0.22, 0.0, 0.66));
    gRough = mix(gRough, 0.80, corridor * 0.60);
    gRough = mix(gRough, 0.70, rut * 0.55);

    // Turning circle: plant pivoting on the spot tears the surface into
    // concentric arcs and throws the fines out to a scuffed lip. The arcs are a
    // ring function of the radius from the disc centre — reconstructed here from
    // the vertex mask's own gradient rather than passed in, which costs nothing
    // and keeps the disc centres out of the shader.
    if (churn > 0.004) {
      float arc = sin(churn * 46.0) * 0.5 + 0.5;
      float torn = churn * (0.45 + 0.55 * arc) * (0.5 + 0.7 * n3);
      c = mix(c, dirt * 0.86, clamp(torn * 0.85, 0.0, 0.80));
      c = mix(c, uBase3 * 1.30, smoothstep(0.55, 0.92, n4) * churn * 0.30);
      gRough = mix(gRough, 0.86, churn * 0.5);
    }

    // Close-range grit and loose stones.
    // Round 4: the near band reached 46 m and the stone contrast was under a
    // tenth of a stop, so a graded fill surface — which in reality is 30% loose
    // stone by area — measured sd 0.061 over the whole gameplay yard and read
    // as a poured slab. Three octaves now instead of two, the band reaches
    // 78 m, and the picked-out stones are a real value break in BOTH directions
    // (pale quartz up, dark basalt down) rather than a wash.
    //
    // Round 5 integration: round 4 put ALL of that contrast in the albedo,
    // on the argument that a micro-normal does nothing under a high sun. That
    // is measurable, and it measures wrong. High-pass texture energy on near
    // sand, grain-subtracted, came out at 3.6% in open sun and 4.3-5.8% inside
    // a cast shadow at the SAME depth (ground.png y508-524, outpost.png
    // y592-624) — relative contrast RISING as the key is removed, which is the
    // signature of paint, not of relief. The two pure-noise albedo terms are
    // halved and the difference is spent on a grit-scale height field below;
    // the picked-out quartz and basalt stay in the albedo because a quartz
    // pebble really is a different colour, not just a different angle.
    if (near > 0.01) {
      float grit = opfbm(vOPP.xz * 22.0, 2);
      float mid = opfbm(vOPP.xz * 6.0, 2);
      float fines = opfbm(vOPP.xz * 62.0, 2);
      c *= 1.0 - 0.17 * (grit - 0.5) * near;
      c *= 1.0 - 0.11 * (mid - 0.5) * near;
      c *= 1.0 - 0.10 * (fines - 0.5) * near * near;
      // A beaten surface has had its loose stone kicked, swept and driven off
      // it — that ABSENCE is half of why a real path reads as polished earth.
      float loose = 1.0 - 0.85 * max(footCore, corridor * (1.0 - bermE));
      c = mix(c, uBase3 * 2.1, smoothstep(0.72, 0.92, grit) * near * (0.30 + 0.55 * hardN) * loose);
      c = mix(c, uBase2 * 0.58, smoothstep(0.74, 0.94, 1.0 - grit) * near * 0.48 * loose);
      // Stones sit ON the surface, so they roughen it and tilt their own normal.
      gRough = clamp(gRough - 0.10 * smoothstep(0.72, 0.92, grit) * near * loose, 0.14, 1.0);
    }

    // BEATEN FOOTPATHS. A desire line is worn through the loose surface to the
    // compacted earth beneath: darker, smoother, and — the part that makes it
    // read as trodden rather than painted — flanked by a scuffed margin of the
    // material that has been kicked out of it.
    vec3 beaten = uBase * (0.29 + 0.18 * n2) * (0.88 + 0.24 * n3);
    c = mix(c, beaten, foot * 0.88);
    c = mix(c, sand * 1.12, foot * (1.0 - footCore) * 0.34);
    gRough = mix(gRough, 0.68, footCore * 0.75);

    // SPILL. Oil, diesel and hydraulic fluid under everything that is parked or
    // decanted here: near-black, and far smoother than the ground it soaks.
    float oilN = max(spill, smoothstep(0.25, 0.75, oil * (0.55 + 0.9 * n3)));
    c = mix(c, vec3(0.030, 0.028, 0.026), oilN * 0.86);
    // SCORCH. The opposite material to spill — a burn scar is bone dry and
    // matt, with a rim of pale ash where the fire ran out of fuel.
    c = mix(c, vec3(0.052, 0.047, 0.043) * (0.55 + 0.9 * n3), scorch * 0.82);
    float ashRim = smoothstep(0.10, 0.26, scorchRaw) * smoothstep(0.52, 0.28, scorchRaw);
    c = mix(c, uBase3 * 1.55, ashRim * 0.34);

    // The verge is loose stone standing on fines, so it is the roughest thing
    // on the site — that gloss break is what keeps the transition visible when
    // the sun is high enough to flatten the value break.
    gRough = clamp(uRgh.x - hard * 0.03 + (n4 - 0.5) * 0.12 - oilN * 0.55
                   - corridor * 0.10 - footCore * 0.14 + scorch * 0.05
                   + vergeK * 0.05, 0.16, 1.0);
    gMetal = 0.0;
    if (uWearCtl.y > 0.5) c = vec3(foot * 0.9 + footCore * 0.1, corridor * 0.6 + rut, max(spill, scorch));

    // Gravel micro-relief. The amplitude is millimetres, not metres: a graded
    // surface is *flat*, and overdriving this reads as a lava field.
    float fade = 1.0 - smoothstep(16.0, 110.0, dcam);
    if (fade > 0.003) {
      float amp = 0.055 * (0.5 + 0.8 * hard) * (1.0 - oilN);
      float e = 0.16;
      float h0 = opfbm(vOPP.xz * 3.0, 2) + opfbm(vOPP.xz * 11.0, 2) * 0.16;
      float hx = opfbm((vOPP.xz + vec2(e, 0.0)) * 3.0, 2) + opfbm((vOPP.xz + vec2(e, 0.0)) * 11.0, 2) * 0.16;
      float hz = opfbm((vOPP.xz + vec2(0.0, e)) * 3.0, 2) + opfbm((vOPP.xz + vec2(0.0, e)) * 11.0, 2) * 0.16;
      nrm = normalize(wn + vec3((h0 - hx) * amp / e, 0.0, (h0 - hz) * amp / e) * fade);

      // Grit-scale relief, at the SAME two frequencies the grit albedo above
      // uses. Heights are in metres: a 2.2 mm pebble field at a 45 mm
      // wavelength is a peak slope of 2*pi*A/lambda = 0.30, which is a 17 deg
      // wobble — small enough that it cannot read as a lava field, large enough
      // that removing the key removes the detail with it. The finite-difference
      // step is 8 mm so the 62-cycle octave is actually resolved rather than
      // aliased. Faded by the near-band term, so it only exists where a pebble
      // subtends more than a pixel.
      float gN = near * fade * (1.0 - oilN);
      if (gN > 0.004) {
        float e2 = 0.008;
        float gA = 0.0028 * (0.6 + 0.7 * hard);
        float gB = 0.0009 * (0.6 + 0.7 * hard);
        float k0 = opfbm(vOPP.xz * 22.0, 2) * gA + opfbm(vOPP.xz * 62.0, 2) * gB;
        float kx = opfbm((vOPP.xz + vec2(e2, 0.0)) * 22.0, 2) * gA
                 + opfbm((vOPP.xz + vec2(e2, 0.0)) * 62.0, 2) * gB;
        float kz = opfbm((vOPP.xz + vec2(0.0, e2)) * 22.0, 2) * gA
                 + opfbm((vOPP.xz + vec2(0.0, e2)) * 62.0, 2) * gB;
        nrm = normalize(nrm + vec3((k0 - kx) / e2, 0.0, (k0 - kz) / e2) * gN);
      }
      // RELIEF FOR THE AUTHORED WEAR.
      //
      // Albedo alone cannot make a rut. A 55 mm groove and a 40 mm berm are
      // visible on desert ground only because they turn toward and away from a
      // low sun, and that is a normal, not a colour. Both fields are DISTANCE
      // fields, so their gradient direction is recoverable from four taps of
      // the same texture — and because a bilinear filter reconstructs a linear
      // ramp exactly, that gradient is clean at 0.5 m/texel where a sampled
      // height field would be blocky.
      if (corridor > 0.02 || foot > 0.02) {
        vec4 Wpu = texture2D(uWearMap, wuv + vec2(uWearTexel.x, 0.0));
        vec4 Wmu = texture2D(uWearMap, wuv - vec2(uWearTexel.x, 0.0));
        vec4 Wpv = texture2D(uWearMap, wuv + vec2(0.0, uWearTexel.y));
        vec4 Wmv = texture2D(uWearMap, wuv - vec2(0.0, uWearTexel.y));
        // Compound-local gradient -> world, through the compound's own yaw.
        // (x, z) = (u*cos + v*sin, -u*sin + v*cos).
        vec2 gl = vec2(Wpu.g - Wmu.g, Wpv.g - Wmv.g);
        vec2 gf = vec2(Wpu.r - Wmu.r, Wpv.r - Wmv.r);
        if (corridor > 0.02 && dot(gl, gl) > 1e-9) {
          vec2 d = normalize(gl);
          vec3 across = vec3(d.x * uTheta.x + d.y * uTheta.y, 0.0, -d.x * uTheta.y + d.y * uTheta.x);
          // d/dlat of: 55 mm rut pair, 38 mm crown between the wheels,
          // 45 mm spoil ridge on the shoulder. All signed off |lat|.
          float sgn = latS < 0.0 ? -1.0 : 1.0;
          float dh = sgn * (0.055 * 2.0 * (ra * 3.5 * exp(-ra * ra) + rb * 3.0 * 0.64 * exp(-rb * rb)) * rutW
                          - 0.045 * 2.0 * bshape / 0.78 * bermE)
                   - 0.038 * 2.0 * latS / 0.44 * crownE;
          nrm = normalize(nrm - across * dh * corridor * fade);
        }
        if (foot > 0.02 && dot(gf, gf) > 1e-9) {
          vec2 d = normalize(gf);
          vec3 aFoot = vec3(d.x * uTheta.x + d.y * uTheta.y, 0.0, -d.x * uTheta.y + d.y * uTheta.x);
          // The path itself is dished 35 mm; the relief lives entirely in the
          // shoulder where it drops off, which is where the eye reads it.
          float lip = foot * (1.0 - footCore);
          nrm = normalize(nrm + aFoot * lip * 0.16 * fade);
        }
      }
    }
  `,
};

/** Wood grain fakes a shallow directional relief; kept out of BODY for legibility. */
const WOOD_HELPER = /* glsl */ `
vec3 tangentFromGrain(vec3 wn, float grain, float gap) {
  vec3 t = cross(wn, vec3(0.0, 1.0, 0.0));
  float l = length(t);
  t = l > 0.08 ? t / l : vec3(1.0, 0.0, 0.0);
  vec3 b = cross(wn, t);
  return b * ((grain - 0.5) * 0.22 - gap * 0.55);
}
`;

const toV3 = (c) => new THREE.Vector3(c[0], c[1], c[2]);

let EMPTY_WEAR = null;
function emptyWear() {
  if (!EMPTY_WEAR) {
    EMPTY_WEAR = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
    EMPTY_WEAR.needsUpdate = true;
  }
  return EMPTY_WEAR;
}

/**
 * Build one weathered surface material.
 * Colours are LINEAR rgb triples (the renderer never leaves linear space).
 */
export function createSurface(opts = {}) {
  const {
    mode = MODE.CONCRETE,
    color = PALETTE.concrete,
    color2 = null,
    color3 = null,
    rust = PALETTE.metalRust,
    dust = [0.50, 0.445, 0.355],
    wear = 0.35,
    dustAmt = 0.30,
    scale = 1.0,
    metalness = 0.0,
    roughness = 0.9,
    // The corroded end of the range, the polished-arris end, and how much the
    // dust film is allowed to matt the surface. Defaults are the round-5
    // numbers, so a material that says nothing renders exactly as it used to.
    roughWorn = 0.94,
    roughChip = 0.45,
    dustMatt = 0.55,
    f0 = [0.560, 0.550, 0.530],
    corrFreq = 26.0,
    corrAmp = 0.55,
    dado = 0,
    dadoStrength = 0.92,
    dadoColor = [0.115, 0.098, 0.048],
    side = THREE.FrontSide,
    map = null,
    alphaTest = 0,
    transparent = false,
    depthWrite = true,
    envMapIntensity = 1.0,
    name = 'op',
  } = opts;

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness,
    metalness,
    side,
    map,
    alphaTest,
    transparent,
    depthWrite,
    envMapIntensity,
    dithering: true,
  });
  mat.name = name;
  mat.defines = { OP_MODE: mode };

  const dim = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  mat.userData.u = {
    uBase: { value: toV3(color) },
    uBase2: { value: toV3(color2 ?? dim(color, 0.74)) },
    uBase3: { value: toV3(color3 ?? dim(color, 1.22)) },
    uRust: { value: toV3(rust) },
    uDust: { value: toV3(dust) },
    uWear: { value: wear },
    uDustAmt: { value: dustAmt },
    uScale: { value: scale },
    uMetal: { value: metalness },
    uCorrFreq: { value: corrFreq },
    uCorrAmp: { value: corrAmp },
    uDadoCol: { value: toV3(dadoColor) },
    uDado: { value: new THREE.Vector2(dado, dado > 0 ? dadoStrength : 0) },
    uBounce: { value: new THREE.Vector3(0, 0, 0) },
    uRgh: { value: new THREE.Vector4(roughness, roughWorn, roughChip, dustMatt) },
    uF0: { value: toV3(f0) },
    uAbl: { value: 0 },
    // A 1x1 black default is a valid *empty* field — no pool anywhere — so a
    // surface renders correctly even if the bake fails to build.
    uLampMap: { value: emptyWear() },
    uWearOrg: { value: new THREE.Vector4(0, 0, 1, 1) },
    uTheta: { value: new THREE.Vector2(1, 0) },
    uLampGain: { value: new THREE.Vector3(0, 0, 0) },
  };
  if (mode === MODE.GROUND) {
    // Same argument for the wear field: black is "no path, no corridor, and a
    // lateral offset off the end of the rut set".
    Object.assign(mat.userData.u, {
      uWearMap: { value: emptyWear() },
      uWearTexel: { value: new THREE.Vector2(1, 1) },
      // (wear amount, debug dump, junction ablation).
      uWearCtl: { value: new THREE.Vector3(1, 0, 0) },
    });
  }

  mat.customProgramCacheKey = () => `op${mode}|${side}|${alphaTest > 0 ? 'a' : ''}|${map ? 'm' : ''}`;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.u);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         ${VARY}
         attribute vec3 aWeather;
         attribute vec3 aVar;
         #if OP_MODE == 5
         attribute vec4 aTrack;
         attribute vec3 aGround;
         #endif`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         {
           vec3 opN = objectNormal;
           #ifdef USE_INSTANCING
             opN = mat3(instanceMatrix) * opN;
           #endif
           vOPN = normalize(mat3(modelMatrix) * opN);
         }`,
      )
      .replace(
        '#include <project_vertex>',
        `{
           vec4 opWP = vec4(transformed, 1.0);
           #ifdef USE_INSTANCING
             opWP = instanceMatrix * opWP;
           #endif
           vOPP = (modelMatrix * opWP).xyz;
         }
         vOPW = aWeather;
         vOPV = aVar;
         #if OP_MODE == 5
         vOPT = aTrack;
         vOPC = vec3(aGround.x, normalize(mat3(modelMatrix) * vec3(aGround.y, 0.0, aGround.z)).xz);
         vOPL = transformed.xz;
         #endif
         #include <project_vertex>`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         ${VARY}
         ${UNIFORMS}
         ${NOISE_GLSL}
         ${WOOD_HELPER}
         float gRough = 0.9;
         float gMetal = 0.0;
         vec3 gNorm = vec3(0.0, 1.0, 0.0);`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         {
           ${PROLOGUE}
           ${BODY[mode]}
           ${EPILOGUE}
         }`,
      )
      // Bounced light off sunlit sand.
      //
      // This is the fix for the coldest defect in round 1: the PMREM probe is
      // generated from the SKY DOME ONLY, so every downward- and side-facing
      // surface in the compound was being lit by pure Rayleigh blue with no
      // ground term whatsoever, and the whole outpost measured bluer than it
      // measured red in broad daylight. In Afghanistan the lower hemisphere is
      // dominated by sunlit khaki gravel at a very high albedo, and that warm
      // bounce is most of what fills a shadow. `uBounce` is driven from the
      // time of day so it dies with the sun instead of glowing at midnight.
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
         {
           vec3 bn = normalize(vOPN);
           #ifdef DOUBLE_SIDED
             bn *= (float(gl_FrontFacing) * 2.0 - 1.0);
           #endif
           float lower = clamp(0.55 - 0.55 * bn.y, 0.0, 1.0);
           reflectedLight.indirectDiffuse += diffuseColor.rgb * uBounce * lower;
           // Baked lamp pools.
           //
           // Round 5 measured the site's lamps radially and found no pool at
           // all: "the lamps are emissive decals, not lights". There are ~40 of
           // them and three.js's forward path loops every light in every
           // fragment of every material, so forty more real lights is not a
           // trade this frame budget can make. What every one of them mostly
           // does for the image is light the FLOOR — and a fixed lamp over
           // graded ground has an exactly computable floor pool, so it is
           // rasterised once (wear.js addLamp: Lambert on a horizontal plane,
           // inverse square, cut by the shade's own half-angle) and costs one
           // texture fetch. The masts and floods that light objects as well as
           // ground are still real lights.
           //
           // Round 6: the pool used to be applied to OP_MODE 5 only, i.e. to the
           // pad and nothing else, and that is why the night frame still read as
           // "lamps that emit no light" even with the pool switched on — a drum
           // standing in the middle of a lit pool was drawn at exactly its
           // moonlit value, so the pool became a painted disc that objects
           // occlude but never receive. Every mode samples it now. The compound
           // is one rigid group, so the local coordinate the pool is rasterised
           // in is just the world position turned back through the yaw.
           //
           // The branch is on a UNIFORM, so it is coherent and derivatives
           // inside it are well defined; in daylight uLampGain is zero and the
           // fetch does not happen at all.
           if (uLampGain.x > 0.0) {
             #if OP_MODE == 5
             vec2 lpl = vOPL;
             #else
             vec2 lpl = vec2(vOPP.x * uTheta.x - vOPP.z * uTheta.y,
                             vOPP.x * uTheta.y + vOPP.z * uTheta.x);
             #endif
             vec3 pool = texture2D(uLampMap, (lpl - uWearOrg.xy) * uWearOrg.zw).rgb;
             pool *= pool;
             #if OP_MODE != 5
             // The field is irradiance on the FLOOR. A surface a metre up is
             // nearer the lamp, not further, but it is also progressively out
             // from under the shade, so the honest cheap answer is to hold it
             // for the first couple of metres and let it die by the eaves —
             // a lit ground plane under an unlit building is exactly the tell
             // this is here to remove, and a lit parapet nine metres up is the
             // opposite one.
             pool *= 1.0 - smoothstep(1.3, 4.6, vOPP.y);
             // Light arrives from above and from the side. A downward-facing
             // face sees the pool's own bounce; an up-facing one sees the
             // fixture. Neither is zero, so this only shapes it.
             //
             // The 0.72: a floor irradiance field over-reads on a wall, and the
             // whole point of a night frame is that it stays a night frame —
             // measured, every extra 10% here costs about 0.4 of the ground
             // band's blue-minus-red, which is the criterion this must not eat.
             pool *= (0.72) * (0.42 + 0.58 * (1.0 - abs(bn.y)));
             #endif
             reflectedLight.indirectDiffuse += diffuseColor.rgb * pool * uLampGain;
           }
         }`,
      )
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n roughnessFactor = gRough;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n metalnessFactor = gMetal;`)
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         normal = normalize((viewMatrix * vec4(gNorm, 0.0)).xyz);`,
      );

    mat.userData.shader = shader;
  };

  return mat;
}
