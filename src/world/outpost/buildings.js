import * as THREE from 'three';
import { box, post, cyl, strut, wallRun, stairFlight, lattice, xform, bakeWeather } from './geo.js';

/**
 * Architecture.
 *
 * Human scale is the whole game here: doors are 2.1m, a storey is 3.2m, a
 * parapet is knee-to-waist, a window cill is 1.05m. Get those wrong by 20% and
 * the compound reads as a toy no matter how good the shading is. Every wall is a
 * solid of real thickness so openings get reveals and roofs get overhang shadow.
 *
 * Builders work in their own local frame — base at y=0, "front" facing +Z — and
 * return a bag of geometry grouped by material. `placeBag` moves a finished bag
 * into compound space.
 */

export const STOREY = 3.2;
export const DOOR_H = 2.1;
export const DOOR_W = 1.1;

const GEO_KEYS = [
  'concrete', 'masonry', 'metal', 'corr', 'wood', 'glass', 'glow', 'cloth', 'net',
  'rubber', 'paint', 'paintWarn', 'sign', 'dark', 'mil', 'dado',
];

/**
 * The painted socle, as geometry.
 *
 * Applied as a 30mm-proud skin rather than a shader band so it reads at any
 * distance: a slab of saturated ochre from the ground to 1.35m with a hard
 * top line is THE identifying mark of a Soviet institutional building, and it
 * also breaks the "one flat grey rectangle" read that the round-1 critics
 * pinned on every facade here.
 */
export function dadoSkin(b, { w, d, h = 1.35, out = 0.03, y = 0 }) {
  for (const sz of [-1, 1]) b.dado.push(box(w + out * 2, h, 0.05, { y: y + h / 2, z: sz * (d / 2 + out) }));
  for (const sx of [-1, 1]) b.dado.push(box(0.05, h, d + out * 2, { x: sx * (w / 2 + out), y: y + h / 2 }));
  // A cast bullnose at the head of the band — where the painter stopped.
  for (const sz of [-1, 1]) b.concrete.push(box(w + out * 2 + 0.10, 0.07, 0.12, { y: y + h + 0.03, z: sz * (d / 2 + out + 0.02) }));
  for (const sx of [-1, 1]) b.concrete.push(box(0.12, 0.07, d + out * 2 + 0.10, { x: sx * (w / 2 + out + 0.02), y: y + h + 0.03 }));
}

/**
 * Stencil atlas decal. `cell` indexes the 4x4 grid in `signTexture()`; the plane
 * is pushed 18mm off the face so it never z-fights and picks up its own sliver
 * of contact shadow at grazing sun.
 */
export function signPlane(b, { x, y, z, faceZ = 1, w = 1.4, h = 1.4, cell = 0, ry = null, rz = 0, dx = 0 }) {
  const g = new THREE.PlaneGeometry(w, h, 1, 1);
  const uv = g.attributes.uv;
  const cx = cell % 4;
  const cy = 3 - Math.floor(cell / 4);
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (cx + uv.getX(i) * 0.94 + 0.03) / 4, (cy + uv.getY(i) * 0.94 + 0.03) / 4);
  }
  xform(g, { rz, ry: ry ?? (faceZ > 0 ? 0 : Math.PI), x: x + dx, y, z: z + (ry === null ? faceZ * 0.018 : 0) });
  b.sign.push(g);
  return g;
}

export function newBag() {
  const b = {};
  for (const k of GEO_KEYS) b[k] = [];
  b.lights = [];
  b.interest = [];
  return b;
}

export function mergeBags(dst, src) {
  for (const k of Object.keys(src)) {
    if (!dst[k]) dst[k] = [];
    for (const item of src[k]) dst[k].push(item);
  }
  return dst;
}

/** Bake weathering on every geometry in a bag against the structure's own extent. */
function bakeBag(b, y1, wear = 0, y0 = 0) {
  for (const k of GEO_KEYS) for (const g of b[k]) bakeWeather(g, { y0, y1, wear });
  return b;
}

/** Transform a finished bag into compound-local space. */
export function placeBag(dst, src, { u = 0, v = 0, y = 0, ry = 0 } = {}) {
  const cs = Math.cos(ry);
  const sn = Math.sin(ry);
  for (const k of Object.keys(src)) {
    if (!dst[k]) dst[k] = [];
    for (const item of src[k]) {
      if (item && item.isBufferGeometry) {
        xform(item, { ry });
        item.translate(u, y, v);
        dst[k].push(item);
      } else if (item && item.pos) {
        const p = item.pos;
        dst[k].push({
          ...item,
          pos: new THREE.Vector3(p.x * cs + p.z * sn + u, p.y + y, -p.x * sn + p.z * cs + v),
          ry: (item.ry ?? 0) + ry,
        });
      }
    }
  }
  return dst;
}

// ---------------------------------------------------------------- fittings ---

/**
 * A glazed opening: recessed pane, protruding cill, and usually a welded grille.
 * Returns the opening spec so the wall run can punch a hole for it.
 */
function windowUnit(b, { x, y, z, w, h, faceZ = 1, lit = false, barred = true, boarded = false, wallT, shell = 'concrete' }) {
  const inset = 0.17;
  const zp = z + faceZ * (wallT / 2 - inset);
  // A painted timber frame in the reveal, with a transom and a mullion. Round 1
  // shipped an unframed black rectangle, which reads as a hole cut in cardboard:
  // a real window is four bright edges around a dark centre, and it is the BRIGHT
  // EDGE the eye uses to decide the wall has thickness.
  const fr = 0.055;
  for (const sx of [-1, 1]) {
    b.paint.push(box(fr, h - 0.02, 0.075, { x: x + sx * (w / 2 - fr / 2 - 0.02), y: y + h / 2, z: zp + faceZ * 0.03 }));
  }
  for (const sy of [0.02, h - 0.02]) {
    b.paint.push(box(w - 0.04, fr, 0.075, { x, y: y + sy, z: zp + faceZ * 0.03 }));
  }
  b.paint.push(box(0.042, h - 0.1, 0.06, { x, y: y + h / 2, z: zp + faceZ * 0.03 }));
  b.paint.push(box(w - 0.12, 0.042, 0.06, { x, y: y + h * 0.62, z: zp + faceZ * 0.03 }));
  // The room behind. Without something occupying the reveal the pane reads as a
  // decal; a dark card 200mm back gives it parallax and a believable interior.
  b.dark.push(box(w - 0.06, h - 0.06, 0.04, { x, y: y + h / 2, z: zp - faceZ * 0.20 }));
  (lit ? b.glow : b.glass).push(box(w - 0.10, h - 0.10, 0.02, { x, y: y + h / 2, z: zp }));
  // Cill throws water clear of the wall — and seeds the dirt streak below it.
  b[shell].push(box(w + 0.30, 0.075, wallT + 0.22, { x, y: y - 0.038, z: z + faceZ * 0.02, rx: faceZ * 0.035 }));
  b[shell].push(box(w + 0.24, 0.115, wallT + 0.12, { x, y: y + h + 0.058, z }));
  if (boarded) {
    for (let i = 0; i < 3; i++) {
      b.wood.push(box(w + 0.06, (h - 0.06) / 3 - 0.03, 0.035, {
        x, y: y + 0.05 + ((h - 0.1) / 3) * (i + 0.5), z: z + faceZ * (wallT / 2 + 0.02), rz: (i - 1) * 0.02,
      }));
    }
  } else if (barred) {
    const zb = z + faceZ * (wallT / 2 - 0.06);
    const n = Math.max(2, Math.round(w / 0.24));
    for (let i = 1; i < n; i++) {
      b.metal.push(cyl(0.014, h - 0.05, 5, { x: x - w / 2 + (w * i) / n, y: y + h / 2, z: zb }));
    }
    b.metal.push(xform(cyl(0.014, w - 0.05, 5), { rz: Math.PI / 2, x, y: y + h / 2, z: zb }));
  }
  return { x, w, y0: y, h };
}

/** Steel door in a framed opening, with a concrete threshold outside. */
function doorUnit(b, { x, z, faceZ = 1, wallT, w = DOOR_W, h = DOOR_H, doubleLeaf = false, shell = 'concrete' }) {
  const zp = z + faceZ * (wallT / 2 - 0.11);
  b.dark.push(box(w - 0.02, h - 0.02, 0.03, { x, y: h / 2, z: zp - faceZ * 0.22 }));
  if (doubleLeaf) {
    for (const sx of [-1, 1]) {
      b.paint.push(box(w / 2 - 0.03, h - 0.05, 0.055, { x: x + sx * w / 4, y: h / 2, z: zp }));
      // Braced ledge boarding on the leaf face, and a hinge set.
      for (const sy of [0.34, h - 0.34]) {
        b.metal.push(box(w / 2 - 0.10, 0.06, 0.022, { x: x + sx * w / 4, y: sy, z: zp + faceZ * 0.04 }));
      }
      for (const sy of [0.42, h - 0.42]) {
        b.metal.push(box(0.10, 0.11, 0.06, { x: x + sx * (w / 2 - 0.06), y: sy, z: zp + faceZ * 0.03 }));
      }
    }
    b.metal.push(cyl(0.020, 0.30, 5, { x: x - 0.07, y: 1.04, z: zp + faceZ * 0.06 }));
    b.metal.push(cyl(0.020, 0.30, 5, { x: x + 0.07, y: 1.04, z: zp + faceZ * 0.06 }));
  } else {
    b.paint.push(box(w - 0.06, h - 0.05, 0.055, { x, y: h / 2, z: zp }));
    for (const sy of [0.36, h - 0.36]) {
      b.metal.push(box(w - 0.16, 0.055, 0.022, { x, y: sy, z: zp + faceZ * 0.04 }));
      b.metal.push(box(0.10, 0.11, 0.06, { x: x - w / 2 + 0.07, y: sy, z: zp + faceZ * 0.03 }));
    }
    b.metal.push(xform(cyl(0.022, 0.16, 5), { rz: Math.PI / 2, x: x + w / 2 - 0.18, y: 1.02, z: zp + faceZ * 0.05 }));
  }
  const zf = z + faceZ * (wallT / 2 + 0.02);
  b[shell].push(box(w + 0.26, 0.11, 0.07, { x, y: h + 0.055, z: zf }));
  b[shell].push(box(0.11, h + 0.11, 0.07, { x: x - w / 2 - 0.075, y: (h + 0.11) / 2, z: zf }));
  b[shell].push(box(0.11, h + 0.11, 0.07, { x: x + w / 2 + 0.075, y: (h + 0.11) / 2, z: zf }));
  b.concrete.push(box(w + 0.75, 0.15, 0.9, { x, y: 0.075, z: z + faceZ * (wallT / 2 + 0.45) }));
  b.interest.push({ pos: new THREE.Vector3(x, 0, z + faceZ * (wallT / 2 + 1.5)), kind: 'door' });
  return { x, w, y0: 0, h };
}

/** Parapet + coping + scuppers + downpipes on a flat roof. */
function parapet(b, { w, d, y, t = 0.17, h = 0.55 }) {
  const runs = [
    { len: w, ry: 0, x: 0, z: d / 2 - t / 2, cap: w + t * 2 },
    { len: w, ry: 0, x: 0, z: -d / 2 + t / 2, cap: w + t * 2 },
    { len: d - t * 2, ry: Math.PI / 2, x: w / 2 - t / 2, z: 0, cap: d - t * 2 },
    { len: d - t * 2, ry: Math.PI / 2, x: -w / 2 + t / 2, z: 0, cap: d - t * 2 },
  ];
  for (const s of runs) {
    for (const g of wallRun(s.len, h, t, [])) b.concrete.push(xform(g, { ry: s.ry, x: s.x, y, z: s.z }));
    b.concrete.push(xform(box(s.cap, 0.075, t + 0.14), { ry: s.ry, x: s.x, y: y + h + 0.037, z: s.z }));
  }
  // Two scuppers and their downpipes — the origin of the vertical staining.
  for (const sx of [-w * 0.31, w * 0.33]) {
    b.metal.push(xform(cyl(0.05, 0.44, 6), { rx: Math.PI / 2, x: sx, y: y + 0.11, z: d / 2 + 0.06 }));
    b.metal.push(cyl(0.055, y - 0.3, 6, { x: sx, y: (y - 0.3) / 2 + 0.15, z: d / 2 + 0.07 }));
    for (let k = 0; k < 3; k++) b.metal.push(box(0.17, 0.05, 0.05, { x: sx, y: 0.9 + k * 1.6, z: d / 2 + 0.03 }));
  }
}

// ------------------------------------------------------------- blockhouse ---

/** Two-storey command block: flat roof, parapet, external roof stair. */
export function blockhouse({ w = 18, d = 13, storeys = 2, wallT = 0.30, rng, litFrac = 0.55 } = {}) {
  const b = newBag();
  const H = storeys * STOREY;

  b.concrete.push(box(w + 0.5, 0.44, d + 0.5, { y: 0.22 }));
  b.concrete.push(box(w - 0.2, 0.3, d - 0.2, { y: 0.5 }));

  const frontOpen = [];
  const backOpen = [];
  const door = doorUnit(b, { x: -w / 2 + 2.8, z: d / 2 - wallT / 2, wallT, w: 1.35, h: DOOR_H, doubleLeaf: true });
  frontOpen.push(door);

  const nWin = Math.max(4, Math.round((w - 5.5) / 2.55));
  for (let s = 0; s < storeys; s++) {
    for (let i = 0; i < nWin; i++) {
      const x = -w / 2 + 4.8 + (i * (w - 6.6)) / Math.max(1, nWin - 1);
      const y = s * STOREY + (s === 0 ? 1.36 : 1.05);
      if (!(s === 0 && Math.abs(x - door.x) < 1.7)) {
        frontOpen.push(windowUnit(b, {
          x, y, z: d / 2 - wallT / 2, w: 1.35, h: 1.42, faceZ: 1, wallT,
          lit: rng.chance(litFrac), boarded: rng.chance(0.10), barred: rng.chance(0.75),
        }));
      }
      backOpen.push(windowUnit(b, {
        x, y, z: -(d / 2 - wallT / 2), w: 1.35, h: 1.42, faceZ: -1, wallT,
        lit: rng.chance(litFrac * 0.5), boarded: rng.chance(0.18), barred: rng.chance(0.6),
      }));
    }
  }

  // Side-wall fittings are authored in a scratch bag at the origin, then rotated
  // into the correct face — same window code, no duplicated maths.
  for (const sx of [-1, 1]) {
    const sb = newBag();
    const openings = [];
    for (let s = 0; s < storeys; s++) {
      for (let i = 0; i < 2; i++) {
        const along = -d / 4 + (i * d) / 2;
        openings.push(windowUnit(sb, {
          x: along, y: s * STOREY + (s === 0 ? 1.36 : 1.05), z: 0, w: 1.2, h: 1.35, faceZ: 1, wallT,
          lit: rng.chance(litFrac * 0.45), barred: true,
        }));
      }
    }
    for (const g of wallRun(d - wallT * 2, H, wallT, openings)) sb.concrete.push(g);
    placeBag(b, sb, { u: sx * (w / 2 - wallT / 2), ry: sx * Math.PI * 0.5 });
  }

  for (const g of wallRun(w, H, wallT, frontOpen)) b.concrete.push(xform(g, { z: d / 2 - wallT / 2 }));
  for (const g of wallRun(w, H, wallT, backOpen)) b.concrete.push(xform(g, { z: -(d / 2 - wallT / 2) }));

  // Corner pilasters, bay pilasters and storey string courses. Vertical rhythm is
  // what stops a big shaded facade reading as one flat grey rectangle — it is
  // doing more work here than any amount of shader detail.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) b.concrete.push(post(0.74, H, 0.74, sx * (w / 2 - 0.02), 0.4, sz * (d / 2 - 0.02)));
  }
  const bayN = nWin + 1;
  const bayStep = (w - 6.6) / Math.max(1, nWin - 1);
  for (let i = 1; i < bayN; i++) {
    const x = -w / 2 + 4.8 - bayStep / 2 + (i * (w - 6.6 + bayStep)) / bayN;
    for (const sz of [-1, 1]) {
      b.concrete.push(post(0.56, H - 0.15, 0.44, x, 0.4, sz * (d / 2 + 0.20)));
      b.concrete.push(box(0.70, 0.14, 0.52, { x, y: H - 0.2, z: sz * (d / 2 + 0.22) }));
    }
  }
  // Canopy over the ground floor and surface-run conduit: the sort of afterthought
  // ironmongery that makes a facade look built-and-modified rather than modelled.
  b.concrete.push(box(w * 0.62, 0.16, 0.72, { x: -w * 0.06, y: STOREY - 0.55, z: d / 2 + 0.3 }));
  for (let i = 0; i < 4; i++) {
    b.metal.push(strut(
      new THREE.Vector3(-w * 0.06 - w * 0.27 + (i * w * 0.54) / 3, STOREY - 0.62, d / 2 + 0.62),
      new THREE.Vector3(-w * 0.06 - w * 0.27 + (i * w * 0.54) / 3, STOREY - 1.5, d / 2 + 0.16),
      0.032, 5,
    ));
  }
  for (const cx2 of [-w * 0.42, w * 0.18]) {
    b.metal.push(cyl(0.045, H - 0.6, 6, { x: cx2, y: (H - 0.6) / 2 + 0.4, z: d / 2 + 0.2 }));
    for (let k = 0; k < 4; k++) b.metal.push(box(0.14, 0.05, 0.05, { x: cx2, y: 1.2 + k * 1.5, z: d / 2 + 0.14 }));
  }
  signPlane(b, { x: door.x, y: DOOR_H + 0.78, z: d / 2 + 0.17, w: 2.4, h: 0.8, cell: 2 });
  signPlane(b, { x: -(w / 2 + 0.42), y: 4.15, z: 0, ry: -Math.PI / 2, w: 1.9, h: 1.9, cell: 12 });
  signPlane(b, { x: w / 2 + 0.42, y: 4.15, z: d * 0.24, ry: Math.PI / 2, w: 1.7, h: 1.7, cell: 10 });
  // Storey string courses, thrown well clear of the wall so they cast a hard
  // band of shadow across the elevation at every sun angle. This is the cheapest
  // way to stop a two-storey facade reading as one flat rectangle.
  for (let s = 1; s < storeys; s++) b.concrete.push(box(w + 0.62, 0.26, d + 0.62, { y: s * STOREY - 0.10 }));
  b.concrete.push(box(w + 0.34, 0.15, d + 0.34, { y: 0.95 }));
  dadoSkin(b, { w: w + 0.06, d: d + 0.06, h: 0.78, y: 0.52 });

  const roofY = H;
  // Deep cornice: the biggest single shadow on the building.
  b.concrete.push(box(w + 0.92, 0.30, d + 0.92, { y: roofY + 0.15 }));
  b.concrete.push(box(w + 0.52, 0.22, d + 0.52, { y: roofY + 0.41 }));
  parapet(b, { w: w + 0.36, d: d + 0.36, y: roofY + 0.52 });

  // Roof furniture: vent cowls and a water tank on a stand.
  for (let i = 0; i < 3; i++) {
    const vx = -w / 2 + 3 + i * 4.2;
    b.metal.push(cyl(0.17, 0.62, 8, { x: vx, y: roofY + 0.65, z: -d / 4 }));
    b.metal.push(cyl(0.26, 0.07, 8, { x: vx, y: roofY + 0.99, z: -d / 4 }));
  }
  const tx = w / 2 - 2.8;
  const tz = d / 4;
  b.metal.push(cyl(0.85, 1.25, 12, { x: tx, y: roofY + 1.6, z: tz }));
  b.metal.push(cyl(0.88, 0.06, 12, { x: tx, y: roofY + 2.24, z: tz }));
  for (const sx of [-0.62, 0.62]) {
    for (const sz of [-0.62, 0.62]) b.metal.push(post(0.09, 0.98, 0.09, tx + sx, roofY + 0.34, tz + sz));
  }

  // External steel stair to the roof on the blind face.
  for (let f = 0; f < storeys; f++) {
    const fwd = f % 2 === 0;
    for (const g of stairFlight({ rise: STOREY, run: 3.3, width: 1.05 })) {
      b.metal.push(xform(g, {
        ry: fwd ? 0 : Math.PI,
        x: -(w / 2 + 1.95),
        y: f * STOREY + 0.44,
        z: fwd ? -d / 2 + 0.8 : -d / 2 + 4.1,
      }));
    }
    b.metal.push(box(2.5, 0.09, 1.4, {
      x: -(w / 2 + 1.95), y: (f + 1) * STOREY + 0.40, z: fwd ? -d / 2 + 4.8 : -d / 2 + 0.1,
    }));
  }

  b.lights.push({ pos: new THREE.Vector3(door.x + 1.4, DOOR_H + 0.7, d / 2 + 0.2), kind: 'wall' });
  b.interest.push({ pos: new THREE.Vector3(0, roofY + 0.4, 0), kind: 'roof' });
  return bakeBag(b, roofY + 2.4, 0.15);
}

// ---------------------------------------------------------------- barracks --

/**
 * Single-storey hut.
 *
 * `style` is the whole point of this function. A real garrison is built in
 * phases by whoever had materials that decade: the original 1960s blockwork
 * barrack, a 1970s in-situ concrete one next to it, and a 1980s steel shed
 * thrown up on a slab when the establishment grew. Round 1 shipped three
 * identical parallel bars, which is the single loudest "procedural" tell on the
 * site, so the three now differ in structure, cladding, roof form, height,
 * fenestration rhythm and silhouette — not just in noise seed.
 *
 *   masonry  — whitewashed block, painted dado, pitched corrugated roof, gables
 *   concrete — bare in-situ concrete, expressed frame, shallow mono-pitch, parapet
 *   steel    — later addition: portal frame, corrugated cladding, roller shutter
 */
export function barracks({
  w = 26, d = 10, wallT = 0.26, rng, litFrac = 0.4, style = 'masonry', signCell = 0, lean = false,
} = {}) {
  if (style === 'steel') return steelShed({ w, d, rng, litFrac, signCell });
  if (style === 'concrete') return concreteHut({ w, d, wallT, rng, litFrac, signCell, lean });
  const b = newBag();
  const shell = 'masonry';
  const H = 3.05;
  const pitch = 0.17;
  const beamTop = H + 0.18;
  const riseW = (d / 2) * pitch;
  const ridgeY = beamTop + riseW;
  const eaveZ = d / 2 + 0.6;
  const eaveY = ridgeY - eaveZ * pitch;
  const ang = Math.atan(pitch);

  b.concrete.push(box(w + 0.46, 0.4, d + 0.46, { y: 0.2 }));
  b.concrete.push(box(w - 0.2, 0.28, d - 0.2, { y: 0.48 }));

  const frontOpen = [];
  const backOpen = [];
  const door = doorUnit(b, { x: -w / 2 + 2.3, z: d / 2 - wallT / 2, wallT, w: 1.05, shell });
  frontOpen.push(door);
  // Fenestration rhythm is per-building: a paired-window barrack and an
  // evenly-spaced one are read as different buildings from 80m even when the
  // cladding is identical.
  const nWin = Math.max(4, Math.round((w - 6) / 3.0));
  const paired = rng.chance(0.5);
  for (let i = 0; i < nWin; i++) {
    const t = i / Math.max(1, nWin - 1);
    const x = -w / 2 + 4.8 + (paired ? (t + (i % 2 ? 0.10 : -0.10) / nWin) : t) * (w - 7.4);
    frontOpen.push(windowUnit(b, {
      x, y: 1.30, z: d / 2 - wallT / 2, w: 1.25, h: 1.30, faceZ: 1, wallT, shell,
      lit: rng.chance(litFrac), boarded: rng.chance(0.12), barred: rng.chance(0.4),
    }));
    backOpen.push(windowUnit(b, {
      x, y: 1.30, z: -(d / 2 - wallT / 2), w: 1.25, h: 1.30, faceZ: -1, wallT, shell,
      lit: rng.chance(litFrac * 0.45), boarded: rng.chance(0.2), barred: rng.chance(0.4),
    }));
  }

  for (const g of wallRun(w, H, wallT, frontOpen)) b[shell].push(xform(g, { z: d / 2 - wallT / 2 }));
  for (const g of wallRun(w, H, wallT, backOpen)) b[shell].push(xform(g, { z: -(d / 2 - wallT / 2) }));
  for (const sx of [-1, 1]) {
    for (const g of wallRun(d - wallT * 2, H, wallT, [])) {
      b[shell].push(xform(g, { ry: sx * Math.PI * 0.5, x: sx * (w / 2 - wallT / 2) }));
    }
  }
  b.concrete.push(box(w + 0.32, 0.18, d + 0.32, { y: H + 0.09 }));
  // Bay piers between the windows and a plinth band, both of which catch a rim
  // of light on an otherwise dead facade.
  for (let i = 0; i <= nWin; i++) {
    const x = -w / 2 + 3.1 + (i * (w - 6.2)) / nWin;
    for (const sz of [-1, 1]) b[shell].push(post(0.32, H - 0.1, 0.14, x, 0, sz * (d / 2 + 0.06)));
  }
  b.concrete.push(box(w + 0.2, 0.12, d + 0.2, { y: 0.72 }));
  // Painted socle band with a cast-in drip, then the number on the gable end.
  b.concrete.push(box(w + 0.34, 0.07, d + 0.34, { y: 1.22 }));
  signPlane(b, { x: w / 2 + 0.03, y: 1.95, z: 0, ry: Math.PI / 2, w: 2.0, h: 2.0, cell: signCell });
  signPlane(b, { x: -(w / 2 + 0.03), y: 2.00, z: -d * 0.12, ry: -Math.PI / 2, w: 2.3, h: 1.0, cell: 0 });
  signPlane(b, { x: door.x, y: DOOR_H + 0.92, z: d / 2 + 0.03, w: 1.7, h: 0.55, cell: 7 });

  // Gable infill: a real triangular prism, not a flat card.
  const shape = new THREE.Shape();
  shape.moveTo(-(d / 2), 0);
  shape.lineTo(d / 2, 0);
  shape.lineTo(0, riseW);
  shape.lineTo(-(d / 2), 0);
  for (const sx of [-1, 1]) {
    const g = new THREE.ExtrudeGeometry(shape, { depth: wallT, bevelEnabled: false });
    g.rotateY(Math.PI / 2);
    g.translate(sx * (w / 2 - wallT / 2) - wallT / 2, beamTop, 0);
    b[shell].push(g);
  }

  // Rainwater goods. Every bracket is an origin for a rust run, and the gutter
  // outlet is where the big dark stain on the wall below actually comes from.
  for (const sx of [-1, 1]) {
    const px = sx * (w / 2 - 0.55);
    b.metal.push(cyl(0.05, H - 0.15, 6, { x: px, y: (H - 0.15) / 2, z: d / 2 + 0.13 }));
    b.metal.push(xform(cyl(0.05, 0.75, 6), { rz: 0.9, x: px, y: H + 0.24, z: d / 2 + 0.20 }));
    for (let k = 0; k < 3; k++) b.metal.push(box(0.16, 0.045, 0.045, { x: px, y: 0.7 + k * 1.0, z: d / 2 + 0.08 }));
    b.metal.push(box(0.30, 0.10, 0.30, { x: px, y: 0.14, z: d / 2 + 0.16 }));
  }
  if (lean) {
    // A lean-to store tacked on the blind end — nothing says "grew over thirty
    // years" like an outbuilding that does not match the building it leans on.
    const lw = 3.4;
    const lh = 2.35;
    for (const g of wallRun(lw, lh, 0.18, [])) b.corr.push(xform(g, { x: -w / 2 - lw / 2, z: d / 2 - 1.5 }));
    for (const g of wallRun(3.0, lh, 0.18, [])) b.corr.push(xform(g, { ry: Math.PI / 2, x: -w / 2 - lw, z: 0 }));
    b.corr.push(xform(box(lw + 0.4, 0.05, 3.4), { rx: -0.16, x: -w / 2 - lw / 2, y: lh + 0.28, z: 0 }));
    b.wood.push(box(1.0, 1.95, 0.05, { x: -w / 2 - lw / 2, y: 0.98, z: d / 2 - 1.6 }));
    b.concrete.push(box(lw + 0.5, 0.2, 3.6, { x: -w / 2 - lw / 2, y: 0.1 }));
  }

  // Rafter tails poking out under the eaves.
  const nRaft = Math.round(w / 1.15);
  for (let i = 0; i <= nRaft; i++) {
    const x = -w / 2 + (i * w) / nRaft;
    for (const sz of [-1, 1]) {
      b.wood.push(xform(box(0.07, 0.15, 1.1), {
        rx: sz * ang, x, y: eaveY + 0.02 + (eaveZ - d / 2 - 0.15) * pitch, z: sz * (d / 2 + 0.3),
      }));
    }
  }

  // Corrugated roof: two slopes plus a ridge cap.
  const slopeLen = eaveZ * Math.sqrt(1 + pitch * pitch);
  for (const sz of [-1, 1]) {
    b.corr.push(xform(box(w + 0.75, 0.06, slopeLen), {
      rx: sz * ang, y: (ridgeY + eaveY) / 2 + 0.03, z: (sz * eaveZ) / 2,
    }));
  }
  b.corr.push(box(w + 0.75, 0.07, 0.46, { y: ridgeY + 0.06 }));
  for (const sz of [-1, 1]) b.wood.push(box(w + 0.75, 0.18, 0.05, { y: eaveY - 0.06, z: sz * (eaveZ + 0.02) }));

  // Entrance canopy — reads instantly as "way in".
  const cx = door.x;
  b.corr.push(xform(box(2.7, 0.05, 1.6), { rx: 0.17, x: cx, y: DOOR_H + 0.62, z: d / 2 + 0.75 }));
  for (const sx of [-1, 1]) {
    b.metal.push(post(0.07, DOOR_H + 0.42, 0.07, cx + sx * 1.15, 0.0, d / 2 + 1.4));
    b.metal.push(strut(
      new THREE.Vector3(cx + sx * 1.15, DOOR_H + 0.5, d / 2 + 1.4),
      new THREE.Vector3(cx + sx * 1.15, DOOR_H + 0.02, d / 2 + wallT / 2),
      0.03, 5,
    ));
  }

  // Stove flue — a small silhouette break that says "occupied".
  const fx = w * 0.2;
  b.metal.push(cyl(0.10, 2.1, 8, { x: fx, y: ridgeY + 0.55, z: -d * 0.18 }));
  b.metal.push(cyl(0.16, 0.09, 8, { x: fx, y: ridgeY + 1.62, z: -d * 0.18 }));

  b.lights.push({ pos: new THREE.Vector3(cx + 1.6, DOOR_H + 0.55, d / 2 + 0.2), kind: 'wall' });
  return bakeBag(b, ridgeY + 1.8, 0.3);
}

/**
 * In-situ concrete hut: expressed frame with infill panels, shallow mono-pitch
 * behind a parapet, no gable. Reads as a decade later and a different trade.
 */
function concreteHut({ w = 22, d = 9.5, wallT = 0.28, rng, litFrac = 0.4, signCell = 9, lean = false } = {}) {
  const b = newBag();
  const H = 3.35;
  const shell = 'concrete';

  b.concrete.push(box(w + 0.5, 0.42, d + 0.5, { y: 0.21 }));
  const frontOpen = [];
  const backOpen = [];
  const door = doorUnit(b, { x: w / 2 - 2.6, z: d / 2 - wallT / 2, wallT, w: 1.15, shell });
  frontOpen.push(door);
  // Long horizontal ribbon windows in threes between the frame bays.
  const bays = Math.max(4, Math.round(w / 4.4));
  const bayW = w / bays;
  for (let i = 0; i < bays; i++) {
    const x = -w / 2 + bayW * (i + 0.5);
    if (Math.abs(x - door.x) > 2.2) {
      frontOpen.push(windowUnit(b, {
        x, y: 1.30, z: d / 2 - wallT / 2, w: bayW - 1.5, h: 0.95, faceZ: 1, wallT, shell,
        lit: rng.chance(litFrac), boarded: rng.chance(0.14), barred: rng.chance(0.55),
      }));
    }
    backOpen.push(windowUnit(b, {
      x, y: 1.30, z: -(d / 2 - wallT / 2), w: bayW - 1.5, h: 0.95, faceZ: -1, wallT, shell,
      lit: rng.chance(litFrac * 0.4), boarded: rng.chance(0.22), barred: rng.chance(0.5),
    }));
  }
  for (const g of wallRun(w, H, wallT, frontOpen)) b.concrete.push(xform(g, { z: d / 2 - wallT / 2 }));
  for (const g of wallRun(w, H, wallT, backOpen)) b.concrete.push(xform(g, { z: -(d / 2 - wallT / 2) }));
  for (const sx of [-1, 1]) {
    for (const g of wallRun(d - wallT * 2, H, wallT, [])) {
      b.concrete.push(xform(g, { ry: sx * Math.PI * 0.5, x: sx * (w / 2 - wallT / 2) }));
    }
  }
  // The expressed frame: columns proud of the infill by 120mm, with a deep
  // spandrel beam. That relief is doing all the work on an otherwise flat wall.
  for (let i = 0; i <= bays; i++) {
    const x = -w / 2 + bayW * i;
    for (const sz of [-1, 1]) {
      b.concrete.push(post(0.46, H + 0.30, 0.20, x, 0, sz * (d / 2 + 0.09)));
    }
  }
  for (const sz of [-1, 1]) b.concrete.push(box(w + 0.30, 0.40, 0.24, { y: H - 0.20, z: sz * (d / 2 + 0.11) }));
  b.concrete.push(box(w + 0.34, 0.20, d + 0.34, { y: H + 0.10 }));
  parapet(b, { w: w + 0.34, d: d + 0.34, y: H + 0.20, h: 0.46, t: 0.15 });
  // Mono-pitch deck falling to the back, seen only as a sliver over the parapet.
  b.corr.push(xform(box(w - 0.2, 0.06, d + 0.1), { rx: 0.07, y: H + 0.42 }));

  dadoSkin(b, { w: w + 0.04, d: d + 0.04, h: 0.78, y: 0.42 });
  signPlane(b, { x: -w / 2 + 3.2, y: 2.86, z: d / 2 + 0.12, w: 1.7, h: 0.85, cell: signCell });
  signPlane(b, { x: w / 2 + 0.15, y: 2.05, z: 0, ry: Math.PI / 2, w: 2.0, h: 2.0, cell: 11 });

  // Surface-run conduit and a distribution box: the ironmongery that stops a
  // concrete elevation from reading as an untextured slab.
  for (const cx2 of [-w * 0.34, w * 0.10]) {
    b.metal.push(cyl(0.04, H - 0.5, 6, { x: cx2, y: (H - 0.5) / 2 + 0.3, z: d / 2 + 0.16 }));
    for (let k = 0; k < 3; k++) b.metal.push(box(0.13, 0.045, 0.045, { x: cx2, y: 0.9 + k * 1.0, z: d / 2 + 0.12 }));
  }
  b.metal.push(box(0.42, 0.56, 0.20, { x: w * 0.10 + 0.5, y: 1.55, z: d / 2 + 0.18 }));
  for (const sx of [-1, 1]) {
    const px = sx * (w / 2 - 0.45);
    b.metal.push(cyl(0.055, H, 6, { x: px, y: H / 2, z: d / 2 + 0.20 }));
    for (let k = 0; k < 3; k++) b.metal.push(box(0.17, 0.05, 0.05, { x: px, y: 0.8 + k * 1.1, z: d / 2 + 0.14 }));
  }
  // Roof furniture.
  for (let i = 0; i < 3; i++) {
    b.metal.push(cyl(0.15, 0.55, 8, { x: -w / 4 + i * (w / 4), y: H + 0.72, z: -d / 5 }));
    b.metal.push(cyl(0.23, 0.06, 8, { x: -w / 4 + i * (w / 4), y: H + 1.02, z: -d / 5 }));
  }
  b.metal.push(cyl(0.11, 2.4, 8, { x: -w * 0.30, y: H + 1.4, z: d * 0.22 }));
  if (lean) {
    b.corr.push(xform(box(4.6, 0.05, 2.9), { rx: -0.19, x: w / 2 + 2.1, y: H - 0.35, z: d / 2 - 2.0 }));
    for (const sz of [-1, 1]) {
      b.metal.push(post(0.09, H - 0.9, 0.09, w / 2 + 4.1, 0, d / 2 - 2.0 + sz * 1.2));
    }
  }
  b.lights.push({ pos: new THREE.Vector3(door.x - 1.3, DOOR_H + 0.75, d / 2 + 0.25), kind: 'wall' });
  return bakeBag(b, H + 1.6, 0.34);
}

/**
 * The 1980s addition: a steel portal-frame shed on a slab. Corrugated
 * everywhere, roller shutter at one end, translucent roof lights, and no
 * pretension to matching anything already on site.
 */
function steelShed({ w = 20, d = 11, rng, litFrac = 0.3, signCell = 1 } = {}) {
  const b = newBag();
  const eave = 4.0;
  const ridge = 5.5;
  const halfD = d / 2;
  const ang = Math.atan2(ridge - eave, halfD);

  b.concrete.push(box(w + 0.9, 0.34, d + 0.9, { y: 0.17 }));
  b.concrete.push(box(w + 0.5, 0.55, d + 0.5, { y: 0.28 }));

  // Portal frames on 4m centres, expressed inside and out.
  const frames = Math.max(4, Math.round(w / 4.0));
  for (let i = 0; i <= frames; i++) {
    const x = -w / 2 + (w / frames) * i;
    for (const sz of [-1, 1]) {
      b.metal.push(post(0.20, eave, 0.34, x, 0.4, sz * (halfD + 0.16)));
      b.metal.push(xform(box(0.16, 0.28, Math.hypot(halfD, ridge - eave) + 0.2), {
        rx: -sz * ang, x, y: (eave + ridge) / 2 + 0.4, z: (sz * halfD) / 2,
      }));
    }
  }
  // Cladding: sheets to the eaves on all four sides, gable infill above.
  // Cladding runs from the top of the plinth to the eaves. Leaving a gap at the
  // bottom shows daylight straight through the building.
  const clad = eave - 0.10;
  for (const sz of [-1, 1]) {
    b.corr.push(box(w, clad, 0.05, { y: clad / 2 + 0.50, z: sz * (halfD + 0.02) }));
  }
  for (const sx of [-1, 1]) {
    b.corr.push(box(0.05, clad, d, { x: sx * (w / 2 - 0.02), y: clad / 2 + 0.50 }));
    const gable = new THREE.Shape();
    gable.moveTo(-halfD, 0);
    gable.lineTo(halfD, 0);
    gable.lineTo(0, ridge - eave);
    const gg = new THREE.ExtrudeGeometry(gable, { depth: 0.05, bevelEnabled: false });
    gg.rotateY(Math.PI / 2);
    gg.translate(sx * (w / 2 - 0.02), eave + 0.4, 0);
    b.corr.push(gg);
  }
  // Roof: two slopes, a ridge cap, and three GRP roof lights per slope.
  const slope = Math.hypot(halfD, ridge - eave) + 0.55;
  for (const sz of [-1, 1]) {
    b.corr.push(xform(box(w + 0.7, 0.06, slope), { rx: sz * ang, y: (eave + ridge) / 2 + 0.46, z: (sz * (halfD + 0.5)) / 2 }));
    for (let i = 0; i < 3; i++) {
      const x = -w / 3 + i * (w / 3);
      b.glass.push(xform(box(1.5, 0.05, slope * 0.42), { rx: sz * ang, x, y: (eave + ridge) / 2 + 0.53, z: (sz * (halfD + 0.5)) / 2 }));
    }
  }
  b.corr.push(box(w + 0.7, 0.08, 0.52, { y: ridge + 0.48 }));
  for (const sz of [-1, 1]) {
    b.metal.push(box(w + 0.7, 0.16, 0.10, { y: eave + 0.30, z: sz * (halfD + 0.55) }));
  }

  // Roller shutter at the gable end, on its own steel goalpost.
  const sw = 4.2;
  b.metal.push(box(0.22, 4.2, 0.30, { x: w / 2 - 0.06, y: 2.1 + 0.4, z: -sw / 2 }));
  b.metal.push(box(0.22, 4.2, 0.30, { x: w / 2 - 0.06, y: 2.1 + 0.4, z: sw / 2 }));
  b.metal.push(box(0.30, 0.36, sw + 0.6, { x: w / 2 - 0.06, y: 3.68, z: 0 }));
  b.dark.push(box(0.08, 3.05, sw - 0.1, { x: w / 2 - 0.14, y: 1.95, z: 0 }));
  for (let i = 0; i < 14; i++) {
    b.metal.push(box(0.09, 0.06, sw - 0.16, { x: w / 2 - 0.05, y: 0.55 + i * 0.215, z: 0 }));
  }
  b.concrete.push(box(2.4, 0.16, sw + 1.2, { x: w / 2 + 1.2, y: 0.42 }));

  // Personnel door and a couple of high windows on the long side.
  const door = doorUnit(b, { x: -w / 2 + 3.0, z: halfD + 0.02, wallT: 0.14, w: 1.0, shell: 'metal' });
  void door;
  for (let i = 0; i < 3; i++) {
    const x = -w / 2 + 7.0 + i * 4.2;
    b.dark.push(box(1.3, 0.85, 0.04, { x, y: 2.95, z: halfD - 0.03 }));
    (rng.chance(litFrac) ? b.glow : b.glass).push(box(1.2, 0.76, 0.03, { x, y: 2.95, z: halfD + 0.03 }));
    for (const sy of [-0.42, 0.42]) b.paint.push(box(1.34, 0.05, 0.07, { x, y: 2.95 + sy, z: halfD + 0.05 }));
    for (const sx of [-0.66, 0.66]) b.paint.push(box(0.05, 0.90, 0.07, { x: x + sx, y: 2.95, z: halfD + 0.05 }));
  }
  signPlane(b, { x: -w / 2 + 5.6, y: 3.86, z: halfD + 0.06, w: 2.6, h: 0.9, cell: signCell });
  signPlane(b, { x: w / 2 + 0.10, y: 4.4, z: 0, ry: Math.PI / 2, w: 2.2, h: 1.1, cell: 15 });

  // Downpipes, vents, a wall fan and a fuel-oil tank against the blind wall.
  for (const sx of [-1, 1]) {
    const px = sx * (w / 2 - 0.25);
    b.metal.push(cyl(0.055, eave, 6, { x: px, y: eave / 2 + 0.4, z: halfD + 0.16 }));
    for (let k = 0; k < 3; k++) b.metal.push(box(0.17, 0.05, 0.05, { x: px, y: 1.0 + k * 1.2, z: halfD + 0.10 }));
  }
  b.metal.push(cyl(0.24, 0.9, 10, { x: w * 0.18, y: ridge + 1.0, z: -d * 0.1 }));
  b.metal.push(cyl(0.34, 0.08, 10, { x: w * 0.18, y: ridge + 1.5, z: -d * 0.1 }));
  b.metal.push(box(0.9, 0.9, 0.24, { x: -w * 0.24, y: 3.1, z: -halfD - 0.10 }));
  b.metal.push(xform(cyl(0.55, 1.6, 12), { rz: Math.PI / 2, x: w * 0.30, y: 0.95, z: -halfD - 0.75 }));
  for (const sx of [-0.55, 0.55]) b.metal.push(post(0.10, 0.42, 0.10, w * 0.30 + sx, 0.0, -halfD - 0.75));

  b.lights.push({ pos: new THREE.Vector3(-w / 2 + 4.4, 3.6, halfD + 0.2), kind: 'wall' });
  b.interest.push({ pos: new THREE.Vector3(w / 2 + 3.5, 0, 0), kind: 'bay' });
  return bakeBag(b, ridge + 1.4, 0.55);
}

// ------------------------------------------------------------- vehicle shed --

/** Open-fronted vehicle shed: portal frame, mono-pitch corrugated roof. */
export function vehicleShed({ w = 16, d = 12, bays = 3 } = {}) {
  const b = newBag();
  const Hf = 4.7;
  const Hb = 3.7;
  const wallT = 0.25;
  const drop = Hf - Hb;
  const slope = Math.atan2(drop, d + 1.2);

  b.concrete.push(box(w + 0.7, 0.32, d + 0.7, { y: 0.16 }));
  for (const g of wallRun(w, Hb, wallT, [])) b.concrete.push(xform(g, { z: -(d / 2 - wallT / 2) }));
  for (const sx of [-1, 1]) {
    const openings = sx > 0 ? [{ x: 0, w: 1.3, y0: 1.5, h: 0.85 }] : [];
    for (const g of wallRun(d - wallT * 2, Hb + 0.6, wallT, openings)) {
      b.concrete.push(xform(g, { ry: sx * Math.PI * 0.5, x: sx * (w / 2 - wallT / 2) }));
    }
  }

  for (let i = 0; i <= bays; i++) {
    b.concrete.push(post(0.44, Hf, 0.44, -w / 2 + (i * w) / bays, 0, d / 2 - 0.22));
  }
  b.concrete.push(box(w + 0.5, 0.65, 0.52, { y: Hf + 0.33, z: d / 2 - 0.22 }));

  b.corr.push(xform(box(w + 0.95, 0.06, Math.hypot(d + 1.2, drop)), { rx: -slope, y: (Hf + Hb) / 2 + 0.66, z: 0 }));
  const nP = 6;
  for (let i = 0; i <= nP; i++) {
    const t = i / nP;
    b.metal.push(box(w + 0.6, 0.11, 0.07, { y: Hf + 0.58 - drop * t, z: d / 2 - 0.35 - (d - 0.7) * t }));
  }
  b.corr.push(box(w + 0.95, 0.3, 0.06, { y: Hf + 0.8, z: d / 2 + 0.58 }));

  b.lights.push({ pos: new THREE.Vector3(-w / 4, Hf - 0.4, d / 2 - 0.55), kind: 'wall' });
  b.lights.push({ pos: new THREE.Vector3(w / 4, Hf - 0.4, d / 2 - 0.55), kind: 'wall' });
  for (let i = 0; i < bays; i++) {
    b.interest.push({ pos: new THREE.Vector3(-w / 2 + (w / bays) * (i + 0.5), 0, d / 2 + 3.0), kind: 'bay' });
  }
  return bakeBag(b, Hf + 1.1, 0.4);
}

// ------------------------------------------------------------------ bunker --

/** Half-bermed ammunition store: thick concrete, blast door, vent stacks. */
export function bunker({ w = 12, d = 8 } = {}) {
  const b = newBag();
  const H = 3.0;
  b.concrete.push(box(w, H, d, { y: H / 2 }));
  b.concrete.push(box(w + 0.95, 0.48, d + 0.95, { y: H + 0.24 }));
  b.concrete.push(box(3.2, 2.8, 1.3, { y: 1.4, z: d / 2 + 0.65 }));
  b.metal.push(box(2.25, 2.15, 0.10, { y: 1.08, z: d / 2 + 1.2 }));
  for (const sx of [-0.55, 0.55]) b.metal.push(cyl(0.03, 1.65, 5, { x: sx, y: 1.08, z: d / 2 + 1.27 }));
  for (let i = 0; i < 3; i++) {
    const x = -w / 3 + i * (w / 3);
    b.metal.push(cyl(0.13, 1.1, 8, { x, y: H + 1.0, z: -d / 4 }));
    b.metal.push(cyl(0.2, 0.07, 8, { x, y: H + 1.58, z: -d / 4 }));
  }
  b.interest.push({ pos: new THREE.Vector3(0, 0, d / 2 + 2.8), kind: 'door' });
  return bakeBag(b, H + 1.6, 0.25);
}

// ------------------------------------------------------------- watchtower ---

/**
 * Watchtower: braced steel legs, switchback timber stairs, a cabin with a
 * waist-high corrugated screen and a searchlight on the roof.
 */
export function watchtower({ h = 9 } = {}) {
  const b = newBag();
  const half = 1.75;
  const cabH = 2.4;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) b.concrete.push(post(0.74, 0.55, 0.74, sx * half, -0.15, sz * half));
  }
  for (const g of lattice({ half, y0: 0.35, y1: h, legR: 0.085, braceR: 0.05, panels: Math.max(3, Math.round(h / 2.3)) })) {
    b.metal.push(g);
  }

  b.wood.push(box(half * 2 + 0.95, 0.11, half * 2 + 0.95, { y: h + 0.055 }));
  for (const sz of [-1, 1]) {
    b.metal.push(box(half * 2 + 1.0, 0.15, 0.09, { y: h - 0.07, z: sz * (half + 0.47) }));
    b.metal.push(box(0.09, 0.15, half * 2 + 1.0, { y: h - 0.07, x: sz * (half + 0.47) }));
  }

  const cw = half + 0.44;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) b.wood.push(post(0.13, cabH, 0.13, sx * cw, h + 0.11, sz * cw));
  }
  const screen = [
    { x: 0, z: -cw, ry: 0, len: cw * 2 },
    { x: cw, z: 0, ry: Math.PI / 2, len: cw * 2 },
    { x: -cw, z: 0, ry: Math.PI / 2, len: cw * 2 },
    { x: -cw * 0.5, z: cw, ry: 0, len: cw },
  ];
  for (const s of screen) {
    b.corr.push(xform(box(s.len, 1.05, 0.05), { ry: s.ry, x: s.x, y: h + 0.64, z: s.z }));
    b.wood.push(xform(box(s.len, 0.11, 0.17), { ry: s.ry, x: s.x, y: h + 1.22, z: s.z }));
  }
  b.corr.push(box(cw * 2 + 1.05, 0.07, cw * 2 + 1.05, { y: h + cabH + 0.14 }));
  for (const sz of [-1, 1]) {
    b.corr.push(xform(box(cw * 2 + 1.05, 0.05, 0.6), { rx: sz * 0.28, y: h + cabH + 0.06, z: sz * (cw + 0.76) }));
    b.wood.push(box(cw * 2 + 1.05, 0.17, 0.06, { y: h + cabH + 0.02, z: sz * (cw + 0.52) }));
  }

  // Switchback stairs on one face: flights between two landings.
  const nF = Math.max(3, Math.round(h / 2.3));
  const fr = h / nF;
  const run = 3.2;
  const sx0 = half + 1.6;
  for (let f = 0; f < nF; f++) {
    const fwd = f % 2 === 0;
    for (const g of stairFlight({ rise: fr, run, width: 0.98 })) {
      b.wood.push(xform(g, { ry: fwd ? 0 : Math.PI, x: sx0, y: f * fr, z: fwd ? -run / 2 : run / 2 }));
    }
    b.wood.push(box(1.6, 0.1, 1.5, { x: sx0, y: (f + 1) * fr - 0.05, z: (fwd ? 1 : -1) * (run / 2 + 0.75) }));
  }
  b.wood.push(box(1.7, 0.1, 1.5, { x: sx0 - 0.9, y: h - 0.05, z: (nF % 2 === 1 ? 1 : -1) * (run / 2 + 0.75) }));

  b.metal.push(cyl(0.06, 0.95, 6, { y: h + cabH + 0.62 }));
  b.metal.push(xform(cyl(0.34, 0.42, 12), { rx: Math.PI / 2, y: h + cabH + 1.1, z: 0.14 }));
  b.lights.push({ pos: new THREE.Vector3(0, h + cabH + 1.1, 0.36), kind: 'searchlight' });
  b.interest.push({ pos: new THREE.Vector3(0, h + 0.2, 0), kind: 'guardpost' });
  return bakeBag(b, h + cabH + 1.5, 0.45);
}

// --------------------------------------------------------------- gatehouse --

/** Main gate: piers, lintel with a stencilled star, sliding leaves, boom barrier. */
export function gateway({ gap = 9 } = {}) {
  const b = newBag();
  const pierH = 4.6;
  const pw = 1.35;
  for (const sx of [-1, 1]) {
    const x = sx * (gap / 2 + pw / 2);
    b.concrete.push(post(pw, pierH, pw, x, 0));
    b.concrete.push(box(pw + 0.32, 0.24, pw + 0.32, { x, y: pierH + 0.12 }));
    b.concrete.push(box(pw + 0.5, 0.52, pw + 0.5, { x, y: 0.26 }));
  }
  b.concrete.push(box(gap + pw * 2 + 0.5, 0.8, 0.78, { y: pierH + 0.62 }));

  // Red star on the lintel — one silhouette that says "Soviet garrison".
  const star = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 0.62 : 0.26;
    if (i === 0) star.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else star.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const sg = new THREE.ExtrudeGeometry(star, { depth: 0.06, bevelEnabled: false });
  sg.translate(0, pierH + 0.62, 0.39);
  b.paintWarn.push(sg);

  // Sliding leaves. Chain-link infill is added by the caller.
  for (const sx of [-1, 1]) {
    const openAmt = sx > 0 ? 0.55 : 0.18;
    const lw = gap / 2 - 0.15;
    const cxg = sx * (gap / 4 + openAmt * lw * 0.75);
    const ry = sx * openAmt * 1.2;
    const frame = [];
    frame.push(box(lw, 0.11, 0.09, { y: 0.16 }));
    frame.push(box(lw, 0.11, 0.09, { y: 2.6 }));
    frame.push(box(lw, 0.07, 0.07, { y: 1.38 }));
    for (let i = 0; i <= 3; i++) frame.push(box(0.09, 2.55, 0.09, { x: -lw / 2 + (i * lw) / 3, y: 1.38 }));
    for (const g of frame) b.metal.push(xform(g, { ry, x: cxg }));
    b.interest.push({ pos: new THREE.Vector3(cxg, 1.38, 0), kind: 'gateleaf', ry, span: lw });
  }

  // Boom barrier with counterweight, banded red and white.
  const bx = gap / 2 + pw + 1.6;
  b.metal.push(post(0.28, 1.1, 0.28, bx, 0));
  const boomLen = 7.0;
  const segs = 8;
  for (let i = 0; i < segs; i++) {
    const g = xform(cyl(0.075, boomLen / segs, 8), { rz: Math.PI / 2, x: bx - (i + 0.5) * (boomLen / segs), y: 1.2 });
    (i % 2 === 0 ? b.paintWarn : b.paint).push(g);
  }
  b.metal.push(box(0.5, 0.5, 0.36, { x: bx + 0.7, y: 1.1 }));

  // Guard hut beside the gate.
  const hx = -(gap / 2 + pw + 2.8);
  const hw = 2.7;
  const hd = 2.4;
  const hh = 2.8;
  for (const g of wallRun(hw, hh, 0.2, [{ x: 0, w: 1.7, y0: 1.05, h: 1.05 }])) b.concrete.push(xform(g, { x: hx, z: hd / 2 }));
  for (const g of wallRun(hw, hh, 0.2, [])) b.concrete.push(xform(g, { x: hx, z: -hd / 2 }));
  for (const g of wallRun(hd - 0.4, hh, 0.2, [])) b.concrete.push(xform(g, { ry: Math.PI / 2, x: hx + hw / 2 - 0.1 }));
  for (const g of wallRun(hd - 0.4, hh, 0.2, [{ x: 0, w: 1.0, y0: 0, h: 2.05 }])) {
    b.concrete.push(xform(g, { ry: -Math.PI / 2, x: hx - hw / 2 + 0.1 }));
  }
  b.concrete.push(box(hw + 0.75, 0.19, hd + 0.75, { x: hx, y: hh + 0.095 }));
  b.glow.push(box(1.6, 0.98, 0.05, { x: hx, y: 1.57, z: hd / 2 - 0.04 }));
  b.lights.push({ pos: new THREE.Vector3(hx, hh + 0.32, hd / 2 + 0.1), kind: 'wall' });
  b.interest.push({ pos: new THREE.Vector3(hx + 2.0, 0, hd / 2 + 0.9), kind: 'guardpost' });
  return bakeBag(b, pierH + 1.5, 0.4);
}

/** Circular concrete helipad with worn markings and edge lights. */
export function helipad({ r = 9.5 } = {}) {
  const b = newBag();
  const slab = new THREE.CylinderGeometry(r, r + 0.22, 0.36, 40, 1, false);
  slab.translate(0, -0.11, 0);
  b.concrete.push(slab);
  const rr = r - 1.35;
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    b.paint.push(box(0.55, 0.035, (2 * Math.PI * rr) / 40 + 0.03, { x: Math.cos(a) * rr, y: 0.062, z: Math.sin(a) * rr, ry: -a }));
  }
  b.paint.push(box(0.6, 0.035, 4.8, { x: -1.6, y: 0.062 }));
  b.paint.push(box(0.6, 0.035, 4.8, { x: 1.6, y: 0.062 }));
  b.paint.push(box(2.8, 0.035, 0.6, { y: 0.062 }));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.4;
    b.lights.push({ pos: new THREE.Vector3(Math.cos(a) * (r + 0.6), 0.3, Math.sin(a) * (r + 0.6)), kind: 'padlight' });
  }
  return bakeBag(b, 1.0, 0.55, -3.0);
}
