import * as THREE from 'three';
import { buildShapeLibrary } from './RockShapes.js';
import { createRockMaterial } from './RockMaterial.js';
import { buildRockField, CLEAR } from './Scatter.js';

/**
 * rocks — the landscape's gameplay furniture and its main source of silhouette.
 *
 * Three pieces:
 *   RockShapes    archetype library (chips / stones / boulders / monoliths /
 *                 stratified outcrops), each cleaved from half-space
 *                 intersections rather than displaced from a sphere, with three
 *                 LODs per variant.
 *   RockMaterial  one shared MeshStandardMaterial + onBeforeCompile: strata in
 *                 the body's local frame, baked cavity/edge shading, dust,
 *                 lichen, analytic normal detail.
 *   Scatter       rule-driven placement — talus at slope feet, boulder families
 *                 off broken ground, outcrops only on steep bedrock, valley
 *                 floor left clear for the outpost.
 */
export async function install(world) {
  const t0 = performance.now();
  const lib = buildShapeLibrary();
  const material = createRockMaterial();
  const { group, meshes, collars, records } = buildRockField(world, lib, material);
  world.scene.add(group);

  let instances = 0;
  let triangles = 0;
  let collarTris = 0;
  let collarInst = 0;
  for (const m of collars) {
    collarInst += m.count;
    collarTris += (m.geometry.attributes.position.count / 3) * m.count;
  }
  // Per-LOD breakdown: the hero mesh is 4x the triangles of the mid one, so a
  // band-0 population that quietly grows is the fastest way to blow the budget.
  const perLod = [0, 0, 0];
  const instLod = [0, 0, 0];
  for (const m of meshes) {
    const tri = (m.geometry.attributes.position.count / 3) * m.count;
    instances += m.count;
    triangles += tri;
    const lod = +(m.name.match(/lod(\d)/)?.[1] ?? 0);
    perLod[lod] += tri;
    instLod[lod] += m.count;
  }
  console.log(
    `[rocks] ${meshes.length + collars.length} draws, ${instances} instances, ` +
      `${((triangles + collarTris) / 1e6).toFixed(2)}M tris, ${Math.round(performance.now() - t0)}ms` +
      ` | lod0 ${instLod[0]}i/${(perLod[0] / 1e6).toFixed(2)}M` +
      ` lod1 ${instLod[1]}i/${(perLod[1] / 1e6).toFixed(2)}M` +
      ` lod2 ${instLod[2]}i/${(perLod[2] / 1e6).toFixed(2)}M` +
      ` collar ${collars.length}d/${collarInst}i/${(collarTris / 1e6).toFixed(2)}M`,
  );

  const tmp = new THREE.Matrix4();
  const zero = new THREE.Vector3(0, 0, 0);

  return {
    group,
    meshes,
    /** Fines aprons. Separate bodies, placed in world space — see Scatter.addCollar. */
    collars,
    material,
    /** Keep-clear radii used for the outpost footprint, metres. */
    clearRadii: CLEAR,
    /**
     * Remove every rock instance inside a circle. Provided for the outpost /
     * gameplay modules, which install after this one and know their real
     * footprint — collapsing an instance to zero scale costs no draw call.
     */
    clearCircle(x, z, r) {
      const r2 = r * r;
      let removed = 0;
      for (const rec of records) {
        let dirty = false;
        for (let i = 0; i < rec.n; i++) {
          const dx = rec.xz[i * 2] - x;
          const dz = rec.xz[i * 2 + 1] - z;
          if (dx * dx + dz * dz > r2) continue;
          rec.mesh.getMatrixAt(i, tmp);
          const e = tmp.elements;
          if (e[0] === 0 && e[5] === 0 && e[10] === 0) continue;
          tmp.scale(zero);
          rec.mesh.setMatrixAt(i, tmp);
          dirty = true;
          removed++;
        }
        if (dirty) rec.mesh.instanceMatrix.needsUpdate = true;
      }
      return removed;
    },
  };
}
