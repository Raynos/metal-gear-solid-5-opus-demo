import * as THREE from 'three';
import { PALETTE } from '../../config/ArtDirection.js';
import { GLSL_NOISE, GLSL_TERRAIN, GLSL_WIND } from './shaderLib.js';
import { mulberry32 } from './VegField.js';

/**
 * Grass — dry Afghan tussock, placed and animated entirely on the GPU.
 *
 * The CPU never touches an instance. Each InstancedMesh is a fixed lattice of
 * cells that is *snapped* to the camera in world space, so as you walk the set of
 * occupied cells changes but every surviving tuft stays nailed to the same patch
 * of ground (a camera-relative scatter would slide, which instantly reads as fake).
 * The vertex shader samples the baked terrain height texture to root and tilt the
 * tuft, samples the drainage/slope mask to decide whether the tuft exists at all,
 * and dithers it out over the last few metres of the ring instead of popping.
 *
 * Three rings, same look, falling geometry cost:
 *   near  10 blades x 3 segments   0 - 13 m
 *   mid    7 blades x 2 segments   8 - 26 m
 *   far    8 blades x 1 segment  18 - 60 m
 */

const TAU = Math.PI * 2;

/**
 * One tuft: several curved ribbons springing from a common root.
 * Blades taper to a point, carry a rounded (cylinder-ish) normal so they don't
 * read as flat cards, and store (t, phase, side) for the wind stage.
 */
function buildTuft({ blades, segments, seed, minH, maxH, width, spread, curve }) {
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
    const w = width * (0.65 + 0.7 * rng());
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

      const halfW = 0.5 * w * Math.pow(Math.max(0, 1 - t * t * 0.98), 0.55);
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
uniform vec3 uTuft;    // (scaleMin, scaleRange, widthGain)
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
  float dens = vegDensity(wxz, slope);

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

    vec3 p = position;
    vec3 n = normal;
    float t = aVeg.x;

    // Thicken blades with distance: below ~1.5 px wide a blade stops being a
    // blade and becomes shimmer. Width only — length must not stretch.
    float widen = min(1.0 + dist * uTuft.z, 3.2);
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
    n = normalize(mix(basis * n, up, 0.50));

    float gh = vegHeightAt(wxz);
    gVegPos = vec3(wxz.x, gh - 0.03, wxz.y) + p;
    gVegNrm = n;

    // Straw is bleached at the tip and stained toward the root; a per-tuft
    // shift keeps the field from reading as one flat colour.
    float tint = vegHash21(cellIdx + 23.9);
    vVegTint = mix(uGrassDark, uGrassLight, clamp(tint * 0.42 + aVeg.y * 0.32 + t * 0.55 + 0.04, 0.0, 1.0));
    // Two extra families, or the whole field is one note: stands that have gone
    // over to rust, and older olive-brown tussock that never bleached.
    float family = vegHash21(cellIdx + 77.3);
    vVegTint = mix(vVegTint, vVegTint * vec3(1.26, 0.92, 0.58), smoothstep(0.58, 0.92, family) * 0.85);
    vVegTint = mix(vVegTint, vVegTint * vec3(0.88, 0.88, 0.74), (1.0 - smoothstep(0.08, 0.40, family)) * 0.55);
    vVegAO = mix(0.76, 1.12, smoothstep(0.0, 0.24, t)) * mix(0.90, 1.12, tint);
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
  const { blades, segments, cellSize, grid, innerStart, innerEnd, outerStart, outerEnd, minH, maxH, width, spread, curve, scaleMin, scaleMax, widthGain, seed } =
    opts;

  const geo = buildTuft({ blades, segments, seed, minH, maxH, width, spread, curve });
  const count = grid * grid;
  const cells = new Float32Array(count * 2);
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const o = (j * grid + i) * 2;
      cells[o] = i;
      cells[o + 1] = j;
    }
  }
  geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.82,
    metalness: 0.0,
    side: THREE.DoubleSide,
    envMapIntensity: 1.05,
    dithering: true,
  });

  const local = {
    uFieldCell: { value: new THREE.Vector2() },
    uRing: { value: new THREE.Vector4(cellSize, grid * 0.5, innerStart, outerEnd) },
    uRingFadeIn: { value: new THREE.Vector2(innerEnd, outerStart) },
    uTuft: { value: new THREE.Vector3(scaleMin, scaleMax - scaleMin, widthGain) },
  };
  mat.userData.uniforms = local;
  const base = { cellSize, innerStart, innerEnd, outerStart, outerEnd, scaleMin, scaleMax, widthGain };

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
         uniform vec3 uSunDir;
         uniform vec3 uSunColor;
         uniform float uTranslucency;`,
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
           // Subsurface. A dry blade is a thin translucent membrane: light that
           // hits its back comes through rather than stopping, so a back-lit
           // field glows instead of going flat black. Two lobes — a broad
           // through-scatter that lifts every shadowed blade, and a tight
           // forward lobe that flares when you look toward the sun.
           //
           // Deliberately NOT multiplied by the shadow term. Sampling the sun's
           // shadow map here would mean reaching into the cascade scheme's
           // internals, and getting it wrong turns every back-facing blade
           // black. A blade glowing slightly inside a shadow is the far cheaper
           // error, and it costs one less PCF tap per grass fragment.
           vec3 V = normalize(cameraPosition - vWorldPosition);
           float ndl = dot(normalize(vVegN), uSunDir);
           float through = clamp(-ndl * 0.65 + 0.45, 0.0, 1.0);
           float lobe = pow(clamp(dot(-uSunDir, V), 0.0, 1.0), 2.5);
           float trans = through * (0.50 + 0.95 * lobe) * (0.40 + 0.60 * vVegT);
           reflectedLight.directDiffuse +=
             uSunColor * RECIPROCAL_PI * uTranslucency * trans * diffuseColor.rgb;
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

export function createGrass(field, uniforms) {
  const rings = [
    // near — full ribbon detail, the only tier the player is ever close to
    {
      blades: 7, segments: 3, cellSize: 0.485, grid: 52,
      innerStart: -1, innerEnd: 0, outerStart: 9.5, outerEnd: 12.6,
      minH: 0.22, maxH: 0.86, width: 0.0115, spread: 0.13, curve: 0.85,
      scaleMin: 0.85, scaleMax: 1.40, widthGain: 0.010, seed: 1337,
    },
    // mid — same silhouette, a quarter of the triangles
    {
      blades: 5, segments: 2, cellSize: 0.723, grid: 72,
      innerStart: 8.0, innerEnd: 11.5, outerStart: 19.0, outerEnd: 25.5,
      minH: 0.26, maxH: 0.94, width: 0.018, spread: 0.21, curve: 0.82,
      scaleMin: 1.00, scaleMax: 1.60, widthGain: 0.016, seed: 991,
    },
    // far — loose clumps, wide enough to hold up at a couple of pixels
    {
      blades: 5, segments: 1, cellSize: 1.283, grid: 96,
      innerStart: 18.0, innerEnd: 24.0, outerStart: 45.0, outerEnd: 60.0,
      minH: 0.34, maxH: 1.10, width: 0.042, spread: 0.62, curve: 0.70,
      scaleMin: 1.20, scaleMax: 2.05, widthGain: 0.012, seed: 4451,
    },
  ];

  const meshes = rings.map((r) => createGrassRing(field, uniforms, r));

  // Zoom. The instance count is fixed, so covering more ground from a vantage
  // point means spending the same tufts over a wider, coarser lattice — which is
  // what you want, because from 60 m up a tuft is a pixel anyway. Quantised with
  // hysteresis so it changes at most once per climb rather than crawling.
  const ZOOM_STEPS = [1, 2, 4, 8];
  const ZOOM_UP = [14, 40, 105]; // climb past this (metres over ground) to widen
  const ZOOM_DOWN = [10, 30, 80]; // drop below this to tighten again
  let zi = 0;

  function pickZoom(hAbove) {
    if (zi < ZOOM_UP.length && hAbove > ZOOM_UP[zi]) zi++;
    else if (zi > 0 && hAbove < ZOOM_DOWN[zi - 1]) zi--;
    return ZOOM_STEPS[zi];
  }

  return {
    meshes,
    update(camera) {
      const ground = field.heightAt(camera.position.x, camera.position.z);
      const zoom = pickZoom(Math.max(0, camera.position.y - ground));
      for (const m of meshes) {
        const b = m.userData.base;
        const u = m.userData.local;
        const cs = b.cellSize * zoom;
        u.uRing.value.set(cs, u.uRing.value.y, b.innerStart * zoom, b.outerEnd * zoom);
        u.uRingFadeIn.value.set(b.innerEnd * zoom, b.outerStart * zoom);
        // Tufts grow with the lattice, but sub-linearly: a 4x wider spacing with
        // 4x taller grass would read as a wheat field, not a distant plain. The
        // per-metre thickening has to come back down by the same factor or the
        // far blades balloon into straw.
        const s = Math.pow(zoom, 0.4);
        u.uTuft.value.set(b.scaleMin * s, (b.scaleMax - b.scaleMin) * s, b.widthGain / zoom);
        u.uFieldCell.value.set(Math.floor(camera.position.x / cs), Math.floor(camera.position.z / cs));
      }
    },
  };
}

/**
 * Dry grass is only a little darker than the sand it grows out of — sun-bleached
 * straw, not a dark plant. Pushing PALETTE.grassDry up toward the sand value is
 * what stops the field from reading as a scatter of black specks.
 */
export const GRASS_COLORS = {
  light: new THREE.Vector3(PALETTE.grassDry[0] * 1.80, PALETTE.grassDry[1] * 1.74, PALETTE.grassDry[2] * 1.90),
  dark: new THREE.Vector3(PALETTE.grassDry[0] * 1.10, PALETTE.grassDry[1] * 1.04, PALETTE.grassDry[2] * 1.00),
};
