import * as THREE from 'three';
import { makeRng, fbm3 } from './Noise.js';
import { SKIRTS } from './RockShapes.js';

/**
 * Placement rules.
 *
 * Uniform scatter is the tell that gives away procedural worlds instantly. Real
 * debris obeys gravity and geology:
 *   - scree accumulates at the *foot* of steep ground, in fans, not on flats;
 *   - boulders come off a parent outcrop, so they arrive in clusters with a
 *     size gradient, not as isolated singletons;
 *   - blocks that reach the valley floor got there down a *drainage line*, so
 *     they lie in trains along the wadis and not broadcast over the interfluves;
 *   - outcrops and cliffs only exist where the bedrock is already exposed, i.e.
 *     on steep slopes and ridge shoulders;
 *   - and between all of that, most of the desert is simply bare.
 *
 * Round 2 drives all of this off the terrain's own erosion solve rather than off
 * local slope probes. `terrain.surfaceAt(x, z)` returns `{ rock, scree, flow,
 * ao }` — bedrock exposure, talus/alluvial deposition, and drainage accumulation
 * — which is the ground truth for where material actually came to rest. Reading
 * that instead of guessing is the difference between a rock field that agrees
 * with the landform and one that is sprinkled on top of it. It is read
 * defensively: the module still installs against a terrain that has no erosion.
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
/**
 * Band 0 must start OUTSIDE the family's keep-clear radius or the hero mesh is
 * dead weight that nothing is ever eligible for. Round 1 had `boulders` switch
 * to LOD1 at 85 m while refusing to place a boulder inside 126 m, so the
 * subdivided mesh was built, uploaded and never drawn.
 *
 * It must also stay a THIN ring. The hero mesh is ~4x the triangles of the mid
 * one, and the first version of this table put 345 instances (2.7% of the field)
 * into 53% of the module's entire triangle budget for bodies that are already
 * 150 m away. Band 0 is a courtesy for the handful of rocks nearest the play
 * space, not a quality tier for the middle distance.
 */
// Round 3 pulled every cull radius (the third number) in by ~28%. The rock
// field was 0.91 M triangles of the frame's 3.9 M and the outermost band was
// paying for bodies past 1.2 km, where the aerial perspective has already washed
// them to within a few sRGB counts of the sky behind them. Measured: the vista
// silhouette is unchanged and the field costs 0.24 M less.
const BANDS = {
  chips: [26, 85, 150],
  stones: [74, 260, 450],
  boulders: [146, 420, 900],
  formations: [242, 800, 1350],
  outcrops: [214, 700, 1200],
};

/** Keep-clear radii, metres. The outpost owns the valley floor. */
export const CLEAR = {
  gravel: 34,
  stone: 52,
  boulder: 112,
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

const ZERO_SURFACE = { rock: 0, scree: 0, flow: 0, ao: 1 };

export function buildRockField(world, lib, material) {
  const terrain = world.terrain;
  const rng = makeRng(0x5eed13);
  const shapes = cloneVariantGeometries(lib);
  const field = new Field(material);

  // The erosion channels are optional: terrain is owned by another author and
  // may be mid-rewrite. Everything below degrades to the slope/relief heuristics
  // rather than throwing.
  const hasSurface = typeof terrain.surfaceAt === 'function';
  const surfaceAt = hasSurface ? (x, z) => terrain.surfaceAt(x, z) : () => ZERO_SURFACE;

  /**
   * Low-frequency patchiness, ~120 m and ~400 m. Even inside a depositional
   * zone a real rock field is blotchy: there are swept stretches with nothing on
   * them at all, and the eye reads those gaps as strongly as it reads the rocks.
   * Constant density over a qualifying region is still "uniform scatter", just
   * with a mask on it.
   */
  const patch = (x, z, k) => {
    const a = fbm3(x * k, 7.3, z * k, 3);
    const b = fbm3(x * k * 0.28 - 41.0, 2.1, z * k * 0.28 + 17.0, 2);
    return Math.max(0, Math.min(1, (a * 0.55 + b * 0.65 - 0.28) * 1.9));
  };

  /** Unit vector pointing down the steepest descent at (x, z). */
  const grad = new THREE.Vector2();
  function downhill(x, z, e) {
    const dx = terrain.heightAt(x + e, z) - terrain.heightAt(x - e, z);
    const dz = terrain.heightAt(x, z + e) - terrain.heightAt(x, z - e);
    const l = Math.hypot(dx, dz);
    if (l < 1e-5) {
      grad.set(0, 0);
      return 0;
    }
    grad.set(-dx / l, -dz / l);
    return l / (2 * e);                    // gradient magnitude
  }

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
  function groundY(x, z, foot, size) {
    let m = seatY(x, z, size);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.37;
      const h = seatY(x + Math.cos(a) * foot, z + Math.sin(a) * foot, size);
      if (h < m) m = h;
    }
    return m;
  }

  /**
   * Ground for placement. `seatHeightAt` seats against the surface the clipmap
   * actually *draws* at the range a body of this size is read from, instead of
   * the fine heightfield — past 190 m the two differ by metres and the fine one
   * leaves big rocks hanging in mid-air. Older terrains lack it, hence the
   * fallback.
   */
  const seatY = terrain.seatHeightAt
    ? (x, z, size) => terrain.seatHeightAt(x, z, size)
    : (x, z) => terrain.heightAt(x, z);

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
    // Past the cull radius the body is smaller than the pixel it would land in.
    // Scale it out of the count entirely rather than shipping it to the GPU.
    if (bands[2] !== undefined && d > bands[2]) return;
    const n = terrain.normalAt(x, z);
    // On steep ground a boulder beds itself into the slope: align harder and
    // bury deeper, or it reads as a prop balanced on a hillside. A *slabby*
    // body lies down regardless — the single change that stops the mid sizes
    // reading as sheets of card standing on edge is refusing to stand a slab up.
    const slope = 1 - n.y;
    const al = Math.min(1, align + slope * 1.15 + (v.flat ?? 0) * 0.8);
    aligned.copy(UP).lerp(n, al).normalize();
    q.setFromUnitVectors(UP, aligned);
    spin.setFromAxisAngle(aligned, rng() * Math.PI * 2);
    q.premultiply(spin);
    // A rock resting on the ground is not free to lean far: its own weight put
    // it on its most stable face. Slabs get almost none.
    const t = tilt * (1 - (v.flat ?? 0) * 0.65);
    if (t > 0) {
      euler.set((rng() - 0.5) * t * 2, 0, (rng() - 0.5) * t * 2);
      spin.setFromEuler(euler);
      q.premultiply(spin);
    }
    const centre = seatY(x, z, size);
    const low = foot > 0 ? groundY(x, z, size * foot, size) : centre;
    // Only a body fully aligned to the slope may sit at the centre height: its
    // base plane already follows the ground. Anything standing even slightly
    // upright has to be seated on the LOWEST ground under its footprint, or its
    // downhill edge hangs in the air. Round 1's linear blend left 20 m
    // formations visibly floating off hillsides — cubing the weight means the
    // centre height is only reached once alignment is essentially complete.
    const seat = low + (centre - low) * (al * al * al);
    // Randomised burial. The mean has to agree with the fines-apron profile
    // authored in RockShapes (the collar's rim is cut below this line so the
    // terrain clips it), so the jitter is deliberately narrow and symmetric.
    const bury = sink + (rng() - 0.5) * 0.1 + slope * 0.14;
    pos.set(x, seat - v.size.y * size * bury, z);
    scl.setScalar(size);
    const band = d < bands[0] ? 0 : d < bands[1] ? 1 : 2;
    field.add(v, band, new THREE.Matrix4().compose(pos, q, scl), [rng(), rng()], x, z, shadowBand);
  }

  const pick = (arr) => arr[(rng() * arr.length) | 0];

  // ------------------------------------------------------------- desert lag --
  // Ground litter, but in *sheets*, not broadcast. A stone pavement forms where
  // the wind has already stripped the fines out — around drainage lines, on
  // deflated interfluves and across scree tails — and the bare stretches between
  // those sheets are as characteristic as the sheets themselves.
  {
    let placed = 0;
    for (let i = 0; i < 9000 && placed < 3400; i++) {
      const a = rng() * Math.PI * 2;
      const r = radius(CLEAR.gravel, 168, 1.3);
      const cx = Math.cos(a) * r;
      const cz = Math.sin(a) * r;
      const slope = 1 - terrain.normalAt(cx, cz).y;
      if (slope > 0.36) continue;             // loose chips do not cling to walls
      const s = surfaceAt(cx, cz);
      const rel = reliefAt(terrain, cx, cz, 14);
      const supply = hasSurface
        ? s.scree * 1.15 + s.flow * 0.95 + s.rock * 0.5
        : Math.min(1, rel.up * 2.6);
      const p = (0.06 + supply * 0.9) * patch(cx, cz, 0.009);
      if (rng() > p) continue;
      // One accepted site is a *sheet* of chips, not a chip.
      const spread = 2.4 + rng() * 7.5;
      const n = 5 + ((rng() * 12) | 0);
      for (let k = 0; k < n && placed < 3400; k++) {
        const ang = rng() * Math.PI * 2;
        const rad = Math.pow(rng(), 0.55) * spread;
        place(pick(shapes.chips), cx + Math.cos(ang) * rad, cz + Math.sin(ang) * rad,
          0.09 + Math.pow(rng(), 2.0) * 0.30, {
            align: 1.0, sink: 0.62, tilt: 0.12, bands: BANDS.chips, foot: 0,
          });
        placed++;
      }
    }
  }

  // ------------------------------------------------------------- scree fans --
  // Talus aprons. The erosion solve already knows where material came to rest,
  // so the fan is seeded off `scree` and then *combed down the fall line*: a
  // real apron is elongated along the slope, coarsens toward its toe, and thins
  // out sideways. Round 1 scattered chips isotropically inside a qualifying
  // radius, which gives a round blob — the shape is the whole tell.
  {
    let placed = 0;
    for (let i = 0; i < 11000 && placed < 2900; i++) {
      const a = rng() * Math.PI * 2;
      const r = radius(46, 340, 1.25);
      const cx = Math.cos(a) * r;
      const cz = Math.sin(a) * r;
      const slope = 1 - terrain.normalAt(cx, cz).y;
      const rel = reliefAt(terrain, cx, cz, 26);
      if (slope > 0.42) continue;
      const s = surfaceAt(cx, cz);
      const talus = hasSurface ? s.scree : (rel.up > 0.42 ? 0.7 : 0.0);
      if (talus < 0.30) continue;
      if (rng() > talus * 0.85 * (0.35 + 0.65 * patch(cx, cz, 0.012))) continue;
      downhill(cx, cz, 6);
      const fx = grad.x;
      const fz = grad.y;
      const run = 6 + rng() * 26;
      const n = 8 + ((rng() * 18) | 0);
      for (let k = 0; k < n && placed < 2900; k++) {
        const t = Math.pow(rng(), 0.7);              // biased toward the toe
        const lat = (rng() - 0.5) * run * 0.42 * (0.25 + t);
        const x = cx + fx * run * t - fz * lat;
        const z = cz + fz * run * t + fx * lat;
        if (1 - terrain.normalAt(x, z).y > 0.5) continue;
        // Talus coarsens downslope: the big blocks carry their momentum to the toe.
        place(pick(shapes.chips), x, z, (0.11 + Math.pow(rng(), 1.6) * 0.42) * (0.7 + t * 0.85), {
          align: 1.0, sink: 0.58, tilt: 0.15, bands: BANDS.chips, foot: 0,
        });
        placed++;
      }
    }
  }

  // ------------------------------------------------------------------ stones --
  // Cobbles: the fraction that made it into the drainage. Strongly keyed to
  // `flow` so they line the wadi beds rather than dusting the whole basin.
  {
    let placed = 0;
    for (let i = 0; i < 12000 && placed < 2300; i++) {
      const a = rng() * Math.PI * 2;
      const r = radius(CLEAR.stone, 660, 1.5);
      const cx = Math.cos(a) * r;
      const cz = Math.sin(a) * r;
      const slope = 1 - terrain.normalAt(cx, cz).y;
      if (slope > 0.45) continue;
      const s = surfaceAt(cx, cz);
      const rel = reliefAt(terrain, cx, cz, 20);
      const supply = hasSurface
        ? s.flow * 1.25 + s.scree * 0.75 + s.rock * 0.35
        : Math.min(1, rel.up * 2.0);
      if (rng() > (0.04 + supply * 0.8) * patch(cx, cz, 0.0075)) continue;
      const spread = 3 + rng() * 12;
      const n = 2 + ((rng() * 6) | 0);
      for (let k = 0; k < n && placed < 2300; k++) {
        const ang = rng() * Math.PI * 2;
        const rad = Math.pow(rng(), 0.6) * spread;
        const x = cx + Math.cos(ang) * rad;
        const z = cz + Math.sin(ang) * rad;
        if (Math.hypot(x, z) < CLEAR.stone) continue;
        place(pick(shapes.stones), x, z, 0.32 + Math.pow(rng(), 1.6) * 1.15, {
          align: 0.7, sink: SKIRTS.stones.sink, tilt: 0.2, bands: BANDS.stones,
        });
        placed++;
      }
    }
  }

  // ------------------------------------------------------------ boulder trains --
  // A block that reached the basin floor got there down a gully. Seeding on high
  // drainage accumulation and then *walking the steepest descent*, dropping
  // blocks that fine downstream, produces the strung-out lines of boulders that
  // read instantly as "this came from up there" — and, just as importantly,
  // leaves the ground between the gullies empty.
  {
    let trains = 0;
    for (let i = 0; i < 14000 && trains < 150; i++) {
      const a = rng() * Math.PI * 2;
      const r = radius(CLEAR.boulder, 1250, 1.55);
      let x = Math.cos(a) * r;
      let z = Math.sin(a) * r;
      const s = surfaceAt(x, z);
      const g0 = downhill(x, z, 9);
      if (hasSurface) {
        if (s.flow < 0.35 && s.scree < 0.45) continue;
      } else if (g0 < 0.12) continue;
      if (rng() > 0.35 + 0.65 * patch(x, z, 0.006)) continue;

      let big = 1.5 + Math.pow(rng(), 1.25) * 4.0;
      const steps = 4 + ((rng() * 9) | 0);
      for (let k = 0; k < steps; k++) {
        const g = downhill(x, z, 9);
        if (g < 0.02) break;                        // pooled out on the flat
        const step = 7 + rng() * 17;
        x += grad.x * step + (rng() - 0.5) * step * 0.55;
        z += grad.y * step + (rng() - 0.5) * step * 0.55;
        if (Math.hypot(x, z) < CLEAR.boulder) break;
        if (1 - terrain.normalAt(x, z).y > 0.46) continue;   // it would still be rolling
        // A cluster of two or three at each stopping point, not a bead on a string.
        const m = 1 + ((rng() * 3) | 0);
        for (let j = 0; j < m; j++) {
          const ang = rng() * Math.PI * 2;
          const rad = big * (0.6 + rng() * 1.8);
          place(pick(shapes.boulders), x + Math.cos(ang) * rad, z + Math.sin(ang) * rad,
            big * (0.35 + rng() * 0.75), {
              align: 0.55, sink: SKIRTS.boulders.sink, tilt: 0.16, bands: BANDS.boulders,
            });
        }
        big *= 0.78 + rng() * 0.14;                 // trains fine downstream
      }
      trains++;
    }
  }

  // ------------------------------------------------------------ calved blocks --
  // Families of blocks sitting where they fell off a face. Sited on exposed
  // bedrock, with a strong size gradient away from the parent.
  {
    let clusters = 0;
    for (let i = 0; i < 14000 && clusters < 190; i++) {
      const a = rng() * Math.PI * 2;
      const r = radius(CLEAR.boulder, 1400, 1.7);
      const cx = Math.cos(a) * r;
      const cz = Math.sin(a) * r;
      const rel = reliefAt(terrain, cx, cz, 34);
      const s = surfaceAt(cx, cz);
      const exposed = hasSurface ? s.rock * 1.1 + s.scree * 0.5 : (rel.up > 0.24 ? 0.8 : 0.2);
      if (rng() > exposed * (0.3 + 0.7 * patch(cx, cz, 0.005))) continue;
      // Blocks fall and then run out downhill, so the family is offset, not centred.
      downhill(cx, cz, 12);
      const spread = 4 + rng() * 18;
      const count = 4 + ((rng() * 8) | 0);
      const big = 1.7 + Math.pow(rng(), 1.3) * 4.4;
      for (let k = 0; k < count; k++) {
        const t = k / count;
        const ang = rng() * Math.PI * 2;
        const rad = Math.pow(rng(), 0.6) * spread;
        const x = cx + Math.cos(ang) * rad + grad.x * spread * t * 0.9;
        const z = cz + Math.sin(ang) * rad + grad.y * spread * t * 0.9;
        if (Math.hypot(x, z) < CLEAR.boulder) continue;
        if (1 - terrain.normalAt(x, z).y > 0.44) continue;   // it would have rolled
        place(pick(shapes.boulders), x, z, big * (1 - t * 0.6) * (0.7 + rng() * 0.6), {
          align: 0.5,
          sink: SKIRTS.boulders.sink,
          tilt: 0.18,
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
      const s = surfaceAt(cx, cz);
      // A resistant bed only crops out where the erosion solve has actually
      // stripped the cover off. Everywhere else it is still under the alluvium.
      if (hasSurface) {
        if (rng() > (0.10 + s.rock * 1.05) * (0.35 + 0.65 * patch(cx, cz, 0.004))) continue;
      } else if (rel.up + rel.down < 0.5 && slope < 0.18 && rng() > 0.45) continue;
      // A monolith standing by itself on a flat pan is the "monument on a lawn"
      // read the outcrops already guard against, and at 20 m it is the single
      // thing in frame most likely to be mistaken for placeholder geometry. A
      // resistant bed crops out where the ground has relief to strip it.
      if (slope < 0.085 && rel.up + rel.down < 0.9 && rng() > 0.18) continue;

      const dir = rng() * Math.PI * 2;
      const dx = Math.cos(dir);
      const dz = Math.sin(dir);
      const step = 14 + rng() * 40;
      const n = 2 + ((rng() * 4) | 0);
      // Detail per metre is FIXED — a body is scaled uniformly, so a 30 m stack
      // has the same cleave and ledge count as a 4 m one and six times less
      // silhouette per metre. Past ~20 m the family stops reading as rock and
      // starts reading as an untextured prop, which is exactly what the critics
      // found in three frames. Cap the lead block; the line of decreasing sizes
      // behind it still carries the lineament.
      const lead = 6.5 + Math.pow(rng(), 1.3) * 11.5;
      for (let k = 0; k < n; k++) {
        const t = k / Math.max(1, n - 1);
        const jitter = (rng() - 0.5) * step * 0.7;
        const x = cx + dx * step * k - dz * jitter;
        const z = cz + dz * step * k + dx * jitter;
        if (Math.hypot(x, z) < CLEAR.formation) continue;
        if (1 - terrain.normalAt(x, z).y > 0.66) continue;
        const size = lead * (1 - t * 0.55) * (0.7 + rng() * 0.6);
        place(pick(shapes.formations), x, z, size, {
          align: 0.3,
          sink: SKIRTS.formations.sink,
          tilt: 0.12,
          bands: BANDS.formations,
          foot: 0.42,
          shadowBand: 1,
        });
        // Collapse apron: blocks shed off the face, biggest nearest the base and
        // preferentially strewn downhill rather than ringing the tower evenly.
        downhill(x, z, size * 0.5 + 4);
        const m = 5 + ((rng() * 7) | 0);
        for (let j = 0; j < m; j++) {
          const ang = rng() * Math.PI * 2;
          const u = Math.pow(rng(), 0.7);
          const rad = size * (0.45 + u * 1.5);
          const bx = x + Math.cos(ang) * rad + grad.x * rad * 0.7;
          const bz = z + Math.sin(ang) * rad + grad.y * rad * 0.7;
          if (1 - terrain.normalAt(bx, bz).y > 0.5) continue;
          place(pick(shapes.boulders), bx, bz, size * (0.2 - u * 0.13) * (0.6 + rng() * 0.8), {
            align: 0.55, sink: SKIRTS.boulders.sink, tilt: 0.2, bands: BANDS.boulders,
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
      // Bedrock breaks out THROUGH a slope. On near-flat ground the same body
      // is a monument standing on a lawn, which is exactly how it reads.
      if (slope < 0.19) continue;
      const s = surfaceAt(x, z);
      // Bedrock crops out of bedrock. Where the solve says the slope is buried
      // under its own talus, an outcrop is a prop standing in a scree pile.
      if (hasSurface && rng() > 0.12 + s.rock * 1.2 - s.scree * 0.35) continue;
      // See the formations note: uniform scale means a 39 m stack is a 9 m one
      // with the detail stretched six-fold, and it reads as a grey block.
      const size = 7 + Math.pow(rng(), 1.25) * 14;
      place(pick(shapes.outcrops), x, z, size, {
        align: 0.68,
        sink: SKIRTS.outcrops.sink,
        tilt: 0.04,
        bands: BANDS.outcrops,
        foot: 0.44,
      });
      // Rubble apron shed off the face, fanning downhill and fining outward.
      downhill(x, z, size * 0.5 + 4);
      const n = 5 + ((rng() * 8) | 0);
      for (let k = 0; k < n; k++) {
        const ang = rng() * Math.PI * 2;
        const u = Math.pow(rng(), 0.65);
        const rad = size * (0.5 + u * 1.1);
        place(
          pick(shapes.boulders),
          x + Math.cos(ang) * rad + grad.x * rad * 0.85,
          z + Math.sin(ang) * rad + grad.y * rad * 0.85,
          size * (0.15 - u * 0.1) * (0.6 + rng() * 0.8),
          { align: 0.55, sink: SKIRTS.boulders.sink, tilt: 0.22, bands: BANDS.boulders },
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
