import * as THREE from 'three';
import { GLSL_NOISE, GLSL_WIND } from './shaderLib.js';
import { mulberry32 } from './VegField.js';
import { brushParams, deadTreeParams, growPlant, scrubParams } from './Branching.js';

/**
 * Scrub — the woody half of the vegetation: thorny shrubs, dry brush balls and
 * the occasional dead tree. These carry the silhouette work that grass cannot;
 * a bare tree against a ridgeline is the single most legible MGSV composition.
 *
 * Everything is instanced per variant, casts and receives shadow, and sways on
 * the same gust field as the grass so the whole landscape moves as one system.
 */

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

function branchMaterial(uniforms, color, flex, roughness = 0.88) {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(color[0], color[1], color[2], THREE.LinearSRGBColorSpace),
    roughness,
    metalness: 0.0,
    envMapIntensity: 0.8,
    dithering: true,
  });
  injectBranchWind(mat, uniforms, flex);
  return mat;
}

/** Depth material matching the wind displacement, or shadows detach from the plant. */
function matchingDepthMaterial(uniforms, flex) {
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  injectBranchWind(d, uniforms, flex);
  return d;
}

function makeInstanced(geo, mat, depthMat, count, name) {
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.customDepthMaterial = depthMat;
  mesh.name = name;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  return mesh;
}

/**
 * Scatter woody plants. Candidates are rejected by the same drainage/slope mask
 * the grass uses, biased differently per kind: scrub likes the *margins* of the
 * wet lines, trees want a visible spot with root water, brush collects on flats.
 */
function scatter({ field, rng, count, radius, accept, variants, tilt, scaleRange, falloff = 0.5 }) {
  const perVariant = variants.map(() => []);
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2;
    // falloff 0.5 spreads candidates uniformly over the disc; pushing it toward
    // 1 concentrates them near the playable centre and lets the outer field
    // thin out gradually instead of ending on a visible circle.
    const r = radius * Math.pow(rng(), falloff);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const s = field.density(x, z);
    if (!accept(s, rng, x, z)) continue;
    const v = Math.floor(rng() * variants.length);
    const scale = scaleRange[0] + (scaleRange[1] - scaleRange[0]) * rng();
    _q.setFromUnitVectors(_up, s.normal).slerp(_qIdentity, 1 - tilt);
    _q.multiply(_qYaw.setFromAxisAngle(_up, rng() * Math.PI * 2));
    _v.set(x, s.height, z);
    _scale.set(scale * (0.9 + rng() * 0.2), scale, scale * (0.9 + rng() * 0.2));
    perVariant[v].push(_m.compose(_v, _q, _scale).clone());
  }
  return perVariant;
}

export function createScrub(field, uniforms, seed = 20260731) {
  const rng = mulberry32(seed);
  const group = [];
  let tris = 0;

  const countTris = (geo, instances) => {
    tris += (geo.index.count / 3) * instances;
  };

  // ---- thorny scrub -------------------------------------------------------
  const scrubGeos = [0, 1, 2, 3, 4].map((i) => growPlant(scrubParams(4100 + i * 137)));
  const scrubMat = branchMaterial(uniforms, [0.510, 0.448, 0.310], 0.055, 0.92);
  const scrubDepth = matchingDepthMaterial(uniforms, 0.055);
  const scrubSets = scatter({
    field,
    rng,
    count: 8000,
    radius: 380,
    falloff: 0.95,
    // Scrub survives where grass is only patchy — the drier margins.
    accept: (s, r) => s.slope < 0.36 && r() < 0.014 + s.density * 0.072,
    variants: scrubGeos,
    tilt: 0.5,
    scaleRange: [0.60, 2.35],
  });

  // ---- dry brush balls ----------------------------------------------------
  const brushGeos = [0, 1, 2].map((i) => growPlant(brushParams(7700 + i * 91)));
  const brushMat = branchMaterial(uniforms, [0.560, 0.485, 0.330], 0.03, 0.95);
  const brushDepth = matchingDepthMaterial(uniforms, 0.03);
  const brushSets = scatter({
    field,
    rng,
    count: 6500,
    radius: 340,
    falloff: 0.92,
    // Brush blows about and snags on flat, open ground rather than in the wet lines.
    accept: (s, r) => s.slope < 0.24 && r() < 0.016 + (1.0 - s.density) * 0.048,
    variants: brushGeos,
    tilt: 0.85,
    scaleRange: [0.70, 1.55],
  });

  // ---- dead trees ---------------------------------------------------------
  const treeGeos = [0, 1, 2, 3].map((i) => growPlant(deadTreeParams(3300 + i * 211)));
  const treeMat = branchMaterial(uniforms, [0.490, 0.438, 0.355], 0.045, 0.82);
  const treeDepth = matchingDepthMaterial(uniforms, 0.045);
  const treeSets = scatter({
    field,
    rng,
    count: 3200,
    radius: 460,
    // Rare, and only where there is enough water to have grown one — plus a
    // deliberate bias onto breaks of slope, where they read against the sky.
    accept: (s, r) => s.slope < 0.30 && s.density > 0.30 && r() < 0.006 + s.density * 0.020,
    variants: treeGeos,
    tilt: 0.35,
    scaleRange: [1.05, 2.60],
  });

  /**
   * One InstancedMesh has a single world-spanning bounding sphere, so nothing in
   * it is ever frustum-culled and the whole set is re-submitted for every shadow
   * cascade. Splitting each variant at `shadowRadius` costs one extra draw call
   * in the main pass and takes the outer 85% of the bushes out of three shadow
   * passes — the shadow of a bush 300 m away is not a pixel of anything.
   */
  const build = (geos, sets, mat, depth, label, shadowRadius = 120) => {
    const meshes = [];
    geos.forEach((geo, i) => {
      const list = sets[i];
      if (!list.length) return;
      const near = [];
      const far = [];
      const r2 = shadowRadius * shadowRadius;
      for (const m of list) {
        const x = m.elements[12];
        const z = m.elements[14];
        (x * x + z * z <= r2 ? near : far).push(m);
      }
      for (const [part, sub, cast] of [['', near, true], ['-far', far, false]]) {
        if (!sub.length) continue;
        const mesh = makeInstanced(geo, mat, depth, sub.length, `${label}-${i}${part}`);
        sub.forEach((m, k) => mesh.setMatrixAt(k, m));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.castShadow = cast;
        countTris(geo, sub.length);
        meshes.push(mesh);
      }
    });
    return meshes;
  };

  group.push(...build(scrubGeos, scrubSets, scrubMat, scrubDepth, 'scrub', 110));
  const brushMeshes = build(brushGeos, brushSets, brushMat, brushDepth, 'brush');
  for (const m of brushMeshes) m.castShadow = false;
  group.push(...brushMeshes);
  group.push(...build(treeGeos, treeSets, treeMat, treeDepth, 'deadtree', 180));

  const counts = {
    scrub: scrubSets.reduce((a, b) => a + b.length, 0),
    brush: brushSets.reduce((a, b) => a + b.length, 0),
    trees: treeSets.reduce((a, b) => a + b.length, 0),
    tris: Math.round(tris),
  };

  return { meshes: group, counts, brushGeos, brushMat, brushDepth };
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

        const h = field.heightAt(s.x, s.z);
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
