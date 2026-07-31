import * as THREE from 'three';
import { makeRng } from './Noise.js';

/**
 * Placement rules.
 *
 * Uniform scatter is the tell that gives away procedural worlds instantly. Real
 * debris obeys gravity and geology:
 *   - scree accumulates at the *foot* of steep ground, in fans, not on flats;
 *   - boulders come off a parent outcrop, so they arrive in clusters with a
 *     size gradient, not as isolated singletons;
 *   - outcrops and cliffs only exist where the bedrock is already exposed, i.e.
 *     on steep slopes and ridge shoulders;
 *   - the valley floor the player fights on stays clear.
 *
 * Distance from the world origin also drives LOD banding. The play space is
 * centred on the outpost, so banding by origin distance is stable, costs nothing
 * per frame, and lets the far field drop to silhouette meshes with no shadows.
 */

/**
 * LOD switch distances from the play centre, per family: `[lod1, lod2, cull]`.
 * Small debris drops to its cheap mesh almost immediately — a 20 cm chip is two
 * pixels at 80 m — while a 25 m outcrop has to hold up much further out.
 *
 * The third entry is a hard cull. It matters more than the LOD split: an
 * InstancedMesh has one world-spanning bounding sphere, so nothing about it is
 * ever frustum-culled and every instance is re-submitted for each shadow
 * cascade as well as the main pass. A 30 cm chip at 300 m was costing 30
 * triangles four times a frame to cover a third of a pixel.
 */
const DEFAULT_BANDS = [160, 520, 1500];
const BANDS = {
  chips: [26, 85, 150],
  stones: [45, 190, 620],
  boulders: [85, 300, 1250],
  formations: [200, 800, 1900],
  outcrops: [170, 700, 1700],
};

/** Keep-clear radii, metres. The outpost owns the valley floor. */
export const CLEAR = {
  gravel: 42,
  stone: 60,
  boulder: 126,
  formation: 190,
  outcrop: 182,
};

const UP = new THREE.Vector3(0, 1, 0);

function reliefAt(terrain, x, z, r) {
  const h = terrain.heightAt(x, z);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const d = terrain.heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r) - h;
    if (d > hi) hi = d;
    if (d < lo) lo = d;
  }
  return { up: hi / r, down: -lo / r };
}

/**
 * Collects instance transforms per (variant, LOD band) and turns them into
 * InstancedMeshes at the end.
 */
class Field {
  constructor(material) {
    this.material = material;
    this.groups = new Map();
    this.records = [];
  }

  add(variant, band, matrix, tint, x, z, shadowBand = 0) {
    const lod = Math.min(band, variant.lods.length - 1);
    // Band is part of the key as well as LOD: a far group must be able to drop
    // out of the shadow pass even when it shares a mesh resolution with a near one.
    const key = `${variant.id}:${lod}:${band}`;
    let g = this.groups.get(key);
    if (!g) {
      g = { variant, lod, band, shadowBand, matrices: [], tints: [], xz: [] };
      this.groups.set(key, g);
    }
    g.matrices.push(matrix);
    g.tints.push(tint);
    g.xz.push(x, z);
  }

  build(group) {
    const meshes = [];
    for (const g of this.groups.values()) {
      const n = g.matrices.length;
      if (!n) continue;
      // Per-instance attributes live on the geometry, so each group needs its
      // own BufferGeometry. The heavy attributes are shared by reference — this
      // costs one object, not one vertex buffer.
      const src = g.variant.lods[g.lod];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', src.attributes.position);
      geo.setAttribute('normal', src.attributes.normal);
      geo.setAttribute('aRock', src.attributes.aRock);
      geo.boundingBox = src.boundingBox;
      geo.boundingSphere = src.boundingSphere;
      const mesh = new THREE.InstancedMesh(geo, this.material, n);
      const tint = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        mesh.setMatrixAt(i, g.matrices[i]);
        tint[i * 2] = g.tints[i][0];
        tint[i * 2 + 1] = g.tints[i][1];
      }
      geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 2));
      mesh.instanceMatrix.needsUpdate = true;
      // The sun's shadow frustum is only ~240 m wide: submitting the far field
      // to the depth pass costs vertices and buys nothing.
      mesh.castShadow = g.band <= g.shadowBand;
      mesh.receiveShadow = true;
      mesh.name = `rock_${g.variant.id}_lod${g.lod}_b${g.band}`;
      mesh.computeBoundingSphere();
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
      meshes.push(mesh);
      this.records.push({ mesh, xz: g.xz, matrices: g.matrices, n });
    }
    return meshes;
  }
}

/** Tag every variant with a stable id used for grouping and mesh names. */
function cloneVariantGeometries(lib) {
  let id = 0;
  const out = {};
  for (const [family, variants] of Object.entries(lib)) {
    out[family] = variants.map((v) => ({ ...v, id: `${family}${id++}` }));
  }
  return out;
}

export function buildRockField(world, lib, material) {
  const terrain = world.terrain;
  const rng = makeRng(0x5eed13);
  const shapes = cloneVariantGeometries(lib);
  const field = new Field(material);

  const pos = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const spin = new THREE.Quaternion();
  const aligned = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const euler = new THREE.Euler();

  /**
   * Radius sample with density falling off away from the play area. Pure
   * area-uniform scatter over a 2 km disc puts 95% of the rocks where the player
   * will never stand; `bias > 1` pulls the mass back in without leaving the
   * skyline empty.
   */
  const radius = (near, far, bias) => near + (far - near) * Math.pow(rng(), bias);

  /**
   * Lowest ground height under the rock's footprint. Only used for bodies that
   * stay near-upright on a slope: if the body is *aligned* to the slope its base
   * plane already follows the ground and the centre height is correct, whereas
   * the minimum would lift its downhill edge into the air.
   */
  function groundY(x, z, foot) {
    let m = terrain.heightAt(x, z);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.37;
      const h = terrain.heightAt(x + Math.cos(a) * foot, z + Math.sin(a) * foot);
      if (h < m) m = h;
    }
    return m;
  }

  /**
   * @param {object} v      variant
   * @param {number} size   largest dimension in metres
   * @param {number} align  0 = stand upright, 1 = lie flat on the slope
   * @param {number} sink   fraction of the body buried
   * @param {number} tilt   extra random lean, radians
   * @param {number[]} bands LOD switch distances from the play centre
   * @param {number} shadowBand highest LOD band that still casts shadows
   */
  function place(
    v, x, z, size,
    { align = 0.5, sink = 0.25, tilt = 0.12, bands = DEFAULT_BANDS, shadowBand = 0, foot = 0.42 } = {},
  ) {
    const d = Math.hypot(x, z);
    const n = terrain.normalAt(x, z);
    // On steep ground a boulder beds itself into the slope: align harder and
    // bury deeper, or it reads as a prop balanced on a hillside.
    const slope = 1 - n.y;
    const al = Math.min(1, align + slope * 0.9);
    aligned.copy(UP).lerp(n, al).normalize();
    q.setFromUnitVectors(UP, aligned);
    spin.setFromAxisAngle(aligned, rng() * Math.PI * 2);
    q.premultiply(spin);
    if (tilt > 0) {
      euler.set((rng() - 0.5) * tilt * 2, 0, (rng() - 0.5) * tilt * 2);
      spin.setFromEuler(euler);
      q.premultiply(spin);
    }
    // Past the cull radius the body is smaller than the pixel it would land in.
    // Scale it out of the count entirely rather than shipping it to the GPU.
    if (bands[2] !== undefined && d > bands[2]) return;
    const centre = terrain.heightAt(x, z);
    const low = foot > 0 ? groundY(x, z, size * foot) : centre;
    const h = centre * al + low * (1 - al);
    pos.set(x, h - v.size.y * size * (sink + slope * 0.2), z);
    scl.setScalar(size);
    const band = d < bands[0] ? 0 : d < bands[1] ? 1 : 2;
    field.add(v, band, new THREE.Matrix4().compose(pos, q, scl), [rng(), rng()], x, z, shadowBand);
  }

  const pick = (arr) => arr[(rng() * arr.length) | 0];

  // ---------------------------------------------------------------- gravel --
  // Ground litter. Thousands of chips, thickest where the ground has just
  // enough tilt to shed material but not enough to keep it moving.
  {
    let placed = 0;
    for (let i = 0; i < 26000 && placed < 3200; i++) {
      const a = rng() * Math.PI * 2;
      const r = radius(CLEAR.gravel, 148, 1.35);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const rel = reliefAt(terrain, x, z, 14);
      const slope = 1 - terrain.normalAt(x, z).y;
      if (slope > 0.36) continue;             // loose chips do not cling to walls
      const p = 0.32 + Math.min(1, rel.up * 2.6) * 0.55 - slope * 0.35;
      if (rng() > p) continue;
      place(pick(shapes.chips), x, z, 0.13 + Math.pow(rng(), 1.8) * 0.4, {
        align: 1.0,
        sink: 0.5,
        tilt: 0.16,
        bands: BANDS.chips,
        foot: 0,
      });
      placed++;
    }
  }

  // ------------------------------------------------------------------ scree --
  // Talus fans: dense chip fields hugging the foot of steep ground, which is
  // where gravity actually piles debris.
  {
    let placed = 0;
    for (let i = 0; i < 30000 && placed < 2400; i++) {
      const a = rng() * Math.PI * 2;
      const r = radius(52, 148, 1.3);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const slope = 1 - terrain.normalAt(x, z).y;
      const rel = reliefAt(terrain, x, z, 26);
      if (slope > 0.38) continue;             // too steep to hold debris
      if (rel.up < 0.42) continue;            // nothing uphill to shed it
      place(pick(shapes.chips), x, z, 0.16 + Math.pow(rng(), 1.5) * 0.6, {
        align: 1.0,
        sink: 0.48,
        tilt: 0.2,
        bands: BANDS.chips,
        foot: 0,
      });
      placed++;
    }
  }

  // ------------------------------------------------------------------ stones --
  {
    let placed = 0;
    for (let i = 0; i < 26000 && placed < 2200; i++) {
      const a = rng() * Math.PI * 2;
      const r = radius(CLEAR.stone, 615, 1.55);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const rel = reliefAt(terrain, x, z, 20);
      const slope = 1 - terrain.normalAt(x, z).y;
      if (slope > 0.45) continue;
      const p = 0.25 + Math.min(1, rel.up * 2.0) * 0.6;
      if (rng() > p) continue;
      place(pick(shapes.stones), x, z, 0.34 + Math.pow(rng(), 1.6) * 1.25, {
        align: 0.55,
        sink: 0.3,
        tilt: 0.35,
        bands: BANDS.stones,
      });
      placed++;
    }
  }

  // ---------------------------------------------------------------- boulders --
  // Clustered: pick parent sites on broken ground, then drop a family of rocks
  // around each with a size gradient, the way a collapsed face actually litters.
  // A quarter of the sites are allowed on the flats too — the valley floor of
  // an Afghan basin is not swept clean, and cover has to exist where the player
  // actually fights.
  {
    let clusters = 0;
    for (let i = 0; i < 18000 && clusters < 260; i++) {
      const a = rng() * Math.PI * 2;
      const r = radius(CLEAR.boulder, 1400, 1.7);
      const cx = Math.cos(a) * r;
      const cz = Math.sin(a) * r;
      const rel = reliefAt(terrain, cx, cz, 34);
      if (rel.up < 0.24 && rel.down < 0.3 && rng() > 0.3) continue;
      const spread = 5 + rng() * 24;
      const count = 4 + ((rng() * 8) | 0);
      const big = 1.6 + Math.pow(rng(), 1.3) * 4.2;
      for (let k = 0; k < count; k++) {
        const t = k / count;
        const ang = rng() * Math.PI * 2;
        const rad = Math.pow(rng(), 0.6) * spread;
        const x = cx + Math.cos(ang) * rad;
        const z = cz + Math.sin(ang) * rad;
        if (Math.hypot(x, z) < CLEAR.boulder) continue;
        if (1 - terrain.normalAt(x, z).y > 0.44) continue;   // it would have rolled
        place(pick(shapes.boulders), x, z, big * (1 - t * 0.6) * (0.7 + rng() * 0.6), {
          align: 0.3,
          sink: 0.22 + rng() * 0.16,
          tilt: 0.24,
          bands: BANDS.boulders,
        });
      }
      clusters++;
    }
  }

  // -------------------------------------------------------------- formations --
  // The skyline furniture. Placed along *lineaments* rather than one at a time:
  // an exposed dyke or a resistant bed weathers out as a line of monoliths of
  // decreasing size with a debris apron, and reading that line is what makes a
  // valley floor feel like geology instead of set dressing.
  {
    let reefs = 0;
    for (let i = 0; i < 26000 && reefs < 110; i++) {
      const a = rng() * Math.PI * 2;
      const r = radius(CLEAR.formation, 1600, 1.45);
      const cx = Math.cos(a) * r;
      const cz = Math.sin(a) * r;
      const rel = reliefAt(terrain, cx, cz, 55);
      const slope = 1 - terrain.normalAt(cx, cz).y;
      if (rel.up + rel.down < 0.5 && slope < 0.18 && rng() > 0.45) continue;

      const dir = rng() * Math.PI * 2;
      const dx = Math.cos(dir);
      const dz = Math.sin(dir);
      const step = 14 + rng() * 40;
      const n = 2 + ((rng() * 4) | 0);
      const lead = 8 + Math.pow(rng(), 1.15) * 21;
      for (let k = 0; k < n; k++) {
        const t = k / Math.max(1, n - 1);
        const jitter = (rng() - 0.5) * step * 0.7;
        const x = cx + dx * step * k - dz * jitter;
        const z = cz + dz * step * k + dx * jitter;
        if (Math.hypot(x, z) < CLEAR.formation) continue;
        if (1 - terrain.normalAt(x, z).y > 0.66) continue;
        const size = lead * (1 - t * 0.55) * (0.7 + rng() * 0.6);
        place(pick(shapes.formations), x, z, size, {
          align: 0.18,
          sink: 0.24 + rng() * 0.2,
          tilt: 0.22,
          bands: BANDS.formations,
          foot: 0.3,
          shadowBand: 1,
        });
        // collapse apron: blocks shed off the face, biggest nearest the base
        const m = 4 + ((rng() * 6) | 0);
        for (let j = 0; j < m; j++) {
          const ang = rng() * Math.PI * 2;
          const rad = size * (0.45 + Math.pow(rng(), 0.7) * 1.5);
          const bx = x + Math.cos(ang) * rad;
          const bz = z + Math.sin(ang) * rad;
          if (1 - terrain.normalAt(bx, bz).y > 0.5) continue;
          place(pick(shapes.boulders), bx, bz, size * (0.07 + rng() * 0.2), {
            align: 0.35, sink: 0.3, tilt: 0.4, bands: BANDS.boulders,
          });
        }
      }
      reefs++;
    }
  }

  // ----------------------------------------------------------------- outcrops --
  // Stratified bedrock pushing out of steep slopes. Sunk hard and part-aligned
  // to the slope normal so the lowest courses disappear into the hillside and
  // the thing reads as bedrock rather than a prop dropped on a hill.
  {
    let placed = 0;
    for (let i = 0; i < 26000 && placed < 240; i++) {
      const a = rng() * Math.PI * 2;
      const r = radius(CLEAR.outcrop, 1500, 1.4);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const slope = 1 - terrain.normalAt(x, z).y;
      if (slope < 0.13) continue;
      const size = 9 + Math.pow(rng(), 1.1) * 30;
      place(pick(shapes.outcrops), x, z, size, {
        align: 0.5,
        sink: 0.34 + rng() * 0.24,
        tilt: 0.05,
        bands: BANDS.outcrops,
        foot: 0.36,
      });
      // rubble apron shed off the face
      const n = 4 + ((rng() * 7) | 0);
      for (let k = 0; k < n; k++) {
        const ang = rng() * Math.PI * 2;
        const rad = size * (0.5 + rng() * 1.1);
        place(
          pick(shapes.boulders),
          x + Math.cos(ang) * rad,
          z + Math.sin(ang) * rad,
          size * (0.05 + rng() * 0.14),
          { align: 0.4, sink: 0.3, tilt: 0.4, bands: BANDS.boulders },
        );
      }
      placed++;
    }
  }

  const group = new THREE.Group();
  group.name = 'rocks';
  const meshes = field.build(group);
  return { group, meshes, records: field.records };
}
