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
  gRough = clamp(mix(gRough, 0.96, clamp(dustMask, 0.0, 1.0) * 0.55), 0.05, 1.0);
  gMetal = gMetal * (1.0 - clamp(dustMask, 0.0, 1.0) * 0.6);
  c *= 0.90 + 0.19 * vOPV.z;
  diffuseColor.rgb *= max(c, vec3(0.0));
  gNorm = normalize(nrm);
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
    gRough = clamp(0.90 + (m2 - 0.5) * 0.18, 0.5, 1.0);
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
    gRough = mix(gRough, 0.44, chipE * 0.62);
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
    gRough = clamp(0.88 + (m2 - 0.5) * 0.16 + joint * 0.08, 0.5, 1.0);
    gRough = mix(gRough, 0.46, chipE * 0.58);
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
    c = mix(c, mix(uRust * 1.15, vec3(0.20, 0.19, 0.18), 0.35) * (0.7 + 0.5 * m2), clamp(chipE * 0.65, 0.0, 0.75));
    gRough = clamp(mix(0.46, 0.94, rustM) + (m3 - 0.5) * 0.08 + run * 0.35, 0.08, 1.0);
    gRough = mix(gRough, 0.42, chipE * 0.45);
    gMetal = mix(uMetal, 0.04, max(rustM, run * 0.8));
    gMetal = mix(gMetal, 0.55, chipE * 0.35);
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
    gRough = clamp(mix(0.50, 0.95, rustM) - fix * 0.25, 0.1, 1.0);
    gMetal = mix(uMetal, 0.04, rustM);
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
    gRough = clamp(0.86 + (grain - 0.5) * 0.2 + gap * 0.1, 0.5, 1.0);
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
    gRough = 0.98;
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
    gRough = clamp(0.93 + (n2s - 0.5) * 0.08, 0.6, 1.0);
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
    float wild = (1.0 - grade) * (1.0 - road);
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
    float gradeN = clamp(grade * 1.35 - 0.30 + (n1 - 0.5) * 0.50, 0.0, 1.0);
    vec3 c = mix(sand, fill, gradeN * 0.78);

    // Graded gravel hardstanding: cooler, coarser, crushed rock through the fines.
    vec3 gravel = mix(uBase * 0.58, uBase3, 0.5 + 0.4 * n2);
    gravel = mix(gravel, uBase3 * 1.9, smoothstep(0.60, 0.95, n4) * 0.45);
    gravel = mix(gravel, uBase * 0.82, smoothstep(0.62, 0.30, n3) * 0.4);
    gravel *= 0.90 + 0.20 * n4;
    float hardN = clamp(hard * 1.25 - 0.25 + (n1 - 0.5) * 0.55, 0.0, 1.0);
    c = mix(c, gravel, hardN);
    // Big, slow tonal drift across the platform: fill from different borrow pits.
    c *= 0.80 + 0.42 * n0;

    // Vehicle track: compacted fines, two wheel ruts, loose spoil at the shoulder.
    // Compacted fines are markedly darker and smoother than the surround: that
    // value break is what makes a track read as a track from 100 m up.
    vec3 dirt = uBase * (0.46 + 0.26 * n2) * (0.9 + 0.2 * n3);
    float shoulder = smoothstep(0.35, 1.0, abs(lat) * 0.28);
    c = mix(c, mix(dirt, sand * 1.10, shoulder), road);
    gRough = mix(gRough, 0.80, road * (1.0 - shoulder) * 0.6);
    // Two wheel ruts each side of the crown, wandering the way a truck does.
    // Round 4: the rut set was symmetric, fixed-width and albedo-only, which is
    // a stripe rather than a rut. It now wanders (the sway term, a slow
    // function of arc length, so both ruts move together as one vehicle line),
    // it is narrower and deeper, and it carries a NORMAL so the groove picks up
    // a shadow on one flank and a highlight on the other at low sun — which is
    // the only reason a 60mm depression is visible on sand at all.
    float sway = (opfbm(vec2(along * 0.045, 3.7), 2) - 0.5) * 1.30;
    float r1 = (abs(lat) - (1.02 + sway)) * 3.4;
    float r2 = (abs(lat) - (2.62 + sway)) * 3.0;
    float rut = exp(-r1 * r1) + exp(-r2 * r2) * 0.62;
    float rutN = 0.45 + 0.9 * opfbm(vec2(along * 0.55, lat * 4.0), 2);
    rut = clamp(rut, 0.0, 1.0) * road * rutN;
    c *= 1.0 - 0.40 * rut;
    gRough = mix(gRough, 0.72, rut * 0.5);
    // Loose spoil pushed to the shoulder catches the light and outlines the track.
    float shoulderBand = smoothstep(0.45, 0.05, abs(abs(lat) * 0.30 - 1.05));
    c = mix(c, sand * 1.16, shoulderBand * road * 0.45);

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
      c = mix(c, uBase3 * 2.1, smoothstep(0.72, 0.92, grit) * near * (0.30 + 0.55 * hardN));
      c = mix(c, uBase2 * 0.58, smoothstep(0.74, 0.94, 1.0 - grit) * near * 0.48);
      // Stones sit ON the surface, so they roughen it and tilt their own normal.
      gRough = clamp(gRough - 0.10 * smoothstep(0.72, 0.92, grit) * near, 0.14, 1.0);
    }

    // Worn footpaths: boot traffic polishes the fines and kills the gravel.
    // Round 4: a beaten path is not just darker, it has a CROWN of scuffed
    // lighter material either side of a polished core, and boot prints churn the
    // edges. Without the edge break it reads as a painted line.
    c = mix(c, dirt * 1.02, path * (0.6 + 0.4 * n3));
    float pathEdge = smoothstep(0.20, 0.62, path) * smoothstep(0.98, 0.66, path);
    c = mix(c, sand * 1.14, pathEdge * 0.42);
    gRough = mix(gRough, 0.78, path * 0.45);

    // Oil and diesel: dark, low-roughness, slightly iridescent at the edge.
    float oilN = smoothstep(0.25, 0.75, oil * (0.55 + 0.9 * n3));
    c = mix(c, vec3(0.030, 0.028, 0.026), oilN * 0.85);

    gRough = clamp(0.94 - hard * 0.03 + (n4 - 0.5) * 0.12 - oilN * 0.55, 0.16, 1.0);
    gMetal = 0.0;

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
      // The rut groove itself. lat runs across the track, so its gradient in
      // world space is the track's own normal direction; d(rut)/d(lat) rolls the
      // shading normal into and out of the groove, which is what puts a 60mm
      // depression on the screen at all. Analytic rather than sampled, because
      // the rut is defined by lat and there is nothing to sample.
      float dr = -2.0 * (r1 * 3.4 * exp(-r1 * r1) + r2 * 3.0 * exp(-r2 * r2) * 0.62);
      vec3 across = normalize(vec3(vOPC.y, 0.0, vOPC.z) + vec3(1e-5, 0.0, 0.0));
      nrm = normalize(nrm + across * dr * road * rutN * 0.085 * sign(lat) * fade);
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
  };

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
