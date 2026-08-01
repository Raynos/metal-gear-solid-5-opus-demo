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

/**
 * A side-release buckle: a body block, a narrower tongue and a retaining lip.
 * Three boxes, ~90 triangles, and it is the difference between webbing and a
 * painted stripe. Every load-bearing strap on a soldier terminates in one of
 * these, and the eye reads their regular hard-edged rhythm long before it can
 * resolve the strap itself.
 */
function buckle(p, opts = {}) {
  const w = opts.w ?? 0.032;
  const h = opts.h ?? 0.024;
  const rot = opts.rotY ?? 0;
  const zone = opts.zone ?? MZ.DARKPOLY;
  const at = (dx, dy, dz) =>
    new THREE.Matrix4().makeRotationY(rot).setPosition(p.x + dx, p.y + dy, p.z + dz);
  return [
    { surface: roundedBox(w, h, 0.013, 0.004, { zone, radial: 6, segs: 5 }).transform(at(0, 0, 0)), mat: 'metal' },
    {
      surface: roundedBox(w * 0.62, h * 0.42, 0.017, 0.003, { zone, radial: 6, segs: 4 }).transform(at(0, -h * 0.62, 0)),
      mat: 'metal',
    },
    {
      surface: roundedBox(w * 1.06, h * 0.16, 0.016, 0.003, { zone, radial: 6, segs: 4 }).transform(at(0, h * 0.42, 0)),
      mat: 'metal',
    },
  ];
}

/**
 * A Cordura pouch: body, overhanging lid, bound edge, pull tab.
 *
 * ROUND 5 (three rounds of "pouch edges have no depth"). A `roundedBox` with a
 * 12 mm fillet is a soap bar — it has no CUT EDGE anywhere, and a cut edge is
 * the only thing that makes a fabric box read as sewn. Every real pouch is a
 * bag with a lid that OVERHANGS it by 4-6 mm on three sides, and every panel of
 * both is finished with a folded binding tape that stands ~2 mm proud. That
 * gives, from top to bottom in about 30 px: lid binding (lit), lid face,
 * lid binding again (lit), the reveal under the overhang (black), the body
 * binding (lit), the body face. Six value steps where round 4 had one.
 *
 * `at` is the placement matrix; the pouch is authored around its own origin
 * with -Z outboard, matching the rest of this file.
 */
function pouch(w, h, d, at, o = {}) {
  const zone = o.zone ?? Z.POUCH;
  const tapeZone = o.tapeZone ?? Z.WEBBING;
  const out = [];
  const push = (s) => out.push({ surface: s.transform(at), mat: 'cloth' });
  const lidH = o.lidH ?? Math.min(0.030, h * 0.30);
  const bodyH = h - lidH - 0.006;
  const bodyY = -h / 2 + bodyH / 2;
  const lidY = h / 2 - lidH / 2;

  // Body. A loaded pouch bellies outward at its middle and pinches at the seams.
  push(
    loftKeys(
      [
        { p: V(0, bodyY - bodyH / 2, 0), rx: w * 0.46, rz: d * 0.42, n: 5.2, zone },
        { p: V(0, bodyY - bodyH * 0.18, -0.002), rx: w / 2, rz: d / 2, n: 4.6, zone },
        { p: V(0, bodyY + bodyH * 0.18, -0.002), rx: w / 2, rz: d / 2, n: 4.6, zone },
        { p: V(0, bodyY + bodyH / 2, 0), rx: w * 0.48, rz: d * 0.46, n: 5.2, zone },
      ],
      9,
      { radial: o.radial ?? 14, capStart: true, capEnd: true },
    ),
  );
  // Lid, 5 mm proud of the body on every side so it throws a hard shadow line
  // across the front of the pouch.
  push(
    loftKeys(
      [
        { p: V(0, lidY - lidH / 2, -0.001), rx: w / 2 + 0.005, rz: d / 2 + 0.005, n: 5.0, zone },
        { p: V(0, lidY + lidH * 0.1, -0.002), rx: w / 2 + 0.005, rz: d / 2 + 0.005, n: 5.0, zone },
        { p: V(0, lidY + lidH / 2, 0.002), rx: w * 0.47, rz: d * 0.46, n: 5.2, zone },
      ],
      7,
      { radial: o.radial ?? 14, capStart: true, capEnd: true },
    ),
  );
  // Binding tape around the lid's cut edge and the body's mouth.
  const loop = (y, rx, rz) => {
    const pts = [];
    for (let i = 0; i <= 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const s = Math.sin(a);
      const c = Math.cos(a);
      const k = Math.pow(Math.pow(Math.abs(s / rx), 5.0) + Math.pow(Math.abs(c / rz), 5.0), -1 / 5.0);
      pts.push(V(s * k, y, c * k));
    }
    return strap(pts, 0.008, 0.0035, tapeZone, { stations: 13 });
  };
  push(loop(lidY - lidH / 2 - 0.001, w / 2 + 0.006, d / 2 + 0.006));
  // Pull tab hanging off the bottom of the lid.
  push(
    strap(
      [
        V(0, lidY - lidH / 2, -d / 2 - 0.004),
        V(0, lidY - lidH / 2 - 0.012, -d / 2 - 0.010),
        V(0, lidY - lidH / 2 - 0.024, -d / 2 - 0.008),
      ],
      0.014,
      0.004,
      tapeZone,
      { stations: 6 },
    ),
  );
  return out;
}

/**
 * A ladder of MOLLE webbing. Rows of 25 mm tape stitched across a panel is what
 * every modern load-bearing surface actually looks like, and the horizontal
 * banding survives to any distance where the character is more than a few
 * pixels wide.
 */
function molle(y0, rows, spacing, span, z, zone = Z.WEBBING, bulge = 0.0) {
  const out = [];
  for (let r = 0; r < rows; r++) {
    const y = y0 - r * spacing;
    out.push({
      surface: strap(
        [V(-span, y, z), V(-span * 0.5, y, z + bulge), V(0, y, z + bulge * 1.15), V(span * 0.5, y, z + bulge), V(span, y, z)],
        0.021,
        0.006,
        zone,
        { stations: 9 },
      ),
      mat: 'cloth',
    });
  }
  return out;
}

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
        { p: V(0, 1.42, -0.008), rx: 0.190 * bulk, rz: 0.120 * bulk, n: 3.2, zone: Z.VEST },
        // Round 5: the carrier used to stop dead here with a flat cap, which is
        // the 90-degree corner the critics read as "box shoulders". Two more
        // stations run it up over the trapezius and close it at the neck, so
        // the top of the rig is a yoke that follows the body under it.
        { p: V(0, 1.448, -0.005), rx: 0.163 * bulk, rz: 0.108 * bulk, n: 2.9, zone: Z.VEST },
        { p: V(0, 1.468, -0.003), rx: 0.121 * bulk, rz: 0.094 * bulk, n: 2.6, zone: Z.VEST },
      ],
      16,
      { radial: 24, capStart: true, capEnd: true },
    ),
    mat: 'cloth',
  });

  // Front magazine pouches. Three across, angled outward, with real lids.
  const magY = 1.185;
  for (let i = -1; i <= 1; i++) {
    const m = new THREE.Matrix4()
      .makeRotationY(-i * 0.34)
      .setPosition(i * 0.062, magY, -0.152 + Math.abs(i) * 0.012);
    parts.push(...pouch(0.062, 0.148, 0.05, m, { radial: 12 }));
    parts.push({
      surface: strap(
        [V(i * 0.062, magY + 0.082, -0.14), V(i * 0.062, magY + 0.066, -0.183), V(i * 0.062, magY - 0.01, -0.181)],
        0.014,
        0.005,
        Z.WEBBING,
        { stations: 8 },
      ).transform(new THREE.Matrix4().makeRotationY(-i * 0.34)),
      mat: 'cloth',
    });
  }

  // Utility / radio pouch high on the left chest, with a stub antenna.
  parts.push(
    ...pouch(0.07, 0.085, 0.048, new THREE.Matrix4().makeRotationY(0.3).setPosition(-0.105, 1.305, -0.13), {
      radial: 12,
    }),
  );
  parts.push({
    surface: tube(V(-0.118, 1.345, -0.13), V(-0.135, 1.47, -0.1), 0.0035, 0.002, 6, MZ.DARKPOLY),
    mat: 'metal',
  });

  // Right chest admin pouch + a grenade.
  parts.push(
    ...pouch(0.075, 0.062, 0.04, new THREE.Matrix4().makeRotationY(-0.3).setPosition(0.105, 1.315, -0.128), {
      radial: 12,
      lidH: 0.020,
    }),
  );
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
  for (const sgn of [-1, 1]) parts.push(...buckle(V(sgn * 0.168, 1.113, -0.05), { w: 0.03, h: 0.03, rotY: sgn * 1.3 }));

  // --- the BACK of the carrier -------------------------------------------
  // The third-person camera spends the entire game looking at this panel, and
  // in round 1 it was blank. Round 3 gave it three widely spaced tapes and a
  // pouch, and a row-scan across the shipped frame still returned the same
  // 8-bit value 150 times in a row. Nothing below is decoration: every piece is
  // a value STEP across that span — a raised plate pocket, a recessed spine
  // channel between two padded panels, six MOLLE rungs at 32 mm with vertical
  // stitch stiles, a shoulder yoke, and the hard horizontal of the drag handle.

  // Raised rear plate pocket standing 14 mm off the carrier, with its own
  // stitched border: a lit top edge and a shadowed bottom edge straight across
  // the middle of the panel.
  parts.push({
    surface: loftKeys(
      [
        { p: V(0, 1.14, 0.128), rx: 0.128 * bulk, rz: 0.030, n: 5.0, zone: Z.VEST },
        { p: V(0, 1.19, 0.136), rx: 0.140 * bulk, rz: 0.034, n: 5.4, zone: Z.VEST },
        { p: V(0, 1.30, 0.138), rx: 0.146 * bulk, rz: 0.035, n: 5.4, zone: Z.VEST },
        { p: V(0, 1.37, 0.130), rx: 0.132 * bulk, rz: 0.030, n: 5.0, zone: Z.VEST },
      ],
      10,
      { radial: 18, capStart: true, capEnd: true },
    ),
    mat: 'cloth',
  });
  // Spine channel: two padded panels either side of a 26 mm gap. A real carrier
  // is built this way so the wearer's spine is not loaded, and the gap reads as
  // a dark vertical stripe down the middle of the back — the one axis the
  // horizontal MOLLE rungs cannot break.
  for (const sgn of [-1, 1]) {
    parts.push({
      surface: loftKeys(
        [
          { p: V(sgn * 0.058, 1.13, 0.146), rx: 0.036, rz: 0.013, n: 4.6, zone: Z.POUCH },
          { p: V(sgn * 0.062, 1.20, 0.152), rx: 0.042, rz: 0.016, n: 4.8, zone: Z.POUCH },
          { p: V(sgn * 0.062, 1.31, 0.153), rx: 0.042, rz: 0.016, n: 4.8, zone: Z.POUCH },
          { p: V(sgn * 0.058, 1.375, 0.145), rx: 0.034, rz: 0.012, n: 4.6, zone: Z.POUCH },
        ],
        10,
        { radial: 12, capStart: true, capEnd: true },
      ),
      mat: 'cloth',
    });
  }
  parts.push(...molle(1.352, 6, 0.032, 0.106, 0.146, Z.WEBBING, 0.007));
  // The tapes are stitched down every 52 mm; the stitch columns are what make a
  // ladder read as a grid rather than as stripes.
  for (const sx of [-0.078, -0.026, 0.026, 0.078]) {
    parts.push({
      surface: strap(
        [V(sx, 1.365, 0.148), V(sx, 1.28, 0.157), V(sx, 1.20, 0.157), V(sx, 1.155, 0.148)],
        0.010,
        0.004,
        Z.WEBBING,
        { stations: 10 },
      ),
      mat: 'cloth',
    });
  }
  // Rear utility pouch. This is the single closest piece of kit to the gameplay
  // lens, so it is the one that has to carry a real lid and a bound edge.
  parts.push(
    ...pouch(
      0.128,
      0.098,
      0.048,
      new THREE.Matrix4().makeRotationY(Math.PI).setPosition(0, 1.112, 0.162),
      { radial: 14, lidH: 0.028 },
    ),
  );
  parts.push({
    surface: strap(
      [V(-0.056, 1.146, 0.156), V(-0.028, 1.152, 0.184), V(0.028, 1.152, 0.184), V(0.056, 1.146, 0.156)],
      0.02,
      0.007,
      Z.WEBBING,
      { stations: 9 },
    ),
    mat: 'cloth',
  });
  // Drag handle across the shoulder blades.
  parts.push({
    surface: strap(
      [V(-0.055, 1.4, 0.115), V(-0.03, 1.418, 0.142), V(0.03, 1.418, 0.142), V(0.055, 1.4, 0.115)],
      0.03,
      0.011,
      Z.WEBBING,
      { stations: 10 },
    ),
    mat: 'cloth',
  });
  // Shoulder yoke: the seam where the strap assembly is sewn into the back
  // panel, running out over each trapezius. It closes the outline at the top of
  // the carrier, which otherwise ends in a bare curve against the collar.
  for (const sgn of [-1, 1]) {
    parts.push({
      surface: strap(
        [V(sgn * 0.03, 1.418, 0.114), V(sgn * 0.078, 1.428, 0.102), V(sgn * 0.112, 1.4, 0.056), V(sgn * 0.122, 1.352, 0.01)],
        0.04,
        0.010,
        Z.WEBBING,
        { stations: 12 },
      ),
      mat: 'cloth',
    });
    parts.push(...buckle(V(sgn * 0.088, 1.325, 0.128), { w: 0.028, h: 0.022, rotY: sgn * 0.15 }));
  }
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
  // These are the closest pieces of kit to the gameplay lens (they sit at the
  // small of the back, dead centre of frame), so they get the full pouch build.
  for (const x of o.pouches ?? [-0.11, 0.11]) {
    const rotY = x > 0 ? -0.5 : 0.5;
    const m = new THREE.Matrix4().makeRotationY(rotY).setPosition(x * 1.1, 0.978, 0.1);
    // The pouch is authored with -Z outboard; these sit on the BACK of the
    // belt, so it is turned to face rearward.
    m.multiply(new THREE.Matrix4().makeRotationY(Math.PI));
    parts.push(...pouch(0.085, 0.095, 0.055, m, { radial: 12, lidH: 0.026 }));
    parts.push({
      surface: strap([V(0, 0.038, 0.03), V(0, 0.022, -0.032), V(0, -0.03, -0.03)], 0.014, 0.005, Z.WEBBING, {
        stations: 8,
      }).transform(m),
      mat: 'cloth',
    });
  }
  // Belt keepers: four short loops holding the belt to the trouser waistband.
  for (const a of [-0.9, -0.3, 0.3, 0.9, 2.4, 3.9]) {
    const px = Math.sin(a) * 0.152;
    const pz = -Math.cos(a) * 0.113;
    parts.push({
      surface: roundedBox(0.016, 0.05, 0.014, 0.004, { zone: Z.WEBBING, radial: 8 }).transform(
        new THREE.Matrix4().makeRotationY(-a).setPosition(px * 1.06, 0.972, pz * 1.06),
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

/**
 * The rucksack.
 *
 * Round 1's was, accurately, "a rounded box". The fix is not more subdivisions —
 * it is that a real pack is an assembly: a main body, a separate lid that
 * overhangs it, side pockets that break the flanks, MOLLE ladders across the
 * back panel, compression straps that pull the profile in at two heights, and
 * buckles wherever a strap ends. All of that is silhouette and horizontal
 * banding, which is what survives to the distance the gameplay camera sits at.
 */
export function buildBackpack(o = {}) {
  const parts = [];
  // Round 4: this was a 31 cm wide, 40 cm tall expedition rucksack standing
  // 27 cm proud of the spine. From the gameplay camera it WAS the character —
  // a row-scan across the shipped frame returned 150 consecutive pixels of one
  // value, because the only thing in that scanline was the pack's blank flank.
  // Everything worth looking at (the carrier's back panel, the MOLLE, the drag
  // handle, the shoulders, the collar, the neck) was behind it. This is now a
  // low-profile assault pack: 25 cm wide, 26 cm tall, riding high and tight so
  // the bottom third of the carrier and both shoulders stay in the outline.
  const back = 0.148;
  parts.push({
    surface: loftKeys(
      [
        { p: V(0, 1.135, back - 0.006), rx: 0.101, rz: 0.040, n: 3.6, zone: Z.PACK },
        { p: V(0, 1.19, back + 0.004), rx: 0.116, rz: 0.052, n: 3.8, zone: Z.PACK },
        { p: V(0, 1.27, back + 0.008), rx: 0.124, rz: 0.058, n: 4.0, zone: Z.PACK },
        { p: V(0, 1.34, back + 0.004), rx: 0.121, rz: 0.053, n: 4.0, zone: Z.PACK },
        { p: V(0, 1.39, back - 0.008), rx: 0.102, rz: 0.040, n: 3.6, zone: Z.PACK },
      ],
      12,
      { radial: 20, capStart: true, capEnd: true },
    ),
    mat: 'cloth',
  });
  // Top lid, overhanging the body so it casts a line of shadow across it.
  parts.push({
    surface: loftKeys(
      [
        { p: V(0, 1.418, back - 0.004), rx: 0.092, rz: 0.036, n: 3.4, zone: Z.PACK },
        { p: V(0, 1.402, back + 0.003), rx: 0.113, rz: 0.050, n: 3.8, zone: Z.PACK },
        { p: V(0, 1.383, back + 0.004), rx: 0.116, rz: 0.053, n: 3.8, zone: Z.PACK },
        { p: V(0, 1.366, back + 0.001), rx: 0.110, rz: 0.049, n: 3.8, zone: Z.PACK },
      ],
      9,
      { radial: 18, capStart: true, capEnd: true },
    ),
    mat: 'cloth',
  });
  // Lid closure straps running down onto the back panel, each ending in a buckle.
  for (const sx of [-0.05, 0.05]) {
    parts.push({
      surface: strap(
        [V(sx, 1.412, back + 0.02), V(sx, 1.385, back + 0.056), V(sx, 1.345, back + 0.066), V(sx, 1.312, back + 0.062)],
        0.022,
        0.007,
        Z.WEBBING,
        { stations: 10 },
      ),
      mat: 'cloth',
    });
    parts.push(...buckle(V(sx, 1.316, back + 0.07), { w: 0.026, h: 0.02 }));
  }

  // Side pockets: the flanks are where a pack's silhouette is judged.
  for (const sgn of [-1, 1]) {
    parts.push({
      surface: loftKeys(
        [
          { p: V(sgn * 0.114, 1.185, back + 0.018), rx: 0.026, rz: 0.036, n: 3.6, zone: Z.PACK },
          { p: V(sgn * 0.124, 1.222, back + 0.024), rx: 0.031, rz: 0.043, n: 3.8, zone: Z.PACK },
          { p: V(sgn * 0.124, 1.278, back + 0.024), rx: 0.031, rz: 0.043, n: 3.8, zone: Z.PACK },
          { p: V(sgn * 0.114, 1.315, back + 0.018), rx: 0.024, rz: 0.034, n: 3.6, zone: Z.PACK },
        ],
        9,
        { radial: 14, capStart: true, capEnd: true },
      ),
      mat: 'cloth',
    });
    parts.push({
      surface: strap(
        [V(sgn * 0.102, 1.302, back + 0.018), V(sgn * 0.136, 1.306, back + 0.024), V(sgn * 0.134, 1.264, back + 0.05)],
        0.018,
        0.006,
        Z.WEBBING,
        { stations: 9 },
      ),
      mat: 'cloth',
    });
    // Daisy chain down the flank. The pack's SIDE is what the over-the-shoulder
    // camera actually sees — the MOLLE on the rear panel faces away from it —
    // and in round 4 that side was 90 px of one unbroken value. A vertical tape
    // tacked down every 38 mm puts a rung across it at the one frequency that
    // survives to gameplay range.
    parts.push({
      surface: strap(
        [V(sgn * 0.101, 1.155, back - 0.004), V(sgn * 0.122, 1.21, back + 0.012), V(sgn * 0.129, 1.29, back + 0.014), V(sgn * 0.11, 1.36, back - 0.006)],
        0.017,
        0.005,
        Z.WEBBING,
        { stations: 12 },
      ),
      mat: 'cloth',
    });
    for (const yy of [1.196, 1.234, 1.272, 1.31]) {
      parts.push({
        surface: strap(
          [V(sgn * 0.106, yy, back + 0.002), V(sgn * 0.132, yy, back + 0.016), V(sgn * 0.128, yy, back + 0.038)],
          0.007,
          0.004,
          Z.WEBBING,
          { stations: 6 },
        ),
        mat: 'cloth',
      });
    }
  }

  // MOLLE ladders across the back panel. Five rows at 34 mm rather than four at
  // 48: at the distance the gameplay camera sits, 48 mm spacing puts one dark
  // line every 19 px and leaves everything between them flat.
  parts.push(...molle(1.335, 5, 0.034, 0.084, back + 0.06, Z.WEBBING, 0.009));

  // Horizontal compression straps, cinched with buckles on the character's left.
  for (const y of [1.168, 1.302]) {
    parts.push({
      surface: strap(
        [V(-0.124, y, back + 0.012), V(-0.095, y, back + 0.06), V(0, y, back + 0.068), V(0.095, y, back + 0.06), V(0.124, y, back + 0.012)],
        0.026,
        0.008,
        Z.WEBBING,
        { stations: 14 },
      ),
      mat: 'cloth',
    });
    parts.push(...buckle(V(-0.07, y, back + 0.072), { w: 0.028, h: 0.02 }));
  }

  // Bedroll lashed under the pack — the one horizontal mass on a body made of
  // verticals, and it sits exactly on the waistline where the eye reads the
  // break between torso and hips.
  parts.push({
    surface: loftKeys(
      [
        { p: V(-0.115, 1.118, back + 0.014), rx: 0.033, rz: 0.033, n: 2.2, zone: Z.PACK },
        { p: V(0, 1.106, back + 0.022), rx: 0.038, rz: 0.038, n: 2.2, zone: Z.PACK },
        { p: V(0.115, 1.118, back + 0.014), rx: 0.033, rz: 0.033, n: 2.2, zone: Z.PACK },
      ],
      9,
      { radial: 12, capStart: true, capEnd: true, forward: V(0, 1, 0) },
    ),
    mat: 'cloth',
  });
  for (const sx of [-0.058, 0.058]) {
    parts.push({
      surface: strap(
        [V(sx, 1.146, back + 0.03), V(sx, 1.112, back + 0.056), V(sx, 1.078, back + 0.03)],
        0.016,
        0.006,
        Z.WEBBING,
        { stations: 8 },
      ),
      mat: 'cloth',
    });
  }

  // Whip antenna off the pack's left shoulder. A 45 cm line breaking the
  // headroom above the silhouette is the cheapest possible read of "this is
  // equipment, not a costume", and it survives to any distance.
  parts.push({
    surface: loftKeys(
      [
        { p: V(-0.088, 1.36, back + 0.03), rx: 0.0055, rz: 0.0055, n: 2.2, zone: MZ.DARKPOLY },
        { p: V(-0.104, 1.52, back + 0.028), rx: 0.0035, rz: 0.0035, n: 2.2, zone: MZ.DARKPOLY },
        { p: V(-0.128, 1.68, back + 0.016), rx: 0.0026, rz: 0.0026, n: 2.2, zone: MZ.DARKPOLY },
        { p: V(-0.162, 1.80, back - 0.008), rx: 0.0018, rz: 0.0018, n: 2.2, zone: MZ.DARKPOLY },
      ],
      12,
      { radial: 6, capStart: true, capEnd: true },
    ),
    mat: 'metal',
  });

  // Shoulder straps over the front, each with a sternum-height adjuster.
  for (const sgn of [-1, 1]) {
    parts.push({
      surface: strap(
        [
          V(sgn * 0.085, 1.38, back - 0.03),
          V(sgn * 0.1, 1.452, 0.03),
          V(sgn * 0.102, 1.432, -0.06),
          V(sgn * 0.093, 1.33, -0.12),
          V(sgn * 0.07, 1.19, -0.13),
        ],
        0.046,
        0.013,
        Z.WEBBING,
        { stations: 18 },
      ),
      mat: 'cloth',
    });
    parts.push(...buckle(V(sgn * 0.082, 1.215, -0.142), { w: 0.03, h: 0.024, rotY: sgn * 0.2 }));
  }
  void o;
  return parts;
}

// -------------------------------------------------------------------------
// Headgear
// -------------------------------------------------------------------------

/**
 * A modern combat helmet (ACH/MICH pattern).
 *
 * Round 4's was a capped loft with a flat circular bottom edge and no brim, no
 * chin cup and no nape strap — a dome, which is exactly the "asymmetric blob"
 * note. What makes a helmet read as a helmet at any distance is three things and
 * none of them is resolution:
 *   1. A SCALLOPED edge — cut low over the brow and the nape, swept up over the
 *      ears. That single curve is the difference between a helmet and a bowl.
 *   2. A rolled BRIM standing 5 mm proud all the way round, so the edge carries
 *      a lit top and a shadowed underside instead of ending in nothing.
 *   3. A CHINSTRAP that is a closed system: two Y-yokes off the side rails, a
 *      chin cup under the jaw, and a nape pad behind. Without it a helmet floats.
 * The shell is swept as a quarter-ellipse from the crown down to that scalloped
 * edge rather than lofted along a straight spine, because a loft cross-section
 * cannot vary in height and the scallop is the whole point.
 */
export function buildHelmet() {
  const parts = [];
  const CY = 1.812; // crown, 30 mm above the skull's own 1.782
  const CX = -0.0; // centre in x
  const CZ = -0.008; // centre in z (skull is set back)

  // Edge height as a function of the angle around the helmet. a = 0 is the
  // FRONT (-Z), a = PI/2 the character's right (+X). Anchored to real landmarks
  // on this skull: the brow ridge is at y 1.710 and the top of the ear at 1.706,
  // so the front edge sits a few mm above the brow, the sides clear the ear, and
  // the back drops 45 mm to cover the nape. Round 4's edge was FLAT at 1.598 —
  // below the chin at 1.574 — so the helmet swallowed the entire face.
  const edgeY = (a) => 1.700 - 0.004 * Math.max(0, Math.cos(a)) - 0.045 * Math.max(0, -Math.cos(a));
  const edgeR = (a) => {
    const s = Math.sin(a);
    const c = Math.cos(a);
    // Superelliptic: a helmet is wider than it is deep at the ears and pushes
    // forward over the brow.
    const rx = 0.1125;
    const rz = c > 0 ? 0.1215 : 0.1265; // front (cos>0) / back
    const k = Math.pow(Math.pow(Math.abs(s / rx), 2.7) + Math.pow(Math.abs(c / rz), 2.7), -1 / 2.7);
    return k;
  };

  const shell = new Surface();
  const RINGS = 11;
  const SEG = 26;
  for (let j = 0; j <= RINGS; j++) {
    const t = j / RINGS;
    // Quarter-ellipse from crown (t=0) to edge (t=1).
    const rf = Math.sin((t * Math.PI) / 2);
    const yf = 1 - Math.cos((t * Math.PI) / 2);
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      const R = edgeR(a);
      const yE = edgeY(a);
      shell.vert(
        CX + Math.sin(a) * R * rf,
        CY - (CY - yE) * yf,
        CZ - Math.cos(a) * R * rf,
        (i / SEG) * 0.5,
        t * 0.16,
        Z.HELMCOVER,
        i / SEG,
        // rim: metres to the cut edge, so the stitched-border term draws the
        // cover's edge binding and nothing else.
        Math.min(0.25, (1 - t) * 0.22),
      );
    }
  }
  for (let j = 0; j < RINGS; j++) {
    for (let i = 0; i < SEG; i++) {
      const p = j * (SEG + 1) + i;
      shell.quad(p, p + 1, p + SEG + 2, p + SEG + 1);
    }
  }
  parts.push({ surface: shell, mat: 'cloth' });

  // Rolled brim: a closed loop of 22 mm tape following the same scalloped edge,
  // standing 5 mm proud. Lit on top, shadowed underneath — the horizontal that
  // separates the helmet from the head at any distance.
  const brim = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const R = edgeR(a) * 1.035;
    brim.push(V(CX + Math.sin(a) * R, edgeY(a) + 0.004, CZ - Math.cos(a) * R));
  }
  parts.push({ surface: strap(brim, 0.019, 0.012, Z.HELMCOVER, { stations: 30 }), mat: 'cloth' });

  // Cover seam: the four-panel seam over the crown, and the cat-eye retro band
  // around the back. Two more horizontals on an otherwise blank dome.
  // Two full meridian seams from edge, over the crown, to the opposite edge:
  // the four-panel cover every helmet cover is cut from.
  for (const a0 of [0.66, 2.24]) {
    const seam = [];
    for (let i = 0; i <= 18; i++) {
      const u = (i / 18) * 2 - 1; // -1 edge(a0) .. 0 crown .. +1 edge(a0+PI)
      const a = u < 0 ? a0 : a0 + Math.PI;
      const k = Math.abs(u);
      const rf = Math.sin((k * Math.PI) / 2);
      const yf = 1 - Math.cos((k * Math.PI) / 2);
      const R = edgeR(a) * rf;
      seam.push(V(CX + Math.sin(a) * R, CY - (CY - edgeY(a)) * yf + 0.0028, CZ - Math.cos(a) * R));
    }
    parts.push({ surface: strap(seam, 0.009, 0.004, Z.HELMCOVER, { stations: 22 }), mat: 'cloth' });
  }
  const band = [];
  for (let i = 0; i <= 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const t = 0.72;
    const rf = Math.sin((t * Math.PI) / 2);
    const yf = 1 - Math.cos((t * Math.PI) / 2);
    const R = edgeR(a) * rf * 1.02;
    band.push(V(CX + Math.sin(a) * R, CY - (CY - edgeY(a)) * yf, CZ - Math.cos(a) * R));
  }
  parts.push({ surface: strap(band, 0.016, 0.005, Z.WEBBING, { stations: 26 }), mat: 'cloth' });

  // NVG shroud on the brow, and the side rails the chinstrap yokes hang off.
  parts.push({
    surface: roundedBox(0.05, 0.028, 0.024, 0.007, { zone: MZ.DARKPOLY, radial: 10 }).transform(
      new THREE.Matrix4().makeRotationX(0.30).setPosition(0, 1.720, -0.122),
    ),
    mat: 'metal',
  });
  for (const sgn of [-1, 1]) {
    parts.push({
      surface: strap(
        [V(sgn * 0.099, 1.716, -0.055), V(sgn * 0.110, 1.710, 0.0), V(sgn * 0.100, 1.706, 0.055)],
        0.016,
        0.009,
        MZ.DARKPOLY,
        { stations: 8 },
      ),
      mat: 'metal',
    });
    // Chinstrap Y-yoke off the side rail: a forward leg down in front of the
    // ear to the jaw hinge, a rear leg behind it to the nape pad. Both are
    // 11 mm tape, i.e. two pixels at gameplay range — their job is to close the
    // shape between the helmet and the jaw, not to be read individually.
    parts.push({
      surface: strap(
        [V(sgn * 0.093, 1.700, -0.038), V(sgn * 0.083, 1.640, -0.048), V(sgn * 0.055, 1.590, -0.058)],
        0.011,
        0.004,
        Z.WEBBING,
        { stations: 9 },
      ),
      mat: 'cloth',
    });
    parts.push({
      surface: strap(
        [V(sgn * 0.095, 1.700, 0.026), V(sgn * 0.086, 1.646, 0.036), V(sgn * 0.058, 1.602, 0.02)],
        0.011,
        0.004,
        Z.WEBBING,
        { stations: 9 },
      ),
      mat: 'cloth',
    });
    parts.push(...buckle(V(sgn * 0.062, 1.606, -0.03), { w: 0.017, h: 0.013, rotY: sgn * 0.5 }));
  }
  // Chin cup under the jaw, and the nape pad behind.
  parts.push({
    surface: roundedBox(0.058, 0.02, 0.028, 0.007, { zone: Z.WEBBING, radial: 10 }).transform(
      new THREE.Matrix4().makeRotationX(-0.3).setPosition(0, 1.578, -0.056),
    ),
    mat: 'cloth',
  });
  parts.push({
    surface: roundedBox(0.082, 0.026, 0.02, 0.007, { zone: Z.WEBBING, radial: 10 }).transform(
      new THREE.Matrix4().setPosition(0, 1.614, 0.056),
    ),
    mat: 'cloth',
  });
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
  const rows = [0.24, 0.38, 0.52];
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
      // 17 mm of stand-off, not 5.5. The bandana goes OVER the hair, and the
      // hair shell is 13 mm proud of the skull — at 5.5 mm the band was buried
      // inside it everywhere except the bare forehead, which is why the head
      // came back from the gameplay camera as one undifferentiated dark bowl.
      // The 1.5 mm ripple is the fold the cloth takes over the ear.
      p3.multiplyScalar(1 + (0.0168 + 0.0012 * Math.sin(th * 7)) / len).add(HEAD_CENTRE);
      band.vert(p3.x, p3.y, p3.z, (i / R) * 0.5, j * 0.03, Z.BANDANA);
    }
  }
  for (let j = 0; j < rows.length - 1; j++) {
    for (let i = 0; i < R; i++) {
      const a = j * (R + 1) + i;
      // Rows run UP the skull, so this is the opposite winding to
      // displacedSphere (whose rows run down). See geometry.js.
      band.quad(a, a + R + 1, a + R + 2, a + 1);
    }
  }
  parts.push({ surface: band, mat: 'cloth' });
  // Knot + tails trailing down the back of the head. Round 4 halved both: at
  // 26 mm wide and 15 cm long the tails were the widest thing on the head and
  // the only saturated colour in the frame, so from the gameplay camera the
  // read was "red ribbon", not "soldier". A tied bandana tail is a 14 mm
  // pennant.
  //
  // Round 5 moved the knot DOWN to the nape and laid the tails flat against the
  // skull. At y 1.712 with the tails hanging off the back of the crown they
  // stood clear of the silhouette on both sides of the head and read, at
  // gameplay range, as two antennae — the "asymmetric blob" note. A bandana is
  // tied at the occiput, below the widest point of the skull, and its tails lie
  // ON the hair.
  parts.push({
    surface: roundedBox(0.036, 0.024, 0.022, 0.006, { zone: Z.BANDANA, radial: 8 }).transform(
      new THREE.Matrix4().makeRotationX(0.35).setPosition(0, 1.664, 0.098),
    ),
    mat: 'cloth',
  });
  for (const sgn of [-1, 1]) {
    parts.push({
      surface: strap(
        [
          V(sgn * 0.014, 1.658, 0.1),
          V(sgn * 0.03, 1.634, 0.096),
          V(sgn * 0.042, 1.608, 0.084),
          V(sgn * 0.046, 1.586, 0.066),
        ],
        0.017,
        0.004,
        Z.BANDANA,
        { stations: 10, taper: 0.5 },
      ),
      mat: 'cloth',
    });
  }
  return parts;
}

/**
 * A band wrapped onto the actual skull surface at a given latitude.
 *
 * Anything worn on the head has to follow `headSurface`, not a cylinder: the
 * temples and eye sockets are recessed by up to 17 mm, so a straight ring
 * floats off the head exactly where it is most visible. `tilt` lifts the band
 * toward the front, which is how a strap clears the brow instead of cutting
 * across the eye.
 */
function skullBand(opts = {}) {
  const s = new Surface();
  const R = opts.segments ?? 26;
  const rows = opts.rows ?? [-0.5, 0.0, 0.5];
  const lat = opts.lat ?? 0.36;
  const halfWidth = opts.halfWidth ?? 0.012;
  const tilt = opts.tilt ?? 0;
  const stand = opts.stand ?? 0.005;
  const zone = opts.zone ?? Z.LEATHER;
  const dir = new THREE.Vector3();
  const p3 = new THREE.Vector3();
  for (let j = 0; j < rows.length; j++) {
    for (let i = 0; i <= R; i++) {
      const th = (i / R) * Math.PI * 2;
      // -cos(th) peaks at the front of the head (-Z), so `tilt` raises the band
      // over the brow and drops it behind the ears.
      const cy = lat + rows[j] * 2 * halfWidth + tilt * -Math.cos(th);
      const s2 = Math.sqrt(Math.max(0, 1 - cy * cy));
      dir.set(Math.cos(th) * s2, cy, Math.sin(th) * s2);
      headSurface(dir, p3, {});
      p3.sub(HEAD_CENTRE);
      const len = p3.length() || 1;
      p3.multiplyScalar(1 + stand / len).add(HEAD_CENTRE);
      s.vert(p3.x, p3.y, p3.z, (i / R) * 0.5, j * halfWidth, zone, i / R, j === 0 || j === rows.length - 1 ? 0 : 0.02);
    }
  }
  for (let j = 0; j < rows.length - 1; j++) {
    for (let i = 0; i < R; i++) {
      const a = j * (R + 1) + i;
      // Rows run up the skull; opposite winding to displacedSphere.
      s.quad(a, a + R + 1, a + R + 2, a + 1);
    }
  }
  return s;
}

/** Eyepatch over the right eye. */
export function buildEyepatch() {
  const parts = [];
  const patch = displacedSphere(
    (dir, out) => {
      out.set(0.036 + 0.033 * dir.x, 1.690 + 0.031 * dir.y, -0.0715 + 0.012 * dir.z - 0.013 * dir.x);
    },
    14,
    10,
    Z.LEATHER,
    0.2,
  );
  parts.push({ surface: patch, mat: 'cloth' });
  // The strap wraps the skull ABOVE the brow line. Round 1 routed it through
  // (-0.05, 1.678, -0.072) — straight across the left eye — which read as a
  // black bar over the whole mid-face.
  parts.push({ surface: skullBand({ lat: 0.30, halfWidth: 0.006, tilt: 0.115, stand: 0.0045 }), mat: 'cloth' });
  // Short tab joining the strap down onto the patch itself.
  parts.push({
    surface: strap(
      [V(0.052, 1.716, -0.068), V(0.060, 1.703, -0.070), V(0.056, 1.688, -0.068)],
      0.012,
      0.005,
      Z.LEATHER,
      { stations: 6 },
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
  parts.push(
    ...pouch(
      0.1,
      0.12,
      0.06,
      new THREE.Matrix4().makeRotationY(0.5 + Math.PI).setPosition(-0.16, 0.9, 0.055),
      { radial: 12, lidH: 0.030 },
    ),
  );
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
