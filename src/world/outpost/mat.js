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
};

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
  float wear = clamp(uWear + vOPW.y + vOPV.x, 0.0, 1.5);
  // Pick the horizontal axis that runs ALONG the face so streaks stay thin.
  float sx = abs(wn.x) > abs(wn.z) ? vOPP.z : vOPP.x;

  float m1 = optri(vOPP, wn, 0.30 * uScale, 4);
  float m2 = optri(vOPP, wn, 1.9 * uScale, 3);
  float m3 = optri(vOPP, wn, 7.5 * uScale, 2);

  // Streaks: noise stretched ~30:1 vertically, only on near-vertical faces,
  // strongest just under the top edge and fading out before the ground.
  float st = opn2(vec2(sx * 3.1 * uScale, vOPP.y * 0.10));
  float streak = smoothstep(0.46, 0.90, st * 0.72 + m1 * 0.45);
  streak *= smoothstep(1.05, 0.28, y01) * side;
  float splash = smoothstep(0.16, 0.0, y01) * side;
  vec3 nrm = wn;
`;

/** Shared epilogue: the unifying desert dust film + gentle value jitter. */
const EPILOGUE = /* glsl */ `
  float dustMask = uDustAmt * (0.30 + 0.55 * up) * (0.45 + 0.75 * m1);
  dustMask += uDustAmt * splash * 0.7;
  c = mix(c, uDust * (0.8 + 0.4 * m2), clamp(dustMask, 0.0, 0.85));
  gRough = clamp(mix(gRough, 0.96, clamp(dustMask, 0.0, 1.0) * 0.55), 0.05, 1.0);
  gMetal = gMetal * (1.0 - clamp(dustMask, 0.0, 1.0) * 0.6);
  c *= 0.90 + 0.19 * vOPV.z;
  diffuseColor.rgb *= max(c, vec3(0.0));
  gNorm = normalize(nrm);
`;

const BODY = {
  [MODE.CONCRETE]: /* glsl */ `
    // Patch history first: pours from different decades, different cement.
    float pourAge = optri(vOPP, wn, 0.055 * uScale, 3);
    vec3 c = mix(uBase, uBase3, smoothstep(0.42, 0.78, pourAge) * 0.45);
    c = mix(c, uBase2, clamp(m1 * 1.45 - 0.22, 0.0, 1.0));
    c *= 0.84 + 0.32 * m2;
    // Shuttering board seams every 850mm.
    float seam = 1.0 - smoothstep(0.0, 0.030, abs(fract(vOPP.y / 0.85 + 0.5) - 0.5));
    c *= 1.0 - 0.20 * seam * side;
    // Dirt washing down the face — the single strongest "this is not CG" cue.
    c *= 1.0 - 0.52 * streak * (0.45 + wear);
    // Splash zone: mud and salt at the bottom of every wall.
    c = mix(c, uBase * 0.42 * (0.7 + 0.6 * m3), splash * 0.92);
    // Sun-bleached tops.
    c = mix(c, c * 1.22 + 0.02, up * 0.5);
    // Spalled edges: exposed aggregate near the top, with rust bleed from rebar.
    float chip = smoothstep(0.70, 0.94, m3) * (smoothstep(0.82, 1.0, y01) * 1.7 + 0.24 * wear);
    chip = clamp(chip, 0.0, 1.0);
    c = mix(c, uBase * 0.55 + vec3(0.02, 0.017, 0.014), chip * 0.7);
    c = mix(c, uRust * 0.8, clamp(chip * streak * 1.6, 0.0, 0.6));
    // Fine pinholing and aggregate at arm's length.
    float fine = optri(vOPP, wn, 26.0 * uScale, 2);
    c *= 0.93 + 0.14 * fine;
    gRough = clamp(0.90 + (m2 - 0.5) * 0.18, 0.5, 1.0);
    gMetal = 0.0;
    // Relief so a shaded facade still catches a gradient from the sky.
    nrm = normalize(wn + vec3(m3 - 0.5, m2 - 0.5, m2 - 0.5) * 0.22 * (0.4 + chip)
                       - vec3(0.0, seam * side * 0.12, 0.0));
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
    gRough = clamp(mix(0.46, 0.94, rustM) + (m3 - 0.5) * 0.08, 0.08, 1.0);
    gMetal = mix(uMetal, 0.04, rustM);
    nrm = normalize(wn + vec3(m3 - 0.5, 0.0, m2 - 0.5) * 0.14 * rustM);
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
    gRough = clamp(mix(0.50, 0.95, rustM), 0.1, 1.0);
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
    vec3 c = mix(uBase, uBase2, clamp(m1 * 1.3 - 0.1, 0.0, 1.0));
    // Coarse weave, plus big slack folds.
    float weave = 0.5 + 0.5 * sin(vOPP.x * 130.0) * sin(vOPP.z * 130.0);
    float fold = optri(vOPP, wn, 0.9 * uScale, 3);
    c *= 0.86 + 0.22 * weave;
    c *= 0.82 + 0.36 * fold;
    c = mix(c, uBase3, smoothstep(0.55, 0.95, m2) * 0.5);
    c *= 1.0 - 0.25 * streak * wear;
    gRough = 0.97;
    gMetal = 0.0;
    nrm = normalize(wn + vec3(fold - 0.5, 0.0, m2 - 0.5) * 0.55);
  `,
  [MODE.GROUND]: /* glsl */ `
    float road = clamp(vOPT.x, 0.0, 1.0);
    float lat = vOPT.y;
    float along = vOPT.z;
    float hard = clamp(vOPT.w, 0.0, 1.0);
    float oil = clamp(vOPW.y, 0.0, 1.0);
    float path = clamp(vOPW.z, 0.0, 1.0);

    float dcam = length(vOPP - cameraPosition);
    float near = 1.0 - smoothstep(5.0, 46.0, dcam);
    float n0 = opfbm(vOPP.xz * 0.011, 3);
    float n1 = opfbm(vOPP.xz * 0.055, 4);
    float n2 = opfbm(vOPP.xz * 0.42, 3);
    float n3 = opfbm(vOPP.xz * 2.6, 2);
    float n4 = opfbm(vOPP.xz * 13.0, 2);

    vec3 sand = mix(uBase2, uBase, clamp(n0 * 0.5 + n1 * 0.8 + n2 * 0.45 - 0.15, 0.0, 1.0));
    sand *= 0.88 + 0.26 * n3;
    // Drifted fines catch on the lee of every bump — big, soft, low-contrast.
    sand = mix(sand, uBase * 1.12, smoothstep(0.55, 0.9, n1) * 0.35);

    // Graded gravel hardstanding: cooler, coarser, crushed rock through the fines.
    vec3 gravel = mix(uBase * 0.58, uBase3, 0.5 + 0.4 * n2);
    gravel = mix(gravel, uBase3 * 1.9, smoothstep(0.60, 0.95, n4) * 0.45);
    gravel = mix(gravel, uBase * 0.82, smoothstep(0.62, 0.30, n3) * 0.4);
    gravel *= 0.90 + 0.20 * n4;
    float hardN = clamp(hard * 1.25 - 0.25 + (n1 - 0.5) * 0.55, 0.0, 1.0);
    vec3 c = mix(sand, gravel, hardN);
    // Big, slow tonal drift across the platform: fill from different borrow pits.
    c *= 0.80 + 0.42 * n0;

    // Vehicle track: compacted fines, two wheel ruts, loose spoil at the shoulder.
    // Compacted fines are markedly darker and smoother than the surround: that
    // value break is what makes a track read as a track from 100 m up.
    vec3 dirt = uBase * (0.46 + 0.26 * n2) * (0.9 + 0.2 * n3);
    float shoulder = smoothstep(0.35, 1.0, abs(lat) * 0.28);
    c = mix(c, mix(dirt, sand * 1.10, shoulder), road);
    gRough = mix(gRough, 0.80, road * (1.0 - shoulder) * 0.6);
    float rut = exp(-pow((abs(lat) - 0.92) * 2.2, 2.0)) + exp(-pow((abs(lat) - 2.6) * 2.8, 2.0)) * 0.5;
    float rutN = 0.45 + 0.9 * opfbm(vec2(along * 0.55, lat * 4.0), 2);
    c *= 1.0 - 0.34 * clamp(rut, 0.0, 1.0) * road * rutN;
    // Loose spoil pushed to the shoulder catches the light and outlines the track.
    float shoulderBand = smoothstep(0.45, 0.05, abs(abs(lat) * 0.30 - 1.05));
    c = mix(c, sand * 1.16, shoulderBand * road * 0.45);

    // Close-range grit and loose stones. At high sun the micro-normal does almost
    // nothing, so the near-field surface has to be carried by albedo.
    if (near > 0.01) {
      float grit = opfbm(vOPP.xz * 22.0, 2);
      float mid = opfbm(vOPP.xz * 6.0, 2);
      c *= 1.0 - 0.34 * (grit - 0.5) * near;
      c *= 1.0 - 0.20 * (mid - 0.5) * near;
      c = mix(c, uBase3 * 1.7, smoothstep(0.74, 0.93, grit) * near * (0.25 + 0.5 * hardN));
      c = mix(c, uBase2 * 0.75, smoothstep(0.76, 0.95, 1.0 - grit) * near * 0.35);
    }

    // Worn footpaths: boot traffic polishes the fines and kills the gravel.
    c = mix(c, dirt * 1.05, path * (0.6 + 0.4 * n3));

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
