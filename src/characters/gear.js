import * as THREE from 'three';
import { Surface, loftKeys, displacedSphere, roundedBox, strap, tube } from './geometry.js';
import { Z, MZ } from './materials.js';
import { headSurface, HEAD_CENTRE } from './body.js';

/**
 * Kit.
 *
 * Silhouette is most of what makes a soldier read as a soldier, and almost all
 * of a soldier's silhouette is equipment: the square break of a plate carrier,
 * magazine pouches stacked across the belly, straps crossing the back, a helmet
 * that squares off the head, boots that widen the ankle. The body underneath is
 * comparatively generic — this file is where the character actually gets built.
 *
 * Everything here is welded to a single bone (rigid attachment) so kit never
 * shears across a joint the way skinned cloth does.
 */

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// -------------------------------------------------------------------------
// Torso rig / webbing
// -------------------------------------------------------------------------

export function buildChestRig(o = {}) {
  const parts = [];
  const bulk = o.bulk ?? 1;
  const heavy = o.heavy ?? true;

  // Carrier shell — boxier than the torso beneath it and standing off it.
  parts.push({
    surface: loftKeys(
      [
        { p: V(0, 1.075, -0.012), rx: 0.163 * bulk, rz: 0.126 * bulk, n: 3.4, zone: Z.VEST },
        { p: V(0, 1.13, -0.014), rx: 0.168 * bulk, rz: 0.132 * bulk, n: 3.6, zone: Z.VEST },
        { p: V(0, 1.22, -0.016), rx: 0.184 * bulk, rz: 0.139 * bulk, n: 3.8, zone: Z.VEST },
        { p: V(0, 1.31, -0.016), rx: 0.199 * bulk, rz: 0.143 * bulk, n: 3.8, zone: Z.VEST },
        { p: V(0, 1.38, -0.012), rx: 0.204 * bulk, rz: 0.134 * bulk, n: 3.6, zone: Z.VEST },
        { p: V(0, 1.42, -0.008), rx: 0.185 * bulk, rz: 0.116 * bulk, n: 3.2, zone: Z.VEST },
      ],
      14,
      { radial: 24, capStart: true, capEnd: true },
    ),
    mat: 'cloth',
  });

  // Front magazine pouches. Three across, angled outward, with flaps.
  const magY = 1.185;
  for (let i = -1; i <= 1; i++) {
    const m = new THREE.Matrix4()
      .makeRotationY(-i * 0.34)
      .setPosition(i * 0.062, magY, -0.152 + Math.abs(i) * 0.012);
    parts.push({
      surface: roundedBox(0.062, 0.125, 0.05, 0.014, { zone: Z.POUCH, radial: 12 }).transform(m),
      mat: 'cloth',
    });
    // Flap + retention strap over the top of each pouch.
    parts.push({
      surface: roundedBox(0.064, 0.026, 0.056, 0.01, { zone: Z.POUCH, radial: 10 }).transform(
        new THREE.Matrix4().makeRotationY(-i * 0.34).setPosition(i * 0.062, magY + 0.062, -0.153 + Math.abs(i) * 0.012),
      ),
      mat: 'cloth',
    });
    parts.push({
      surface: strap(
        [V(i * 0.062, magY + 0.075, -0.14), V(i * 0.062, magY + 0.06, -0.183), V(i * 0.062, magY - 0.01, -0.181)],
        0.014,
        0.005,
        Z.WEBBING,
        { stations: 8 },
      ).transform(new THREE.Matrix4().makeRotationY(-i * 0.34)),
      mat: 'cloth',
    });
  }

  // Utility / radio pouch high on the left chest, with a stub antenna.
  parts.push({
    surface: roundedBox(0.07, 0.085, 0.048, 0.012, { zone: Z.POUCH, radial: 12 }).transform(
      new THREE.Matrix4().makeRotationY(0.3).setPosition(-0.105, 1.305, -0.13),
    ),
    mat: 'cloth',
  });
  parts.push({
    surface: tube(V(-0.118, 1.345, -0.13), V(-0.135, 1.47, -0.1), 0.0035, 0.002, 6, MZ.DARKPOLY),
    mat: 'metal',
  });

  // Right chest admin pouch + a grenade.
  parts.push({
    surface: roundedBox(0.075, 0.06, 0.04, 0.01, { zone: Z.POUCH, radial: 12 }).transform(
      new THREE.Matrix4().makeRotationY(-0.3).setPosition(0.105, 1.315, -0.128),
    ),
    mat: 'cloth',
  });
  if (heavy) {
    parts.push({
      surface: loftKeys(
        [
          { p: V(0.135, 1.235, -0.126), rx: 0.024, rz: 0.024, n: 2.4, zone: MZ.DARKPOLY },
          { p: V(0.135, 1.265, -0.126), rx: 0.029, rz: 0.029, n: 2.6, zone: MZ.DARKPOLY },
          { p: V(0.135, 1.295, -0.126), rx: 0.024, rz: 0.024, n: 2.4, zone: MZ.DARKPOLY },
          { p: V(0.135, 1.308, -0.126), rx: 0.012, rz: 0.012, n: 2.4, zone: MZ.DARKPOLY },
        ],
        8,
        { radial: 10, capStart: true, capEnd: true },
      ),
      mat: 'metal',
    });
  }

  // Shoulder straps front-to-back over the trapezius.
  for (const sgn of [-1, 1]) {
    parts.push({
      surface: strap(
        [
          V(sgn * 0.085, 1.34, -0.135),
          V(sgn * 0.1, 1.425, -0.09),
          V(sgn * 0.105, 1.455, -0.01),
          V(sgn * 0.098, 1.425, 0.07),
          V(sgn * 0.085, 1.33, 0.115),
        ],
        0.052,
        0.014,
        Z.WEBBING,
        { stations: 16 },
      ),
      mat: 'cloth',
    });
  }
  // Cummerbund / side release across the ribs.
  parts.push({
    surface: strap(
      [V(-0.16, 1.11, -0.09), V(-0.175, 1.115, 0.02), V(-0.13, 1.115, 0.105), V(0, 1.115, 0.135), V(0.13, 1.115, 0.105), V(0.175, 1.115, 0.02), V(0.16, 1.11, -0.09)],
      0.055,
      0.014,
      Z.WEBBING,
      { stations: 22 },
    ),
    mat: 'cloth',
  });
  return parts;
}

export function buildBelt(o = {}) {
  const parts = [];
  parts.push({
    surface: loftKeys(
      [
        { p: V(0, 0.995, -0.004), rx: 0.152, rz: 0.113, n: 2.8, zone: Z.BELT },
        { p: V(0, 0.972, -0.004), rx: 0.158, rz: 0.118, n: 2.8, zone: Z.BELT },
        { p: V(0, 0.948, -0.004), rx: 0.152, rz: 0.113, n: 2.8, zone: Z.BELT },
      ],
      6,
      { radial: 22 },
    ),
    mat: 'cloth',
  });
  parts.push({
    surface: roundedBox(0.052, 0.038, 0.02, 0.006, { zone: MZ.BRASS, radial: 10 }).transform(
      new THREE.Matrix4().setPosition(0, 0.972, -0.118),
    ),
    mat: 'metal',
  });
  // Rear belt pouches — reads well from behind, which is the gameplay camera.
  for (const x of o.pouches ?? [-0.11, 0.11]) {
    parts.push({
      surface: roundedBox(0.085, 0.075, 0.055, 0.012, { zone: Z.POUCH, radial: 12 }).transform(
        new THREE.Matrix4().makeRotationY(x > 0 ? -0.5 : 0.5).setPosition(x * 1.1, 0.965, 0.1),
      ),
      mat: 'cloth',
    });
  }
  return parts;
}

/** Thigh holster with a sidearm in it. */
export function buildHolster(side = 1) {
  const parts = [];
  const x = side * 0.155;
  const m = new THREE.Matrix4().makeRotationZ(side * -0.06).setPosition(x, 0.72, 0.01);
  parts.push({ surface: roundedBox(0.062, 0.17, 0.09, 0.016, { zone: Z.LEATHER, radial: 12 }).transform(m), mat: 'cloth' });
  parts.push({
    surface: roundedBox(0.07, 0.05, 0.098, 0.014, { zone: Z.LEATHER, radial: 10 }).transform(
      new THREE.Matrix4().makeRotationZ(side * -0.06).setPosition(x, 0.805, 0.006),
    ),
    mat: 'cloth',
  });
  // Pistol grip and slide poking out of the top.
  parts.push({
    surface: roundedBox(0.032, 0.1, 0.052, 0.01, { zone: MZ.GUNMETAL, radial: 10 }).transform(
      new THREE.Matrix4().makeRotationX(0.18).setPosition(x, 0.845, 0.02),
    ),
    mat: 'metal',
  });
  // Leg strap.
  parts.push({
    surface: strap([V(x - 0.05, 0.66, -0.06), V(x + 0.01, 0.655, -0.075), V(x + 0.04, 0.66, 0.02), V(x - 0.01, 0.658, 0.085), V(x - 0.06, 0.66, 0.04)], 0.022, 0.007, Z.WEBBING, { stations: 14 }),
    mat: 'cloth',
  });
  return parts;
}

export function buildBackpack(o = {}) {
  const parts = [];
  const back = 0.185;
  parts.push({
    surface: loftKeys(
      [
        { p: V(0, 1.02, back - 0.01), rx: 0.13, rz: 0.062, n: 3.6, zone: Z.PACK },
        { p: V(0, 1.09, back + 0.006), rx: 0.145, rz: 0.078, n: 3.8, zone: Z.PACK },
        { p: V(0, 1.22, back + 0.012), rx: 0.155, rz: 0.084, n: 4.0, zone: Z.PACK },
        { p: V(0, 1.34, back + 0.006), rx: 0.152, rz: 0.078, n: 4.0, zone: Z.PACK },
        { p: V(0, 1.42, back - 0.012), rx: 0.13, rz: 0.06, n: 3.6, zone: Z.PACK },
      ],
      12,
      { radial: 20, capStart: true, capEnd: true },
    ),
    mat: 'cloth',
  });
  // Top lid + compression straps.
  parts.push({
    surface: roundedBox(0.26, 0.05, 0.15, 0.02, { zone: Z.PACK, radial: 14 }).transform(
      new THREE.Matrix4().setPosition(0, 1.435, back),
    ),
    mat: 'cloth',
  });
  for (const y of [1.14, 1.29]) {
    parts.push({
      surface: strap([V(-0.155, y, back + 0.02), V(-0.12, y, back + 0.088), V(0, y, back + 0.098), V(0.12, y, back + 0.088), V(0.155, y, back + 0.02)], 0.03, 0.008, Z.WEBBING, { stations: 14 }),
      mat: 'cloth',
    });
  }
  // Bedroll lashed under the pack.
  parts.push({
    surface: loftKeys(
      [
        { p: V(-0.15, 1.0, back + 0.03), rx: 0.045, rz: 0.045, n: 2.2, zone: Z.PACK },
        { p: V(0, 0.985, back + 0.04), rx: 0.05, rz: 0.05, n: 2.2, zone: Z.PACK },
        { p: V(0.15, 1.0, back + 0.03), rx: 0.045, rz: 0.045, n: 2.2, zone: Z.PACK },
      ],
      9,
      { radial: 12, capStart: true, capEnd: true, forward: V(0, 1, 0) },
    ),
    mat: 'cloth',
  });
  // Shoulder straps over the front.
  for (const sgn of [-1, 1]) {
    parts.push({
      surface: strap(
        [
          V(sgn * 0.09, 1.4, back - 0.03),
          V(sgn * 0.105, 1.462, 0.03),
          V(sgn * 0.105, 1.44, -0.06),
          V(sgn * 0.095, 1.33, -0.12),
          V(sgn * 0.07, 1.19, -0.13),
        ],
        0.048,
        0.014,
        Z.WEBBING,
        { stations: 18 },
      ),
      mat: 'cloth',
    });
  }
  return parts;
}

// -------------------------------------------------------------------------
// Headgear
// -------------------------------------------------------------------------

export function buildHelmet() {
  const parts = [];
  parts.push({
    surface: loftKeys(
      [
        { p: V(0, 1.598, -0.004), rx: 0.107, rz: 0.118, n: 2.7, zone: Z.HELMCOVER },
        { p: V(0, 1.615, -0.006), rx: 0.111, rz: 0.121, n: 2.7, zone: Z.HELMCOVER },
        { p: V(0, 1.66, -0.008), rx: 0.108, rz: 0.117, n: 2.7, zone: Z.HELMCOVER },
        { p: V(0, 1.715, -0.008), rx: 0.096, rz: 0.104, n: 2.6, zone: Z.HELMCOVER },
        { p: V(0, 1.768, -0.008), rx: 0.068, rz: 0.074, n: 2.5, zone: Z.HELMCOVER },
        { p: V(0, 1.802, -0.008), rx: 0.026, rz: 0.028, n: 2.4, zone: Z.HELMCOVER },
      ],
      13,
      { radial: 22, capEnd: true },
    ),
    mat: 'cloth',
  });
  // Ear/side rails and a front NVG shroud — the shapes that make a modern helmet
  // silhouette readable at 30 m.
  parts.push({
    surface: roundedBox(0.05, 0.032, 0.028, 0.008, { zone: MZ.DARKPOLY, radial: 10 }).transform(
      new THREE.Matrix4().setPosition(0, 1.652, -0.114),
    ),
    mat: 'metal',
  });
  for (const sgn of [-1, 1]) {
    parts.push({
      surface: strap([V(sgn * 0.1, 1.63, -0.06), V(sgn * 0.112, 1.628, 0.0), V(sgn * 0.1, 1.63, 0.06)], 0.02, 0.012, MZ.DARKPOLY, { stations: 8 }),
      mat: 'metal',
    });
    // Chin strap.
    parts.push({
      surface: strap([V(sgn * 0.098, 1.62, -0.03), V(sgn * 0.072, 1.575, -0.02), V(sgn * 0.03, 1.548, -0.035), V(0, 1.545, -0.04)], 0.014, 0.006, Z.WEBBING, { stations: 10 }),
      mat: 'cloth',
    });
  }
  return parts;
}

export function buildCap() {
  const parts = [];
  parts.push({
    surface: loftKeys(
      [
        { p: V(0, 1.612, -0.006), rx: 0.088, rz: 0.098, n: 2.6, zone: Z.CAP },
        { p: V(0, 1.66, -0.008), rx: 0.09, rz: 0.099, n: 2.6, zone: Z.CAP },
        { p: V(0, 1.72, -0.008), rx: 0.082, rz: 0.09, n: 2.5, zone: Z.CAP },
        { p: V(0, 1.768, -0.008), rx: 0.05, rz: 0.055, n: 2.4, zone: Z.CAP },
        { p: V(0, 1.788, -0.008), rx: 0.016, rz: 0.018, n: 2.4, zone: Z.CAP },
      ],
      11,
      { radial: 18, capEnd: true },
    ),
    mat: 'cloth',
  });
  // Bill.
  parts.push({
    surface: loftKeys(
      [
        { p: V(0, 1.616, -0.08), rx: 0.086, rz: 0.008, n: 4.0, zone: Z.CAP },
        { p: V(0, 1.612, -0.115), rx: 0.082, rz: 0.008, n: 4.0, zone: Z.CAP },
        { p: V(0, 1.606, -0.15), rx: 0.062, rz: 0.007, n: 4.0, zone: Z.CAP },
      ],
      7,
      { radial: 14, capStart: true, capEnd: true, forward: V(0, 1, 0) },
    ),
    mat: 'cloth',
  });
  return parts;
}

export function buildBoonie() {
  const parts = [];
  parts.push({
    surface: loftKeys(
      [
        { p: V(0, 1.6, -0.006), rx: 0.094, rz: 0.104, n: 2.6, zone: Z.CAP },
        { p: V(0, 1.66, -0.008), rx: 0.096, rz: 0.105, n: 2.6, zone: Z.CAP },
        { p: V(0, 1.73, -0.008), rx: 0.082, rz: 0.09, n: 2.5, zone: Z.CAP },
        { p: V(0, 1.775, -0.008), rx: 0.032, rz: 0.035, n: 2.4, zone: Z.CAP },
      ],
      9,
      { radial: 18, capEnd: true },
    ),
    mat: 'cloth',
  });
  // Floppy brim: a ring that droops at the front and back.
  const brim = new Surface();
  const R = 22;
  const rows = [
    { r: 0.095, dy: 0.0 },
    { r: 0.14, dy: -0.014 },
    { r: 0.168, dy: -0.03 },
  ];
  for (const row of rows) {
    for (let i = 0; i <= R; i++) {
      const th = (i / R) * Math.PI * 2;
      const droop = 1 + 0.5 * Math.cos(th * 2);
      brim.vert(
        Math.cos(th) * row.r,
        1.6 + row.dy * droop + 0.004,
        -0.006 + Math.sin(th) * row.r * 1.06,
        (i / R) * 0.55,
        row.r,
        Z.CAP,
      );
    }
  }
  for (let j = 0; j < rows.length - 1; j++) {
    for (let i = 0; i < R; i++) {
      const a = j * (R + 1) + i;
      brim.quad(a, a + 1, a + R + 2, a + R + 1);
    }
  }
  parts.push({ surface: brim, mat: 'cloth' });
  return parts;
}

/** Snake's bandana: a band across the forehead with two tails down the back. */
export function buildBandana() {
  const parts = [];
  // The band is wrapped onto the actual skull surface, not onto a cylinder —
  // a straight ring stands 40 mm proud where the cranium narrows and reads as
  // horns.
  const band = new Surface();
  const R = 26;
  const rows = [0.30, 0.42, 0.54];
  const dir = new THREE.Vector3();
  const p3 = new THREE.Vector3();
  for (let j = 0; j < rows.length; j++) {
    const cy = rows[j];
    for (let i = 0; i <= R; i++) {
      const th = (i / R) * Math.PI * 2;
      const s2 = Math.sqrt(Math.max(0, 1 - cy * cy));
      dir.set(Math.cos(th) * s2, cy, Math.sin(th) * s2);
      headSurface(dir, p3, {});
      p3.sub(HEAD_CENTRE);
      const len = p3.length() || 1;
      p3.multiplyScalar(1 + (0.0055 + 0.0015 * Math.sin(th * 7)) / len).add(HEAD_CENTRE);
      band.vert(p3.x, p3.y, p3.z, (i / R) * 0.5, j * 0.03, Z.BANDANA);
    }
  }
  for (let j = 0; j < rows.length - 1; j++) {
    for (let i = 0; i < R; i++) {
      const a = j * (R + 1) + i;
      band.quad(a, a + 1, a + R + 2, a + R + 1);
    }
  }
  parts.push({ surface: band, mat: 'cloth' });
  // Knot + tails trailing down the back of the head.
  parts.push({
    surface: roundedBox(0.04, 0.032, 0.032, 0.008, { zone: Z.BANDANA, radial: 8 }).transform(
      new THREE.Matrix4().setPosition(0, 1.716, 0.092),
    ),
    mat: 'cloth',
  });
  for (const sgn of [-1, 1]) {
    parts.push({
      surface: strap(
        [V(sgn * 0.012, 1.712, 0.094), V(sgn * 0.03, 1.662, 0.106), V(sgn * 0.045, 1.608, 0.104), V(sgn * 0.052, 1.562, 0.088)],
        0.026,
        0.005,
        Z.BANDANA,
        { stations: 10, taper: 0.35 },
      ),
      mat: 'cloth',
    });
  }
  return parts;
}

/** Eyepatch over the right eye. */
export function buildEyepatch() {
  const parts = [];
  const patch = displacedSphere(
    (dir, out) => {
      out.set(0.036 + 0.032 * dir.x, 1.692 + 0.03 * dir.y, -0.07 + 0.013 * dir.z - 0.012 * dir.x);
    },
    14,
    10,
    Z.LEATHER,
    0.2,
  );
  parts.push({ surface: patch, mat: 'cloth' });
  parts.push({
    surface: strap(
      [V(0.052, 1.672, -0.072), V(0.083, 1.681, 0.0), V(0.03, 1.7, 0.09), V(-0.05, 1.7, 0.082), V(-0.079, 1.688, -0.008), V(-0.05, 1.678, -0.072)],
      0.011,
      0.005,
      Z.LEATHER,
      { stations: 20 },
    ),
    mat: 'cloth',
  });
  return parts;
}

// -------------------------------------------------------------------------
// Prosthetic arm
// -------------------------------------------------------------------------

/**
 * A mechanical left arm. Same spine as the flesh arm so the shoulder still
 * blends into the jacket, but the profiles are hard-edged superellipses with
 * exposed joint gaps — the read is machined parts, not a painted limb.
 */
export function buildProstheticArm(armPoint, wrist) {
  const parts = [];
  const seg = (a, b, ra, rb, n, zone) => ({
    surface: loftKeys(
      [
        { p: armPoint(a), rx: ra, rz: ra * 1.06, n, zone },
        { p: armPoint((a + b) / 2), rx: (ra + rb) / 2, rz: ((ra + rb) / 2) * 1.06, n, zone },
        { p: armPoint(b), rx: rb, rz: rb * 1.06, n, zone },
      ],
      7,
      { radial: 14, capStart: true, capEnd: true },
    ),
    mat: 'metal',
  });

  // Shoulder cowl (stays cloth-adjacent so it merges into the jacket).
  parts.push({
    surface: loftKeys(
      [
        { p: V(0.085, 1.478, -0.014), rx: 0.086, rz: 0.09, n: 3.0, zone: MZ.PROSTHETIC },
        { p: V(0.135, 1.474, -0.014), rx: 0.078, rz: 0.082, n: 3.0, zone: MZ.PROSTHETIC },
        { p: armPoint(0.07), rx: 0.068, rz: 0.072, n: 3.0, zone: MZ.PROSTHETIC },
        { p: armPoint(0.16), rx: 0.055, rz: 0.058, n: 3.2, zone: MZ.PROSTHETIC },
      ],
      10,
      { radial: 16, capStart: true },
    ),
    mat: 'metal',
  });
  parts.push(seg(0.17, 0.4, 0.047, 0.043, 3.4, MZ.GUNMETAL));
  parts.push(seg(0.41, 0.46, 0.05, 0.05, 3.0, MZ.PROSTHETIC));
  // Elbow hinge.
  parts.push(seg(0.47, 0.55, 0.044, 0.045, 2.6, MZ.GUNMETAL));
  const e = armPoint(0.51);
  parts.push({
    surface: tube(e.clone().add(V(0.03, 0.02, 0)), e.clone().add(V(-0.03, -0.02, 0)), 0.019, 0.019, 12, MZ.GUNMETAL),
    mat: 'metal',
  });
  parts.push(seg(0.56, 0.74, 0.046, 0.041, 3.6, MZ.PROSTHETIC));
  parts.push(seg(0.75, 0.9, 0.038, 0.031, 3.4, MZ.GUNMETAL));
  // Wrist collar.
  parts.push({
    surface: loftKeys(
      [
        { p: armPoint(0.92), rx: 0.031, rz: 0.033, n: 3.0, zone: MZ.PROSTHETIC },
        { p: armPoint(0.96), rx: 0.034, rz: 0.036, n: 3.0, zone: MZ.PROSTHETIC },
        { p: wrist, rx: 0.028, rz: 0.031, n: 3.0, zone: MZ.PROSTHETIC },
      ],
      6,
      { radial: 14, capStart: true, capEnd: true },
    ),
    mat: 'metal',
  });
  // Cable runs along the underside of the forearm.
  parts.push({
    surface: loftKeys(
      [
        { p: armPoint(0.58).add(V(0.02, -0.02, 0.03)), rx: 0.006, rz: 0.006, n: 2.2, zone: MZ.DARKPOLY },
        { p: armPoint(0.72).add(V(0.018, -0.018, 0.034)), rx: 0.006, rz: 0.006, n: 2.2, zone: MZ.DARKPOLY },
        { p: armPoint(0.88).add(V(0.012, -0.012, 0.028)), rx: 0.005, rz: 0.005, n: 2.2, zone: MZ.DARKPOLY },
      ],
      8,
      { radial: 7, capStart: true, capEnd: true },
    ),
    mat: 'metal',
  });
  return parts;
}

// -------------------------------------------------------------------------
// Weapon
// -------------------------------------------------------------------------

/**
 * Assault rifle, built in weapon space: +X toward the muzzle, +Y up, +Z to the
 * shooter's right. `gripCenter`/`gripUp` describe where the firing hand closes,
 * `foregrip` where the support hand goes; the animation system uses both to keep
 * the weapon locked in the hands through every state.
 */
export function buildRifle(o = {}) {
  const parts = [];
  const push = (s) => parts.push({ surface: s, mat: 'metal' });

  // Receiver.
  push(roundedBox(0.055, 0.078, 0.28, 0.008, { zone: MZ.GUNMETAL, radial: 12 }).transform(
    new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(-0.03, 0.005, 0),
  ));
  // Upper rail.
  push(roundedBox(0.028, 0.014, 0.3, 0.003, { zone: MZ.GUNMETAL, radial: 8 }).transform(
    new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(-0.01, 0.05, 0),
  ));
  // Handguard.
  push(loftKeys(
    [
      { p: V(0.11, 0.006, 0), rx: 0.03, rz: 0.03, n: 3.2, zone: MZ.DARKPOLY },
      { p: V(0.2, 0.006, 0), rx: 0.028, rz: 0.028, n: 3.4, zone: MZ.DARKPOLY },
      { p: V(0.29, 0.008, 0), rx: 0.026, rz: 0.026, n: 3.4, zone: MZ.DARKPOLY },
    ],
    9,
    { radial: 12, capStart: true, capEnd: true, forward: V(0, 1, 0) },
  ));
  // Barrel + flash hider.
  push(tube(V(0.28, 0.012, 0), V(0.4, 0.012, 0), 0.0085, 0.0075, 10, MZ.GUNMETAL));
  push(tube(V(0.395, 0.012, 0), V(0.44, 0.012, 0), 0.0125, 0.0135, 10, MZ.GUNMETAL));
  // Gas block + front sight.
  push(roundedBox(0.022, 0.05, 0.026, 0.004, { zone: MZ.GUNMETAL, radial: 8 }).transform(
    new THREE.Matrix4().setPosition(0.3, 0.03, 0),
  ));
  // Magazine: curved, angled forward-down.
  push(loftKeys(
    [
      { p: V(0.03, -0.03, 0), rx: 0.014, rz: 0.033, n: 4.0, zone: MZ.DARKPOLY },
      { p: V(0.048, -0.1, 0), rx: 0.014, rz: 0.033, n: 4.0, zone: MZ.DARKPOLY },
      { p: V(0.082, -0.165, 0), rx: 0.013, rz: 0.031, n: 4.0, zone: MZ.DARKPOLY },
      { p: V(0.108, -0.205, 0), rx: 0.012, rz: 0.028, n: 4.0, zone: MZ.DARKPOLY },
    ],
    10,
    { radial: 12, capStart: true, capEnd: true, forward: V(0, 0, 1) },
  ));
  // Pistol grip.
  push(loftKeys(
    [
      { p: V(-0.06, -0.02, 0), rx: 0.019, rz: 0.024, n: 3.0, zone: MZ.DARKPOLY },
      { p: V(-0.078, -0.075, 0), rx: 0.019, rz: 0.023, n: 3.0, zone: MZ.DARKPOLY },
      { p: V(-0.096, -0.128, 0), rx: 0.018, rz: 0.022, n: 3.0, zone: MZ.DARKPOLY },
    ],
    8,
    { radial: 12, capStart: true, capEnd: true, forward: V(0, 0, 1) },
  ));
  // Stock: tube + butt pad.
  push(tube(V(-0.15, 0.005, 0), V(-0.29, -0.005, 0), 0.017, 0.016, 10, MZ.GUNMETAL));
  push(roundedBox(0.024, 0.085, 0.05, 0.008, { zone: MZ.DARKPOLY, radial: 10 }).transform(
    new THREE.Matrix4().setPosition(-0.3, -0.006, 0),
  ));
  push(roundedBox(0.09, 0.03, 0.045, 0.008, { zone: MZ.DARKPOLY, radial: 10 }).transform(
    new THREE.Matrix4().setPosition(-0.22, 0.028, 0),
  ));
  // Optic + mount.
  if (o.optic !== false) {
    push(tube(V(-0.035, 0.086, 0), V(0.06, 0.086, 0), 0.019, 0.019, 12, MZ.GUNMETAL));
    push(roundedBox(0.03, 0.03, 0.03, 0.004, { zone: MZ.GUNMETAL, radial: 8 }).transform(
      new THREE.Matrix4().setPosition(-0.01, 0.066, 0),
    ));
    push(loftKeys(
      [
        { p: V(-0.033, 0.086, 0), rx: 0.016, rz: 0.016, n: 2.2, zone: MZ.GLASS },
        { p: V(-0.031, 0.086, 0), rx: 0.016, rz: 0.016, n: 2.2, zone: MZ.GLASS },
      ],
      3,
      { radial: 10, capStart: true, capEnd: true, forward: V(0, 1, 0) },
    ));
  }
  // Charging handle + ejection port lip.
  push(roundedBox(0.05, 0.012, 0.014, 0.003, { zone: MZ.GUNMETAL, radial: 8 }).transform(
    new THREE.Matrix4().setPosition(-0.12, 0.042, 0.026),
  ));
  // Trigger guard.
  push(strap([V(-0.052, -0.02, 0), V(-0.045, -0.05, 0), V(-0.01, -0.055, 0), V(0.01, -0.03, 0)], 0.03, 0.007, MZ.GUNMETAL, { stations: 9 }));
  // Sling attachment.
  push(tube(V(-0.14, -0.02, 0.024), V(-0.14, -0.02, 0.032), 0.007, 0.007, 8, MZ.GUNMETAL));

  return {
    parts,
    gripCenter: V(-0.078, -0.075, 0),
    gripUp: V(0.32, 0.947, 0).normalize(),
    foregrip: V(0.205, 0.006, 0),
    foreAxis: V(1, 0, 0),
    muzzle: V(0.45, 0.012, 0),
  };
}

/**
 * Uniform pockets. Bellows cargo pockets on the outside of each thigh and two
 * flapped chest pockets. They stand proud of the garment by ~15 mm, which is
 * enough to catch a rim of sun and throw a contact shadow — the cheapest way to
 * turn a smooth tube into a piece of clothing.
 */
export function buildPockets(o = {}) {
  const parts = [];
  const cargo = o.cargo !== false;
  for (const sgn of [-1, 1]) {
    if (!cargo) break;
    const x = sgn * 0.086;
    // Bellows pocket body, wrapped around the curve of the thigh.
    parts.push({
      surface: loftKeys(
        [
          { p: V(x, 0.79, -0.012), rx: 0.052, rz: 0.058, n: 4.2, zone: Z.TROUSER },
          { p: V(x, 0.75, -0.014), rx: 0.058, rz: 0.064, n: 4.4, zone: Z.TROUSER },
          { p: V(x, 0.70, -0.014), rx: 0.058, rz: 0.064, n: 4.4, zone: Z.TROUSER },
          { p: V(x, 0.665, -0.012), rx: 0.05, rz: 0.056, n: 4.2, zone: Z.TROUSER },
        ],
        9,
        { radial: 14, capStart: true, capEnd: true },
      ).transform(new THREE.Matrix4().makeScale(1, 1, 1)),
      mat: 'cloth',
    });
    // Flap across the top of the pocket, a shade darker.
    parts.push({
      surface: loftKeys(
        [
          { p: V(x, 0.795, -0.012), rx: 0.055, rz: 0.061, n: 4.4, zone: Z.POUCH },
          { p: V(x, 0.772, -0.013), rx: 0.06, rz: 0.066, n: 4.6, zone: Z.POUCH },
          { p: V(x, 0.762, -0.013), rx: 0.058, rz: 0.064, n: 4.6, zone: Z.POUCH },
        ],
        6,
        { radial: 14, capStart: true, capEnd: true },
      ),
      mat: 'cloth',
    });
  }
  // Chest pockets, tucked under the carrier so only the outer edge shows.
  for (const sgn of [-1, 1]) {
    parts.push({
      surface: roundedBox(0.072, 0.09, 0.03, 0.01, { zone: Z.TROUSER, radial: 10 }).transform(
        new THREE.Matrix4().makeRotationY(-sgn * 0.35).setPosition(sgn * 0.172, 1.255, -0.062),
      ),
      mat: 'cloth',
    });
  }
  // Hip dump pouch.
  parts.push({
    surface: roundedBox(0.1, 0.11, 0.06, 0.016, { zone: Z.POUCH, radial: 12 }).transform(
      new THREE.Matrix4().makeRotationY(0.5).setPosition(-0.16, 0.9, 0.055),
    ),
    mat: 'cloth',
  });
  return parts;
}

/** Kneepads — small, but they break up the leg silhouette exactly where it needs it. */
export function buildKneepads() {
  const parts = [];
  for (const sgn of [-1, 1]) {
    const x = sgn * 0.1;
    parts.push({
      surface: loftKeys(
        [
          { p: V(x, 0.555, -0.03), rx: 0.058, rz: 0.05, n: 3.0, zone: Z.KNEEPAD },
          { p: V(x, 0.51, -0.045), rx: 0.066, rz: 0.055, n: 3.2, zone: Z.KNEEPAD },
          { p: V(x, 0.46, -0.04), rx: 0.06, rz: 0.05, n: 3.0, zone: Z.KNEEPAD },
        ],
        7,
        { radial: 14, capStart: true, capEnd: true },
      ),
      mat: 'cloth',
    });
  }
  return parts;
}
