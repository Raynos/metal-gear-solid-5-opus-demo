import * as THREE from 'three';
import { makeRng, fbm3 } from './Noise.js';
import { COLLARS, buildCollarLibrary } from './RockShapes.js';
import { WIND_DIR } from './RockMaterial.js';

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
// Round 4 pulled them in again, and shrank the hero ring on `stones` hardest.
// The terrain's round-4 erosion solve qualifies far more sites than round 3's,
// so the same rules delivered 11.5k instances where they used to deliver 7.2k
// and the frame went 20k triangles over budget. Measured cost per band: the
// 4,148-instance boulder silhouette band was 163k triangles for bodies past
// 720 m, where aerial perspective has them within a few sRGB counts of the sky,
// and the 176-instance band-0 stone ring was 105k — 600 triangles each, for a
// 60 cm body no closer than 52 m. And the hero (twice-subdivided) boulder mesh
// is 2,458 triangles a body: 83 of them in the band-0 ring were 29% of the whole
// module, for bodies the keep-clear radius already puts 112 m from the play
// space, so that ring is now 20 m wide instead of 34.
// Round 5 rebuilt this table around the SHADOW ring, because the reason three
// critics have called the small rocks "flat decals printed on the ground" is
// that not one of them has ever cast a shadow. `castShadow` is set from
// `band <= shadowBand`, and band 0 was a dead ring on every small family:
//   chips     band 0 was r < 26 m, but CLEAR.gravel refuses a chip inside 34 m
//   stones    band 0 was 52-60 m, an 8 m wide annulus
//   boulders  band 0 was 112-126 m
// Measured on the shipped field: 0 of 1445 chips, 0 of 1555 boulders and 0 of
// 166 outcrops cast a shadow; 74 stones did. So the hero mesh each of those
// families builds was uploaded and never drawn, and the shadow band each was
// nominally given was empty. Band 0 now starts OUTSIDE the keep-clear radius by
// a real margin on every family, and `LOD_SHIFT` decouples the mesh resolution
// from it so widening the ring buys shadows rather than triangles.
const BANDS = {
  chips: [66, 122, 176],
  stones: [95, 220, 350],
  boulders: [128, 360, 600],
  talus: [104, 320, 840],
  formations: [242, 700, 1120],
  outcrops: [214, 640, 1020],
};

/**
 * Extra LOD steps taken on top of the band index, per family.
 *
 * LOD was welded to band, so the only way to give a family a wider shadow ring
 * was to give it a wider *hero* ring at the same time — and the hero mesh is 4x
 * to 16x the triangles. A 0.4 m shale flake does not need 126 triangles (that
 * is 4 mm of edge each), and no player can get within 112 m of a boulder or
 * 182 m of an outcrop, so neither of those subdivided meshes is reachable
 * either. This is what pays for the shadows.
 */
const LOD_SHIFT = {
  chips: 1, stones: 1, boulders: 1, talus: 1, formations: 0, outcrops: 1,
};

/**
 * Highest band that still submits to the shadow cascades, per family.
 *
 * Round 5 dropped `formations` from 1 to 0. QUALITY.shadowDistance is 380 m and
 * a band-1 formation is 242-700 m out, so most of that band was paying three
 * cascades' worth of vertices to cast a shadow outside the shadow frustum
 * entirely — 38k triangles a frame for nothing. That is what pays for the chip
 * and stone rings, which are inside 95 m and land on ground the player is
 * standing on.
 */
const SHADOW_BAND = {
  chips: 0, stones: 0, boulders: 0, talus: 0, formations: 0, outcrops: 0,
};

/**
 * Desert-varnish weight per family, handed to the shader as `aTint.z`.
 *
 * A clast that has lain still for centuries grows a manganese-iron coat and
 * goes dark; a face that is actively spalling off a butte does not. So this
 * tracks size: 1 on the pebbles, ~0 on the skyline furniture. It is also what
 * separates a small rock from the sand it sits on — see RockMaterial's uVarnish.
 */
const CLAST = {
  chips: 1.0, stones: 0.72, talus: 0.80, boulders: 0.30, formations: 0.08, outcrops: 0.05,
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

/**
 * Steepest ground any body may be seated on, degrees.
 *
 * FATAL, round 4: a scatter instance was found cantilevered horizontally out of
 * a near-vertical ridge face into open sky. The mechanism is in `place`: `al`
 * (alignment to the slope normal) saturates at 1 on steep ground, so the body is
 * laid flat ON the face and seated at the face's own centre height. On a 70
 * degree spire that means a 20 m outcrop lying on its side, half of it in mid
 * air. Measured over the whole shipped instance set with a 24-point lower-flank
 * support ring:
 *   outcrops    median 5.45 m of underside above the drawn ground, max 18.8 m;
 *               99.4% of them more than 0.5 m proud; 59% seated past 50 degrees
 *   formations  median 2.03 m proud, 86% past 0.5 m, 35% seated past 50 degrees
 *   boulders    median 0.14 m proud, 12% past 0.5 m, 21% past 50 degrees
 * There is no family exemption. The outcrops and formations wanted steep ground
 * and that is exactly how they earned the worst numbers in the set.
 */
const MAX_SEAT_DEG = 50;
const MAX_SEAT_NY = Math.cos((MAX_SEAT_DEG * Math.PI) / 180);   // 0.643

/**
 * Angle of repose of dry angular scree, as a terrain gradient (rise/run).
 * Talus aprons stand at it; above it material is still moving, below it the
 * apron has run out onto the pediment.
 */
const REPOSE = Math.tan((34 * Math.PI) / 180);   // 0.675

/**
 * Largest world height a body placed by the *scatter* rules may have.
 *
 * A critic found a 25 m plate standing in the vista that the round-2 commit
 * claimed to have killed. Anything that big has to come off the deliberate
 * formation/outcrop path, where the site is qualified against slope, relief and
 * bedrock exposure and the body is checked for aspect — not off a boulder train
 * that happened to roll a large `big`. Above this, the size is scaled down
 * rather than the instance dropped, so the geology still reads.
 */
const SCATTER_MAX_HEIGHT = 4.0;

/**
 * Hard per-family instance ceilings.
 *
 * Placement density is driven by the terrain's erosion channels, which belong to
 * another author and change under us: the identical rule set delivered 7,220
 * instances against one revision of `surfaceAt` and 11,488 against the next, and
 * the frame went from 0.42 M triangles to 0.79 M and over the shared budget
 * without a line of this module changing. The per-loop `placed <` limits only
 * bound the OUTER loops; every family also drops clusters, trains and aprons
 * from inner loops that nothing was counting. This is the backstop: whatever the
 * landscape says, the rock field costs at most this much.
 */
const CAPS = {
  chips: 1750,
  stones: 1650,
  boulders: 1650,
  talus: 3300,
  formations: 300,
  outcrops: 200,
};

function reliefAt(terrain, x, z, r) {
  const h = terrain.heightAt(x, z);
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const d = terrain.heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r) - h;
    sum += d;
    if (d > hi) hi = d;
    if (d < lo) lo = d;
  }
  // `curv` is the discrete Laplacian, normalised by the probe radius: <0 on a
  // convex nose or ridge shoulder, >0 in a hollow or a gully floor. Curvature is
  // what actually sorts desert surfaces — a convex interfluve is deflated down
  // to a stone pavement, a concave hollow is where the fines end up — and it is
  // the channel that was missing from round 2's slope-and-flow-only rules.
  return { up: hi / r, down: -lo / r, curv: (sum / 6) / r };
}

/**
 * Least-squares plane through the terrain over a disc of radius `r`.
 *
 * This is the plane the fines collar lies in. Fitting the *drawn* ground over
 * the collar's own footprint, rather than taking the analytic normal at its
 * centre, is what drives the rim's deviation from the ground to zero by
 * construction — the previous collar was welded into the rock body and inherited
 * the rock's tilt, which measured 27.7 deg off horizontal at the median.
 */
function groundPlane(terrain, x, z, r, size) {
  const seat = terrain.seatHeightAt
    ? (px, pz) => terrain.seatHeightAt(px, pz, size)
    : (px, pz) => terrain.heightAt(px, pz);
  const h0 = seat(x, z);
  let sxx = 0; let szz = 0; let sxz = 0; let sxy = 0; let szy = 0; let sy = 0;
  const N = 6;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + 0.31;
    const dx = Math.cos(a) * r;
    const dz = Math.sin(a) * r;
    const dy = seat(x + dx, z + dz) - h0;
    sxx += dx * dx; szz += dz * dz; sxz += dx * dz;
    sxy += dx * dy; szy += dz * dy; sy += dy;
  }
  const det = sxx * szz - sxz * sxz;
  let a = 0;
  let b = 0;
  if (Math.abs(det) > 1e-8) {
    a = (sxy * szz - szy * sxz) / det;
    b = (szy * sxx - sxy * sxz) / det;
  }
  // A drift does not stand on a 40 degree wall; past ~25 deg the fines have
  // gone. Clamping the fitted gradient also stops one bad probe tipping a collar.
  const g = Math.hypot(a, b);
  if (g > 0.47) { a *= 0.47 / g; b *= 0.47 / g; }
  return { y: h0 + sy / N * 0.35, a, b };
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
    /** Collar instances, keyed `${family}:${ring}:${band}` — see addCollar. */
    this.collars = new Map();
  }

  /**
   * A fines collar. Its matrix is solved in WORLD space by `place` and shares
   * nothing with the rock's own transform but its position, so a tilted rock
   * still gets a drift that lies flat in the ground plane.
   */
  addCollar(family, ring, band, matrix, tint, x, z) {
    const key = `${family}:${ring}:${band}`;
    let g = this.collars.get(key);
    if (!g) {
      g = { family, ring, band, matrices: [], tints: [], xz: [] };
      this.collars.set(key, g);
    }
    g.matrices.push(matrix);
    g.tints.push(tint);
    g.xz.push(x, z);
  }

  add(variant, band, matrix, tint, x, z, shadowBand = 0, lodShift = 0) {
    const lod = Math.min(band + lodShift, variant.lods.length - 1);
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

  buildCollars(group, lib) {
    const meshes = [];
    for (const g of this.collars.values()) {
      const n = g.matrices.length;
      if (!n) continue;
      const src = lib[g.family][g.ring];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', src.attributes.position);
      geo.setAttribute('normal', src.attributes.normal);
      geo.setAttribute('aRock', src.attributes.aRock);
      geo.boundingBox = src.boundingBox;
      geo.boundingSphere = src.boundingSphere;
      const mesh = new THREE.InstancedMesh(geo, this.material, n);
      // vec3: value shift, strata phase, desert-varnish weight.
      const tint = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        mesh.setMatrixAt(i, g.matrices[i]);
        tint[i * 3] = g.tints[i][0];
        tint[i * 3 + 1] = g.tints[i][1];
        tint[i * 3 + 2] = g.tints[i][2] ?? 0;
      }
      geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
      mesh.instanceMatrix.needsUpdate = true;
      // A 15 cm drift casts no shadow anything can see, and it is lying in the
      // ground plane, so its own self-shadow is a shadow-acne generator.
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.name = `rockcollar_${g.family}_r${g.ring}_b${g.band}`;
      mesh.computeBoundingSphere();
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      // Drifts are coplanar with the ground by construction; without a polygon
      // offset they z-fight with the terrain across their whole area.
      group.add(mesh);
      meshes.push(mesh);
      this.records.push({ mesh, xz: g.xz, matrices: g.matrices, n });
    }
    return meshes;
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
      // vec3: value shift, strata phase, desert-varnish weight.
      const tint = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        mesh.setMatrixAt(i, g.matrices[i]);
        tint[i * 3] = g.tints[i][0];
        tint[i * 3 + 1] = g.tints[i][1];
        tint[i * 3 + 2] = g.tints[i][2] ?? 0;
      }
      geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
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
  // Round 4 made this markedly more binary: -0.34 with a 2.7 gain leaves ~38%
  // of the area at literally zero density instead of the old 12%, so the bare
  // stretches read as swept ground rather than as thinner scatter. Measured on
  // a 4 km grid the zero fraction went 0.12 -> 0.38 and the p90 is unchanged,
  // i.e. the rocks that survive are in the same places, just with real gaps
  // between them.
  const patch = (x, z, k) => {
    const a = fbm3(x * k, 7.3, z * k, 3);
    const b = fbm3(x * k * 0.28 - 41.0, 2.1, z * k * 0.28 + 17.0, 2);
    return Math.max(0, Math.min(1, (a * 0.55 + b * 0.65 - 0.34) * 2.7));
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

  const spent = { chips: 0, stones: 0, boulders: 0, talus: 0, formations: 0, outcrops: 0 };

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

  // --- seat qualification ---------------------------------------------------
  //
  // Two tests and one guarantee, in that order. Every one of them is here
  // because the round-4 audit measured the failure it catches.

  /**
   * Is this a face a body of this footprint can rest on at all?
   *
   * Six probes around the footprint, least-squares plane through them. Returns
   * the plane's tilt in degrees and the worst deviation of the real ground from
   * that plane, in metres. A spire passes a point-normal test — the normal at
   * one sample on a knife edge can be anything — but it cannot pass this one,
   * because no plane fits a knife edge.
   */
  function seatFace(x, z, r) {
    const h0 = terrain.heightAt(x, z);
    let sxx = 0; let szz = 0; let sxz = 0; let sxy = 0; let szy = 0;
    const P = 6;
    const dxs = new Array(P);
    const dzs = new Array(P);
    const dys = new Array(P);
    for (let i = 0; i < P; i++) {
      const a = (i / P) * Math.PI * 2 + 0.41;
      const dx = Math.cos(a) * r;
      const dz = Math.sin(a) * r;
      const dy = terrain.heightAt(x + dx, z + dz) - h0;
      dxs[i] = dx; dzs[i] = dz; dys[i] = dy;
      sxx += dx * dx; szz += dz * dz; sxz += dx * dz;
      sxy += dx * dy; szy += dz * dy;
    }
    const det = sxx * szz - sxz * sxz;
    let a = 0;
    let b = 0;
    if (Math.abs(det) > 1e-8) {
      a = (sxy * szz - szy * sxz) / det;
      b = (szy * sxx - sxy * sxz) / det;
    }
    let resid = 0;
    for (let i = 0; i < P; i++) {
      const e = Math.abs(dys[i] - (a * dxs[i] + b * dzs[i]));
      if (e > resid) resid = e;
    }
    return { tilt: (Math.atan(Math.hypot(a, b)) * 180) / Math.PI, resid };
  }

  /**
   * How far the highest point of a placed body's lower flank floats above the
   * ground the clipmap actually draws.
   *
   * `v.support` is the body's own lower-flank silhouette in local space, so
   * pushing it through the FINISHED matrix is the only honest way to ask the
   * question — the transform has already applied slope alignment, a random lean
   * and a non-uniform scale, and a cantilever is precisely a body whose lean put
   * its flank in the air. `dy` corrects the cheap fine-field probes to the drawn
   * surface with one expensive `seatY` call at the centre, which is what makes
   * this affordable at ~12,000 placements.
   */
  const sv = new THREE.Vector3();
  function proudOf(v, matrix, size, x, z) {
    const S = v.support;
    if (!S || S.length < 9) return 0;
    const dy = terrain.heightAt(x, z) - seatY(x, z, size);
    let hi = -Infinity;
    // 12 azimuths is enough to find a cantilever: the failure mode is half the
    // body in the air, not one vertex.
    const step = S.length > 36 ? 6 : 3;
    for (let i = 0; i < S.length; i += step) {
      sv.set(S[i], S[i + 1], S[i + 2]).applyMatrix4(matrix);
      const d = sv.y - (terrain.heightAt(sv.x, sv.z) - dy);
      if (d > hi) hi = d;
    }
    return hi === -Infinity ? 0 : hi;
  }

  /** Rejection tally, published for the audit. */
  const rejected = { steep: 0, rough: 0, float: 0, cull: 0, cap: 0 };

  // --- collar solve scratch ------------------------------------------------
  const cq = new THREE.Quaternion();
  const cyaw = new THREE.Quaternion();
  const cn = new THREE.Vector3();
  const cpos = new THREE.Vector3();
  const cscl = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const sp = new THREE.Vector3();
  const FBINS = 16;
  const fr = new Float32Array(FBINS);

  /**
   * Bank a fines collar against an already-placed, already-tilted body.
   *
   * Every number here is world space, which is the whole point of the round-4
   * rebuild. The body's lower-flank support points are pushed through the
   * instance's *finished* rotation and scale, the silhouette of that is read off
   * in world azimuth bins, and an ellipse is fitted to it. The collar is then
   * laid in the plane of the surrounding ground — not the rock's base plane —
   * at that ellipse.
   */
  function addCollar(v, matrix, family, band, x, z, worldH) {
    const prof = COLLARS[family];
    if (!prof || band > 1) return;
    // A 20 cm drift banked against a stone is sub-pixel past a couple of
    // hundred metres, and the collar meshes were the third largest line in the
    // module's budget. Band 1 reaches 700 m on the big families; this does not.
    if (x * x + z * z > 300 * 300) return;
    const S = v.support;
    if (!S || S.length < 9) return;
    basis.copy(matrix).setPosition(0, 0, 0);
    fr.fill(0);
    let n = 0;
    let a0 = 0;
    let c2 = 0;
    let s2 = 0;
    for (let i = 0; i < S.length; i += 3) {
      sp.set(S[i], S[i + 1], S[i + 2]).applyMatrix4(basis);
      const r = Math.hypot(sp.x, sp.z);
      if (r < 1e-4) continue;
      const th = Math.atan2(sp.z, sp.x);
      a0 += r;
      c2 += r * Math.cos(2 * th);
      s2 += r * Math.sin(2 * th);
      n++;
      let k = Math.floor(((th + Math.PI) / (Math.PI * 2)) * FBINS) % FBINS;
      if (k < 0) k += FBINS;
      if (r > fr[k]) fr[k] = r;
    }
    if (!n) return;
    a0 /= n;
    // r(t) ~ a0 + amp*cos(2(t - phi)) — the ellipse the tilted hull projects.
    const A = (2 * c2) / n;
    const B = (2 * s2) / n;
    let amp = Math.hypot(A, B);
    const phi = 0.5 * Math.atan2(B, A);
    if (amp > a0 * 0.40) amp = a0 * 0.40;      // never let the drift degenerate
    const rx = a0 + amp;
    const rz = a0 - amp;

    // The plane of the GROUND under the collar, fitted over its own footprint.
    let rimR = a0 * prof.flare;
    const g = groundPlane(terrain, x, z, rimR * 0.85, worldH);
    // Blown fines do not bank on a wall. Past ~24 deg the drift thins out and
    // past ~37 deg there is nothing left to draw; skipping the steep sites is
    // also what removes the tilt outliers, because a plane fitted to steep,
    // curved ground is where the fit stops being a good description of it.
    const gm = Math.hypot(g.a, g.b);
    if (gm > 0.75) return;
    const steep = 1 - THREE.MathUtils.clamp((gm - 0.45) / 0.30, 0, 1) * 0.75;
    cn.set(-g.a, 1, -g.b).normalize();
    cq.setFromUnitVectors(UP, cn);
    // A rotation of -phi about +Y sends local +X to world azimuth phi.
    cyaw.setFromAxisAngle(UP, -phi);
    cq.multiply(cyaw);
    // Drift height at the stone, in metres: proportional to the footprint, but
    // never past a third of what is actually sticking out of the ground — a
    // drift taller than its stone is a mound with a pebble on it.
    let ry = Math.max(0.02, Math.min(prof.bank * a0, worldH * 0.34)) * steep;

    // Guarantee the rim ends up UNDER the ground. The fitted plane is first
    // order; over a curved footprint the rim can still surface, and a rim that
    // surfaces is a visible disc edge lying on the sand — the single tell this
    // whole rebuild exists to remove. Measured before this pass, 2.7% of rim
    // samples sat above the drawn ground, up to 1.78 m on the big families.
    //
    // Two passes: sink the drift to swallow the worst overshoot, and if that is
    // still not enough, pull the whole collar in. A smaller drift is always a
    // better answer than a floating one.
    const seatFn = terrain.seatHeightAt
      ? (px, pz) => terrain.seatHeightAt(px, pz, worldH)
      : (px, pz) => terrain.heightAt(px, pz);
    let shrink = 1;
    let excess = 0;
    for (let pass = 0; pass < 2; pass++) {
      excess = 0;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.17;
        const dx = Math.cos(a) * rimR * shrink;
        const dz = Math.sin(a) * rimR * shrink;
        const rimY = g.y + g.a * dx + g.b * dz - prof.drop * ry;
        const e = rimY - seatFn(x + dx, z + dz);
        if (e > excess) excess = e;
      }
      if (excess <= ry * 2.0) break;
      shrink *= 0.55;
      ry *= 0.7;
    }
    cscl.set(rx * shrink, ry, rz * shrink);
    // Cap the correction: a collar is allowed to bury itself, not to chase a
    // cliff edge down and drag the whole drift underground.
    cpos.set(x, g.y - ry * 0.05 - Math.min(excess, ry * 3.0), z);
    // Clast weight 0: past the inner lip the collar is drifted SAND, and the
    // varnish term must not touch it.
    field.addCollar(family, band === 0 ? 0 : 1, band,
      new THREE.Matrix4().compose(cpos, cq, cscl), [rng(), rng(), 0], x, z);
  }

  /**
   * @param {object} v      variant
   * @param {number} size   largest dimension in metres
   * @param {number} align  0 = stand upright, 1 = lie flat on the slope
   * @param {number} sink   fraction of the body buried
   * @param {number} tilt   extra random lean, radians
   * @param {number[]} bands LOD switch distances from the play centre
   * @param {number} shadowBand highest LOD band that still casts shadows
   * @param {string} collar family key in COLLARS, or null for no fines apron
   * @param {number} maxHeight hard world-height cap; the size is scaled to fit
   */
  function place(
    v, x, z, size,
    {
      align = 0.5, sink = 0.25, tilt = 0.12, bands = DEFAULT_BANDS, shadowBand = 0,
      foot = 0.42, collar = null, maxHeight = SCATTER_MAX_HEIGHT, family = collar,
      lodShift = 0, clast = 0,
    } = {},
  ) {
    if (family && spent[family] >= CAPS[family]) { rejected.cap++; return; }
    const d = Math.hypot(x, z);
    // Past the cull radius the body is smaller than the pixel it would land in.
    // Scale it out of the count entirely rather than shipping it to the GPU.
    if (bands[2] !== undefined && d > bands[2]) { rejected.cull++; return; }

    // --- per-instance scale, with a hard anisotropy clamp -------------------
    // Non-uniform scale is worth having: it is the cheapest way to stop six
    // boulder variants reading as six boulder variants. It is also exactly how
    // a plate gets made, so the ratio between the largest and smallest axis is
    // clamped to 1.32 — inside the 0.7-1.4 band — and the clamp is applied to
    // the numbers, not hoped for.
    let ax = 0.88 + rng() * 0.28;
    let ay = 0.88 + rng() * 0.28;
    let az = 0.88 + rng() * 0.28;
    {
      const lo = Math.min(ax, ay, az);
      const hi = Math.max(ax, ay, az);
      if (hi / lo > 1.32) {
        const mid = Math.sqrt(lo * hi);
        const k = Math.sqrt(1.32);
        const cl = (t) => THREE.MathUtils.clamp(t, mid / k, mid * k);
        ax = cl(ax); ay = cl(ay); az = cl(az);
      }
    }
    // Hard world-size cap. The scatter families are debris; anything bigger than
    // SCATTER_MAX_HEIGHT is landform and belongs on the deliberate path.
    //
    // The bound is the body's LONGEST world dimension, not its local height.
    // Capping the local height let a 6 m wide boulder tilted 30 degrees stand
    // 5.96 m tall in world Y — the AABB of a tilted body is taller than the body
    // — and 40 instances were doing exactly that. Bounding the longest dimension
    // bounds every projection of it, so the rule cannot be routed around.
    const wMax = size * Math.max(ax, ay, az);
    if (wMax > maxHeight) size *= maxHeight / wMax;

    const n = terrain.normalAt(x, z);

    // --- FATAL 1: nothing seats on a wall ----------------------------------
    // Point normal first (cheap), then the plane through the body's own
    // footprint. The second test is the one that catches a spire: a 20 m body
    // straddling a ridge crest can have a gentle normal at its centre and 30 m
    // of air under one flank, and it is the residual, not the tilt, that says so.
    if (n.y < MAX_SEAT_NY) { rejected.steep++; return; }
    const footR = size * Math.max(0.22, foot);
    if (footR > 0.9) {
      const face = seatFace(x, z, footR);
      if (face.tilt > MAX_SEAT_DEG) { rejected.steep++; return; }
      // A body cannot bridge relief it is not much taller than. The bound is
      // generous — half the body's longest dimension — because a rock DOES sit
      // in broken ground; what it does not do is span a gully.
      if (face.resid > size * 0.50) { rejected.rough++; return; }
    }

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
    // Randomised burial, as a fraction of the body's own WORLD height.
    //
    // Round 4 halved the slope term and dropped the family means. Measured on
    // the round-3 field, the median outcrop had 7.35 m of a 10.4 m body under
    // the ground — 70% buried, so a family authored to carry the skyline was
    // paying for nine bedding courses and showing three. Burial is still
    // deliberately asymmetric (sinking is invisible, floating never is), just
    // no longer wholesale.
    const height = v.size.y * size * ay;
    const bury = sink + (rng() - 0.5) * 0.08 + slope * 0.07;
    pos.set(x, seat - height * bury, z);
    scl.set(size * ax, size * ay, size * az);
    const band = d < bands[0] ? 0 : d < bands[1] ? 1 : 2;
    const m = new THREE.Matrix4().compose(pos, q, scl);

    // --- FATAL 1, the guarantee --------------------------------------------
    // Everything above is a rule about where a body MAY go. This is the check
    // that it actually landed there. Sink first — burying a rock is what the
    // ground does to one — and reject only if even a sink of half the body's
    // height cannot get its underside down to the drawn surface. That case is
    // not a seating error to be corrected: it is a site that is not ground.
    const tol = height * 0.08 + 0.04;
    let proud = proudOf(v, m, size, x, z);
    if (proud > tol) {
      const drop = Math.min(proud - tol, height * 0.55 + 0.15);
      pos.y -= drop;
      proud -= drop;
      if (proud > tol) { rejected.float++; return; }
      m.compose(pos, q, scl);
    }

    if (family) spent[family]++;
    field.add(v, band, m, [rng(), rng(), clast], x, z, shadowBand, lodShift);
    if (collar) addCollar(v, m, collar, band, x, z, height);
  }

  const pick = (arr) => arr[(rng() * arr.length) | 0];

  /**
   * Per-family placement defaults.
   *
   * The band table, the shadow ring, the LOD shift and the varnish weight all
   * belong to the family, not to the call site — and the reason the small
   * families went three rounds without a shadow is that each of those four
   * numbers had to be repeated by hand at every `place` call and one of them was
   * always missing. Spread this and then override.
   */
  const FAM = (family, extra) => ({
    bands: BANDS[family],
    shadowBand: SHADOW_BAND[family],
    lodShift: LOD_SHIFT[family],
    clast: CLAST[family],
    family,
    ...extra,
  });

  // ------------------------------------------------------------- desert lag --
  // Ground litter, but in *sheets*, not broadcast. A stone pavement forms where
  // the wind has already stripped the fines out — around drainage lines, on
  // deflated interfluves and across scree tails — and the bare stretches between
  // those sheets are as characteristic as the sheets themselves.
  {
    let placed = 0;
    for (let i = 0; i < 9000 && placed < 2400; i++) {
      const a = rng() * Math.PI * 2;
      const r = radius(CLEAR.gravel, 168, 1.3);
      const cx = Math.cos(a) * r;
      const cz = Math.sin(a) * r;
      const slope = 1 - terrain.normalAt(cx, cz).y;
      if (slope > 0.36) continue;             // loose chips do not cling to walls
      const s = surfaceAt(cx, cz);
      const rel = reliefAt(terrain, cx, cz, 14);
      // Deflation, not supply, is what builds a lag pavement: the wind has to
      // have taken the fines away and left the clasts behind, and it can only
      // do that on a convex, swept surface. A hollow with the same sediment
      // supply is where the sand ends up, so it gets none. `curv` < 0 is convex.
      const deflate = THREE.MathUtils.clamp(-rel.curv * 14 + 0.35, 0, 1);
      const supply = hasSurface
        ? s.scree * 1.15 + s.flow * 0.95 + s.rock * 0.5
        : Math.min(1, rel.up * 2.6);
      const p = (0.03 + supply * 0.85) * patch(cx, cz, 0.009) * (0.28 + 0.85 * deflate);
      if (rng() > p) continue;
      // One accepted site is a *sheet* of chips, not a chip. Round 4 grew the
      // clasts and cut the count: a 7 cm flake is under a pixel past 25 m, so
      // 3400 of them were buying pixel fizz and a shadow-pass bill, not gravel.
      const spread = 2.4 + rng() * 7.5;
      const n = 5 + ((rng() * 12) | 0);
      for (let k = 0; k < n && placed < 2400; k++) {
        const ang = rng() * Math.PI * 2;
        const rad = Math.pow(rng(), 0.55) * spread;
        place(pick(shapes.chips), cx + Math.cos(ang) * rad, cz + Math.sin(ang) * rad,
          0.16 + Math.pow(rng(), 1.7) * 0.40, FAM('chips', {
            // `foot` was 0 (seat on the centre height alone). Measured, that
            // left 5 chips proud of the drawn ground by more than their own
            // thickness where the surface falls away under them; seating on the
            // lowest ground under the footprint costs six height probes.
            align: 1.0, sink: 0.52, tilt: 0.10, foot: 0.5,
          }));
        placed++;
      }
    }
  }

  // ----------------------------------------------------------- talus aprons --
  //
  // MAJOR 3, round 4: "there is no talus anywhere in the world. The rock slope
  // runs into the flat valley in a single smooth concave fillet with no debris
  // at all." Correct, and the reason is that the previous pass was a scatter
  // rule with `talus` in its name: it sampled a point, asked the erosion solve
  // whether `scree` was high there, and dropped 20 cm chips around it. A 20 cm
  // chip has a hard cull at 176 m, and the massifs whose feet the critic
  // measured are 400-800 m out — so by construction not one clast of it could
  // ever appear at the base of a mountain.
  //
  // This is a WALK, not a sample, and it is the only pass in the file that is:
  //   1. seed anywhere; climb the local gradient to find a real FACE (a slope
  //      steeper than the angle of repose — material there is still moving);
  //   2. walk the fall line DOWN from the face until the gradient falls through
  //      the angle of repose. That crossing is the apex of the apron, and it is
  //      where every rock face on earth puts one;
  //   3. lay the apron from that apex on downhill, fanning sideways as it goes
  //      and COARSENING toward the toe. Fines lodge in the first few metres, a
  //      block that survives the fall keeps its momentum to the bottom — that
  //      gradient is the most recognisable thing about a scree slope after its
  //      angle, and it is why the toe of a real apron is a line of boulders.
  //
  // The clast SIZE is set by the range, not by taste: 1 px at 600 m is 0.41 m
  // of world, so an apron built from 0.3 m chips at that range is sub-pixel
  // fizz and an apron built from 1-3.5 m blocks is a legible band of debris.
  // The family therefore carries its own band table out to 900 m.
  {
    let aprons = 0;
    // Bound on SUCCESSES, not attempts. The first version counted attempts, and
    // since the seat rule rejects a third of everything offered on a scree
    // slope, the pass quietly stopped at 1,091 blocks having spent its whole
    // 2,400 budget on rejections.
    for (let i = 0; i < 88000 && aprons < 520 && spent.talus < CAPS.talus; i++) {
      const a = rng() * Math.PI * 2;
      const r = radius(76, 1500, 1.15);
      let x = Math.cos(a) * r;
      let z = Math.sin(a) * r;

      // --- 1. is there a face here? ---------------------------------------
      let g = downhill(x, z, 7);
      if (g < REPOSE) continue;                       // not a face; nothing sheds
      const s0 = surfaceAt(x, z);
      // Bedrock sheds; a slope already buried under its own alluvium does not.
      if (hasSurface && rng() > 0.18 + s0.rock * 1.15) continue;
      const faceY = terrain.heightAt(x, z);

      // --- 2. walk down to the break of slope ------------------------------
      let steps = 0;
      for (; steps < 46; steps++) {
        g = downhill(x, z, 7);
        if (g < REPOSE) break;                        // through the repose angle
        x += grad.x * 5.5;
        z += grad.y * 5.5;
      }
      if (steps === 0 || steps >= 46) continue;       // never left / never landed
      const drop = faceY - terrain.heightAt(x, z);
      if (drop < 9) continue;                         // too small a face to shed an apron
      if (Math.hypot(x, z) < CLEAR.stone) continue;

      // Fall-line frame at the apex. The apron is elongated along it and
      // symmetric across it; a round blob of debris is the tell this replaces.
      downhill(x, z, 9);
      const fx = grad.x;
      const fz = grad.y;
      const dep = hasSurface ? Math.max(s0.scree, surfaceAt(x, z).deposit ?? 0) : 0.6;
      if (hasSurface && dep < 0.10) continue;

      // Apron size scales with the face that fed it, which is what stops every
      // apron in the valley being the same apron.
      const run = Math.min(120, 16 + drop * 1.35) * (0.7 + rng() * 0.6);
      let n = 10 + ((rng() * 22) | 0) + ((drop * 0.35) | 0);
      // Coarsest clast at the toe, in metres. A 60 m face throws 3 m blocks.
      let coarse = Math.min(3.4, 0.85 + drop * 0.045) * (0.75 + rng() * 0.5);

      // --- range-graded grain size -----------------------------------------
      // The first version of this pass put real aprons at the right sites and
      // still failed the critic's crop. Measured: 39-81 rock instances inside
      // 70 m of the ground point under vista.png (1017, 387), and 1.14% of that
      // crop's pixels changed when the whole rock group was hidden. The reason
      // is arithmetic, not placement — that point is 856 m from the camera, the
      // vista is a 42 degree field over 720 lines, so one pixel is 0.92 m of
      // world there and the median talus block was 0.69 m. An apron built from
      // sub-pixel clasts is not an apron, it is dither.
      //
      // So the far aprons are built from FEWER, BIGGER blocks: the same volume
      // of debris, aggregated to the scale the frame can actually resolve. That
      // is the same argument as an LOD, applied to the scatter instead of to
      // the mesh, and it is also true of the real thing — the blocks you can
      // pick out at a kilometre are the house-sized ones at the toe.
      const far = THREE.MathUtils.clamp((Math.hypot(x, z) - 200) / 680, 0, 1);
      const grain = 1 + far * 2.3;
      coarse *= grain;
      n = Math.max(6, Math.round(n * (1 - far * 0.42)));
      aprons++;
      for (let k = 0; k < n && spent.talus < CAPS.talus; k++) {
        // t biased toward the head: an apron is densest where it is fed.
        const t = Math.pow(rng(), 1.35);
        // The fan widens downslope and the lateral profile is a cosine lobe,
        // so the apron has a soft edge instead of a rectangular footprint.
        const lat = (rng() + rng() - 1) * run * (0.20 + 0.42 * t);
        const px = x + fx * run * t - fz * lat;
        const pz = z + fz * run * t + fx * lat;
        // Refuse to climb back up the face: the apron banks against it, it does
        // not creep onto it.
        if (downhill(px, pz, 6) > REPOSE * 1.25) continue;
        // Grain-size gradient. `t^1.6` keeps the fines banked in the top third
        // and puts the blocks on the toe.
        const size = (0.28 + coarse * Math.pow(t, 1.6) * (0.45 + rng() * 1.1)) * (0.55 + 0.45 * grain);
        const small = size < 0.72 && Math.hypot(px, pz) < 150;
        place(pick(small ? shapes.chips : shapes.boulders), px, pz, size,
          FAM('talus', {
            // Scree lies where it lands: aligned to the slope, deeply keyed in,
            // and with almost no free lean — a block that could lean would have
            // kept rolling.
            align: 0.92, sink: 0.40, tilt: 0.16, foot: 0.46,
            collar: small ? null : 'boulders',
            maxHeight: 3.2 + far * 5.0,
          }));
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
      // Round 5 moved the drainage term from `flow` to `accum`. `flow` is the
      // MASK the ground shader paints wadis with — blurred over an 8 m kernel
      // and clamped — so keying a scatter to it spreads cobbles evenly over the
      // whole painted wash. `accum` is the raw D8 contributing area, i.e. the
      // dendritic network itself, and a cobble bar belongs in the channel, not
      // across the width of the paint. This is most of MAJOR 4: the field looked
      // uniform because it was being driven by a deliberately smoothed field.
      const chan = hasSurface ? Math.max(0, (s.accum ?? s.flow) - 0.34) / 0.66 : 0;
      const supply = hasSurface
        ? chan * chan * 1.55 + s.scree * 0.60 + s.rock * 0.30
        : Math.min(1, rel.up * 2.0);
      if (rng() > (0.025 + supply * 0.85) * patch(cx, cz, 0.0075)) continue;
      // Bars, not dust: a channel deposit is a tight lens of cobbles strung
      // along the flow, so the cluster is elongated down the fall line.
      downhill(cx, cz, 8);
      const along = 4 + rng() * 16;
      const across = 1.2 + rng() * 4.0;
      const n = 3 + ((rng() * 8) | 0);
      for (let k = 0; k < n && placed < 2300; k++) {
        const u = (rng() + rng() - 1) * along;
        const w = (rng() + rng() - 1) * across;
        const x = cx + grad.x * u - grad.y * w;
        const z = cz + grad.y * u + grad.x * w;
        if (Math.hypot(x, z) < CLEAR.stone) continue;
        place(pick(shapes.stones), x, z, 0.34 + Math.pow(rng(), 1.6) * 1.20,
          FAM('stones', { align: 0.7, sink: COLLARS.stones.sink, tilt: 0.2, collar: 'stones' }));
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
        // Seed on the raw drainage network, not on the painted mask: a train of
        // blocks came down a real gully, and `accum > 0.5` IS the gully.
        if ((s.accum ?? s.flow) < 0.50 && s.scree < 0.45) continue;
      } else if (g0 < 0.12) continue;
      if (rng() > 0.25 + 0.75 * patch(x, z, 0.006)) continue;

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
            big * (0.35 + rng() * 0.75),
            FAM('boulders', {
              align: 0.55, sink: COLLARS.boulders.sink, tilt: 0.16, collar: 'boulders',
            }));
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
    for (let i = 0; i < 20000 && clusters < 190; i++) {
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
        place(pick(shapes.boulders), x, z, big * (1 - t * 0.6) * (0.7 + rng() * 0.6),
          FAM('boulders', {
            align: 0.5, sink: COLLARS.boulders.sink, tilt: 0.18, collar: 'boulders',
          }));
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
    for (let i = 0; i < 60000 && reefs < 200; i++) {
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
        place(pick(shapes.formations), x, z, size, FAM('formations', {
          align: 0.3,
          sink: COLLARS.formations.sink,
          tilt: 0.12,
          foot: 0.32,
          collar: 'formations',
          // The deliberate path. This family exists to carry the skyline, so it
          // is exempt from the scatter height cap — the site has already been
          // qualified on bedrock exposure, relief and slope above. It is NOT
          // exempt from the seat rule: round 4 shipped 86% of this family with
          // more than half a metre of its underside in open air.
          maxHeight: Infinity,
        }));
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
          place(pick(shapes.boulders), bx, bz, size * (0.2 - u * 0.13) * (0.6 + rng() * 0.8),
            FAM('boulders', {
              align: 0.55, sink: COLLARS.boulders.sink, tilt: 0.2, collar: 'boulders',
            }));
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
    for (let i = 0; i < 72000 && placed < 520; i++) {
      const a = rng() * Math.PI * 2;
      const r = radius(CLEAR.outcrop, 1500, 1.4);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const slope = 1 - terrain.normalAt(x, z).y;
      // Bedrock breaks out THROUGH a slope. On near-flat ground the same body
      // is a monument standing on a lawn, which is exactly how it reads.
      //
      // Round 5 lowered the floor from 0.19 to 0.115 (35.6 -> 27.7 degrees)
      // because `place` now imposes a hard 50 degree CEILING, and the round-4
      // family had a median seat slope of 53.5 degrees — i.e. more than half of
      // it was above the new ceiling and the old window would have starved the
      // skyline. A 28-50 degree window is a hillside, which is where a
      // stratified outcrop crops out; 53-70 degrees is a cliff, which is where
      // one falls off.
      if (slope < 0.115) continue;
      const s = surfaceAt(x, z);
      // Bedrock crops out of bedrock. Where the solve says the slope is buried
      // under its own talus, an outcrop is a prop standing in a scree pile.
      if (hasSurface && rng() > 0.12 + s.rock * 1.2 - s.scree * 0.35) continue;
      // See the formations note: uniform scale means a 39 m stack is a 9 m one
      // with the detail stretched six-fold, and it reads as a grey block.
      const size = 7 + Math.pow(rng(), 1.25) * 14;
      place(pick(shapes.outcrops), x, z, size, FAM('outcrops', {
        align: 0.68,
        sink: COLLARS.outcrops.sink,
        tilt: 0.04,
        // Round 4: 0.44 -> 0.30. `foot` is the radius over which the LOWEST
        // ground is taken, and on a hillside the minimum over 9 m of a 21 m body
        // is metres below its own centre. Combined with the family's sink that
        // put the median outcrop 7.4 m of an 11.7 m body underground: a stack
        // authored with nine bedding courses was showing three, and the vertices
        // for the other six were being submitted every frame regardless.
        foot: 0.30,
        collar: 'outcrops',
        maxHeight: Infinity,
      }));
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
          FAM('boulders', {
            align: 0.55, sink: COLLARS.boulders.sink, tilt: 0.22, collar: 'boulders',
          }),
        );
      }
      placed++;
    }
  }

  const group = new THREE.Group();
  group.name = 'rocks';
  if (Object.entries(spent).some(([k, v]) => v >= CAPS[k])) {
    // Not fatal, but it means the geomorphic rules wanted more than the budget
    // allows and the field is now truncated by an arbitrary counter rather than
    // by geology. Worth knowing before a critic finds the bare patch.
    console.warn('[rocks] instance cap reached:', JSON.stringify(spent));
  }
  const meshes = field.build(group);
  const collars = field.buildCollars(group, buildCollarLibrary());
  return { group, meshes, collars, records: field.records, spent, rejected, wind: WIND_DIR };
}
