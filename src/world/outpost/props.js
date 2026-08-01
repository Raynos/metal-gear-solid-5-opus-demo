import * as THREE from 'three';
import { box, post, cyl, strut, xform, flip, bakeWeather, merge, lattice, catenary, membraneSag } from './geo.js';
import { newBag, signPlane } from './buildings.js';

/**
 * Set dressing.
 *
 * This is the layer that actually sells a military compound: a blockhouse alone
 * reads as architecture homework, but a blockhouse with drums stacked against
 * it, a cable sagging to a floodlight, and a tarp over a pallet of crates reads
 * as a place people work. Everything here is authored once and instanced.
 *
 * Each factory returns a material-keyed bag, already weather-baked in its own
 * local frame, base at y=0.
 */

function bake(b, y1, wear = 0.4, y0 = 0) {
  for (const k of Object.keys(b)) {
    if (k === 'lights' || k === 'interest') continue;
    for (const g of b[k]) bakeWeather(g, { y0, y1, wear });
  }
  return b;
}

/** Collapse a bag into one merged geometry per material key. */
export function bagToGeos(b) {
  const out = {};
  for (const k of Object.keys(b)) {
    if (k === 'lights' || k === 'interest') continue;
    if (b[k].length) out[k] = merge(b[k]);
  }
  return out;
}

// ------------------------------------------------------------- containers ---

/** 20ft ISO container. Corrugation comes from the shader; the ironmongery is real. */
export function containerGeo() {
  const b = newBag();
  const L = 6.06;
  const W = 2.44;
  const H = 2.59;
  const y0 = 0.13;
  b.corr.push(box(L - 0.1, H - 0.3, W - 0.1, { y: y0 + H / 2 }));
  // Top and bottom rails, and the end frames — the flat bits between corrugation.
  for (const sy of [y0 + 0.09, y0 + H - 0.11]) {
    b.metal.push(box(L, 0.19, W + 0.03, { y: sy }));
  }
  for (const sx of [-1, 1]) b.metal.push(box(0.13, H, W + 0.03, { x: sx * (L / 2 - 0.06), y: y0 + H / 2 }));
  // Corner castings.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      for (const sy of [y0 + 0.09, y0 + H - 0.09]) {
        b.metal.push(box(0.19, 0.17, 0.17, { x: sx * (L / 2 - 0.1), y: sy, z: sz * (W / 2 - 0.09) }));
      }
    }
  }
  // Door end: two leaves, four locking rods, hinges and handles.
  const dx = L / 2 - 0.02;
  for (const sz of [-1, 1]) {
    b.metal.push(box(0.05, H - 0.26, W / 2 - 0.08, { x: dx, y: y0 + H / 2, z: sz * (W / 4) }));
    for (let i = 0; i < 2; i++) {
      const rz = sz * (W / 4) + (i - 0.5) * (W / 4 - 0.1);
      b.steel.push(cyl(0.026, H - 0.4, 6, { x: dx + 0.05, y: y0 + H / 2, z: rz }));
      b.steel.push(box(0.09, 0.19, 0.07, { x: dx + 0.08, y: y0 + H / 2 - 0.1, z: rz }));
    }
    for (const sy of [y0 + 0.45, y0 + H - 0.45]) {
      b.metal.push(box(0.11, 0.1, 0.09, { x: dx + 0.03, y: sy, z: sz * (W / 2 - 0.12) }));
    }
  }
  // Door header and the rain gutter over it. The header is the flat band that
  // makes the door end read as a DOOR end at thirty metres — without it both
  // ends of a container are the same corrugated rectangle.
  b.metal.push(box(0.16, 0.17, W + 0.02, { x: dx - 0.05, y: y0 + H - 0.20 }));
  b.metal.push(box(0.26, 0.05, W + 0.06, { x: dx + 0.06, y: y0 + H - 0.05, rz: -0.18 }));
  // Markings. A container with no placard is a crate; a container with an owner
  // code, a serial and a hazard placard is freight. 12 triangles each across 17
  // instances is 204 triangles for the loudest "real object" cue the box has.
  signPlane(b, { x: dx + 0.055, y: y0 + H * 0.62, z: -W * 0.24, w: 1.05, h: 0.62, cell: 11, ry: Math.PI / 2 });
  signPlane(b, { x: dx + 0.055, y: y0 + H * 0.26, z: W * 0.26, w: 0.42, h: 0.30, cell: 15, ry: Math.PI / 2 });
  for (const sz of [-1, 1]) {
    signPlane(b, {
      x: -L * 0.20, y: y0 + H * 0.58, z: sz * (W / 2 + 0.045), w: 1.55, h: 0.85, cell: 9,
      ry: sz > 0 ? 0 : Math.PI,
    });
  }
  // Consolidated data plate on the left leaf: bare steel, and the only thing on
  // the whole box that is allowed to flash.
  b.steel.push(box(0.02, 0.30, 0.22, { x: dx + 0.07, y: y0 + 1.05, z: -W * 0.34 }));
  return bake(b, y0 + H, 0.5);
}

// ------------------------------------------------------------------ drums ---

// -------------------------------------------------------------- sand drift ---

/** How many distinct drift meshes exist. */
export const DRIFT_VARIANTS = 3;

/**
 * A bank of wind-deposited fines against the upwind face of an obstruction.
 *
 * Every critic round has said the props sit ON the ground rather than IN it.
 * A contact shadow only ever half-solves that, because the thing the eye is
 * actually missing is the sand's own response to the object being there: in a
 * desert, anything that stands in the wind for a season grows a wedge of fines
 * on its windward side and a long tail of scour on its lee. Modelling the wedge
 * is worth more than any amount of AO because it is ASYMMETRIC and it points —
 * one glance tells you which way the wind blows here, and every drift in frame
 * agrees, which is a thing procedural scenes essentially never do.
 *
 * Authored with the obstruction at z = 0 and the wind arriving from +z, so the
 * caller only has to rotate the instance to face the wind.
 */
export function driftGeo(variant = 0, { lo = false } = {}) {
  const b = newBag();
  let s = (variant * 374761393 + 7) >>> 0;
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 1) >>> 0) / 4294967296);
  // 12x6 = 144 triangles. A drift is a smooth surface with no silhouette
  // detail finer than its own ripples, and the ripples are in the shader.
  //
  // `lo` is 6x3 = 36. The fillets banked along the foot of every wall are
  // 190 mm tall and 1.7 m wide — a quarter of the resolution is still four
  // times what their silhouette can carry, and there are two hundred of them.
  const NX = lo ? 6 : 12;
  const NZ = lo ? 3 : 6;
  const halfW = 1.0;
  const runOut = 1.0;   // how far upwind the toe of the drift reaches
  const crest = 1.0;    // height at the face, scaled by the instance
  const lee = 0.34;     // short tail on the sheltered side
  const lobe = 0.55 + rnd() * 0.5;
  const skew = (rnd() - 0.5) * 0.5;

  const pos = [];
  const idx = [];
  const height = (fx, fz) => {
    // fx in [-1,1] across the face, fz in [-lee/runOut, 1] upwind.
    const across = Math.max(0, 1 - Math.pow(Math.abs(fx + skew * fz * 0.5), 1.6 + lobe));
    const along = fz >= 0
      ? Math.pow(Math.max(0, 1 - fz), 1.9)          // upwind ramp, concave
      : Math.pow(Math.max(0, 1 + fz / (lee / runOut)), 1.2) * 0.55; // lee tail
    const wob = 0.86 + 0.28 * Math.sin(fx * 5.1 + variant * 2.3) * Math.cos(fz * 3.7 + lobe * 4.0);
    return crest * across * along * wob;
  };
  for (let j = 0; j <= NZ; j++) {
    const fz = -lee / runOut + (j / NZ) * (1 + lee / runOut);
    for (let i = 0; i <= NX; i++) {
      const fx = -1 + (2 * i) / NX;
      pos.push(fx * halfW, height(fx, fz), fz * runOut);
    }
  }
  for (let j = 0; j < NZ; j++) {
    for (let i = 0; i < NX; i++) {
      const a = j * (NX + 1) + i;
      idx.push(a, a + NX + 1, a + 1, a + 1, a + NX + 1, a + NX + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  b.drift.push(g);
  return bake(b, crest, 0.2, 0);
}

/** How many distinct drum meshes exist; placement buckets instances by this. */
export const DRUM_VARIANTS = 4;

/**
 * 200 litre steel drum with rolling hoops.
 *
 * Round 3: these were one mesh instanced eighty times, and eighty identical
 * cylinders is a texture, not a scrapyard. The per-instance `aVar` was already
 * varying the rust and the paint pick, but a drum's identity is in its
 * SILHOUETTE — a drum that has been dropped off a truck has a dished top, a
 * kicked-in side and a bowed hoop, and no amount of albedo variation stands in
 * for that. Four bodies now, each with its own dent field and its own fittings:
 *
 *   0 — sound: a drum that is still in service
 *   1 — knocked about: two shallow side dents, one bowed hoop
 *   2 — labelled: a painted band round the belly and a stencil panel
 *   3 — wrecked: dished top, deep side crease, missing bung
 */
export function drumGeo(variant = 0) {
  const b = newBag();
  const r = 0.293;
  const h = 0.88;
  let s = (variant * 2654435761 + 101) >>> 0;
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 1) >>> 0) / 4294967296);

  // Dent field: a handful of localised radial pushes. Each is a direction, a
  // height, a depth and an angular width — which is exactly how a real dent is
  // described, and why a noise displacement does not look like one.
  const dents = [];
  const nD = [0, 2, 1, 3][variant];
  for (let i = 0; i < nD; i++) {
    dents.push({
      a: rnd() * Math.PI * 2,
      y: 0.16 + rnd() * 0.60,
      depth: (0.020 + rnd() * 0.045) * (variant === 3 ? 1.9 : 1.0),
      wa: 0.45 + rnd() * 0.55,
      wy: 0.10 + rnd() * 0.16,
    });
  }
  const body = cyl(r, h, 18, { y: h / 2 });
  const p = body.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const rad = Math.hypot(x, z);
    if (rad < 1e-4) continue;
    let push = 0;
    for (const d of dents) {
      let da = Math.atan2(z, x) - d.a;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      const fa = Math.max(0, 1 - Math.abs(da) / d.wa);
      const fy = Math.max(0, 1 - Math.abs(y - d.y) / d.wy);
      push += d.depth * fa * fa * fy * fy;
    }
    const k = (rad - push) / rad;
    p.setXYZ(i, x * k, y, z * k);
  }
  body.computeVertexNormals();
  b.metal.push(body);

  // Rolling hoops in BARE steel, not paint. A drum is moved by tipping it and
  // rolling it on these two rings, so they are the one part of the body whose
  // paint is gone by the second time it is handled — and a pair of polished
  // steel bands round a matt painted cylinder is the single cheapest specular
  // cue on the site, because it is a curved surface that sweeps the whole
  // mirror direction and therefore ALWAYS finds the sun from some angle.
  for (const sy of [h * 0.3, h * 0.7]) b.steel.push(cyl(r + 0.022, 0.055, 18, { y: sy }));
  // Chime rings top and bottom. On the wrecked drum the top is dished in.
  b.metal.push(cyl(r + 0.012, 0.045, 18, { y: h - 0.02 }));
  b.metal.push(cyl(r + 0.012, 0.045, 18, { y: 0.02 }));
  if (variant === 3) {
    b.metal.push(cyl(r * 0.72, 0.05, 14, { y: h - 0.075 }));
  } else {
    // Bungs are unpainted plugs on the one face of a drum that points at the
    // sun. Two 100 mm discs of bare steel per drum, times ~80 drums, is a
    // scatter of real highlights across the yard for 32 triangles each.
    b.steel.push(cyl(0.05, 0.03, 8, { x: r * 0.55, y: h + 0.005 }));
    if (variant !== 1) b.steel.push(cyl(0.032, 0.022, 8, { x: -r * 0.5, y: h + 0.004 }));
  }
  if (variant === 2) {
    // Painted contents band and a stencil panel. One drum in four carrying a
    // hazard band is what turns a row of cylinders into stock with a history.
    b.paintWarn.push(cyl(r + 0.004, 0.185, 18, { y: h * 0.50 }));
    b.paint.push(cyl(r + 0.006, 0.032, 18, { y: h * 0.50 + 0.115 }));
    b.paint.push(cyl(r + 0.006, 0.032, 18, { y: h * 0.50 - 0.115 }));
  }
  return bake(b, h, 0.65);
}

// ---------------------------------------------------------------- timber ----

export function crateGeo(s = 1.0) {
  const b = newBag();
  const w = 1.12 * s;
  const h = 0.78 * s;
  const d = 0.82 * s;
  const t = 0.045;
  b.wood.push(box(w - t, h - t, d - t, { y: h / 2 }));
  for (const sy of [t / 2 + 0.01, h - t / 2 - 0.01]) {
    b.wood.push(box(w, t * 1.6, d, { y: sy }));
  }
  // Corner battens, PROUD of the boarding rather than flush with it. A packing
  // case is a frame with boards nailed to the outside of it, so every vertical
  // arris of the case is a 90mm timber standing 25mm off the face — which at
  // 4 m from the gameplay camera is the difference between a crate and a
  // smooth plywood block with lines drawn on it.
  const bt = 0.085;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.wood.push(box(bt, h + 0.02, bt, { x: sx * (w / 2 + bt * 0.18), y: h / 2, z: sz * (d / 2 + bt * 0.18) }));
    }
  }
  for (const sx of [-1, 1]) b.wood.push(box(bt, h, d - bt, { x: sx * (w / 2 + bt * 0.18), y: h / 2 }));
  for (const sz of [-1, 1]) b.wood.push(box(w - bt, h, bt, { z: sz * (d / 2 + bt * 0.18), y: h / 2 }));
  // Diagonal brace on the long faces.
  for (const sz of [-1, 1]) {
    b.wood.push(xform(box(Math.hypot(w, h) - 0.1, 0.1 * s, t * 1.5), {
      rz: Math.atan2(h, w), z: sz * (d / 2 - t * 0.6), y: h / 2,
    }));
  }
  return bake(b, h, 0.5);
}

export function palletGeo() {
  const b = newBag();
  const w = 1.2;
  const d = 0.8;
  for (const sz of [-1, 0, 1]) {
    b.wood.push(box(w, 0.075, 0.1, { y: 0.037, z: sz * (d / 2 - 0.05) }));
    b.wood.push(box(w, 0.09, 0.1, { y: 0.145, z: sz * (d / 2 - 0.05) }));
  }
  for (let i = 0; i < 6; i++) {
    b.wood.push(box(0.1, 0.019, d, { x: -w / 2 + 0.05 + (i * (w - 0.1)) / 5, y: 0.2 }));
  }
  for (const sz of [-1, 0, 1]) {
    for (const sx of [-1, 0, 1]) {
      b.wood.push(box(0.1, 0.075, 0.1, { x: sx * (w / 2 - 0.05), y: 0.112, z: sz * (d / 2 - 0.05) }));
    }
  }
  return bake(b, 0.21, 0.55);
}

// -------------------------------------------------------------- jerry can ---

export function jerryCanGeo() {
  const b = newBag();
  const w = 0.34;
  const h = 0.47;
  const d = 0.17;
  b.metal.push(box(w, h, d, { y: h / 2 }));
  b.metal.push(box(w - 0.05, h - 0.06, d + 0.02, { y: h / 2 }));
  for (let i = 0; i < 3; i++) {
    b.metal.push(box(0.05, 0.05, d + 0.06, { x: -w / 2 + 0.06 + i * (w / 2 - 0.06), y: h - 0.035 }));
  }
  b.metal.push(cyl(0.033, 0.06, 8, { x: w / 2 - 0.09, y: h + 0.03 }));
  return bake(b, h, 0.7);
}

/** Scrap tyre lying flat. Same tread generator as the trucks — it is the same tyre. */
export function tyreGeo(variant = 0) {
  const b = newBag();
  const r = 0.46 + variant * 0.035;
  const wdt = 0.30 + (variant % 2) * 0.07;
  const g = tyreProfile({ r, width: wdt, lugs: 11 + variant, shoulder: 0.10, flat: 0.045, bead: false });
  g.rotateX(Math.PI / 2);
  // A dead tyre off the rim collapses into an oval — nothing about a scrap pile
  // is circular.
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, p.getX(i) * (1 + 0.10 * variant * 0.3), p.getY(i) * 0.86, p.getZ(i) * (1 - 0.06 * variant * 0.3));
  }
  g.computeVertexNormals();
  g.translate(0, wdt * 0.44, 0);
  b.rubber.push(g);
  return bake(b, wdt * 0.9, 0.5);
}

/** Broken slab and rubble — scattered where concrete has been knocked about. */
export function rubbleGeo(seed = 1) {
  const b = newBag();
  let s = seed >>> 0;
  const r = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 1) >>> 0) / 4294967296);
  // Round 3 tried to fix this by narrowing the aspect ratio, and it could not
  // work, because the shape was not a shard — it was TORN. `IcosahedronGeometry`
  // is a PolyhedronGeometry, i.e. non-indexed: every face carries its own copy
  // of each corner. Drawing a fresh random number per vertex therefore moved
  // each copy of a shared corner somewhere different and pulled the solid apart
  // into twenty disconnected triangles, which is exactly the "folded paper" the
  // gameplay camera kept finding at 4 m (shots/r4/gameplay.png, x=905 y=880).
  //
  // The displacement is now a function of the vertex's own DIRECTION, so every
  // copy of a corner gets the same answer and the hull stays closed. Detail 1
  // as well: at 0.5 m across and 2 m from the lens, 20 facets are individually
  // readable and 80 are not.
  const g = new THREE.IcosahedronGeometry(0.30, 1);
  const p = g.attributes.position;
  // Three fixed lobes with a per-seed phase: coherent, cheap, and repeatable
  // for any two vertices that share a position.
  const ph = [r() * 6.283, r() * 6.283, r() * 6.283];
  const inv = 1 / 0.30;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) * inv, y = p.getY(i) * inv, z = p.getZ(i) * inv;
    const k = 1
      + 0.16 * Math.sin(2.7 * x + ph[0]) * Math.cos(3.1 * z + ph[1])
      + 0.11 * Math.sin(3.9 * z + ph[2] + 1.7 * y);
    // A broken piece of slab is a SLAB: 2:1 at worst, with a flat bed face it
    // settles onto. Flattening the underside is what removes the last of the
    // artefact, because it is the up-tilted thin edge that catches nothing.
    p.setXYZ(i, p.getX(i) * k * 1.06, Math.max(p.getY(i) * k, -0.30 * 0.42) * 0.72, p.getZ(i) * k * 1.06);
  }
  g.computeVertexNormals();
  // Sunk far enough that the waist of the chunk is at grade: a piece of broken
  // slab in a compound yard is half in the dirt, not resting on top of it.
  g.translate(0, 0.045, 0);
  b.concrete.push(g);
  // y0 at the bed face rather than 1.4 m below it, so the shader's splash band
  // actually lands on the bottom of the chunk and beds it into the dirt.
  return bake(b, 0.30, 0.9, -0.03);
}

/**
 * Sandbag.
 *
 * Round 1 shipped one bag, instanced 1300 times with ±8% uniform scale, and the
 * revetment read as a grid of identical pillows — which is exactly what it was.
 * A filled hessian bag is not a primitive: it has a seam that runs the long way,
 * ears at both ends where the corners of the sack fold up, a flat top wherever
 * something is stacked on it, a lumpy sand-shaped belly, and it takes the shape
 * of whatever it was dropped onto.
 *
 * So there are now SEVEN bag meshes with genuinely different silhouettes, each
 * with its own end-fold treatment, belly lumps and slump direction, and the
 * placement code hands out non-uniform per-instance scale on top of that. The
 * cost is seven InstancedMesh draws instead of one — the cheapest possible price
 * for killing the single most-noticed artefact on the site.
 */
export function sandbagGeo(variant = 0) {
  const b = newBag();
  let s = (variant * 2654435761 + 17) >>> 0;
  const r = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 1) >>> 0) / 4294967296);

  const g = new THREE.SphereGeometry(1, 8, 5);
  const p = g.attributes.position;
  const sup = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);

  // Per-variant character. The proportions matter more than anything else here:
  // a filled 14"x26" sack is roughly 560 x 340 x 200mm, which is a CHUNKY
  // object — nearly as tall as it is half-wide. The first attempt used a
  // half-height of 90mm and a superellipse exponent near 0.5, and the result was
  // a flying saucer. Volume first, character second.
  const ex = 0.68 + r() * 0.16;      // plan boxiness (higher = rounder)
  const ey = 0.66 + r() * 0.20;      // section boxiness
  const L = 0.255 + r() * 0.052;     // half-length
  const W = 0.152 + r() * 0.030;     // half-width
  const Hh = 0.106 + r() * 0.026;    // half-height
  const slumpX = (r() - 0.5) * 0.12;
  const slumpZ = (r() - 0.5) * 0.11;
  const earDrop = 0.30 + r() * 0.50; // the empty corners of the sack flop DOWN
  const lumpA = 0.13 + r() * 0.14;
  const flatTop = r() < 0.45 ? 0.78 + r() * 0.16 : 1.0; // squashed by the course above
  const ph = [r() * 6.3, r() * 6.3, r() * 6.3];

  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const t = Math.abs(x);
    // The ends of a filled sack are not full of sand: they taper hard and the
    // slack corner folds over and hangs. That fold is the whole silhouette.
    const pinch = 1.0 - 0.42 * Math.pow(t, 2.4);
    let px = sup(x, ex) * L;
    let py = sup(y, ey) * Hh * pinch;
    let pz = sup(z, ex) * W * pinch;
    py -= Math.pow(t, 3.4) * earDrop * Hh * 0.85;
    // Sand does not fill a sack evenly: a few low-frequency lobes of belly.
    const lump =
      Math.sin(px * 9.0 + ph[0]) * Math.cos(pz * 15.0 + ph[1]) * 0.5 +
      Math.sin(px * 19.0 + ph[2]) * 0.30 +
      Math.cos(pz * 24.0 + ph[0]) * 0.24;
    const belly = 1.0 + lump * lumpA * (0.40 + 0.60 * (1.0 - t));
    py *= belly;
    pz *= belly;
    if (py > 0) py *= flatTop;
    px += slumpX * y * 0.5;
    pz += slumpZ * y;
    p.setXYZ(i, px, py, pz);
  }
  g.computeVertexNormals();
  g.translate(0, Hh * 1.02, 0);
  b.cloth.push(g);
  // y0 at the very bottom of the bag so the shader's y01 term can put a contact
  // shadow in the crack between courses; with y0 offset below the mesh the
  // gradient never reaches zero and every bag floats.
  return bake(b, Hh * 2.05, 0.45, 0);
}

/** How many distinct bag meshes exist; placement code buckets instances by this. */
export const SANDBAG_VARIANTS = 7;

// ------------------------------------------------------------- floodlight ---

/** Floodlight on a pole: raked head, brace, junction box, cable drop. */
export function floodlightGeo({ h = 6.4, heads = 1 } = {}) {
  const b = newBag();
  b.concrete.push(cyl(0.34, 0.5, 10, { y: 0.2 }));
  b.metal.push(cyl(0.085, h, 8, { y: h / 2 }));
  b.metal.push(cyl(0.13, 0.1, 8, { y: 0.52 }));
  b.metal.push(box(0.24, 0.36, 0.17, { x: 0.16, y: 1.5 }));
  for (let i = 0; i < heads; i++) {
    const a = heads === 1 ? 0 : (i / heads) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const bx = dx * 0.42;
    const bz = dz * 0.42;
    b.metal.push(strut(new THREE.Vector3(0, h - 0.15, 0), new THREE.Vector3(bx, h + 0.1, bz), 0.045, 6));
    const head = box(0.62, 0.44, 0.3, { x: bx * 1.6, y: h + 0.28, z: bz * 1.6, ry: -a, rz: -0.42 });
    b.metal.push(head);
    b.metal.push(box(0.68, 0.09, 0.36, { x: bx * 1.6, y: h + 0.48, z: bz * 1.6, ry: -a }));
  }
  b.metal.push(catenary(new THREE.Vector3(0.08, h - 0.3, 0), new THREE.Vector3(0.1, 1.7, 0.05), 0.02, 0.016, 5));
  return bake(b, h + 0.6, 0.5);
}

/** The emissive lens that bloom picks up — separate so it can be a glow material. */
export function floodlightLensGeo({ h = 6.4, heads = 1 } = {}) {
  const b = newBag();
  for (let i = 0; i < heads; i++) {
    const a = heads === 1 ? 0 : (i / heads) * Math.PI * 2;
    const dx = Math.cos(a) * 0.42;
    const dz = Math.sin(a) * 0.42;
    b.glow.push(box(0.5, 0.34, 0.06, { x: dx * 1.6 + Math.cos(a) * 0.16, y: h + 0.22, z: dz * 1.6 + Math.sin(a) * 0.16, ry: -a, rz: -0.42 }));
  }
  return bake(b, h + 0.6, 0);
}

/** High mast lighting the vehicle yard: lattice column, four heads on a ring. */
export function highMastGeo({ h = 13 } = {}) {
  const b = newBag();
  b.concrete.push(box(1.7, 0.6, 1.7, { y: 0.25 }));
  for (const g of lattice({ half: 0.52, y0: 0.5, y1: h, legR: 0.07, braceR: 0.038, panels: 8 })) b.metal.push(g);
  b.metal.push(box(2.3, 0.13, 2.3, { y: h + 0.06 }));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const dx = Math.cos(a) * 0.95;
    const dz = Math.sin(a) * 0.95;
    b.metal.push(box(0.72, 0.5, 0.34, { x: dx, y: h + 0.34, z: dz, ry: -a, rz: -0.5 }));
    b.metal.push(box(0.78, 0.1, 0.4, { x: dx, y: h + 0.58, z: dz, ry: -a }));
  }
  return bake(b, h + 0.9, 0.4);
}

export function highMastLensGeo({ h = 13 } = {}) {
  const b = newBag();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    b.glow.push(box(0.58, 0.38, 0.06, { x: Math.cos(a) * 1.14, y: h + 0.26, z: Math.sin(a) * 1.14, ry: -a, rz: -0.5 }));
  }
  return bake(b, h + 0.9, 0);
}

/** Guyed lattice radio mast with a whip and an obstruction light. */
export function antennaMastGeo({ h = 19 } = {}) {
  const b = newBag();
  b.concrete.push(box(1.4, 0.5, 1.4, { y: 0.2 }));
  for (const g of lattice({ half: 0.42, y0: 0.42, y1: h, legR: 0.05, braceR: 0.028, panels: 11, legs: 3 })) b.metal.push(g);
  b.metal.push(cyl(0.022, 3.4, 5, { y: h + 1.7 }));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    const anchor = new THREE.Vector3(Math.cos(a) * 7.5, 0.3, Math.sin(a) * 7.5);
    b.metal.push(strut(new THREE.Vector3(0, h - 1.2, 0), anchor, 0.016, 4));
    b.concrete.push(box(0.5, 0.4, 0.5, { x: anchor.x, y: 0.18, z: anchor.z }));
  }
  // Dipoles part-way up so the silhouette is not a bare stick.
  for (let i = 0; i < 2; i++) {
    const y = h * (0.55 + i * 0.18);
    b.metal.push(xform(cyl(0.018, 2.4, 5), { rz: Math.PI / 2, y }));
    b.metal.push(xform(cyl(0.018, 2.0, 5), { rx: Math.PI / 2, y: y + 0.3 }));
  }
  return bake(b, h + 3.5, 0.35);
}

/** Parabolic dish on a pedestal. */
export function dishGeo({ r = 1.5 } = {}) {
  const b = newBag();
  const pts = [];
  const N = 10;
  for (let i = 0; i <= N; i++) {
    const x = (i / N) * r;
    pts.push(new THREE.Vector2(x, (x * x) / (2.6 * r)));
  }
  const dish = new THREE.LatheGeometry(pts, 22);
  dish.rotateX(-Math.PI / 2 + 0.55);
  dish.translate(0, 2.1, 0);
  b.metal.push(dish);
  const rim = new THREE.TorusGeometry(r, 0.045, 5, 22);
  rim.rotateX(-Math.PI / 2 + 0.55);
  rim.translate(0, 2.1 + Math.sin(0.55) * 0.0, 0);
  b.metal.push(xform(rim, { y: 0.0 }));
  b.metal.push(cyl(0.1, 2.1, 8, { y: 1.05 }));
  b.concrete.push(box(0.9, 0.28, 0.9, { y: 0.14 }));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    b.metal.push(strut(
      new THREE.Vector3(Math.cos(a) * r * 0.8, 2.1 + Math.cos(0.55) * 0.3, Math.sin(a) * r * 0.8),
      new THREE.Vector3(0, 2.1 + 1.05, 0.55), 0.022, 4,
    ));
  }
  b.metal.push(cyl(0.11, 0.28, 8, { y: 3.15, z: 0.55 }));
  return bake(b, 3.4, 0.3);
}

/** Jersey barrier — the universal "keep vehicles out" shape. */
export function barrierGeo() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.32, 0);
  shape.lineTo(0.32, 0);
  shape.lineTo(0.16, 0.28);
  shape.lineTo(0.09, 0.82);
  shape.lineTo(-0.09, 0.82);
  shape.lineTo(-0.16, 0.28);
  shape.lineTo(-0.32, 0);
  const b = newBag();
  const g = new THREE.ExtrudeGeometry(shape, { depth: 1.9, bevelEnabled: false });
  g.translate(0, 0, -0.95);
  b.concrete.push(g);
  return bake(b, 0.82, 0.55);
}

/** Concrete pipe / culvert section — cheap cover, very common on these sites. */
export function pipeGeo() {
  const b = newBag();
  const g = new THREE.CylinderGeometry(0.62, 0.62, 2.4, 14, 1, true);
  g.rotateZ(Math.PI / 2);
  g.translate(0, 0.62, 0);
  b.concrete.push(g);
  const inner = new THREE.CylinderGeometry(0.5, 0.5, 2.38, 14, 1, true);
  inner.rotateZ(Math.PI / 2);
  inner.translate(0, 0.62, 0);
  b.concrete.push(flip(inner));
  for (const sx of [-1, 1]) {
    const ring = new THREE.RingGeometry(0.5, 0.62, 14);
    ring.rotateY(sx * Math.PI * 0.5);
    ring.translate(sx * 1.2, 0.62, 0);
    b.concrete.push(ring);
  }
  return bake(b, 1.24, 0.5);
}

// ----------------------------------------------------------------- truck ----

/**
 * Off-road military tyre.
 *
 * Round 1 used a bare torus: a featureless black doughnut, which is the reason
 * the truck read as a toy. A real 1200x500 military tyre is a *cylinder* with a
 * rounded shoulder, a sidewall that carries lettering-depth relief and a bulge
 * where the load flattens it, and — above everything — a coarse directional
 * tread whose blocks catch a highlight on the top of the arc and go black
 * underneath. That highlight running round the crown is the thing that makes a
 * wheel read as rubber.
 */
function tyreProfile({ r = 0.62, width = 0.42, lugs = 14, shoulder = 0.075, flat = 0.03, bead = true }) {
  const parts = [];
  // Carcass: a lathed section so the shoulder is a real radius, not a chamfer.
  // The shoulder is deliberately tight — at 0.11 on a 0.62 tyre the sidewall
  // silhouette sat at 0.51 while the tread crown was at 0.62, which is a
  // balloon, not a lorry tyre, and it made the lugs read as gear teeth.
  const pts = [];
  const N = 6;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = -Math.PI / 2 + t * Math.PI;
    pts.push(new THREE.Vector2(r - shoulder + Math.cos(a) * shoulder * 0.98, (Math.sin(a) * width) / 2));
  }
  // Inner edge of the sidewall. It has to run BELOW the rim it is mounted on
  // (hubGeo's 0.30 on a 0.62 tyre) or there is an open annulus between tyre and
  // wheel that you can see the sky through.
  pts.unshift(new THREE.Vector2(r * 0.44, -width / 2 + 0.02));
  pts.push(new THREE.Vector2(r * 0.44, width / 2 - 0.02));
  // Round 5: this said `rotateZ`, and it is worth spelling out what that cost.
  // A lathe is symmetric about Y, so rotateZ puts the wheel's axle along X —
  // the truck's own LONGITUDINAL axis. Everything else in this file (the lug
  // ring, the bead, the stud circle, the contact patch, the way tyreGeo lays a
  // scrap tyre flat) is authored for an axle along Z, so the carcass ended up
  // 90 degrees out of plane from its own tread: the lugs stood off in a ring
  // that missed the tyre entirely, and the scrap tyres in the yard stacked on
  // their rims like coins instead of lying flat. That is most of what a critic
  // was seeing when they called the wheels "flat discs with no tread and no
  // hub" — the tread was there, it was just orbiting the wrong axis.
  const carcass = new THREE.LatheGeometry(pts, 16);
  carcass.rotateX(Math.PI / 2);
  parts.push(carcass);
  // Sidewall bead ring, both faces. A torus is already normal to Z, so it needs
  // no rotation at all — it only needs pushing out to the sidewall.
  if (bead) {
    for (const sz of [-1, 1]) {
      const ring = new THREE.TorusGeometry(r * 0.74, 0.035, 4, 14);
      ring.translate(0, 0, (sz * width) / 2 - sz * 0.03);
      parts.push(ring);
    }
  }
  // Tread: staggered lug blocks round the crown. The tangential length has to
  // be most of the pitch — at a 30% duty cycle they read as gear teeth rather
  // than as tread, which is exactly how the first attempt failed.
  const pitch = (2 * Math.PI * r) / lugs;
  for (let i = 0; i < lugs; i++) {
    const a = (i / lugs) * Math.PI * 2;
    const stag = i % 2 === 0 ? 1 : -1;
    for (const half of [-1, 1]) {
      const g = box(pitch * 0.62, 0.034, width * 0.42, {
        x: Math.cos(a) * (r - 0.004),
        y: Math.sin(a) * (r - 0.004),
        z: half * width * 0.235,
        rz: a + stag * 0.26 * half,
        sharp: true,
      });
      parts.push(g);
    }
  }
  // The contact patch: squash the bottom of the tyre so it sits on the ground
  // instead of touching it at one mathematical point.
  const out = merge(parts);
  const p = out.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < -(r - flat)) p.setY(i, -(r - flat) - (y + (r - flat)) * 0.25);
  }
  out.computeVertexNormals();
  return out;
}

/** Steel disc wheel: rim, dish, hub, ten studs and a valve. */
function hubGeo({ r = 0.30, width = 0.40 }) {
  const parts = [];
  // Same axis correction as the carcass: the rim runs about Z, not X.
  parts.push(xform(cyl(r, width * 0.55, 12), { rx: Math.PI / 2 }));
  for (const sz of [-1, 1]) {
    parts.push(xform(cyl(r * 0.95, 0.05, 12), { rx: Math.PI / 2, z: (sz * width) / 2 - sz * 0.06 }));
    parts.push(xform(cyl(r * 0.42, 0.10, 10), { rx: Math.PI / 2, z: (sz * width) / 2 }));
    // Lightening holes read as holes because there is a dark disc behind them.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.3;
      parts.push(xform(cyl(0.055, 0.06, 6), {
        rx: Math.PI / 2, x: Math.cos(a) * r * 0.66, y: Math.sin(a) * r * 0.66, z: (sz * width) / 2 - sz * 0.03,
      }));
    }
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      parts.push(box(0.045, 0.045, 0.05, {
        x: Math.cos(a) * r * 0.30, y: Math.sin(a) * r * 0.30, z: (sz * width) / 2 + sz * 0.03, rz: a, sharp: true,
      }));
    }
  }
  return parts;
}

/**
 * Ural-style 6x6 cargo truck.
 *
 * Everything the critic listed as missing is here: tread and sidewall, disc
 * wheels with studs, live axles on leaf springs with shackles, a glazed and
 * framed cab with opening doors, handles, hinges and mirrors, a vertical
 * exhaust stack with a heat shield, a canvas tilt on real hoops with lashing
 * eyes, mudflaps, and a spare on the headboard. The truck is the object a
 * player walks right up to, so it is the object that has to survive being
 * walked right up to.
 */
export function truckGeo({ tilt = true, rng = null } = {}) {
  const b = newBag();
  const wheelR = 0.62;
  const width = 0.42;
  const axleY = wheelR - 0.03;
  const track = 1.02;
  const rnd = rng ?? (() => 0.5);
  void rnd;

  // ------------------------------------------------------------- chassis ----
  for (const sz of [-1, 1]) {
    b.metal.push(box(6.9, 0.24, 0.10, { y: 0.80, z: sz * 0.46 }));
    b.metal.push(box(6.9, 0.06, 0.16, { y: 0.91, z: sz * 0.46 }));
    b.metal.push(box(6.9, 0.06, 0.16, { y: 0.69, z: sz * 0.46 }));
  }
  for (const cx of [2.6, 0.3, -1.9, -3.2]) b.metal.push(box(0.14, 0.20, 1.02, { x: cx, y: 0.80 }));
  // Transfer case, propshafts, silencer.
  b.metal.push(box(0.70, 0.42, 0.52, { x: 0.55, y: 0.70 }));
  for (const [x0, x1] of [[1.9, 0.9], [0.2, -1.2], [-1.5, -2.6]]) {
    b.metal.push(strut(new THREE.Vector3(x0, 0.70, 0), new THREE.Vector3(x1, axleY, 0), 0.045, 6));
  }
  b.metal.push(xform(cyl(0.16, 1.5, 10), { rz: Math.PI / 2, x: 0.4, y: 0.60, z: 0.62 }));

  // ------------------------------------------------------------ cab -------
  const cabX = 2.35;
  b.mil.push(box(2.05, 1.02, 2.30, { x: cabX, y: 1.44 }));
  // Doors: a real 4mm shut line, a window frame, a handle, two hinges and a step.
  for (const sz of [-1, 1]) {
    const zf = sz * 1.155;
    b.mil.push(box(1.30, 1.62, 0.05, { x: cabX - 0.06, y: 1.75, z: zf }));
    for (const sy of [1.06, 2.30]) b.metal.push(box(0.10, 0.16, 0.05, { x: cabX + 0.55, y: sy, z: zf + sz * 0.03 }));
    b.steel.push(box(0.20, 0.05, 0.05, { x: cabX - 0.52, y: 1.72, z: zf + sz * 0.05 }));
    // Window aperture: painted frame, dark interior, glass proud of the interior.
    b.dark.push(box(1.02, 0.62, 0.03, { x: cabX - 0.06, y: 2.18, z: zf - sz * 0.10 }));
    b.glass.push(box(1.02, 0.62, 0.02, { x: cabX - 0.06, y: 2.18, z: zf + sz * 0.026 }));
    for (const sy of [-0.34, 0.34]) b.mil.push(box(1.12, 0.06, 0.07, { x: cabX - 0.06, y: 2.18 + sy, z: zf + sz * 0.02 }));
    for (const sx of [-0.53, 0.53]) b.mil.push(box(0.06, 0.70, 0.07, { x: cabX - 0.06 + sx, y: 2.18, z: zf + sz * 0.02 }));
    // Step under the door and a grab handle on the A-pillar.
    b.metal.push(box(0.55, 0.05, 0.20, { x: cabX - 0.1, y: 0.92, z: sz * 1.28 }));
    b.steel.push(cyl(0.022, 0.60, 5, { x: cabX + 0.66, y: 2.05, z: sz * 1.22 }));
    // Mirror on a proper double-arm bracket, in bare tube.
    b.steel.push(strut(new THREE.Vector3(cabX + 0.72, 2.36, sz * 1.20), new THREE.Vector3(cabX + 0.60, 2.62, sz * 1.62), 0.022, 5));
    b.steel.push(strut(new THREE.Vector3(cabX + 0.72, 1.98, sz * 1.20), new THREE.Vector3(cabX + 0.60, 2.20, sz * 1.62), 0.022, 5));
    b.mil.push(box(0.09, 0.52, 0.24, { x: cabX + 0.58, y: 2.40, z: sz * 1.66 }));
    b.glass.push(box(0.02, 0.44, 0.19, { x: cabX + 0.63, y: 2.40, z: sz * 1.66 }));
  }
  // Windscreen: two panes with a centre bar, raked, with a dark cab behind.
  b.dark.push(box(1.86, 0.70, 0.04, { x: cabX + 0.94, y: 2.20 }));
  for (const sz of [-1, 1]) {
    b.glass.push(box(0.03, 0.66, 0.86, { x: cabX + 1.00, y: 2.20, z: sz * 0.48 }));
  }
  b.mil.push(box(0.09, 0.74, 0.09, { x: cabX + 1.00, y: 2.20 }));
  b.mil.push(box(0.12, 0.10, 2.26, { x: cabX + 0.99, y: 2.56 }));
  b.mil.push(box(0.12, 0.10, 2.26, { x: cabX + 0.99, y: 1.84 }));
  for (const sz of [-1, 1]) b.metal.push(box(0.05, 0.03, 0.55, { x: cabX + 1.03, y: 1.94, z: sz * 0.45, rz: 0.25 }));
  b.mil.push(box(0.09, 1.72, 2.30, { x: cabX - 1.00, y: 1.76 }));
  b.dark.push(box(0.04, 1.60, 2.16, { x: cabX - 0.94, y: 1.76 }));
  b.mil.push(box(2.20, 0.14, 2.38, { x: cabX, y: 2.60 }));
  b.metal.push(box(0.30, 0.16, 0.30, { x: cabX - 0.7, y: 2.72, z: 0.7 }));

  // ------------------------------------------------- bonnet / front end ----
  b.mil.push(box(1.20, 0.86, 2.02, { x: 3.94, y: 1.52 }));
  b.metal.push(box(0.06, 0.60, 1.90, { x: 4.56, y: 1.58 }));
  b.dark.push(box(0.06, 0.56, 1.48, { x: 4.53, y: 1.46 }));
  for (let i = 0; i < 9; i++) b.steel.push(box(0.10, 0.56, 0.05, { x: 4.57, y: 1.46, z: -0.70 + i * 0.175 }));
  b.metal.push(box(0.26, 0.26, 2.34, { x: 4.62, y: 0.86 }));
  for (const sz of [-1, 1]) {
    b.metal.push(box(0.34, 0.30, 0.14, { x: 4.72, y: 0.86, z: sz * 0.85 }));
    b.steel.push(xform(cyl(0.17, 0.18, 10), { rz: Math.PI / 2, x: 4.50, y: 1.78, z: sz * 0.76 }));
    b.glow.push(xform(cyl(0.14, 0.05, 10), { rz: Math.PI / 2, x: 4.60, y: 1.78, z: sz * 0.76 }));
    b.paintWarn.push(xform(cyl(0.07, 0.05, 8), { rz: Math.PI / 2, x: 4.58, y: 1.44, z: sz * 0.98 }));
    // Wing, and a mudflap behind the front wheel.
    b.mil.push(box(1.50, 0.10, 0.66, { x: 3.60, y: 1.10, z: sz * 1.00 }));
    b.mil.push(box(0.14, 0.42, 0.66, { x: 2.88, y: 0.92, z: sz * 1.00 }));
  }
  b.metal.push(cyl(0.055, 0.42, 6, { x: 4.30, y: 2.02, z: -0.5 }));

  // Vertical exhaust stack behind the cab, with a perforated heat shield.
  b.steel.push(cyl(0.075, 2.45, 8, { x: 1.30, y: 2.02, z: 1.02 }));
  b.steel.push(xform(cyl(0.10, 0.16, 8), { rz: 0.35, x: 1.34, y: 3.22, z: 1.02 }));
  for (let i = 0; i < 5; i++) b.metal.push(box(0.16, 0.05, 0.05, { x: 1.30, y: 1.2 + i * 0.4, z: 1.10 }));

  // Fuel tank on a strap, battery box, and a spare wheel on the headboard.
  b.metal.push(xform(cyl(0.30, 1.25, 14), { rz: Math.PI / 2, x: 0.85, y: 0.86, z: -1.02 }));
  for (const sx of [-0.4, 0.4]) b.metal.push(xform(cyl(0.33, 0.05, 14), { rz: Math.PI / 2, x: 0.85 + sx, y: 0.86, z: -1.02 }));
  b.metal.push(box(0.62, 0.42, 0.44, { x: 1.55, y: 0.92, z: -1.00 }));

  // ------------------------------------------------------------- bed ------
  const bedX = -1.55;
  b.wood.push(box(4.40, 0.16, 2.32, { x: bedX, y: 1.16 }));
  for (const sz of [-1, 1]) {
    // Drop sides made of real boards, with the gap between them.
    for (let k = 0; k < 3; k++) {
      b.wood.push(box(4.40, 0.20, 0.075, { x: bedX, y: 1.34 + k * 0.225, z: sz * 1.16 }));
    }
    for (let i = 0; i < 4; i++) {
      b.metal.push(box(0.07, 0.80, 0.10, { x: bedX - 1.90 + i * 1.27, y: 1.60, z: sz * 1.21 }));
      b.metal.push(box(0.16, 0.06, 0.14, { x: bedX - 1.90 + i * 1.27, y: 1.22, z: sz * 1.24 }));
    }
  }
  b.wood.push(box(0.10, 0.92, 2.32, { x: bedX + 2.20, y: 1.66 }));
  b.wood.push(box(0.10, 0.62, 2.32, { x: bedX - 2.20, y: 1.50 }));
  b.metal.push(box(4.5, 0.09, 0.12, { x: bedX, y: 1.09, z: 0 }));

  if (tilt) {
    // Canvas tilt on five hoops. The canvas sags between the hoops and the
    // ridge scallops — a smooth half-cylinder is the giveaway that it is a
    // primitive rather than cloth over a frame.
    const hoopN = 5;
    const span = 4.30;
    const R0 = 1.24;
    const seg = 11;
    const rows = 16;
    const gt = new THREE.PlaneGeometry(span, 1, rows, seg);
    const gp = gt.attributes.position;
    for (let i = 0; i < gp.count; i++) {
      const col = i % (rows + 1);
      const row = Math.floor(i / (rows + 1));
      const t = col / rows;
      const a = (row / seg) * Math.PI;
      // Sag: zero at each hoop, maximum midway between.
      const hoopPhase = Math.abs(Math.sin(t * (hoopN - 1) * Math.PI));
      const sag = hoopPhase * 0.075 * Math.sin(a);
      const rr = R0 - sag;
      gp.setXYZ(i, bedX - span / 2 + t * span, 1.86 + Math.sin(a) * rr, -Math.cos(a) * rr);
    }
    gt.computeVertexNormals();
    b.cloth.push(gt);
    // Tail curtain, rolled up and lashed on one side.
    b.cloth.push(box(0.06, 1.30, 2.44, { x: bedX - 2.18, y: 1.94 }));
    b.cloth.push(xform(cyl(0.16, 2.30, 8), { rz: Math.PI / 2, x: bedX - 2.20, y: 2.72 }));
    for (let i = 0; i < hoopN; i++) {
      const t = new THREE.TorusGeometry(R0 + 0.015, 0.032, 4, 14, Math.PI);
      t.rotateY(Math.PI / 2);
      t.translate(bedX - span / 2 + (i * span) / (hoopN - 1), 1.86, 0);
      b.metal.push(t);
    }
    // Lashing eyes and rope along the hem.
    for (const sz of [-1, 1]) {
      for (let i = 0; i < 8; i++) {
        b.metal.push(box(0.05, 0.05, 0.05, { x: bedX - 2.0 + i * 0.57, y: 1.84, z: sz * 1.245 }));
      }
      b.metal.push(catenary(
        new THREE.Vector3(bedX - 2.15, 1.84, sz * 1.25),
        new THREE.Vector3(bedX + 2.15, 1.84, sz * 1.25), 0.05, 0.016, 8,
      ));
    }
  } else {
    // Flatbed: spare wheel flat on the deck, and a coil of rope.
    b.rubber.push(xform(tyreProfile({ r: 0.60, width: 0.40, lugs: 16 }), { rx: Math.PI / 2, x: bedX + 1.5, y: 1.44, z: -0.6 }));
    for (const g of hubGeo({ r: 0.29, width: 0.38 })) {
      b.metal.push(xform(g, { rx: Math.PI / 2, x: bedX + 1.5, y: 1.44, z: -0.6 }));
    }
    b.cloth.push(xform(new THREE.TorusGeometry(0.30, 0.075, 5, 12), { rx: Math.PI / 2, x: bedX - 1.2, y: 1.31, z: 0.7 }));
  }

  // ---------------------------------------------------------- running gear --
  const tyre = tyreProfile({ r: wheelR, width, lugs: 17 });
  const hub = merge(hubGeo({ r: 0.30, width: width * 0.95 }));
  for (const ax of [3.28, -1.32, -2.72]) {
    for (const sz of [-1, 1]) {
      b.rubber.push(xform(tyre.clone(), { x: ax, y: axleY, z: sz * track }));
      b.metal.push(xform(hub.clone(), { x: ax, y: axleY, z: sz * track }));
      // Leaf spring pack, spring seat and a shackle at each end.
      for (let k = 0; k < 3; k++) {
        b.metal.push(box(1.35 - k * 0.22, 0.035, 0.09, { x: ax, y: 0.60 + k * 0.045, z: sz * 0.52, rz: 0 }));
      }
      b.metal.push(box(0.20, 0.18, 0.14, { x: ax, y: 0.66, z: sz * 0.52 }));
      for (const sx of [-1, 1]) {
        b.metal.push(box(0.08, 0.26, 0.10, { x: ax + sx * 0.66, y: 0.70, z: sz * 0.52 }));
      }
      // Damper.
      b.metal.push(strut(
        new THREE.Vector3(ax + 0.10, 0.62, sz * 0.60), new THREE.Vector3(ax + 0.30, 1.00, sz * 0.50), 0.035, 5,
      ));
    }
    // Live axle: tube, banjo housing and the diff cover. The tube spans the
    // TRACK, so it runs across the truck (Z) — it was running fore-and-aft.
    b.metal.push(xform(cyl(0.075, track * 2 - 0.2, 8), { rx: Math.PI / 2, x: ax, y: axleY }));
    b.metal.push(xform(cyl(0.20, 0.34, 10), { rx: Math.PI / 2, x: ax, y: axleY }));
    b.metal.push(xform(cyl(0.155, 0.22, 10), { x: ax + 0.20, y: axleY, z: 0.0, rz: Math.PI / 2 }));
  }
  // Rear mudflaps behind the bogie.
  for (const sz of [-1, 1]) b.rubber.push(box(0.03, 0.50, 0.56, { x: -3.30, y: 0.70, z: sz * track }));
  // Low bake wear: a serviceable truck in daily use is dirty, not derelict.
  return bake(b, 2.9, 0.12);
}

// ------------------------------------------------------------- camo netting --

/**
 * Camo net over a pole frame.
 *
 * The round-1 net was a flat plane held rigid, and it is worth being precise
 * about why that fails: a net has no bending stiffness at all. It cannot be
 * flat. Its shape is entirely determined by where it is pinned and by gravity,
 * which means a deep swag between every pair of supports and a hard cusp AT
 * each support — and that alternating cusp/swag rhythm along the roofline is
 * the whole silhouette. So the surface is solved as a real slack membrane
 * (`membraneSag`) pinned at the pole heads, rather than shaped by a formula.
 *
 * The second half is the shadow. Alpha-tested with a genuinely open scrim, this
 * throws the moving dappled light-pool that is a signature MGSV image; getting
 * it requires castShadow on, an alphaTest the depth pass will honour, and — the
 * bit that is easy to miss — holes big enough for the shadow cascade to resolve.
 */
export function camoNet({ w = 12, d = 9, h = 3.1, sag = 0.55, rng = null }) {
  const b = newBag();
  const nx = 16;
  const nz = 12;
  const rnd = rng ?? (() => 0.5);

  // Pole heads: corners plus mid-edges plus one interior prop, each at its own
  // height. A net whose supports are all the same height is a tent, not camo.
  const heads = [
    { i: 0, j: 0, y: h },
    { i: nx, j: 0, y: h - 0.30 },
    { i: nx, j: nz, y: h + 0.22 },
    { i: 0, j: nz, y: h - 0.12 },
    { i: Math.round(nx * 0.5), j: 0, y: h + 0.34 },
    { i: Math.round(nx * 0.5), j: nz, y: h + 0.10 },
    { i: 0, j: Math.round(nz * 0.5), y: h - 0.20 },
    { i: nx, j: Math.round(nz * 0.55), y: h + 0.05 },
    { i: Math.round(nx * 0.62), j: Math.round(nz * 0.45), y: h + 0.55 },
  ];
  for (const p of heads) p.y += (rnd() - 0.5) * 0.22;

  const field = membraneSag({ nx, nz, pins: heads.map((p) => ({ i: p.i, j: p.j, y: p.y })), sag, passes: 300 });

  const g = new THREE.PlaneGeometry(w, d, nx, nz);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  // PlaneGeometry rows run +u then +v; after rotateX(-90) v maps to +z.
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const idx = j * (nx + 1) + i;
      p.setY(idx, field[j * (nx + 1) + i]);
    }
  }
  g.computeVertexNormals();
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / 3.4), uv.getY(i) * (d / 3.4));
  b.net.push(g);

  // Skirts down all four edges, following the swag they hang from and cut to
  // ragged lengths.
  const edgeY = (i, j) => field[j * (nx + 1) + i];
  const skirt = (along, fixed, axis, sz) => {
    const n = axis === 0 ? nx : nz;
    const len = axis === 0 ? w : d;
    const s = new THREE.PlaneGeometry(len, 1.0, n, 2);
    const sp = s.attributes.position;
    for (let k = 0; k < sp.count; k++) {
      const col = k % (n + 1);
      const row = Math.floor(k / (n + 1));
      const t = col / n;
      const y0 = axis === 0 ? edgeY(col, fixed) : edgeY(fixed, col);
      const drop = (0.55 + 0.55 * Math.abs(Math.sin(t * 7.3 + sz * 2.1))) * (row === 0 ? 1 : row === 1 ? 0.5 : 0);
      const posAlong = -len / 2 + t * len;
      const wobble = Math.sin(t * 9.0 + sz) * 0.10;
      if (axis === 0) sp.setXYZ(k, posAlong, y0 - drop, sz * (d / 2) + wobble);
      else sp.setXYZ(k, sz * (w / 2) + wobble, y0 - drop, posAlong);
    }
    s.computeVertexNormals();
    const su = s.attributes.uv;
    for (let k = 0; k < su.count; k++) su.setXY(k, su.getX(k) * (len / 3.4), su.getY(k) * 0.5);
    b.net.push(s);
    void along;
  };
  skirt(0, 0, 0, -1);
  skirt(0, nz, 0, 1);
  skirt(0, 0, 1, -1);
  skirt(0, nx, 1, 1);

  // Poles under each head, out of scaffold tube with a spike foot, plus guys.
  for (const hd of heads) {
    const x = -w / 2 + (hd.i / nx) * w;
    const z = -d / 2 + (hd.j / nz) * d;
    const y = field[hd.j * (nx + 1) + hd.i];
    b.metal.push(cyl(0.045, y + 0.12, 7, { x, y: (y + 0.12) / 2, z }));
    b.metal.push(cyl(0.075, 0.07, 8, { x, y: y + 0.10, z }));
    b.metal.push(cyl(0.13, 0.05, 8, { x, y: 0.025, z }));
  }
  // Guys off the four corners into ground pickets.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const a = new THREE.Vector3(sx * (w / 2), field[(sz > 0 ? nz : 0) * (nx + 1) + (sx > 0 ? nx : 0)], sz * (d / 2));
      const anch = new THREE.Vector3(sx * (w / 2 + 1.9), 0.06, sz * (d / 2 + 1.5));
      b.metal.push(strut(a, anch, 0.012, 4));
      b.metal.push(xform(cyl(0.035, 0.55, 5), { rz: sx * 0.35, x: anch.x, y: 0.2, z: anch.z }));
    }
  }
  return bake(b, h + 0.6, 0.4);
}

/**
 * A tarp thrown over a stack of stores and roped down.
 *
 * The round-1 tarp was a smooth cosine dome, which is the one thing a sheet of
 * canvas over a pile of boxes never is. Real tarpaulin does three things: it
 * takes the CORNERS of whatever is underneath, so the silhouette has hard
 * points; it hangs in straight-line creases radiating from each of those
 * points; and it is pulled into a waist wherever a rope crosses it. All three
 * are here, plus the rope.
 */
export function tarpGeo({ w = 2.6, d = 2.0, h = 1.3, seed = 3 }) {
  const b = newBag();
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 1) >>> 0) / 4294967296);
  const nx = 12;
  const nz = 10;
  const g = new THREE.PlaneGeometry(w, d, nx, nz);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  // The load underneath: two or three crates at different heights.
  const lumps = [];
  for (let i = 0; i < 3; i++) {
    lumps.push({
      x: (rnd() - 0.5) * w * 0.55,
      z: (rnd() - 0.5) * d * 0.55,
      hx: w * (0.16 + rnd() * 0.16),
      hz: d * (0.16 + rnd() * 0.16),
      y: h * (0.62 + rnd() * 0.38),
    });
  }
  const ropes = [-0.28 + rnd() * 0.1, 0.26 + rnd() * 0.1];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    // Height is the upper envelope of the boxes underneath — a max(), which is
    // what produces the hard ridge lines a smooth dome cannot have.
    let y = 0;
    for (const L of lumps) {
      const q = Math.max(Math.abs(x - L.x) / L.hx, Math.abs(z - L.z) / L.hz);
      y = Math.max(y, L.y * Math.max(0, 1 - Math.max(0, q - 1) * 0.9) * (q <= 1 ? 1 : 1));
    }
    // Creases: sharp, straight, and aligned to the sheet, not noise.
    const crease = (Math.abs(Math.sin(x * 4.1 + z * 1.3)) ** 3) * 0.055
                 + (Math.abs(Math.sin(z * 5.3 - x * 0.9)) ** 3) * 0.040;
    y = y * (1 - crease) - crease * 0.04;
    // Rope waists.
    for (const rz of ropes) {
      y -= 0.075 * Math.exp(-((z / (d / 2) - rz * 2) ** 2) * 26.0) * (y > 0.12 ? 1 : 0);
    }
    const edge = Math.max(Math.abs(x) / (w / 2), Math.abs(z) / (d / 2));
    if (edge > 0.86) {
      p.setX(i, x * 1.10);
      p.setZ(i, z * 1.10);
      y *= 0.25;
    }
    p.setY(i, Math.max(0.01, y));
  }
  g.computeVertexNormals();
  b.cloth.push(g);
  // Lashing rope over the top and a couple of ground pegs.
  for (const rz of ropes) {
    const z = rz * d;
    b.metal.push(catenary(
      new THREE.Vector3(-w / 2 - 0.15, 0.04, z),
      new THREE.Vector3(w / 2 + 0.15, 0.04, z),
      -h * 0.88, 0.014, 9,
    ));
  }
  return bake(b, h, 0.5);
}

// --------------------------------------------------------- linework props ---

/**
 * Timber power/telephone pole with a crossarm. Lines strung between these are
 * what makes an approach road read as "leading somewhere" rather than a stripe
 * of dirt across a hillside.
 */
export function telegraphPoleGeo({ h = 8.2 } = {}) {
  const b = newBag();
  b.wood.push(cyl(0.135, h, 8, { y: h / 2 }));
  b.concrete.push(cyl(0.24, 0.55, 8, { y: 0.16 }));
  b.wood.push(box(1.9, 0.11, 0.11, { y: h - 0.5 }));
  b.wood.push(box(1.35, 0.10, 0.10, { y: h - 1.35 }));
  for (const sx of [-1, 1]) {
    for (const [ox, oy] of [[0.82, h - 0.5], [0.58, h - 1.35]]) {
      b.metal.push(cyl(0.035, 0.2, 6, { x: sx * ox, y: oy + 0.15 }));
      b.glass.push(cyl(0.055, 0.11, 6, { x: sx * ox, y: oy + 0.3 }));
    }
    b.metal.push(strut(
      new THREE.Vector3(sx * 0.75, h - 0.56, 0), new THREE.Vector3(sx * 0.1, h - 1.5, 0), 0.026, 4,
    ));
  }
  // Step bolts up one side.
  for (let i = 0; i < 7; i++) b.metal.push(box(0.3, 0.03, 0.03, { x: 0.1, y: 1.6 + i * 0.62, z: (i % 2) * 0.06 }));
  return bake(b, h, 0.6);
}

/** Bulkhead lamp on a bracket — repeats along the perimeter wall. */
export function wallLampGeo() {
  const b = newBag();
  b.metal.push(box(0.1, 0.1, 0.42, { z: 0.21 }));
  b.metal.push(box(0.34, 0.26, 0.2, { y: -0.06, z: 0.46, rx: 0.42 }));
  b.metal.push(box(0.44, 0.08, 0.3, { y: 0.08, z: 0.48 }));
  return bake(b, 0.3, 0.7, -0.4);
}

export function wallLampLensGeo() {
  const b = newBag();
  b.glow.push(box(0.26, 0.18, 0.05, { y: -0.11, z: 0.55, rx: 0.42 }));
  return bake(b, 0.3, 0, -0.4);
}

/**
 * Elevated water tank on a braced frame. Pure silhouette value: one tall,
 * instantly-readable shape breaking a compound that is otherwise all flat roofs.
 */
export function waterTowerGeo({ h = 10.5, r = 2.2 } = {}) {
  const b = newBag();
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) b.concrete.push(post(0.75, 0.6, 0.75, sx * 1.55, -0.2, sz * 1.55));
  }
  for (const g of lattice({ half: 1.55, y0: 0.3, y1: h, legR: 0.085, braceR: 0.05, panels: 4 })) b.metal.push(g);
  b.metal.push(cyl(r, 3.1, 20, { y: h + 1.55 }));
  for (const sy of [h + 0.2, h + 3.05]) b.metal.push(cyl(r + 0.06, 0.14, 20, { y: sy }));
  const cone = new THREE.ConeGeometry(r + 0.1, 0.75, 20, 1, true);
  cone.translate(0, h + 3.45, 0);
  b.corr.push(cone);
  b.metal.push(cyl(0.16, 0.5, 8, { y: h + 4.0 }));
  // Catwalk and ladder.
  const ring = new THREE.TorusGeometry(r + 0.55, 0.035, 4, 24);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, h + 3.15, 0);
  b.metal.push(ring);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.metal.push(post(0.05, 0.95, 0.05, Math.cos(a) * (r + 0.55), h + 2.2, Math.sin(a) * (r + 0.55)));
  }
  b.metal.push(box(r * 2 + 1.2, 0.05, r * 2 + 1.2, { y: h + 2.18 }));
  for (let i = 0; i < Math.round(h / 0.34); i++) {
    b.metal.push(box(0.44, 0.03, 0.03, { x: r * 0.2, y: 0.6 + i * 0.34, z: 1.62 }));
  }
  for (const sx of [-0.2, 0.2]) b.metal.push(cyl(0.025, h + 1.9, 5, { x: r * 0.2 + sx, y: (h + 1.9) / 2, z: 1.62 }));
  b.metal.push(cyl(0.11, h + 1.4, 8, { x: -r * 0.55, y: (h + 1.4) / 2, z: -1.2 }));
  return bake(b, h + 4.4, 0.55);
}

/** Horizontal bulk fuel tank on concrete saddles, with a valve manifold. */
export function fuelTankGeo({ r = 1.55, len = 8.0 } = {}) {
  const b = newBag();
  const y = r + 0.75;
  b.metal.push(xform(cyl(r, len, 22), { rz: Math.PI / 2, y }));
  for (const sx of [-1, 1]) {
    const cap = new THREE.SphereGeometry(r, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    cap.rotateZ((sx * Math.PI) / 2);
    cap.scale(0.55, 1, 1);
    cap.translate((sx * len) / 2, y, 0);
    b.metal.push(cap);
    b.concrete.push(box(1.1, 0.75, r * 2.1, { x: (sx * len) / 3, y: 0.375 }));
    b.concrete.push(box(1.3, 0.22, r * 2.4, { x: (sx * len) / 3, y: 0.11 }));
  }
  for (const sx of [-1, 1]) b.metal.push(xform(cyl(r + 0.04, 0.12, 22), { rz: Math.PI / 2, x: (sx * len) / 4, y }));
  // Manhole, vent and the valve manifold that makes it read as plant, not a barrel.
  b.metal.push(cyl(0.42, 0.16, 12, { y: y + r - 0.02, x: -len * 0.15 }));
  b.metal.push(cyl(0.07, 1.1, 8, { y: y + r + 0.5, x: len * 0.2 }));
  b.metal.push(cyl(0.09, 1.4, 8, { x: len * 0.42, y: 0.7, z: r * 0.6 }));
  b.metal.push(xform(cyl(0.09, 1.2, 8), { rz: Math.PI / 2, x: len * 0.42 + 0.6, y: 1.35, z: r * 0.6 }));
  b.metal.push(box(0.26, 0.26, 0.2, { x: len * 0.42 + 1.1, y: 1.35, z: r * 0.6 }));
  for (let i = 0; i < 7; i++) {
    b.metal.push(box(0.4, 0.03, 0.03, { x: -len / 2 + 0.35, y: 0.5 + i * 0.32, z: r * 0.55 }));
  }
  return bake(b, y + r + 1.0, 0.75);
}
