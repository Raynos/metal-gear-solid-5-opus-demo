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
 * Four rings, one silhouette, geometry cost falling by roughly 2x per step. The
 * fourth exists because round 1 stopped at 60 m and the establishing vista is
 * looking at ground 200-600 m away: LOD that ends before the horizon does is
 * indistinguishable from having no grass at all.
 *
 *   near   9 blades x 3 segments    0 -  13 m   full ribbons
 *   mid    6 blades x 2 segments    9 -  28 m
 *   far    5 blades x 1 segment    20 -  66 m   merged into tufts
 *   cover  5 blades x 1 segment    52 - 158 m   a stipple of dry ground cover
 *
 * and the whole lattice zooms out with camera altitude, so from the vista camera
 * the cover ring is reaching 600 m.
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
        let ex = fnx + sideX * 0.62 * sgn;
        let ey = fny;
        let ez = fnz + sideZ * 0.62 * sgn;
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
uniform vec4 uTuft;    // (scaleMin, scaleRange, widthGain, normalLift)
uniform float uWidenMax;
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

  // Two independent dither draws. The first thins by ground fertility and must
  // NOT shrink what survives — grass on poor ground is sparser, not stunted. The
  // second thins at the ring boundary, where a little shrinking is exactly what
  // sells the fade, so the edge of the field is a gradient and never a circle.
  float pick = vegHash21(cellIdx + 91.7);
  float pickR = vegHash21(cellIdx + 313.1);
  float aliveR = ringFade - pickR;
  float grow = (dens > pick && aliveR > 0.0) ? (0.62 + 0.38 * smoothstep(0.0, 0.30, aliveR)) : 0.0;

  vec3 gVegPos = vec3(0.0);
  vec3 gVegNrm = vec3(0.0, 1.0, 0.0);

  if (grow > 0.001) {
    vec2 r2 = vegHash22(cellIdx + 5.31);
    float rot = r2.x * 6.2831853;
    float cs = cos(rot), sn = sin(rot);
    // Tussocks are tallest in the middle of a clump and stunted at its edge.
    float clump = vegFbm(wxz * 0.42 + 7.0, 2);
    float scale = (uTuft.x + uTuft.y * r2.y) * grow * (0.72 + clump * 0.78);
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
    vVegTint = mix(vVegTint, vVegTint * vec3(1.30, 0.94, 0.56), smoothstep(0.58, 0.92, family) * 0.85);
    vVegTint = mix(vVegTint, vVegTint * vec3(0.94, 0.90, 0.72), (1.0 - smoothstep(0.08, 0.40, family)) * 0.55);
    // Root shadow, but lifted: round 1 crushed the blade base to near-black.
    vVegAO = mix(0.84, 1.12, smoothstep(0.0, 0.24, t)) * mix(0.92, 1.10, tint);
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
    envMapIntensity: 1.15,
    dithering: true,
  });

  const local = {
    uFieldCell: { value: new THREE.Vector2() },
    uRing: { value: new THREE.Vector4(cellSize, grid * 0.5, innerStart, outerEnd) },
    uRingFadeIn: { value: new THREE.Vector2(innerEnd, outerStart) },
    uTuft: { value: new THREE.Vector4(scaleMin, scaleMax - scaleMin, widthGain, normalLift) },
    uWidenMax: { value: widenMax },
  };
  mat.userData.uniforms = local;
  const base = { cellSize, innerStart, innerEnd, outerStart, outerEnd, scaleMin, scaleMax, widthGain, zoomGrow: opts.zoomGrow };

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
           vec3 V = normalize(cameraPosition - vWorldPosition);
           // Tips are thinner than roots, so they transmit more; the base of a
           // tussock is a dense mat that transmits almost nothing.
           reflectedLight.directDiffuse +=
             vegDryShading(normalize(vVegN), V, diffuseColor.rgb, 0.40 + 0.60 * vVegT, vegSunVis);
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

/**
 * `widthGain` is set per ring so a blade is still ~1.5 px across at that ring's
 * far edge (1280 px / 55 deg is about 1330 px per radian). `normalLift` is how
 * far the shading normal is dragged toward the ground normal — higher for the
 * distant rings, where individual blade shading is meaningless and all that
 * matters is that the patch reads as one soft surface.
 */
const RINGS = [
  // near — full ribbon detail, the only tier the player is ever close to.
  // Tight spread and a modest arc: highland tussock stands up and lets its tips
  // droop. Splaying the blades radially turns a tuft into a dead spider.
  {
    blades: 9, segments: 3, cellSize: 0.50, grid: 56,
    innerStart: -1, innerEnd: 0, outerStart: 10.0, outerEnd: 13.2,
    minH: 0.20, maxH: 0.72, width: 0.0135, spread: 0.085, curve: 0.55,
    scaleMin: 0.85, scaleMax: 1.35, widthGain: 0.055, widenMax: 2.6,
    normalLift: 0.52, zoomGrow: 0.40, seed: 1337,
  },
  // mid — same silhouette, a third of the triangles
  {
    blades: 6, segments: 2, cellSize: 0.80, grid: 76,
    innerStart: 8.5, innerEnd: 12.0, outerStart: 21.0, outerEnd: 28.0,
    minH: 0.24, maxH: 0.80, width: 0.024, spread: 0.13, curve: 0.58,
    scaleMin: 1.00, scaleMax: 1.55, widthGain: 0.042, widenMax: 3.0,
    normalLift: 0.60, zoomGrow: 0.38, seed: 991,
  },
  // far — blades merged into loose tufts, wide enough to hold at 2 px
  {
    blades: 5, segments: 1, cellSize: 1.45, grid: 96,
    innerStart: 20.0, innerEnd: 26.0, outerStart: 50.0, outerEnd: 66.0,
    minH: 0.30, maxH: 0.88, width: 0.058, spread: 0.34, curve: 0.68,
    scaleMin: 1.10, scaleMax: 1.75, widthGain: 0.018, widenMax: 3.2,
    normalLift: 0.74, zoomGrow: 0.28, seed: 4451,
  },
  // cover — the stipple that keeps 60-600 m of ground from reading as bare
  // sand. Tufts here must stay *small in world units*: this ring is the one the
  // altitude zoom stretches furthest, and a tuft that grows with the lattice
  // ends up a three-metre plank lying in the desert. Growth is almost switched
  // off; pixel size is bought with width alone.
  {
    blades: 5, segments: 1, cellSize: 3.10, grid: 104,
    innerStart: 52.0, innerEnd: 68.0, outerStart: 120.0, outerEnd: 158.0,
    minH: 0.26, maxH: 0.56, width: 0.075, spread: 0.55, curve: 0.95,
    scaleMin: 1.00, scaleMax: 1.45, widthGain: 0.009, widenMax: 4.0,
    normalLift: 0.88, zoomGrow: 0.12, seed: 7717,
  },
];

export function createGrass(field, uniforms) {
  const meshes = RINGS.map((r) => createGrassRing(field, uniforms, r));

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
      const zoom = pickZoom(Math.max(0, camera.position.y - ground));
      for (const m of meshes) {
        const b = m.userData.base;
        const u = m.userData.local;
        const cs = b.cellSize * zoom;
        u.uRing.value.set(cs, u.uRing.value.y, b.innerStart * zoom, b.outerEnd * zoom);
        u.uRingFadeIn.value.set(b.innerEnd * zoom, b.outerStart * zoom);
        // Tufts grow with the lattice, but sub-linearly: a 4x wider spacing with
        // 4x taller grass would read as a wheat field, not a distant plain. The
        // per-metre thickening is NOT scaled down to match — a zoomed ring
        // reaches four times further, so its blades need to be four times wider
        // to survive at the same pixel size.
        const s = Math.pow(zoom, b.zoomGrow);
        u.uTuft.value.set(b.scaleMin * s, (b.scaleMax - b.scaleMin) * s, b.widthGain, u.uTuft.value.w);
        u.uFieldCell.value.set(Math.floor(camera.position.x / cs), Math.floor(camera.position.z / cs));
      }
    },
  };
}

/**
 * Dry grass is only a little darker than the sand it grows out of — sun-bleached
 * straw, not a dark plant. Pushing PALETTE.grassDry up toward the sand value is
 * what stops the field from reading as a scatter of black specks.
 *
 * Both ends are deliberately warm: red comfortably over blue. Round 1 measured
 * blue above red in every daylight frame, and grass is one of the few surfaces
 * with enough screen area to argue the other way.
 */
export const GRASS_COLORS = {
  // Bleached tip and stained root of dead highland tussock, in linear albedo.
  // Both sit just under PALETTE.sandLight in value and well above it in
  // saturation: dry grass is not a dark plant, it is sand with more yellow in
  // it. Anything darker reads as gravel or litter scattered on the desert.
  light: new THREE.Vector3(0.660, 0.575, 0.312),
  dark: new THREE.Vector3(0.395, 0.330, 0.176),
};
