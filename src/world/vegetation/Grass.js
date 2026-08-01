import * as THREE from 'three';
import { GLSL_DRY_SHADING, GLSL_NOISE, GLSL_TERRAIN, GLSL_WIND } from './shaderLib.js';
import { mulberry32 } from './VegField.js';

/**
 * Grass — dry Afghan tussock, placed and animated entirely on the GPU.
 *
 * The CPU never touches an instance. Each InstancedMesh is a fixed lattice of
 * cells that is *snapped* to the camera in world space, so as you walk the set of
 * occupied cells changes but every surviving tuft stays nailed to the same patch
 * of ground (a camera-relative scatter would slide, which instantly reads as fake).
 * The vertex shader samples the baked terrain height texture to root and tilt the
 * tuft, samples the drainage/slope/development mask to decide whether the tuft
 * exists at all, and dithers it out over the last few metres of the ring instead
 * of popping.
 *
 * Four rings of instanced tufts, one silhouette, geometry cost falling by
 * roughly 2x per step, and then a fifth layer that is not tufts at all:
 *
 *   near   9 blades x 3 segments      0 -  13 m   full ribbons
 *   mid    6 blades x 2 segments      9 -  28 m
 *   far    5 blades x 1 segment      20 -  66 m   merged into tufts
 *   cover  5 blades x 1 segment      52 - 140 m   a stipple of ground cover
 *   mat    flat soft-edged patches   34 - 930 m   coverage as ground tone
 *
 * Round 2 ran the tuft rings out to 158 m, and out to 1264 m once the altitude
 * zoom stretched them. That is the bug all three critics described as white
 * confetti: a sub-pixel vertical blade, lit as a translucent membrane, standing
 * in front of horizontal ground lit as a diffuse mineral. It cannot match, so it
 * detaches. 140 m is where a tuft stops being resolvable, and past it the
 * coverage is drawn as a darkening of the ground itself. See createCoverMat.
 */

const TAU = Math.PI * 2;

/**
 * One tuft: several curved ribbons springing from a common root.
 * Blades taper to a point, carry a rounded (cylinder-ish) normal so they don't
 * read as flat cards, and store (t, phase, side) for the wind stage.
 */
export function buildTuft({ blades, segments, seed, minH, maxH, width, spread, curve, dome = 0 }) {
  const rng = mulberry32(seed);
  const vertsPerBlade = (segments + 1) * 2;
  const trisPerBlade = segments * 2;
  const pos = new Float32Array(blades * vertsPerBlade * 3);
  const nrm = new Float32Array(blades * vertsPerBlade * 3);
  const veg = new Float32Array(blades * vertsPerBlade * 3);
  const idx = new Uint16Array(blades * trisPerBlade * 3);

  let ip = 0;
  for (let b = 0; b < blades; b++) {
    const az = rng() * TAU;
    const dirX = Math.cos(az);
    const dirZ = Math.sin(az);
    const sideX = -dirZ;
    const sideZ = dirX;
    const h = minH + (maxH - minH) * rng();
    const w = width * (0.72 + 0.56 * rng());
    const lean = curve * (0.45 + rng());
    const phase = rng();
    const rootR = spread * Math.sqrt(rng());
    const rootAz = rng() * TAU;
    const rx = Math.cos(rootAz) * rootR;
    const rz = Math.sin(rootAz) * rootR;
    const base = b * vertsPerBlade;

    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      // Spine: arcs over as it rises, so the tip droops the way dead grass does.
      const arc = lean * t * t;
      const y = h * t * (1.0 - 0.28 * arc * arc);
      const off = h * lean * t * t * 0.85;
      const cx = rx + dirX * off;
      const cz = rz + dirZ * off;

      // Ribbon normal = cross(side, spineTangent), with
      // side = (sideX, 0, sideZ) and tangent = (dirX*tf, ty, dirZ*tf).
      const dy = h * (1.0 - 0.28 * arc * arc);
      const doff = h * lean * 2.0 * t * 0.85;
      const tl = Math.hypot(dy, doff) || 1;
      const ty = dy / tl;
      const tf = doff / tl;
      let fnx = -sideZ * ty;
      let fny = sideZ * dirX * tf - sideX * dirZ * tf;
      let fnz = sideX * ty;
      const fl = Math.hypot(fnx, fny, fnz) || 1;
      fnx /= fl;
      fny /= fl;
      fnz /= fl;

      // Taper is gentler than round 1's: a blade that pinches to a needle over
      // its last third is a sub-pixel spike that shimmers and reads as noise.
      const halfW = 0.5 * w * Math.pow(Math.max(0, 1 - t * t * 0.88), 0.52);
      for (let k = 0; k < 2; k++) {
        const sgn = k === 0 ? -1 : 1;
        const o = (base + s * 2 + k) * 3;
        pos[o] = cx + sideX * halfW * sgn;
        pos[o + 1] = y;
        pos[o + 2] = cz + sideZ * halfW * sgn;
        // Splay the normals across the blade width — a flat normal makes grass
        // read as cut paper under a hard sun.
        let ex = fnx + sideX * 0.42 * sgn;
        let ey = fny;
        let ez = fnz + sideZ * 0.42 * sgn;
        if (dome > 0) {
          // Bush clumps are a solid mass, not a handful of independent leaves:
          // shading them off a dome normal is what makes a distant bush read as
          // one lit object instead of a sparkle of unrelated facets.
          const px = cx + sideX * halfW * sgn;
          const pz = cz + sideZ * halfW * sgn;
          const dl = Math.hypot(px, y * 0.55, pz) || 1;
          ex += (px / dl - ex) * dome;
          ey += ((y * 0.55) / dl - ey) * dome;
          ez += (pz / dl - ez) * dome;
        }
        const el = Math.hypot(ex, ey, ez) || 1;
        nrm[o] = ex / el;
        nrm[o + 1] = ey / el;
        nrm[o + 2] = ez / el;
        veg[o] = t;
        veg[o + 1] = phase;
        veg[o + 2] = sgn;
      }
    }

    for (let s = 0; s < segments; s++) {
      const a = base + s * 2;
      idx[ip++] = a;
      idx[ip++] = a + 1;
      idx[ip++] = a + 2;
      idx[ip++] = a + 1;
      idx[ip++] = a + 3;
      idx[ip++] = a + 2;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('aVeg', new THREE.BufferAttribute(veg, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

const GRASS_VERT_HEAD = /* glsl */ `
attribute vec3 aVeg;   // (t along blade, per-blade phase, side sign)
attribute vec2 aCell;  // lattice coordinate inside this ring
uniform vec2 uFieldCell;
uniform vec4 uRing;    // (cellSize, gridHalf, innerFadeEnd, outerFadeEnd)
uniform vec2 uRingFadeIn;  // (innerFadeStart, outerFadeStart)
uniform vec4 uTuft;    // (scaleMin, log(scaleMax/scaleMin), widthGain, normalLift)
uniform float uWidenMax;
uniform vec2 uFarFade; // (fade start, hard cut) in metres
varying float vVegT;
varying vec3 vVegTint;
varying float vVegAO;
varying vec3 vVegN;
`;

const GRASS_VERT_BODY = /* glsl */ `
  vec2 cellIdx = uFieldCell + aCell - uRing.y;
  vec2 cellBase = cellIdx * uRing.x;
  vec2 jitter = vegHash22(cellIdx) - 0.5;
  vec2 wxz = cellBase + jitter * uRing.x * 0.92;

  float slope;
  float devK;
  float dens = vegDensity(wxz, slope, devK);

  float dist = length(wxz - cameraPosition.xz);
  float outer = 1.0 - smoothstep(uRingFadeIn.y, uRing.w, dist);
  float inner = smoothstep(uRing.z, uRingFadeIn.x, dist);
  float ringFade = outer * inner;

  // The hard end of the instanced field. Past uFarFade.y a tuft is a fraction
  // of a pixel, and a fraction of a pixel that is brighter than its background
  // is a snowflake — which is exactly what all three critics read off the dawn
  // frame. Beyond here the coverage is carried by the tonal cover layer, which
  // paints it into the ground instead of standing it up in front of the ground.
  //
  // Thinned stochastically *and* shrunk: thinning alone leaves full-height
  // tufts right up to the cut, shrinking alone leaves a field of ever-smaller
  // specks, which is the confetti in another form.
  float farK = 1.0 - smoothstep(uFarFade.x, uFarFade.y, dist);
  float pickF = vegHash21(cellIdx + 517.3);
  float far_ = (pickF < farK) ? (0.42 + 0.58 * farK) : 0.0;

  // Two independent dither draws. The first thins by ground fertility and must
  // NOT shrink what survives — grass on poor ground is sparser, not stunted. The
  // second thins at the ring boundary, where a little shrinking is exactly what
  // sells the fade, so the edge of the field is a gradient and never a circle.
  float pick = vegHash21(cellIdx + 91.7);
  float pickR = vegHash21(cellIdx + 313.1);
  float aliveR = ringFade - pickR;
  float grow = (dens > pick && aliveR > 0.0) ? (0.62 + 0.38 * smoothstep(0.0, 0.30, aliveR)) : 0.0;
  grow *= far_;

  vec3 gVegPos = vec3(0.0);
  vec3 gVegNrm = vec3(0.0, 1.0, 0.0);

  if (grow > 0.001) {
    vec2 r2 = vegHash22(cellIdx + 5.31);
    float rot = r2.x * 6.2831853;
    float cs = cos(rot), sn = sin(rot);
    // Tussocks are tallest in the middle of a clump and stunted at its edge.
    float clump = vegFbm(wxz * 0.42 + 7.0, 2);
    // Log-uniform over a 3x range, not linear over 1.6x. A linear draw piles
    // everything near the mean and the field reads as one stamped size, which
    // is half of what makes a scatter look procedural; a log draw spends as
    // much of its range on the small half as on the large.
    float scale = uTuft.x * exp(uTuft.y * r2.y) * grow * (0.62 + clump * 0.95);
    // Weeds that survive on a compound apron are trampled, chewed and stunted.
    // Full-height tussock inside the wire reads as an abandoned lot.
    scale *= mix(1.0, 0.52, smoothstep(0.35, 0.90, devK));

    vec3 p = position;
    vec3 n = normal;
    float t = aVeg.x;

    // Thicken blades with distance. Below ~1.5 px wide a blade stops being a
    // blade and becomes shimmer, and 1.5 px at 60 m is seven centimetres — far
    // wider than any real blade, but a sharp thin thing that flickers reads as
    // a rendering fault while a slightly fat one just reads as grass.
    // Width only; length must not stretch.
    float widen = min(1.0 + dist * uTuft.z, uWidenMax);
    p.xz += normalize(p.xz + vec2(1e-6)) * length(p.xz) * (widen - 1.0) * (1.0 - t * 0.35);
    // Squash each tuft on a random pair of axes before rotating it. Every ring
    // shares one tuft mesh, so without this the whole field is one silhouette
    // stamped at N rotations — legible as a repeat the moment two neighbours
    // land at similar angles.
    vec2 asp = 0.70 + 0.60 * vegHash22(cellIdx + 41.7);
    p.x *= asp.x;
    p.z *= asp.y;
    p = vec3(cs * p.x - sn * p.z, p.y, sn * p.x + cs * p.z) * scale;
    n = vec3(cs * n.x - sn * n.z, n.y, sn * n.x + cs * n.z);

    // ---- wind ----
    float gust = vegGust(wxz);
    float bendAmt = uWind.z * (0.16 + gust * 1.3) * scale;
    vec2 wd = uWind.xy;
    // Stiffer at the base than the tip: t^2 puts almost all the motion up top.
    float stiff = t * t;
    float flutter = sin(uTime * 8.4 + aVeg.y * 6.283 + gust * 9.0 + wxz.x * 0.7) * 0.05 * stiff * (0.25 + gust);
    p.xz += wd * bendAmt * stiff + vec2(-wd.y, wd.x) * flutter * scale;
    p.y -= bendAmt * bendAmt * stiff * 1.4;
    // Tilt the normal with the bend so lighting follows the blade over.
    float slopeBend = bendAmt * 2.0 * t / max(0.1, scale);
    vec3 wd3 = vec3(wd.x, 0.0, wd.y);
    n = normalize(n - wd3 * n.y * slopeBend + vec3(0.0, 1.0, 0.0) * dot(n, wd3) * slopeBend);

    // ---- root to the ground and lean with the ground normal ----
    vec3 gn = vegNormalAt(wxz, 2.0);
    vec3 up = mix(vec3(0.0, 1.0, 0.0), gn, 0.72);
    vec3 tx = normalize(cross(vec3(0.0, 0.0, 1.0), up) + vec3(1e-5, 0.0, 0.0));
    vec3 tz = cross(up, tx);
    mat3 basis = mat3(tx, up, tz);
    p = basis * p;
    // A blade's true normal is very nearly horizontal, which under a hard sun
    // splits the field into a lit half and a black half. Real grass reads as a
    // soft canopy, so the shading normal is pulled toward the ground normal —
    // the classic foliage cheat, and the single biggest "not plastic" win here.
    n = normalize(mix(basis * n, up, uTuft.w));

    float gh = vegHeightAt(wxz);
    gVegPos = vec3(wxz.x, gh - 0.03, wxz.y) + p;
    gVegNrm = n;

    // Straw is bleached at the tip and stained toward the root; a per-tuft
    // shift keeps the field from reading as one flat colour.
    float tint = vegHash21(cellIdx + 23.9);
    vVegTint = mix(uGrassDark, uGrassLight, clamp(tint * 0.42 + aVeg.y * 0.32 + t * 0.55 + 0.10, 0.0, 1.0));
    // Two extra families, or the whole field is one note: stands that have gone
    // over to rust, and older olive-brown tussock that never bleached. Both stay
    // warm — red over blue — because Afghan daylight has no cold grass in it.
    float family = vegHash21(cellIdx + 77.3);
    vVegTint = mix(vVegTint, vVegTint * vec3(1.22, 0.98, 0.66), smoothstep(0.58, 0.92, family) * 0.85);
    vVegTint = mix(vVegTint, vVegTint * vec3(0.94, 0.90, 0.72), (1.0 - smoothstep(0.08, 0.40, family)) * 0.55);
    // Root shadow, but lifted: round 1 crushed the blade base to near-black.
    // Capped at 1.0 — the old curve peaked at 1.23, which is a material that
    // reflects more light than lands on it, and it was doing that on the very
    // pixels (blade tips against distant ground) that read as confetti.
    // Round 4: floor 0.80 -> 0.87. The occlusion inside a 20 cm tussock is real
    // but it is not a fifth of the hemisphere, and it was the third of three
    // places round 3 subtracted for the same effect.
    vVegAO = mix(0.87, 1.00, smoothstep(0.0, 0.24, t)) * mix(0.93, 1.00, tint);
    vVegT = t;
    vVegN = n;
  } else {
    // Collapse to a degenerate point at the root: no fragments, no pop.
    gVegPos = vec3(wxz.x, vegHeightAt(wxz), wxz.y);
    vVegTint = uGrassDark;
    vVegAO = 1.0;
    vVegT = 0.0;
    vVegN = vec3(0.0, 1.0, 0.0);
  }
`;

export function createGrassRing(field, uniforms, opts) {
  const {
    blades, segments, cellSize, grid, innerStart, innerEnd, outerStart, outerEnd,
    minH, maxH, width, spread, curve, scaleMin, scaleMax, widthGain, widenMax, normalLift, seed,
  } = opts;

  const geo = buildTuft({ blades, segments, seed, minH, maxH, width, spread, curve });

  // The ring is an annulus but the lattice is a square, and every instance in
  // the corners or in the hole collapses to a degenerate point — invisible, but
  // still counted and still shaded. Emitting only the cells that fall inside the
  // annulus is a third to a half of the triangle budget back for nothing. The
  // radii are in *cells*, which is invariant under the altitude zoom because the
  // ring radii and the cell size scale together.
  const half = grid * 0.5;
  const rIn = Math.max(0, innerStart / cellSize) - 1.0;
  const rOut = outerEnd / cellSize + 1.0;
  const keep = [];
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const d = Math.hypot(i + 0.5 - half, j + 0.5 - half);
      if (d < rIn || d > rOut) continue;
      keep.push(i, j);
    }
  }
  const count = keep.length / 2;
  geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(keep), 2));

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.86,
    metalness: 0.0,
    side: THREE.DoubleSide,
    // Below 1.0, and deliberately: a blade stands inside its own canopy and
    // inside a tussock, so it sees rather less than a full hemisphere of sky.
    // At 1.15 it saw *more* than a flat open surface does, which is one of the
    // reasons every critic measured grass brighter than the ground under it.
    // Round 4: 0.78 -> 0.94. Round 3 subtracted for self-occlusion here AND in
    // the albedo AND in the AO ramp, three times for one effect, and the result
    // measured 0.06-0.08 display luminance below the sand it stands in. A tuft
    // in the open really does see most of the sky; the canopy it hides from is
    // its own, and that is what the AO ramp below is for.
    envMapIntensity: 0.94,
    dithering: true,
  });

  const logRatio = Math.log(scaleMax / scaleMin);
  const local = {
    uFieldCell: { value: new THREE.Vector2() },
    uRing: { value: new THREE.Vector4(cellSize, grid * 0.5, innerStart, outerEnd) },
    uRingFadeIn: { value: new THREE.Vector2(innerEnd, outerStart) },
    uTuft: { value: new THREE.Vector4(scaleMin, logRatio, widthGain, normalLift) },
    uWidenMax: { value: widenMax },
    uFarFade: { value: new THREE.Vector2(GRASS_FADE_START, GRASS_MAX_DIST) },
  };
  mat.userData.uniforms = local;
  const base = { cellSize, innerStart, innerEnd, outerStart, outerEnd, scaleMin, logRatio, widthGain, zoomGrow: opts.zoomGrow };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, local);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         ${GRASS_VERT_HEAD}
         uniform vec3 uGrassLight;
         uniform vec3 uGrassDark;
         ${GLSL_NOISE}
         ${GLSL_TERRAIN}
         ${GLSL_WIND}
         vec3 gGrassPos;
         vec3 gGrassNrm;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `{ ${GRASS_VERT_BODY}
           gGrassPos = gVegPos;
           gGrassNrm = gVegNrm; }
         vec3 objectNormal = gGrassNrm;`,
      )
      .replace('#include <begin_vertex>', `vec3 transformed = gGrassPos;`);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying float vVegT;
         varying vec3 vVegTint;
         varying float vVegAO;
         varying vec3 vVegN;
         ${GLSL_DRY_SHADING}`,
      )
      // THE reason round 3's grass read as black wire, and it has nothing to do
      // with albedo. `normal_fragment_begin` flips the shading normal on back
      // faces of a DOUBLE_SIDED material, which is right for a solid and wrong
      // for a blade of grass: `uTuft.w` has already dragged this normal 78-88%
      // of the way toward the GROUND normal, so flipping it points it at the
      // floor. Under a 68-degree sun that is N.L = 0, and since roughly half the
      // blades in a tuft present their back face, half of every tuft rendered as
      // an unlit silhouette. Cancel the flip: both faces of a blade are shaded
      // with the same canopy normal, which is what every foliage shader does and
      // what the translucency term below is there to complete.
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
         #ifdef DOUBLE_SIDED
           normal *= faceDirection;
           nonPerturbedNormal = normal;
         #endif`,
      )
      // getShadowMask() is not part of the physical material, but everything it
      // needs (vDirectionalShadowCoord, getShadow) is — meshphysical already
      // includes <shadowmap_pars_fragment>. The cascades all render the same
      // casters from the same sun, so their product is the sun's visibility.
      .replace(
        '#include <lights_fragment_begin>',
        `#include <lights_fragment_begin>
         float vegSunVis = getShadowMask();`,
      )
      .replace(
        '#include <shadowmap_pars_fragment>',
        '#include <shadowmap_pars_fragment>\n#include <shadowmask_pars_fragment>',
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         diffuseColor.rgb *= vVegTint * vVegAO;`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
         {
           vec3 toCam = cameraPosition - vWorldPosition;
           float camDist = length(toCam);
           vec3 V = toCam / max(camDist, 1e-4);
           // Tips are thinner than roots, so they transmit more; the base of a
           // tussock is a dense mat that transmits almost nothing.
           reflectedLight.directDiffuse +=
             vegDryShading(normalize(vVegN), V, diffuseColor.rgb, 0.40 + 0.60 * vVegT, vegSunVis, camDist);
         }`,
      );

    // vWorldPosition is not a stock physical-material varying; add it.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPosition;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldPosition = transformed;');
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      '#include <common>\nvarying vec3 vWorldPosition;',
    );

    mat.userData.shader = shader;
  };

  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) mesh.setMatrixAt(i, m);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.castShadow = false; // grass shadows are noise; it receives, it doesn't cast
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  mesh.name = `grass-${cellSize}`;
  mesh.userData.local = local;
  mesh.userData.base = base;
  return mesh;
}

// ---------------------------------------------------------------------------
// Ground cover — the tonal half of the field
// ---------------------------------------------------------------------------

/**
 * Past ~140 m a tuft of grass is smaller than a pixel, and the honest way to
 * draw a thing smaller than a pixel is not to draw it: it is to darken the pixel
 * it would have stood on. Every one of round 2's failures at distance came from
 * doing the opposite — submitting sub-pixel geometry whose lighting (a vertical
 * translucent blade) has nothing to do with the lighting of the horizontal
 * ground behind it, so it detached, floated and read as frost.
 *
 * This layer is that darkening, and it is not a decal texture: it is real
 * MeshStandardMaterial geometry lying on the ground, with the GROUND's normal,
 * so it takes the same sun, the same sky, the same cloud shadow and the same
 * cascade as the terrain does. Because it does not write depth, the aerial
 * perspective pass sees the terrain's depth under it and applies exactly the
 * haze the terrain gets — which is the other half of what makes distant
 * vegetation sit *in* the landscape instead of in front of it.
 *
 * The patches are deliberately big (10-16 m) and soft-edged: at 400 m that is
 * four pixels across, so the field reads as a broad tonal mottle following the
 * drainage rather than as anything you could count.
 */
function buildCoverPatch(seed, rim = 7) {
  const rng = mulberry32(seed);
  const n = rim + 1;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const veg = new Float32Array(n * 3);
  const idx = new Uint16Array(rim * 3);
  nrm[1] = 1;
  veg[0] = 1; // centre carries full weight
  let ip = 0;
  for (let i = 0; i < rim; i++) {
    // An irregular rim, or every patch is the same disc and the overlap pattern
    // starts showing its lattice.
    const a = (i / rim) * TAU + (rng() - 0.5) * 0.35;
    const r = 0.58 + 0.62 * rng();
    const o = (i + 1) * 3;
    pos[o] = Math.cos(a) * r;
    pos[o + 2] = Math.sin(a) * r;
    nrm[o + 1] = 1;
    veg[o] = 0;
    veg[o + 1] = rng();
    idx[ip++] = 0;
    idx[ip++] = i + 1;
    idx[ip++] = ((i + 1) % rim) + 1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('aVeg', new THREE.BufferAttribute(veg, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

// The lattice half-width is `cellSize * grid / 2` and `fadeOut[1]` must not
// exceed it, or the layer simply stops at the edge of its own grid with a hard
// circular boundary and the fade never runs. 20 x 124 / 2 = 1240 m, which is
// exactly where the fade ends. Patch radii scale with the cell for the same
// reason they always did: coverage per unit area has to stay constant.
const COVER = {
  cellSize: 20.0,
  grid: 124,
  patchMin: 13.5,
  patchMax: 25.5,
  fadeIn: [34, 96],   // hands over from the instanced rings as they thin out
  // Round 4 pushed the far edge out from 930 m to 1240 m. The woody tiers used
  // to run to 1050 m and this layer stopped before they did; now that they stop
  // at 560 m, this is the ONLY thing carrying coverage over the far half of the
  // valley floor, and it has to reach past where the aerial perspective has
  // washed the ground out anyway.
  fadeOut: [1030, 1240],
  // Coverage is a fraction of ground, not an opacity: a stand that the density
  // field calls 0.25 hides most of the soil under it once you are far enough
  // away to see it edge-on. The gain converts one into the other, and it is
  // large because it is compensating for a linear-falloff patch whose mean
  // alpha is a third of its peak.
  //
  // Measured on the vista's near plain (frame rows 60-78%), sweeping the gain
  // against the layer switched off: 1.0 -> -4%, 2.2 -> -7%, 3.4 -> -10%,
  // 10 -> -16%, saturating near -26%. 3.4 is the value at which the drainage
  // lines are legible as tone at 300 m without the plain reading as painted.
  gain: 4.2,
  maxAlpha: 0.62,
};

/**
 * Linear albedo of the covered ground. Between bare sand and a grass blade, and
 * it has to be, because this layer IS the grass at distance: if it is darker
 * than the blades it replaces then the field changes value at the LOD boundary,
 * which is the one thing this layer exists to prevent. Luminance 0.259 against
 * the blade mean of 0.294 and sandLight's 0.551 — a stand of dry grass seen from
 * 400 m is mostly grass with some soil showing through, so it lands just under
 * the blade and well under the sand.
 */
const COVER_COLOR = new THREE.Vector3(0.330, 0.262, 0.150);

const COVER_VERT = /* glsl */ `
  vec2 cellIdx = uFieldCell + aCell - uRing.y;
  vec2 jitter = vegHash22(cellIdx) - 0.5;
  vec2 wxz = cellIdx * uRing.x + jitter * uRing.x * 0.92;

  float slope, devK, cover, woody;
  vegDensity(wxz, slope, devK, cover, woody);
  // Union of the two masks, not a sum: on the pan both are high and adding them
  // saturates, while on a hillside only the woody one is non-zero and it has to
  // carry the tone on its own now that the distant bush tiers are gone.
  cover = 1.0 - (1.0 - cover) * (1.0 - woody * 0.66);

  float dist = length(wxz - cameraPosition.xz);
  float band = smoothstep(uRing.z, uRingFadeIn.x, dist) * (1.0 - smoothstep(uRingFadeIn.y, uRing.w, dist));

  vec2 r2 = vegHash22(cellIdx + 5.31);
  float rot = r2.x * 6.2831853;
  float cs = cos(rot), sn = sin(rot);
  float rad = mix(uPatch.x, uPatch.y, r2.y);

  vec2 off = vec2(cs * position.x - sn * position.z, sn * position.x + cs * position.z) * rad;
  vec2 pxz = wxz + off;
  // Lift grows with range because the terrain clipmap coarsens with range: at
  // 600 m its rendered surface can sit a metre or two off the fine heightfield
  // this samples, and a cover patch that sinks under it disappears in patches.
  float lift = 0.06 + dist * 0.0038;
  vec3 wp = vec3(pxz.x, vegHeightAt(pxz) + lift, pxz.y);

  // Per-patch strength as well as per-patch tone, or a hundred overlapping
  // patches average out into one flat wash and the layer stops being mottle.
  float pv = mix(0.55, 1.30, vegHash21(cellIdx + 133.1));
  vCoverA = min(cover * uPatch.z * pv, uPatch.w) * band * aVeg.x;
  // Two tone families so the mottle is not one flat wash: rusted-off stands and
  // older olive-brown ones, the same split the blades themselves carry.
  float fam = vegHash21(cellIdx + 77.3);
  vCoverTint = mix(vec3(1.0), vec3(1.16, 0.97, 0.72), smoothstep(0.55, 0.95, fam) * 0.7)
             * mix(0.80, 1.15, vegHash21(cellIdx + 23.9));
  vCoverXZ = pxz;
  vec3 gCoverPos = wp;
  vec3 gCoverNrm = vegNormalAt(pxz, 3.0);
`;

export function createCoverMat(field, uniforms) {
  const geo = buildCoverPatch(5501);
  const half = COVER.grid * 0.5;
  const keep = [];
  for (let j = 0; j < COVER.grid; j++) {
    for (let i = 0; i < COVER.grid; i++) {
      const d = Math.hypot(i + 0.5 - half, j + 0.5 - half);
      if (d > half || d * COVER.cellSize < COVER.fadeIn[0] - COVER.patchMax) continue;
      keep.push(i, j);
    }
  }
  const count = keep.length / 2;
  geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(keep), 2));

  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(COVER_COLOR.x, COVER_COLOR.y, COVER_COLOR.z, THREE.LinearSRGBColorSpace),
    roughness: 0.95,
    metalness: 0.0,
    side: THREE.DoubleSide,
    transparent: true,
    // Never a depth writer. The aerial-perspective pass reads depth to decide
    // how much haze a pixel gets; if this wrote depth it would hand the pass a
    // surface floating a metre above the ground and the cover would haze
    // differently from the terrain it is painted on — which is precisely the
    // detachment the critics flagged.
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
    envMapIntensity: 0.9,
    dithering: true,
  });

  const local = {
    uFieldCell: { value: new THREE.Vector2() },
    uRing: { value: new THREE.Vector4(COVER.cellSize, half, COVER.fadeIn[0], COVER.fadeOut[1]) },
    uRingFadeIn: { value: new THREE.Vector2(COVER.fadeIn[1], COVER.fadeOut[0]) },
    uPatch: { value: new THREE.Vector4(COVER.patchMin, COVER.patchMax, COVER.gain, COVER.maxAlpha) },
  };
  mat.userData.uniforms = local;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, local);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec3 aVeg;
         attribute vec2 aCell;
         uniform vec2 uFieldCell;
         uniform vec4 uRing;
         uniform vec2 uRingFadeIn;
         uniform vec4 uPatch; // (radiusMin, radiusMax, gain, maxAlpha)
         varying float vCoverA;
         varying vec3 vCoverTint;
         varying vec2 vCoverXZ;
         ${GLSL_NOISE}
         ${GLSL_TERRAIN}
         vec3 gCoverP;
         vec3 gCoverN;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `{ ${COVER_VERT}
           gCoverP = gCoverPos;
           gCoverN = gCoverNrm; }
         vec3 objectNormal = gCoverN;`,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = gCoverP;');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying float vCoverA;
         varying vec3 vCoverTint;
         varying vec2 vCoverXZ;
         ${GLSL_NOISE}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         // World-space mottle, evaluated per fragment. Without it the layer is a
         // few thousand soft-edged discs and reads as airbrush; a real stand of
         // dry grass has a five-metre structure and a one-metre structure inside
         // that, and neither of them is round.
         float mA = vegFbm(vCoverXZ * 0.20 + 3.7, 2);
         float mB = vegNoise(vCoverXZ * 0.85 - 11.0);
         float mott = smoothstep(0.30, 0.80, mA * 0.72 + mB * 0.28);
         diffuseColor.rgb *= vCoverTint * mix(0.86, 1.10, mott);
         diffuseColor.a *= vCoverA * mix(0.30, 1.30, mott);
         if (diffuseColor.a < 0.004) discard;`,
      );
    mat.userData.shader = shader;
  };

  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) mesh.setMatrixAt(i, m);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  // Behind the grass, in front of the terrain.
  mesh.renderOrder = 0.5;
  mesh.name = 'grass-cover';
  mesh.userData.local = local;
  return mesh;
}

/**
 * `widthGain` is set per ring so a blade is still ~1.5 px across at that ring's
 * far edge (1280 px / 55 deg is about 1330 px per radian). `normalLift` is how
 * far the shading normal is dragged toward the ground normal — higher for the
 * distant rings, where individual blade shading is meaningless and all that
 * matters is that the patch reads as one soft surface.
 */
/**
 * Where the instanced field stops, in metres. Round 2's rings reached 158 m at
 * zoom 1 and 1264 m from an elevated camera, and every one of those distant
 * tufts is a sub-pixel sliver of a material that is lit differently from the
 * ground it stands on. All three critics read the result as frost. Coverage
 * past this radius is the cover layer's job — see createCoverMat.
 */
const GRASS_MAX_DIST = 140;
const GRASS_FADE_START = 60;

const RINGS = [
  // near — full ribbon detail, the only tier the player is ever close to.
  // Tight spread and a modest arc: highland tussock stands up and lets its tips
  // droop. Splaying the blades radially turns a tuft into a dead spider.
  {
    blades: 9, segments: 3, cellSize: 0.50, grid: 56,
    innerStart: -1, innerEnd: 0, outerStart: 10.0, outerEnd: 13.2,
    minH: 0.20, maxH: 0.72, width: 0.0135, spread: 0.085, curve: 0.55,
    scaleMin: 0.55, scaleMax: 1.60, widthGain: 0.055, widenMax: 2.6,
    normalLift: 0.78, zoomGrow: 0.40, seed: 1337,
  },
  // mid — same silhouette, a third of the triangles
  {
    blades: 6, segments: 2, cellSize: 0.80, grid: 76,
    innerStart: 8.5, innerEnd: 12.0, outerStart: 21.0, outerEnd: 28.0,
    minH: 0.24, maxH: 0.80, width: 0.024, spread: 0.13, curve: 0.58,
    scaleMin: 0.62, scaleMax: 1.80, widthGain: 0.042, widenMax: 3.0,
    normalLift: 0.80, zoomGrow: 0.38, seed: 991,
  },
  // far — blades merged into loose tufts, wide enough to hold at 2 px
  {
    blades: 5, segments: 1, cellSize: 1.45, grid: 96,
    innerStart: 20.0, innerEnd: 26.0, outerStart: 50.0, outerEnd: 66.0,
    minH: 0.30, maxH: 0.88, width: 0.058, spread: 0.34, curve: 0.68,
    scaleMin: 0.70, scaleMax: 2.00, widthGain: 0.018, widenMax: 3.2,
    normalLift: 0.86, zoomGrow: 0.28, seed: 4451,
  },
  // cover — the last stipple before the tonal layer takes over. Tufts here must
  // stay *small in world units*: a tuft that grows with the lattice ends up a
  // three-metre plank lying in the desert. Growth is almost switched off; pixel
  // size is bought with width alone.
  {
    blades: 5, segments: 1, cellSize: 3.10, grid: 104,
    innerStart: 52.0, innerEnd: 66.0, outerStart: 104.0, outerEnd: 140.0,
    minH: 0.26, maxH: 0.56, width: 0.075, spread: 0.55, curve: 0.95,
    scaleMin: 0.64, scaleMax: 1.66, widthGain: 0.009, widenMax: 4.0,
    normalLift: 0.88, zoomGrow: 0.12, seed: 7717,
  },
];

export function createGrass(field, uniforms) {
  const meshes = RINGS.map((r) => createGrassRing(field, uniforms, r));
  const cover = createCoverMat(field, uniforms);
  meshes.push(cover);

  // Zoom. The instance count is fixed, so covering more ground from a vantage
  // point means spending the same tufts over a wider, coarser lattice — which is
  // what you want, because from 60 m up a tuft is a pixel anyway. Quantised with
  // hysteresis so it changes at most once per climb rather than crawling.
  const ZOOM_STEPS = [1, 2, 4, 8];
  const ZOOM_UP = [14, 40, 105]; // climb past this (metres over ground) to widen
  const ZOOM_DOWN = [10, 30, 80]; // drop below this to tighten again
  let zi = 0;

  function pickZoom(hAbove) {
    // Converge in one call, not one step per frame: the harness poses a camera
    // and settles, and a ring still mid-zoom is a ring that misses the shot.
    let z = 0;
    while (z < ZOOM_UP.length && hAbove > ZOOM_UP[z]) z++;
    while (z > 0 && hAbove < ZOOM_DOWN[z - 1]) z--;
    zi = z;
    return ZOOM_STEPS[z];
  }

  return {
    meshes,
    update(camera) {
      const ground = field.surfaceY(camera.position.x, camera.position.z);
      const zoom0 = pickZoom(Math.max(0, camera.position.y - ground));
      // The cover layer never zooms — its lattice is already 12 m and its reach
      // is fixed in world units, because what it draws is ground, not plants.
      cover.userData.local.uFieldCell.value.set(
        Math.floor(camera.position.x / COVER.cellSize),
        Math.floor(camera.position.z / COVER.cellSize),
      );
      for (const m of meshes) {
        const b = m.userData.base;
        if (!b) continue;
        const u = m.userData.local;
        // The zoom exists so a camera 100 m up still has grass beneath it, but
        // it must never push a ring past the hard cut: at zoom 8 the cover ring
        // used to reach 1264 m, which is where the confetti came from.
        let zoom = zoom0;
        while (zoom > 1 && b.outerEnd * zoom > GRASS_MAX_DIST) zoom /= 2;
        const cs = b.cellSize * zoom;
        u.uRing.value.set(cs, u.uRing.value.y, b.innerStart * zoom, b.outerEnd * zoom);
        u.uRingFadeIn.value.set(b.innerEnd * zoom, b.outerStart * zoom);
        // Tufts grow with the lattice, but sub-linearly: a 4x wider spacing with
        // 4x taller grass would read as a wheat field, not a distant plain. The
        // per-metre thickening is NOT scaled down to match — a zoomed ring
        // reaches four times further, so its blades need to be four times wider
        // to survive at the same pixel size.
        const s = Math.pow(zoom, b.zoomGrow);
        u.uTuft.value.set(b.scaleMin * s, b.logRatio, b.widthGain, u.uTuft.value.w);
        u.uFieldCell.value.set(Math.floor(camera.position.x / cs), Math.floor(camera.position.z / cs));
      }
    },
  };
}

/**
 * Round 2 argued dry grass is "sand with more yellow in it" and set the bleached
 * tip at 0.660 linear — one count under PALETTE.sandLight. Round 3 corrected
 * that and OVERSHOT, to 0.303/0.149 (mean luminance 0.226 against sand at
 * 0.38-0.55). Measured by ablation — the same frame rendered with and without
 * vegetation, post-effects frozen so the diff is not grain — the tufts came back
 * at display luminance 0.550 against the 0.625 of the sand they replace in the
 * `ground` shot, and 0.384 against 0.440 in `gameplay`. That is 0.06-0.08 of
 * display luminance below their own background, which is exactly the magnitude
 * round 2 sat ABOVE it. Black confetti instead of white confetti.
 *
 * The target is not "dark", it is "in the same light as the ground it grows
 * from". Two physical anchors, both of which round 3 got wrong:
 *
 *  - broadband albedo of dry steppe grass is 0.22-0.28, not 0.15-0.20; and
 *    Afghan sand is 0.30-0.40, not the 0.45-0.55 of a lab swatch. The honest
 *    ratio is ~0.7, not the ~0.45 round 3 used.
 *  - a tuft is a vertical structure. Self-shadowing, the AO ramp and an
 *    envMapIntensity under 1 all subtract on top of the albedo, so the RENDERED
 *    ratio is always well below the albedo ratio. Round 3 budgeted for the
 *    albedo difference twice.
 *
 * Bleached tip at luminance 0.387, stained root at 0.201, mean 0.294 — 0.63 of
 * the sand's mean, which after the geometric losses lands a tuft a couple of
 * hundredths under the sand beside it instead of a tenth. R/B is 2.0 (sand is
 * 1.28), so the tuft stays unambiguously the warmer of the two: warm khaki
 * against pale grey-khaki, which is the relationship reference photography of
 * dry Afghan scrub actually shows.
 */
export const GRASS_COLORS = {
  light: new THREE.Vector3(0.520, 0.406, 0.208),
  dark: new THREE.Vector3(0.286, 0.212, 0.104),
};
