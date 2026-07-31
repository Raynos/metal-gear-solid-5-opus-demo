import * as THREE from 'three';
import { makeRng } from './Noise.js';
import { buildRockGeometry, mergeRockGeometries, finaliseGeometry } from './RockGeometry.js';

/**
 * The shape library: a handful of hand-tuned rock *archetypes*, each generated
 * as several distinct variants and several LODs.
 *
 * Variety in a rock field comes from silhouette families, not from randomising
 * one generator harder. Afghanistan reads as: angular shattered blocks, flat
 * shale chips, wind-rounded boulders, and layered outcrops shouldering out of
 * the hillsides. Those are four different generators, not one.
 *
 * Every variant is normalised so its largest dimension is 1 and its origin sits
 * at the base of the bounding box, centred in XZ — so an instance's uniform
 * scale is literally "how big is this rock, in metres", and dropping it onto
 * terrain height plants it instead of floating it.
 */

/** Apply one shared normalisation to every LOD of a variant. */
function normaliseVariant(geos) {
  geos[0].computeBoundingBox();
  const b = geos[0].boundingBox;
  const size = b.getSize(new THREE.Vector3());
  const k = 1 / Math.max(1e-4, Math.max(size.x, size.y, size.z));
  const cx = (b.min.x + b.max.x) * 0.5;
  const cz = (b.min.z + b.max.z) * 0.5;
  const oy = b.min.y;
  for (const g of geos) {
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) {
      p[i] = (p[i] - cx) * k;
      p[i + 1] = (p[i + 1] - oy) * k;
      p[i + 2] = (p[i + 2] - cz) * k;
    }
    g.attributes.position.needsUpdate = true;
    g.computeBoundingBox();
    g.computeBoundingSphere();
  }
  return {
    lods: geos,
    size: geos[0].boundingBox.getSize(new THREE.Vector3()),
  };
}

function variant(seed, lods, make) {
  return normaliseVariant(lods.map((lod) => make(makeRng(seed), lod, seed)));
}

/** Flat angular shale/scree chips — the ground litter layer. */
function chipVariant(seed, lods, a) {
  return variant(seed, lods, (rng, lod) =>
    buildRockGeometry(rng, {
      planeCount: a.planeCount,
      aniso: a.aniso,
      cleaves: 1,
      bedding: 2,
      tightness: 0.3,
      chamfer: 0.04,
      lump: 0.06,
      grain: 0.02,
      grooves: 0,
      angle: 30,
      lod,
      seed,
    }),
  );
}

/**
 * Archetypes, not randomisation. Rolling every parameter per variant converges
 * on the same average lump; picking distinct silhouettes — blocky, slabby,
 * upright wedge, worn dome, shattered — is what makes a field of them read as
 * varied at a glance.
 */
const BOULDERS = [
  { aniso: [1.0, 0.86, 0.92], planeCount: 12, cleaves: 2, joints: 3, tightness: 0.13, chamfer: 0.035, lump: 0.1 },
  { aniso: [1.0, 0.42, 0.88], planeCount: 14, cleaves: 3, joints: 2, tightness: 0.2, chamfer: 0.03, lump: 0.13 },
  { aniso: [1.0, 1.4, 0.72], planeCount: 14, cleaves: 4, joints: 4, tightness: 0.11, chamfer: 0.028, lump: 0.11 },
  { aniso: [1.0, 0.68, 0.6], planeCount: 12, cleaves: 1, joints: 0, tightness: 0.34, chamfer: 0.075, lump: 0.17 },
  { aniso: [1.0, 0.74, 1.0], planeCount: 17, cleaves: 5, joints: 3, tightness: 0.09, chamfer: 0.026, lump: 0.09 },
  { aniso: [1.0, 1.05, 0.58], planeCount: 13, cleaves: 3, joints: 4, tightness: 0.24, chamfer: 0.04, lump: 0.14 },
];

const STONES = [
  { aniso: [1.0, 0.55, 0.9], planeCount: 10, cleaves: 2, joints: 2, tightness: 0.24, chamfer: 0.045, lump: 0.11 },
  { aniso: [1.0, 0.34, 0.78], planeCount: 9, cleaves: 2, joints: 1, tightness: 0.3, chamfer: 0.04, lump: 0.09 },
  { aniso: [1.0, 0.82, 0.72], planeCount: 10, cleaves: 3, joints: 3, tightness: 0.16, chamfer: 0.035, lump: 0.12 },
  { aniso: [1.0, 0.62, 0.55], planeCount: 8, cleaves: 1, joints: 0, tightness: 0.36, chamfer: 0.08, lump: 0.16 },
  { aniso: [1.0, 1.15, 0.66], planeCount: 11, cleaves: 3, joints: 3, tightness: 0.14, chamfer: 0.035, lump: 0.1 },
];

/** Shattered monoliths that carry the skyline. Tall, sharp, deeply cleaved. */
// The third aniso component is the body's *depth*. Below ~0.7 a monolith 20 m
// tall reads edge-on as a sheet of card standing in the sand — a few deep
// cleaves through an already-thin block leave a blade, not a butte — so the
// family floors it. Height (the second component) is what carries the drama.
const FORMATIONS = [
  { aniso: [1.0, 2.1, 0.86], planeCount: 13, cleaves: 4, joints: 5, tightness: 0.1, chamfer: 0.018, lump: 0.11, bedding: 2 },
  { aniso: [1.0, 1.15, 0.95], planeCount: 15, cleaves: 5, joints: 6, tightness: 0.09, chamfer: 0.02, lump: 0.13, bedding: 2 },
  { aniso: [1.0, 1.6, 0.74], planeCount: 12, cleaves: 3, joints: 4, tightness: 0.14, chamfer: 0.022, lump: 0.12, bedding: 3 },
  { aniso: [1.0, 0.78, 1.0], planeCount: 16, cleaves: 6, joints: 6, tightness: 0.08, chamfer: 0.018, lump: 0.14, bedding: 2 },
  { aniso: [1.0, 2.6, 0.80], planeCount: 11, cleaves: 3, joints: 5, tightness: 0.12, chamfer: 0.016, lump: 0.1, bedding: 2 },
];

function bodyVariant(seed, lods, a, extra = {}) {
  return variant(seed, lods, (rng, lod) =>
    buildRockGeometry(rng, {
      planeCount: a.planeCount,
      aniso: a.aniso,
      cleaves: a.cleaves,
      joints: a.joints ?? 0,
      bedding: a.bedding ?? 1,
      tightness: a.tightness,
      chamfer: a.chamfer,
      lump: a.lump,
      grain: 0.045,
      grooves: 4,
      grooveDepth: 0.075,
      angle: 36,
      lod,
      seed,
      ...extra,
    }),
  );
}

/**
 * Stratified outcrop: a stack of bedding slabs with drifting offsets and
 * varying overhang, so the silhouette steps in and out the way weathered
 * sedimentary rock does. Sunk deep into a slope this reads as bedrock
 * *emerging*, which is the whole point — a boulder sat on a hill reads as a
 * prop, an outcrop shouldering out of it reads as terrain.
 */
function outcropVariant(seed, lods, opts = {}) {
  const { layers: nLayers = 6, taper = 0.45, lean = 0.12, spread = 1.0 } = opts;
  return variant(seed, lods, (rng, lod, s) => {
    const entries = [];
    let y = 0;
    let dx = 0;
    let dz = 0;
    const leanX = (rng() - 0.5) * lean;
    const leanZ = (rng() - 0.5) * lean;
    for (let i = 0; i < nLayers; i++) {
      const t = i / (nLayers - 1);
      // non-monotonic taper => ledges and overhangs rather than a smooth cone
      const shelf = 1 - taper * t + (rng() - 0.5) * 0.3;
      const r = Math.max(0.22, shelf) * spread;
      // Course thickness scales with the course's own width, so a broad shelf
      // stays a shelf and never degenerates into a table top.
      const h = r * (0.44 + rng() * 0.3);
      const g = buildRockGeometry(rng, {
        planeCount: 7,
        aniso: [1.0, 0.4 + rng() * 0.22, 0.72 + rng() * 0.4],
        cleaves: 1,
        joints: 3,
        bedding: 2,
        tightness: 0.24,
        chamfer: 0.03,
        lump: 0.07,
        grain: 0.03,
        grooves: 2,
        grooveDepth: 0.05,
        angle: 32,
        lod,
        seed: s + i * 7,
      });
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(dx + leanX * y * 6, y, dz + leanZ * y * 6),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler((rng() - 0.5) * 0.12, rng() * Math.PI * 2, (rng() - 0.5) * 0.12),
        ),
        new THREE.Vector3(r, h, r * (0.8 + rng() * 0.45)),
      );
      entries.push({ geo: g, matrix: m });
      // Courses must OVERLAP. Stacking them edge to edge leaves daylight between
      // the slabs and the whole thing reads as a pile of plates; overlapping by
      // ~30% welds them into one face whose steps are the bedding ledges.
      y += h * (0.72 + rng() * 0.3);
      dx += (rng() - 0.5) * 0.16;
      dz += (rng() - 0.5) * 0.16;
    }
    return finaliseGeometry(mergeRockGeometries(entries));
  });
}

export function buildShapeLibrary() {
  // LOD sets differ per family: gravel never needs a hero mesh, and skyline
  // formations never need a subdivided one.
  const CHIPS = [
    { aniso: [1.0, 0.3, 0.82], planeCount: 7 },
    { aniso: [1.0, 0.42, 0.9], planeCount: 8 },
    { aniso: [1.0, 0.24, 0.7], planeCount: 6 },
    { aniso: [1.0, 0.5, 0.86], planeCount: 9 },
  ];
  const chips = CHIPS.map((a, i) => chipVariant(1000 + i, [1, 2], a));
  const stones = STONES.map((a, i) => bodyVariant(2000 + i, [0, 1, 2], a, { grooves: 2, grooveDepth: 0.05 }));
  const boulders = BOULDERS.map((a, i) => bodyVariant(3000 + i, [0, 1, 2], a));
  const formations = FORMATIONS.map((a, i) => bodyVariant(4000 + i, [0, 1, 2], a, { grooves: 6, grooveDepth: 0.085, angle: 38 }));
  const outcrops = [
    outcropVariant(5000, [0, 1, 2], { layers: 7, taper: 0.5, lean: 0.1, spread: 0.85 }),
    outcropVariant(5001, [0, 1, 2], { layers: 9, taper: 0.62, lean: 0.16, spread: 0.7 }),
    outcropVariant(5002, [0, 1, 2], { layers: 6, taper: 0.3, lean: 0.06, spread: 1.1 }),
    outcropVariant(5003, [0, 1, 2], { layers: 8, taper: 0.72, lean: 0.22, spread: 0.6 }),
  ];
  return { chips, stones, boulders, formations, outcrops };
}
