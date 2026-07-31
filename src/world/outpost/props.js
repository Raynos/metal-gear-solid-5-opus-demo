import * as THREE from 'three';
import { box, post, cyl, strut, xform, flip, bakeWeather, merge, lattice, catenary } from './geo.js';
import { newBag } from './buildings.js';

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
      b.metal.push(cyl(0.026, H - 0.4, 6, { x: dx + 0.05, y: y0 + H / 2, z: rz }));
      b.metal.push(box(0.09, 0.19, 0.07, { x: dx + 0.08, y: y0 + H / 2 - 0.1, z: rz }));
    }
    for (const sy of [y0 + 0.45, y0 + H - 0.45]) {
      b.metal.push(box(0.11, 0.1, 0.09, { x: dx + 0.03, y: sy, z: sz * (W / 2 - 0.12) }));
    }
  }
  return bake(b, y0 + H, 0.5);
}

// ------------------------------------------------------------------ drums ---

/** 200 litre steel drum with rolling hoops. */
export function drumGeo() {
  const b = newBag();
  const r = 0.293;
  const h = 0.88;
  b.metal.push(cyl(r, h, 16, { y: h / 2 }));
  for (const sy of [h * 0.3, h * 0.7]) b.metal.push(cyl(r + 0.022, 0.055, 16, { y: sy }));
  b.metal.push(cyl(r + 0.012, 0.045, 16, { y: h - 0.02 }));
  b.metal.push(cyl(r + 0.012, 0.045, 16, { y: 0.02 }));
  b.metal.push(cyl(0.05, 0.03, 8, { x: r * 0.55, y: h + 0.005 }));
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
  for (const sx of [-1, 1]) b.wood.push(box(t * 1.6, h, d, { x: sx * (w / 2 - t * 0.6), y: h / 2 }));
  for (const sz of [-1, 1]) b.wood.push(box(w, h, t * 1.6, { z: sz * (d / 2 - t * 0.6), y: h / 2 }));
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

export function tyreGeo() {
  const b = newBag();
  const g = new THREE.TorusGeometry(0.42, 0.155, 7, 16);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0.155, 0);
  b.rubber.push(g);
  return bake(b, 0.31, 0.5);
}

/** Broken slab and rubble — scattered where concrete has been knocked about. */
export function rubbleGeo(seed = 1) {
  const b = newBag();
  let s = seed >>> 0;
  const r = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 1) >>> 0) / 4294967296);
  const g = new THREE.IcosahedronGeometry(0.30, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, p.getX(i) * (0.7 + r() * 0.8), p.getY(i) * (0.34 + r() * 0.34), p.getZ(i) * (0.7 + r() * 0.8));
  }
  g.computeVertexNormals();
  g.translate(0, 0.09, 0);
  b.concrete.push(g);
  return bake(b, 1.6, 0.9, -1.4);
}

/**
 * Sandbag: a slumped, boxy pillow rather than a pebble. The superellipsoid
 * exponent is the whole trick — a plain squashed sphere stacks into a pile of
 * eggs, whereas flattening the sides lets a course read as masonry.
 */
export function sandbagGeo() {
  const b = newBag();
  // 8x5 is the floor before the superellipse pinch stops reading; 1200 bags
  // shipped 100 triangles each into the main pass and three shadow cascades.
  const g = new THREE.SphereGeometry(1, 8, 5);
  const p = g.attributes.position;
  const box3 = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const pinch = 1.0 - 0.22 * Math.pow(Math.abs(x), 2.2);
    p.setXYZ(i, box3(x, 0.62) * 0.28, box3(y, 0.55) * 0.098 * pinch, box3(z, 0.62) * 0.165 * pinch);
  }
  g.computeVertexNormals();
  g.translate(0, 0.098, 0);
  b.cloth.push(g);
  return bake(b, 0.196, 0.45, -0.09);
}

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
 * Ural-style 6x6 cargo truck. Big, boxy, high-clearance — the silhouette that
 * says "Soviet military" faster than any decal could.
 */
export function truckGeo({ tilt = true } = {}) {
  const b = newBag();
  const wheelR = 0.62;
  const axleY = wheelR;

  // Chassis.
  for (const sz of [-1, 1]) b.metal.push(box(6.9, 0.2, 0.15, { y: 0.78, z: sz * 0.44 }));
  b.metal.push(box(0.5, 0.16, 0.95, { x: -2.0, y: 0.78 }));

  // Cab: lower body, glazed band, roof.
  b.metal.push(box(2.0, 0.98, 2.32, { x: 2.3, y: 1.42 }));
  b.glass.push(box(1.86, 0.62, 2.2, { x: 2.3, y: 2.22 }));
  b.glass.push(box(1.9, 0.66, 0.05, { x: 3.26, y: 2.2 }));
  b.metal.push(box(2.1, 0.12, 2.4, { x: 2.3, y: 2.58 }));
  for (const sz of [-1, 1]) b.metal.push(box(2.0, 0.66, 0.06, { x: 2.3, y: 2.22, z: sz * 1.17 }));
  b.metal.push(box(0.08, 0.66, 2.2, { x: 1.31, y: 2.22 }));
  // Bonnet, grille, bumper, lights.
  b.metal.push(box(1.15, 0.82, 2.05, { x: 3.9, y: 1.5 }));
  b.metal.push(box(0.1, 0.66, 1.55, { x: 4.48, y: 1.42 }));
  for (let i = 0; i < 7; i++) b.metal.push(box(0.14, 0.6, 0.06, { x: 4.52, y: 1.42, z: -0.68 + i * 0.226 }));
  b.metal.push(box(0.2, 0.24, 2.3, { x: 4.55, y: 0.86 }));
  for (const sz of [-1, 1]) {
    b.metal.push(xform(cyl(0.16, 0.16, 10), { rz: Math.PI / 2, x: 4.46, y: 1.72, z: sz * 0.78 }));
    b.glow.push(xform(cyl(0.13, 0.05, 10), { rz: Math.PI / 2, x: 4.55, y: 1.72, z: sz * 0.78 }));
    // Fenders and mirrors.
    b.metal.push(box(1.35, 0.14, 0.62, { x: 3.55, y: 1.06, z: sz * 1.0 }));
    b.metal.push(strut(new THREE.Vector3(1.5, 2.35, sz * 1.2), new THREE.Vector3(1.75, 2.55, sz * 1.55), 0.028, 5));
    b.metal.push(box(0.06, 0.42, 0.22, { x: 1.78, y: 2.5, z: sz * 1.6 }));
  }
  // Fuel tank and exhaust.
  b.metal.push(xform(cyl(0.28, 1.1, 12), { rz: Math.PI / 2, x: 0.9, y: 0.85, z: -1.05 }));
  b.metal.push(cyl(0.075, 2.2, 8, { x: 1.25, y: 1.9, z: 1.02 }));

  // Cargo bed.
  const bedX = -1.5;
  b.wood.push(box(4.3, 0.14, 2.3, { x: bedX, y: 1.18 }));
  for (const sz of [-1, 1]) b.wood.push(box(4.3, 0.62, 0.09, { x: bedX, y: 1.55, z: sz * 1.15 }));
  b.wood.push(box(0.09, 0.75, 2.3, { x: bedX + 2.15, y: 1.62 }));
  b.wood.push(box(0.09, 0.6, 2.3, { x: bedX - 2.15, y: 1.5 }));
  for (const sz of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      b.metal.push(box(0.07, 0.75, 0.09, { x: bedX - 1.9 + i * 1.27, y: 1.6, z: sz * 1.2 }));
    }
  }

  if (tilt) {
    const canopy = new THREE.CylinderGeometry(1.22, 1.22, 4.3, 16, 1, true, 0, Math.PI);
    xform(canopy, { rz: Math.PI / 2, x: bedX, y: 1.9 });
    b.cloth.push(canopy);
    b.cloth.push(box(0.06, 1.25, 2.44, { x: bedX - 2.15, y: 1.9 }));
    for (let i = 0; i <= 4; i++) {
      const t = new THREE.TorusGeometry(1.22, 0.035, 4, 12, Math.PI);
      t.rotateY(Math.PI / 2);
      t.translate(bedX - 2.15 + i * 1.075, 1.9, 0);
      b.metal.push(t);
    }
  } else {
    b.rubber.push(xform(new THREE.TorusGeometry(0.44, 0.16, 6, 14), { x: bedX + 1.9, y: 1.72, z: -0.8 }));
  }

  // Wheels: one steer axle up front, a bogie at the back.
  for (const ax of [3.3, -1.35, -2.75]) {
    for (const sz of [-1, 1]) {
      const t = new THREE.TorusGeometry(0.44, 0.175, 7, 16);
      t.rotateY(Math.PI / 2);
      t.translate(ax, axleY, sz * 1.06);
      b.rubber.push(t);
      b.metal.push(xform(cyl(0.29, 0.34, 12), { rz: Math.PI / 2, x: ax, y: axleY, z: sz * 1.06 }));
      b.metal.push(xform(cyl(0.11, 0.4, 8), { rz: Math.PI / 2, x: ax, y: axleY, z: sz * 1.06 }));
    }
    b.metal.push(xform(cyl(0.09, 2.0, 8), { rz: Math.PI / 2, x: ax, y: axleY }));
    b.metal.push(box(0.5, 0.34, 0.44, { x: ax, y: axleY }));
  }
  return bake(b, 2.9, 0.45);
}

// ------------------------------------------------------------- camo netting --

/**
 * Camo net stretched over a frame, sagging between the poles. Alpha-tested so
 * light and shadow break through it — that dapple is most of the effect.
 */
export function camoNet({ w = 12, d = 9, h = 3.1, sag = 0.55 }) {
  const b = newBag();
  const nx = 10;
  const nz = 8;
  const g = new THREE.PlaneGeometry(w, d, nx, nz);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) / (w / 2);
    const z = p.getZ(i) / (d / 2);
    const s = Math.cos((x * Math.PI) / 2) * Math.cos((z * Math.PI) / 2);
    p.setY(i, h - sag * s - 0.25 * (1 - s));
  }
  g.computeVertexNormals();
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / 3.2), uv.getY(i) * (d / 3.2));
  b.net.push(g);
  // Skirts hanging off two edges.
  for (const sz of [-1, 1]) {
    const s = new THREE.PlaneGeometry(w, 1.0, nx, 2);
    const sp = s.attributes.position;
    for (let i = 0; i < sp.count; i++) {
      const yy = sp.getY(i);
      sp.setXYZ(i, sp.getX(i), h - 0.25 + yy - 0.5, sz * (d / 2) + Math.sin(sp.getX(i) * 0.9) * 0.12);
    }
    s.computeVertexNormals();
    const su = s.attributes.uv;
    for (let i = 0; i < su.count; i++) su.setXY(i, su.getX(i) * (w / 3.2), su.getY(i) * 0.5);
    b.net.push(s);
  }
  // Poles and guy lines.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.metal.push(post(0.09, h, 0.09, sx * (w / 2), 0, sz * (d / 2)));
      const a = new THREE.Vector3(sx * (w / 2), h, sz * (d / 2));
      const anch = new THREE.Vector3(sx * (w / 2 + 1.9), 0.05, sz * (d / 2 + 1.5));
      b.metal.push(strut(a, anch, 0.014, 4));
      b.metal.push(post(0.07, 0.35, 0.07, anch.x, 0, anch.z));
    }
  }
  b.metal.push(post(0.09, h + 0.2, 0.09, 0, 0, -d / 2));
  b.metal.push(post(0.09, h + 0.2, 0.09, 0, 0, d / 2));
  return bake(b, h + 0.4, 0.4);
}

/** A tarp thrown over a stack of stores, tied down at the corners. */
export function tarpGeo({ w = 2.6, d = 2.0, h = 1.3 }) {
  const b = newBag();
  const g = new THREE.PlaneGeometry(w, d, 8, 7);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = Math.abs(p.getX(i)) / (w / 2);
    const z = Math.abs(p.getZ(i)) / (d / 2);
    const r = Math.max(x, z);
    const dome = Math.cos(Math.min(1, r) * Math.PI * 0.5);
    const wrinkle = Math.sin(p.getX(i) * 5.0) * Math.cos(p.getZ(i) * 4.3) * 0.035;
    p.setY(i, h * dome + wrinkle);
    if (r > 0.92) {
      p.setX(i, p.getX(i) * 1.06);
      p.setZ(i, p.getZ(i) * 1.06);
    }
  }
  g.computeVertexNormals();
  b.cloth.push(g);
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
