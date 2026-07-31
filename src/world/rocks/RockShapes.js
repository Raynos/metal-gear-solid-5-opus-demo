import * as THREE from 'three';
import { makeRng } from './Noise.js';
import {
  buildRockGeometry, mergeRockGeometries, finaliseGeometry, attachSkirt,
} from './RockGeometry.js';

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

/**
 * Apply one shared normalisation to every LOD of a variant, then bank a collar
 * of fines against the base of the near LODs.
 *
 * `skirt.sink` must agree with the burial fraction Scatter actually uses for the
 * family, because the collar's rim is authored to sit *below* that ground line
 * so the terrain clips it. Get it wrong and a disc edge floats in the air.
 */
function normaliseVariant(geos, seed, skirt) {
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
  const bodySize = geos[0].boundingBox.getSize(new THREE.Vector3());
  let lods = geos;
  if (skirt) {
    const rng = makeRng(seed ^ 0x9e37);
    // LOD2 is a >500 m silhouette; a 3 cm sand collar on it is not a pixel.
    lods = geos.map((g, i) => (i < 2 ? attachSkirt(g, { ...skirt, bins: i === 0 ? 14 : 10, rng }) : g));
  }
  return {
    lods,
    size: bodySize,
    /** 0 = equant block, 1 = a slab. Drives how hard Scatter lies it down. */
    flat: Math.max(0, 1 - bodySize.y / Math.max(1e-4, Math.max(bodySize.x, bodySize.z))),
    hasSkirt: !!skirt,
  };
}

function variant(seed, lods, make, skirt) {
  return normaliseVariant(lods.map((lod) => make(makeRng(seed), lod, seed)), seed, skirt);
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
      weather: 0.3,
      // Chips are shale flakes; the aspect floor that stops a boulder becoming a
      // sheet of card would turn a flake into a pebble.
      aspectFloor: 0.24,
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
/**
 * No body is allowed a second-smallest axis below ~0.55 of its longest.
 *
 * Round 1 floored the *depth* of the skyline formations and left the mid sizes
 * alone, and the mid sizes are what the critic actually saw: a 1.5 m stone at
 * aniso [1, 0.34, 0.78] is a paving slab, and a paving slab tipped off the
 * horizontal by the slope-alignment term is a sheet of card standing in sand.
 * Slabbiness is a property of *chips* — anything you could not pick up should
 * be a block. `ledges` restores the flat-and-layered read that thin aniso used
 * to fake, but as courses in the silhouette rather than by squashing the body.
 */
const BOULDERS = [
  { aniso: [1.0, 0.86, 0.92], planeCount: 12, cleaves: 2, joints: 3, tightness: 0.13, chamfer: 0.035, lump: 0.1, ledges: 5, ledgeDepth: 0.035 },
  { aniso: [1.0, 0.62, 0.88], planeCount: 14, cleaves: 3, joints: 2, tightness: 0.2, chamfer: 0.03, lump: 0.13, ledges: 7, ledgeDepth: 0.045 },
  { aniso: [1.0, 1.4, 0.78], planeCount: 14, cleaves: 4, joints: 4, tightness: 0.11, chamfer: 0.028, lump: 0.11, ledges: 4, ledgeDepth: 0.03 },
  { aniso: [1.0, 0.68, 0.66], planeCount: 12, cleaves: 1, joints: 0, tightness: 0.34, chamfer: 0.075, lump: 0.17, ledges: 0 },
  { aniso: [1.0, 0.74, 1.0], planeCount: 17, cleaves: 5, joints: 3, tightness: 0.09, chamfer: 0.026, lump: 0.09, ledges: 6, ledgeDepth: 0.04 },
  { aniso: [1.0, 1.05, 0.72], planeCount: 13, cleaves: 3, joints: 4, tightness: 0.24, chamfer: 0.04, lump: 0.14, ledges: 5, ledgeDepth: 0.05 },
];

const STONES = [
  { aniso: [1.0, 0.62, 0.9], planeCount: 10, cleaves: 2, joints: 2, tightness: 0.24, chamfer: 0.045, lump: 0.11, ledges: 0 },
  { aniso: [1.0, 0.55, 0.82], planeCount: 9, cleaves: 2, joints: 1, tightness: 0.3, chamfer: 0.04, lump: 0.09, ledges: 0 },
  { aniso: [1.0, 0.82, 0.76], planeCount: 10, cleaves: 3, joints: 3, tightness: 0.16, chamfer: 0.035, lump: 0.12, ledges: 0 },
  { aniso: [1.0, 0.7, 0.66], planeCount: 8, cleaves: 1, joints: 0, tightness: 0.36, chamfer: 0.08, lump: 0.16, ledges: 0 },
  { aniso: [1.0, 1.15, 0.72], planeCount: 11, cleaves: 3, joints: 3, tightness: 0.14, chamfer: 0.035, lump: 0.1, ledges: 0 },
];

/** Shattered monoliths that carry the skyline. Tall, sharp, deeply cleaved. */
// The third aniso component is the body's *depth*. Below ~0.7 a monolith 20 m
// tall reads edge-on as a sheet of card standing in the sand — a few deep
// cleaves through an already-thin block leave a blade, not a butte — so the
// family floors it. Height (the second component) is what carries the drama.
const FORMATIONS = [
  { aniso: [1.0, 2.1, 0.86], planeCount: 13, cleaves: 4, joints: 5, tightness: 0.1, chamfer: 0.018, lump: 0.11, bedding: 2, ledges: 9, ledgeDepth: 0.03 },
  { aniso: [1.0, 1.15, 0.95], planeCount: 15, cleaves: 5, joints: 6, tightness: 0.09, chamfer: 0.02, lump: 0.13, bedding: 2, ledges: 7, ledgeDepth: 0.035 },
  { aniso: [1.0, 1.6, 0.78], planeCount: 12, cleaves: 3, joints: 4, tightness: 0.14, chamfer: 0.022, lump: 0.12, bedding: 3, ledges: 11, ledgeDepth: 0.028 },
  { aniso: [1.0, 0.86, 1.0], planeCount: 16, cleaves: 6, joints: 6, tightness: 0.08, chamfer: 0.018, lump: 0.14, bedding: 2, ledges: 6, ledgeDepth: 0.04 },
  { aniso: [1.0, 2.6, 0.84], planeCount: 11, cleaves: 3, joints: 5, tightness: 0.12, chamfer: 0.016, lump: 0.1, bedding: 2, ledges: 13, ledgeDepth: 0.025 },
];

function bodyVariant(seed, lods, a, extra = {}, skirt) {
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
      ledges: a.ledges ?? 0,
      ledgeDepth: a.ledgeDepth ?? 0.04,
      grain: 0.045,
      grooves: 4,
      grooveDepth: 0.075,
      angle: 36,
      lod,
      seed,
      ...extra,
    }),
  skirt);
}

/**
 * Stratified outcrop: a stack of bedding slabs with drifting offsets and
 * varying overhang, so the silhouette steps in and out the way weathered
 * sedimentary rock does. Sunk deep into a slope this reads as bedrock
 * *emerging*, which is the whole point — a boulder sat on a hill reads as a
 * prop, an outcrop shouldering out of it reads as terrain.
 */
function outcropVariant(seed, lods, opts = {}, skirt) {
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
      const shelf = 1 - taper * t + (rng() - 0.5) * 0.18;
      const r = Math.max(0.22, shelf) * spread;
      // Course thickness scales with the course's own width, so a broad shelf
      // stays a shelf and never degenerates into a table top.
      //
      // This matrix scale is applied AFTER the course geometry's own aspect
      // floor, so it can undo it: at h/r = 0.44 on a body whose own Y aniso is
      // already 0.5, the finished course is a third as thick as it is wide and
      // the stack reads as a pile of paving slabs rather than as bedrock. The
      // floor here has to hold in the *stacked* frame.
      const h = r * (0.66 + rng() * 0.34);
      const g = buildRockGeometry(rng, {
        planeCount: 7,
        aniso: [1.0, 0.48 + rng() * 0.24, 0.84 + rng() * 0.3],
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
        // Individual courses in an outcrop are meant to be slabs; the stack is
        // what has to be blocky, and the overlap above guarantees that.
        aspectFloor: 0.46,
        lod,
        seed: s + i * 7,
      });
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(dx + leanX * y * 6, y, dz + leanZ * y * 6),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler((rng() - 0.5) * 0.12, rng() * Math.PI * 2, (rng() - 0.5) * 0.12),
        ),
        new THREE.Vector3(r, h, r * (0.86 + rng() * 0.34)),
      );
      entries.push({ geo: g, matrix: m });
      // Courses must OVERLAP. Stacking them edge to edge leaves daylight between
      // the slabs and the whole thing reads as a pile of plates; overlapping by
      // ~30% welds them into one face whose steps are the bedding ledges.
      y += h * (0.52 + rng() * 0.24);
      dx += (rng() - 0.5) * 0.10;
      dz += (rng() - 0.5) * 0.10;
    }
    return finaliseGeometry(mergeRockGeometries(entries));
  }, skirt);
}

/**
 * Fines-apron profiles, in fractions of the body's own height.
 *
 * `sink` MUST match the burial fraction Scatter uses for the family — the rim
 * is authored below that line so the ground clips it and no disc edge is ever
 * visible. Small bodies bank a proportionally larger drift than big ones: a
 * 40 cm stone half-vanishes into its own dust shadow, a 20 m butte does not.
 */
export const SKIRTS = {
  stones: { flare: 2.15, lip: 0.15, drop: 0.28, sink: 0.32 },
  boulders: { flare: 1.85, lip: 0.13, drop: 0.24, sink: 0.28 },
  formations: { flare: 1.44, lip: 0.06, drop: 0.15, sink: 0.26 },
  outcrops: { flare: 1.42, lip: 0.055, drop: 0.17, sink: 0.36 },
};

export function buildShapeLibrary() {
  // LOD sets differ per family: gravel never needs a hero mesh, and skyline
  // formations never need a subdivided one.
  // Chips are the one family allowed to be slabby — shale flakes genuinely are.
  // But paper-thin flakes half-sunk in sand read as litter rather than gravel,
  // so the thinnest are pulled up off the floor.
  const CHIPS = [
    { aniso: [1.0, 0.42, 0.82], planeCount: 7 },
    { aniso: [1.0, 0.52, 0.9], planeCount: 8 },
    { aniso: [1.0, 0.36, 0.7], planeCount: 6 },
    { aniso: [1.0, 0.62, 0.86], planeCount: 9 },
  ];
  const chips = CHIPS.map((a, i) => chipVariant(1000 + i, [1, 2], a));
  // `hero` on stones and boulders only: those are the bodies a player walks up
  // to. A formation is never nearer than tens of metres and an outcrop is
  // already six merged blocks, so both already have the vertices to hold an
  // irregular outline.
  // No `hero` on stones. A stone is 0.3-1.5 m and band 0 starts at 74 m, so the
  // subdivided mesh buys silhouette detail that is under a pixel wide; the
  // aspect floor, edge weathering and fines apron are what make it read.
  const stones = STONES.map((a, i) =>
    bodyVariant(2000 + i, [0, 1, 2], a, { grooves: 3, grooveDepth: 0.055 }, SKIRTS.stones));
  const boulders = BOULDERS.map((a, i) =>
    bodyVariant(3000 + i, [0, 1, 2], a, { hero: 1 }, SKIRTS.boulders));
  const formations = FORMATIONS.map((a, i) =>
    bodyVariant(4000 + i, [0, 1, 2], a,
      { grooves: 6, grooveDepth: 0.085, angle: 38, aspectFloor: 0.58 }, SKIRTS.formations));
  const outcrops = [
    outcropVariant(5000, [0, 1, 2], { layers: 7, taper: 0.5, lean: 0.1, spread: 0.85 }, SKIRTS.outcrops),
    outcropVariant(5001, [0, 1, 2], { layers: 9, taper: 0.62, lean: 0.16, spread: 0.7 }, SKIRTS.outcrops),
    outcropVariant(5002, [0, 1, 2], { layers: 6, taper: 0.3, lean: 0.06, spread: 1.1 }, SKIRTS.outcrops),
    outcropVariant(5003, [0, 1, 2], { layers: 8, taper: 0.72, lean: 0.22, spread: 0.6 }, SKIRTS.outcrops),
  ];
  return { chips, stones, boulders, formations, outcrops };
}
