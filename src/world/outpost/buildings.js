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

const GEO_KEYS = ['concrete', 'metal', 'corr', 'wood', 'glass', 'glow', 'cloth', 'net', 'rubber', 'paint', 'paintWarn'];

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
function windowUnit(b, { x, y, z, w, h, faceZ = 1, lit = false, barred = true, boarded = false, wallT }) {
  const inset = 0.13;
  const zp = z + faceZ * (wallT / 2 - inset);
  (lit ? b.glow : b.glass).push(box(w - 0.04, h - 0.04, 0.05, { x, y: y + h / 2, z: zp }));
  // Cill throws water clear of the wall — and seeds the dirt streak below it.
  b.concrete.push(box(w + 0.26, 0.08, wallT + 0.18, { x, y: y - 0.04, z }));
  b.concrete.push(box(w + 0.22, 0.11, wallT + 0.10, { x, y: y + h + 0.055, z }));
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
function doorUnit(b, { x, z, faceZ = 1, wallT, w = DOOR_W, h = DOOR_H, doubleLeaf = false }) {
  const zp = z + faceZ * (wallT / 2 - 0.11);
  if (doubleLeaf) {
    b.metal.push(box(w / 2 - 0.03, h - 0.05, 0.055, { x: x - w / 4, y: h / 2, z: zp }));
    b.metal.push(box(w / 2 - 0.03, h - 0.05, 0.055, { x: x + w / 4, y: h / 2, z: zp }));
  } else {
    b.metal.push(box(w - 0.06, h - 0.05, 0.055, { x, y: h / 2, z: zp }));
    b.metal.push(xform(cyl(0.022, 0.16, 5), { rz: Math.PI / 2, x: x + w / 2 - 0.18, y: 1.02, z: zp + faceZ * 0.05 }));
  }
  const zf = z + faceZ * (wallT / 2 + 0.02);
  b.concrete.push(box(w + 0.26, 0.11, 0.07, { x, y: h + 0.055, z: zf }));
  b.concrete.push(box(0.11, h + 0.11, 0.07, { x: x - w / 2 - 0.075, y: (h + 0.11) / 2, z: zf }));
  b.concrete.push(box(0.11, h + 0.11, 0.07, { x: x + w / 2 + 0.075, y: (h + 0.11) / 2, z: zf }));
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

  const nWin = Math.max(3, Math.floor((w - 6) / 3.1));
  for (let s = 0; s < storeys; s++) {
    for (let i = 0; i < nWin; i++) {
      const x = -w / 2 + 4.8 + (i * (w - 6.6)) / Math.max(1, nWin - 1);
      const y = s * STOREY + 1.05;
      if (!(s === 0 && Math.abs(x - door.x) < 1.7)) {
        frontOpen.push(windowUnit(b, {
          x, y, z: d / 2 - wallT / 2, w: 1.2, h: 1.15, faceZ: 1, wallT,
          lit: rng.chance(litFrac), boarded: rng.chance(0.10), barred: rng.chance(0.75),
        }));
      }
      backOpen.push(windowUnit(b, {
        x, y, z: -(d / 2 - wallT / 2), w: 1.2, h: 1.15, faceZ: -1, wallT,
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
          x: along, y: s * STOREY + 1.05, z: 0, w: 1.1, h: 1.1, faceZ: 1, wallT,
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
    for (const sz of [-1, 1]) b.concrete.push(post(0.54, H, 0.54, sx * (w / 2 - 0.08), 0.4, sz * (d / 2 - 0.08)));
  }
  const bayN = nWin + 1;
  const bayStep = (w - 6.6) / Math.max(1, nWin - 1);
  for (let i = 1; i < bayN; i++) {
    const x = -w / 2 + 4.8 - bayStep / 2 + (i * (w - 6.6 + bayStep)) / bayN;
    for (const sz of [-1, 1]) {
      b.concrete.push(post(0.52, H - 0.15, 0.30, x, 0.4, sz * (d / 2 + 0.14)));
      b.concrete.push(box(0.62, 0.12, 0.38, { x, y: H - 0.2, z: sz * (d / 2 + 0.16) }));
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
  b.paint.push(box(1.5, 1.0, 0.04, { x: w * 0.30, y: 2.35, z: d / 2 + 0.17 }));
  for (let s = 1; s < storeys; s++) b.concrete.push(box(w + 0.32, 0.16, d + 0.32, { y: s * STOREY - 0.08 }));
  b.concrete.push(box(w + 0.22, 0.13, d + 0.22, { y: 0.9 }));

  const roofY = H;
  b.concrete.push(box(w + 0.48, 0.34, d + 0.48, { y: roofY + 0.17 }));
  parapet(b, { w: w + 0.32, d: d + 0.32, y: roofY + 0.34 });

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

/** Single-storey barrack hut: corrugated pitched roof, entrance canopy, stove flue. */
export function barracks({ w = 26, d = 10, wallT = 0.26, rng, litFrac = 0.4 } = {}) {
  const b = newBag();
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
  const door = doorUnit(b, { x: -w / 2 + 2.3, z: d / 2 - wallT / 2, wallT, w: 1.05 });
  frontOpen.push(door);
  const nWin = Math.max(4, Math.round((w - 6) / 3.0));
  for (let i = 0; i < nWin; i++) {
    const x = -w / 2 + 4.8 + (i * (w - 7.4)) / Math.max(1, nWin - 1);
    frontOpen.push(windowUnit(b, {
      x, y: 1.05, z: d / 2 - wallT / 2, w: 1.15, h: 1.10, faceZ: 1, wallT,
      lit: rng.chance(litFrac), boarded: rng.chance(0.12), barred: rng.chance(0.4),
    }));
    backOpen.push(windowUnit(b, {
      x, y: 1.05, z: -(d / 2 - wallT / 2), w: 1.15, h: 1.10, faceZ: -1, wallT,
      lit: rng.chance(litFrac * 0.45), boarded: rng.chance(0.2), barred: rng.chance(0.4),
    }));
  }

  for (const g of wallRun(w, H, wallT, frontOpen)) b.concrete.push(xform(g, { z: d / 2 - wallT / 2 }));
  for (const g of wallRun(w, H, wallT, backOpen)) b.concrete.push(xform(g, { z: -(d / 2 - wallT / 2) }));
  for (const sx of [-1, 1]) {
    for (const g of wallRun(d - wallT * 2, H, wallT, [])) {
      b.concrete.push(xform(g, { ry: sx * Math.PI * 0.5, x: sx * (w / 2 - wallT / 2) }));
    }
  }
  b.concrete.push(box(w + 0.32, 0.18, d + 0.32, { y: H + 0.09 }));
  // Bay piers between the windows and a plinth band, both of which catch a rim
  // of light on an otherwise dead facade.
  for (let i = 0; i <= nWin; i++) {
    const x = -w / 2 + 3.1 + (i * (w - 6.2)) / nWin;
    for (const sz of [-1, 1]) b.concrete.push(post(0.32, H - 0.1, 0.14, x, 0, sz * (d / 2 + 0.06)));
  }
  b.concrete.push(box(w + 0.2, 0.12, d + 0.2, { y: 0.72 }));

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
    b.concrete.push(g);
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
