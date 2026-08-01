import * as THREE from 'three';
import { GLSL_DRY_SHADING, GLSL_NOISE, GLSL_WIND } from './shaderLib.js';
import { mulberry32 } from './VegField.js';
import { buildTuft } from './Grass.js';
import { brushParams, deadTreeParams, deadTreeParamsL1, growPlant, scrubParams } from './Branching.js';

/**
 * Scrub — the woody half of the vegetation: thorny shrubs, dry brush balls and
 * the occasional dead tree. These carry the silhouette work that grass cannot;
 * a bare tree against a ridgeline is the single most legible MGSV composition,
 * and low dead scrub dotted across a slope is what tells you the slope is a
 * slope rather than a shaded triangle.
 *
 * Round 1 put 656 bushes over a 380 m disc — one per 700 square metres, which
 * is optically nothing. This scatters ~31,000 over a 1 km disc in three tiers,
 * for about four times the triangles, because the distant tiers are ribbon
 * clumps at 10-24 triangles rather than branch skeletons at 416.
 *
 * Everything is instanced, buckets spatially so the frustum can discard the
 * four fifths of the field behind the camera, casts shadow only within a few
 * tens of metres, and sways on the same gust field as the grass so the whole
 * landscape moves as one system.
 */

/**
 * Woody albedo, linear.
 *
 * Round 2 ran these at 0.30-0.43, which is mineral territory — the same value
 * range as the sand. Measured on the shipped night frame, branch pixels came
 * back at display luminance 80.6 against a far darker ground: dead wood that
 * out-reflected sunlit desert. Weathered dead wood is 0.10-0.16 linear and
 * nearly neutral; the yellow-brown people remember from photographs is the
 * *light* on it, not the surface.
 *
 * Luminances here: scrub 0.130, bush 0.117, brush 0.166 (bleached tumbleweed
 * really is the palest thing in the set), tree 0.141 — against PALETTE.sandDark
 * at 0.38 and sandLight at 0.53. Dry scrub is darker than sunlit sand, always.
 */
const BRANCH_COLORS = {
  scrub: [0.152, 0.128, 0.094],
  bush: [0.140, 0.115, 0.082],
  brush: [0.196, 0.163, 0.108],
  tree: [0.162, 0.140, 0.112],
};

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qIdentity = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _scale = new THREE.Vector3();

/**
 * Wind for instanced woody plants. Same gust field as the grass, but the bend is
 * computed in world space and rotated back into object space through the
 * instance matrix, so a rotated bush still leans downwind.
 */
function injectBranchWind(mat, uniforms, flexAmount) {
  const local = { uFlex: { value: flexAmount } };
  mat.userData.uniforms = local;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, local);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec3 aVeg;   // (flex along branch, per-branch phase, unused)
         uniform float uFlex;
         ${GLSL_NOISE}
         ${GLSL_WIND}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           #ifdef USE_INSTANCING
             mat4 vegInst = instanceMatrix;
           #else
             mat4 vegInst = mat4(1.0);
           #endif
           vec3 vegOrigin = (modelMatrix * vegInst * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
           float gust = vegGust(vegOrigin.xz);
           vec3 wWorld = vec3(uWind.x, 0.0, uWind.y);
           mat3 im = mat3(modelMatrix * vegInst);
           // (M^T * w) — puts the world wind vector into object space without
           // needing an inverse; column dots are exactly the transpose product.
           vec3 wObj = vec3(dot(im[0], wWorld), dot(im[1], wWorld), dot(im[2], wWorld));
           float wl = length(wObj);
           if (wl > 1e-5) {
             wObj /= wl;
             float flex = aVeg.x * aVeg.x * uFlex;
             float sway = uWind.z * (0.22 + gust * 1.15) * flex;
             float rustle = sin(uTime * 5.7 + aVeg.y * 6.283 + gust * 7.0) * 0.10 * flex * (0.3 + gust);
             transformed += wObj * (sway + rustle);
             transformed.y -= sway * sway * 0.9;
           }
         }`,
      );
    mat.userData.shader = shader;
  };
}

/**
 * Dead wood under a hard sun has the same problem grass does: a twig is a
 * cylinder two centimetres across, so half of it is blown out and half is a
 * black line. The same translucency + wrapped-sky term the grass uses lifts the
 * shadow side, at a fraction of the strength — bark transmits, but not much.
 */
function injectBranchShading(mat) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader) => {
    prev.call(mat, shader);
    // The stock `normal` varying is in view space; the sun direction is in world
    // space. Carry a world-space normal and position of our own rather than
    // transforming the sun per fragment.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vVegWorld;\nvarying vec3 vVegNW;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         {
           #ifdef USE_INSTANCING
             mat4 vegM = modelMatrix * instanceMatrix;
           #else
             mat4 vegM = modelMatrix;
           #endif
           vVegWorld = (vegM * vec4(transformed, 1.0)).xyz;
           vVegNW = normalize(mat3(vegM) * objectNormal);
         }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vVegWorld;\nvarying vec3 vVegNW;\n${GLSL_DRY_SHADING}`)
      .replace('#include <shadowmap_pars_fragment>', '#include <shadowmap_pars_fragment>\n#include <shadowmask_pars_fragment>')
      .replace('#include <lights_fragment_begin>', '#include <lights_fragment_begin>\nfloat vegSunVis = getShadowMask();')
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
         // A fifth of the grass gain: bark is a millimetre of dead cellulose,
         // not a membrane. Enough to keep the shadow side off black, not enough
         // to make a dead bush glow like a lampshade.
         {
           vec3 vegToCam = cameraPosition - vVegWorld;
           float vegDist = length(vegToCam);
           reflectedLight.directDiffuse +=
             vegDryShading(normalize(vVegNW), vegToCam / max(vegDist, 1e-4), diffuseColor.rgb, 0.22, vegSunVis, vegDist);
         }`,
      );
    mat.userData.shader = shader;
  };
}

function branchMaterial(uniforms, color, flex, roughness = 0.88) {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(color[0], color[1], color[2], THREE.LinearSRGBColorSpace),
    roughness,
    metalness: 0.0,
    // A twig inside a thorn bush sees a fraction of the sky; the bush shadows
    // itself. 0.9 was close enough to open-sky that a dead bush held its own
    // against sunlit sand at night, which is how the critics caught it.
    envMapIntensity: 0.62,
    dithering: true,
  });
  injectBranchWind(mat, uniforms, flex);
  injectBranchShading(mat);
  return mat;
}

/** Depth material matching the wind displacement, or shadows detach from the plant. */
function matchingDepthMaterial(uniforms, flex) {
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  injectBranchWind(d, uniforms, flex);
  return d;
}

/**
 * Sample candidate points uniformly *by area* over an annulus and keep the ones
 * the ground accepts. Uniform-by-area matters: sampling r linearly piles
 * everything into the middle and leaves the outer ring — which is most of the
 * frame in a wide shot — empty.
 */
function scatterAnnulus({ field, rng, rInner, rOuter, candidates, accept, variants, tilt, scaleRange, sink = 0 }) {
  const perVariant = variants.map(() => []);
  const r2i = rInner * rInner;
  const r2o = rOuter * rOuter;
  // Log-uniform over the scale range. Round 2 drew it linearly over a 2x span,
  // so nearly every instance came out within 30% of the mean and the field read
  // as one stamped size at one density — the critics' third finding. A log draw
  // over a 3x span spends as much of its budget on the runts as on the big ones,
  // and the runts are what make the big ones look big.
  const logRatio = Math.log(scaleRange[1] / scaleRange[0]);
  for (let i = 0; i < candidates; i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(r2i + (r2o - r2i) * rng());
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const s = field.density(x, z);
    if (!accept(s, rng, x, z, r)) continue;
    const v = Math.floor(rng() * variants.length);
    const scale = scaleRange[0] * Math.exp(logRatio * rng());
    _q.setFromUnitVectors(_up, s.normal).slerp(_qIdentity, 1 - tilt);
    _q.multiply(_qYaw.setFromAxisAngle(_up, rng() * Math.PI * 2));
    _v.set(x, s.height - sink * scale, z);
    // Squashed on two independent horizontal axes and in height: a handful of
    // geometry variants all standing at the same proportions is still one shape.
    _scale.set(scale * (0.76 + rng() * 0.46), scale * (0.80 + rng() * 0.44), scale * (0.76 + rng() * 0.46));
    perVariant[v].push(_m.compose(_v, _q, _scale).clone());
  }
  return perVariant;
}

/**
 * One InstancedMesh has a single bounding sphere, so a world-spanning one is
 * never frustum-culled and is re-submitted for every shadow cascade. Splitting a
 * tier onto a coarse spatial grid costs a handful of draw calls and lets the
 * frustum discard most of the field — which is the only reason several thousand
 * distant bushes fit in the triangle budget at all.
 */
function buildTiles(geo, mats, mat, depthMat, name, tile, shadowRadius = 0) {
  // Shadow casting is bucketed with the geometry, not switched per tier: a bush
  // 150 m from the compound casts a shadow that is not one pixel of anything,
  // but it is still re-submitted once per cascade. Splitting at `shadowRadius`
  // costs one draw call and takes most of the field out of three depth passes.
  const r2 = shadowRadius * shadowRadius;
  const buckets = new Map();
  for (const m of mats) {
    const x = m.elements[12];
    const z = m.elements[14];
    const bx = Math.floor(x / tile);
    const bz = Math.floor(z / tile);
    const near = r2 > 0 && x * x + z * z <= r2;
    const key = (bx * 4096 + bz) * 2 + (near ? 1 : 0);
    let list = buckets.get(key);
    if (!list) buckets.set(key, (list = []));
    list.push(m);
  }
  const meshes = [];
  let tris = 0;
  for (const [key, list] of buckets) {
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((m, k) => mesh.setMatrixAt(k, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.computeBoundingSphere();
    const casts = (key & 1) === 1;
    mesh.castShadow = casts;
    mesh.receiveShadow = true;
    if (casts) mesh.customDepthMaterial = depthMat;
    mesh.name = `${name}-${key}`;
    meshes.push(mesh);
    tris += (geo.index.count / 3) * list.length;
  }
  return { meshes, tris };
}

/**
 * Three distance tiers of thorny scrub, plus brush balls and dead trees.
 * Geometry detail and shadow casting both fall off with range; instance density
 * does not, because a slope that is bare at 300 m and dotted at 80 m reads as a
 * bug.
 */
export function createScrub(field, uniforms, seed = 20260731) {
  const rng = mulberry32(seed);
  const meshes = [];
  let tris = 0;
  const counts = {};

  const add = (r) => {
    meshes.push(...r.meshes);
    tris += r.tris;
  };

  // ---- thorny scrub, near: full branch structure, casts shadow -------------
  // Scale tops out just under 1.6: this is *low* dead scrub, knee to waist. A
  // 2.5 m specimen reads as a dead sapling and steals the dead trees' job.
  const scrubGeos = [0, 1, 2, 3].map((i) => growPlant(scrubParams(4100 + i * 137)));
  const scrubMat = branchMaterial(uniforms, BRANCH_COLORS.scrub, 0.055, 0.92);
  const scrubDepth = matchingDepthMaterial(uniforms, 0.055);
  const near = scatterAnnulus({
    field, rng, rInner: 0, rOuter: 62, candidates: 2600,
    // Scrub survives where grass is only patchy — the drier margins — and it is
    // the one thing that keeps growing on ground too steep for tussock.
    //
    // The constant floors in every one of these tests used to be the whole
    // problem: at `0.10 + density*1.05` a tenth of the candidates landed on
    // ground the mask had rejected outright, which put an even pepper over the
    // entire pan no matter what the density field said. The floor is now small
    // enough to read as strays rather than as a texture.
    accept: (s, r) => r() < 0.012 + Math.pow(s.woody, 0.85) * 0.95,
    variants: scrubGeos, tilt: 0.5, scaleRange: [0.42, 1.60], sink: 0.05,
  });
  scrubGeos.forEach((g, i) => add(buildTiles(g, near[i], scrubMat, scrubDepth, `scrub-n${i}`, 500, 62)));
  counts.scrubNear = near.reduce((a, b) => a + b.length, 0);

  // ---- massed bush clumps, three tiers ------------------------------------
  // A branching skeleton is the wrong LOD for distance. Its branches are two
  // centimetres across, which is a third of a pixel at 150 m — round 1's
  // "thousands of bushes" were mathematically present and optically absent.
  // What has to survive at range is *projected area*, so the distant tiers are
  // domes of wide arching ribbons instead: a metre and a half of silhouette for
  // ten triangles.
  const bushMat = branchMaterial(uniforms, BRANCH_COLORS.bush, 0.05, 0.94);
  bushMat.side = THREE.DoubleSide;
  const bushDepth = matchingDepthMaterial(uniforms, 0.05);
  bushDepth.side = THREE.DoubleSide;

  const bushGeoNear = [0, 1].map((i) => buildTuft({
    blades: 9, segments: 2, seed: 8810 + i * 57,
    minH: 0.34, maxH: 0.66, width: 0.085, spread: 0.16, curve: 1.15, dome: 0.7,
  }));
  const bushNear = scatterAnnulus({
    field, rng, rInner: 0, rOuter: 145, candidates: 22000,
    accept: (s, r) => r() < 0.003 + Math.pow(s.woody, 0.85) * 0.50,
    variants: bushGeoNear, tilt: 0.55, scaleRange: [0.58, 2.05], sink: 0.05,
  });
  bushGeoNear.forEach((g, i) => add(buildTiles(g, bushNear[i], bushMat, bushDepth, `bush-n${i}`, 500, 48)));
  counts.bushNear = bushNear.reduce((a, b) => a + b.length, 0);

  // One segment, not two: past 130 m the arc of a branch is under a pixel of
  // curvature and only its width and mass survive, so the second segment is
  // 100k triangles buying nothing.
  const bushGeoMid = buildTuft({
    blades: 6, segments: 1, seed: 9021,
    minH: 0.42, maxH: 0.86, width: 0.185, spread: 0.26, curve: 1.25, dome: 0.85,
  });
  const bushMid = scatterAnnulus({
    field, rng, rInner: 130, rOuter: 340, candidates: 44000,
    accept: (s, r) => r() < 0.004 + Math.pow(s.woody, 0.85) * 0.74,
    variants: [bushGeoMid], tilt: 0.5, scaleRange: [0.72, 2.55], sink: 0.06,
  });
  add(buildTiles(bushGeoMid, bushMid[0], bushMat, null, 'bush-m', 400));
  counts.bushMid = bushMid[0].length;

  const bushGeoFar = buildTuft({
    blades: 5, segments: 1, seed: 9313,
    minH: 0.65, maxH: 1.15, width: 0.40, spread: 0.52, curve: 1.30, dome: 0.95,
  });
  const bushFar = scatterAnnulus({
    field, rng, rInner: 320, rOuter: 1050, candidates: 150000,
    accept: (s, r) => r() < 0.0015 + Math.pow(s.woody, 0.85) * 0.50,
    variants: [bushGeoFar], tilt: 0.45, scaleRange: [0.95, 3.20], sink: 0.10,
  });
  add(buildTiles(bushGeoFar, bushFar[0], bushMat, null, 'bush-f', 560));
  counts.bushFar = bushFar[0].length;

  // ---- dry brush balls ----------------------------------------------------
  const brushGeos = [0, 1, 2].map((i) => growPlant(brushParams(7700 + i * 91)));
  const brushMat = branchMaterial(uniforms, BRANCH_COLORS.brush, 0.03, 0.95);
  const brushDepth = matchingDepthMaterial(uniforms, 0.03);
  const brush = scatterAnnulus({
    field, rng, rInner: 0, rOuter: 190, candidates: 3600,
    // Brush blows about and snags on open ground and against anything that
    // breaks the wind, rather than sitting in the wet lines. It is the one
    // scatter that legitimately covers open ground, so it keeps a real floor —
    // but it now needs the stand field's permission like everything else, or
    // it re-creates the uniform pepper on its own.
    accept: (s, r) => s.slope < 0.30 && r() < (0.05 + (1 - s.density) * 0.30) * s.stand + s.shelter * 0.55,
    variants: brushGeos, tilt: 0.85, scaleRange: [0.45, 1.45],
  });
  brushGeos.forEach((g, i) => add(buildTiles(g, brush[i], brushMat, brushDepth, `brush-${i}`, 600)));
  counts.brush = brush.reduce((a, b) => a + b.length, 0);

  // ---- dead trees ---------------------------------------------------------
  const treeGeos = [0, 1].map((i) => growPlant(deadTreeParams(3300 + i * 211)));
  const treeMat = branchMaterial(uniforms, BRANCH_COLORS.tree, 0.045, 0.84);
  const treeDepth = matchingDepthMaterial(uniforms, 0.045);
  const treeNear = scatterAnnulus({
    field, rng, rInner: 0, rOuter: 175, candidates: 3600,
    // Rare, and only where there is enough water to have grown one — which now
    // means the drainage lines specifically, since that is where the density
    // field puts its water.
    accept: (s, r) => s.slope < 0.34 && s.density > 0.20 && r() < 0.004 + s.density * 0.075,
    variants: treeGeos, tilt: 0.35, scaleRange: [0.85, 2.55], sink: 0.08,
  });
  treeGeos.forEach((g, i) => add(buildTiles(g, treeNear[i], treeMat, treeDepth, `tree-n${i}`, 500, 130)));

  const treeL1 = [growPlant(deadTreeParamsL1(3901))];
  const treeFar = scatterAnnulus({
    field, rng, rInner: 165, rOuter: 760, candidates: 13000,
    // Bias hard onto breaks of slope out here: a bare tree only pays for itself
    // when it is standing against the sky.
    accept: (s, r) => s.slope > 0.04 && s.slope < 0.32 && s.density > 0.14 && r() < 0.004 + s.density * 0.11,
    variants: treeL1, tilt: 0.3, scaleRange: [1.05, 3.15], sink: 0.10,
  });
  add(buildTiles(treeL1[0], treeFar[0], treeMat, null, 'tree-f', 560));
  counts.trees = treeNear.reduce((a, b) => a + b.length, 0) + treeFar[0].length;

  counts.tris = Math.round(tris);
  counts.draws = meshes.length;

  return { meshes, counts, brushGeos, brushMat, brushDepth };
}

/**
 * Tumbleweed — a handful of brush balls actually rolling downwind. Cheap (one
 * instanced draw, a couple of dozen instances) and it is the thing that stops the
 * flats from reading as a still photograph.
 */
export function createTumbleweed(field, uniforms, geo, mat, depthMat, count = 22, seed = 99) {
  const rng = mulberry32(seed);
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.customDepthMaterial = depthMat;
  mesh.frustumCulled = false;
  mesh.name = 'tumbleweed';

  const state = [];
  for (let i = 0; i < count; i++) {
    state.push({
      x: 0,
      z: 0,
      spin: rng() * Math.PI * 2,
      speed: 2.4 + rng() * 3.2,
      radius: 0.30 + rng() * 0.22,
      wobble: rng() * Math.PI * 2,
      fresh: true,
      lateral: (rng() - 0.5) * 0.5,
    });
  }

  const axis = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const qy = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const m = new THREE.Matrix4();

  function respawn(s, cam, wind, first) {
    // Enter from upwind so they always travel *into* frame.
    const spreadAngle = (rng() - 0.5) * 1.9;
    const cs = Math.cos(spreadAngle);
    const sn = Math.sin(spreadAngle);
    const dx = -(wind.x * cs - wind.y * sn);
    const dz = -(wind.x * sn + wind.y * cs);
    const d = first ? 12 + rng() * 90 : 70 + rng() * 45;
    s.x = cam.x + dx * d;
    s.z = cam.z + dz * d;
    s.fresh = false;
  }

  return {
    mesh,
    update(dt, elapsed, camera, wind) {
      for (let i = 0; i < count; i++) {
        const s = state[i];
        if (s.fresh) respawn(s, camera.position, wind, true);
        const gust = 0.65 + 0.35 * Math.sin(elapsed * 0.7 + s.wobble);
        const vx = (wind.x + -wind.y * s.lateral) * s.speed * gust;
        const vz = (wind.y + wind.x * s.lateral) * s.speed * gust;
        s.x += vx * dt;
        s.z += vz * dt;
        s.spin += (Math.hypot(vx, vz) / s.radius) * dt;

        const dx = s.x - camera.position.x;
        const dz = s.z - camera.position.z;
        if (dx * dx + dz * dz > 130 * 130) respawn(s, camera.position, wind, false);

        const h = field.surfaceY(s.x, s.z);
        // Bounce: it is a hollow ball of twigs, it never rolls smoothly.
        const hop = Math.abs(Math.sin(s.spin * 0.5)) * s.radius * 0.35;
        pos.set(s.x, h + s.radius * 0.85 + hop, s.z);
        axis.set(-wind.y, 0, wind.x).normalize();
        q.setFromAxisAngle(axis, s.spin);
        qy.setFromAxisAngle(_up, s.wobble + elapsed * 0.4);
        q.multiply(qy);
        scl.setScalar(s.radius / 0.32);
        mesh.setMatrixAt(i, m.compose(pos, q, scl));
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
