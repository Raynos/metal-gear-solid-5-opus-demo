import * as THREE from 'three';
import { Surface, loftKeys, displacedSphere, frameMatrix, strap } from './geometry.js';
import { Z, SZ } from './materials.js';

/**
 * The humanoid body itself: torso, limbs, hands, feet, head.
 *
 * Authored in character space — feet on y = 0, facing -Z, right hand toward +X —
 * in the same relaxed A-pose the rig binds to. Every anatomical form comes from
 * a swept profile whose cross-section changes along the limb: the deltoid is a
 * widened, forward-biased ellipse; the calf swells behind the shin and collapses
 * into a narrow, flattened ankle; the chest is a wide flat superellipse with a
 * sternum groove and a spine groove. That is the whole difference between a
 * character and a stack of capsules.
 */

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const gauss = (x, s) => Math.exp(-(x / s) * (x / s));

// -------------------------------------------------------------------------
// Torso
// -------------------------------------------------------------------------

export function buildTorso(o = {}) {
  const bulk = o.bulk ?? 1;
  // Sternum groove + spinal furrow. Cheap, and they are the two silhouette cues
  // that read "ribcage" instead of "barrel".
  const grooves = (th) =>
    (1 - 0.05 * gauss(th - Math.PI / 2, 0.3)) * (1 - 0.06 * gauss(th - (3 * Math.PI) / 2, 0.26));
  const lats = (th) =>
    grooves(th) * (1 + 0.05 * (gauss(th, 0.4) + gauss(th - Math.PI, 0.4) + gauss(th - Math.PI * 2, 0.4)));

  const keys = [
    { p: V(0, 0.888, -0.004), rx: 0.152 * bulk, rz: 0.11 * bulk, n: 2.7, zone: Z.JACKET, mod: grooves },
    { p: V(0, 0.935, -0.006), rx: 0.151 * bulk, rz: 0.109 * bulk, n: 2.6, zone: Z.JACKET, mod: grooves },
    { p: V(0, 1.005, -0.008), rx: 0.147 * bulk, rz: 0.105 * bulk, n: 2.5, zone: Z.JACKET, mod: grooves },
    { p: V(0, 1.095, -0.012), rx: 0.152 * bulk, rz: 0.109 * bulk, n: 2.6, zone: Z.JACKET, mod: lats },
    { p: V(0, 1.19, -0.014), rx: 0.172 * bulk, rz: 0.117 * bulk, n: 2.8, zone: Z.JACKET, mod: lats },
    { p: V(0, 1.285, -0.014), rx: 0.19 * bulk, rz: 0.124 * bulk, n: 3.0, zone: Z.JACKET, mod: lats },
    { p: V(0, 1.365, -0.012), rx: 0.206 * bulk, rz: 0.12 * bulk, n: 3.2, zone: Z.JACKET, mod: grooves },
    { p: V(0, 1.435, -0.008), rx: 0.204 * bulk, rz: 0.108 * bulk, n: 3.1, zone: Z.JACKET, mod: grooves },
    { p: V(0, 1.482, -0.004), rx: 0.155, rz: 0.093, n: 2.7, zone: Z.JACKET },
    { p: V(0, 1.512, 0.0), rx: 0.098, rz: 0.08, n: 2.4, zone: Z.COLLAR },
  ];
  return loftKeys(keys, 26, { radial: 26, capStart: true, capEnd: true });
}

/** Hips and seat — the jacket hem overlaps this, so only the lower half shows. */
export function buildHips(o = {}) {
  const bulk = o.bulk ?? 1;
  const keys = [
    { p: V(0, 1.03, -0.004), rx: 0.15 * bulk, rz: 0.113 * bulk, n: 2.6, zone: Z.TROUSER },
    { p: V(0, 0.965, -0.002), rx: 0.158 * bulk, rz: 0.12 * bulk, n: 2.6, zone: Z.TROUSER },
    { p: V(0, 0.9, 0.004), rx: 0.163 * bulk, rz: 0.126 * bulk, n: 2.7, back: 1.12, zone: Z.TROUSER },
    { p: V(0, 0.855, 0.006), rx: 0.152 * bulk, rz: 0.113 * bulk, n: 2.8, back: 1.1, zone: Z.TROUSER },
    { p: V(0, 0.82, 0.004), rx: 0.138 * bulk, rz: 0.1 * bulk, n: 3.0, zone: Z.TROUSER },
    // Crotch: the profile splits into two legs, so pinch the depth hard.
    { p: V(0, 0.8, 0.0), rx: 0.128 * bulk, rz: 0.072 * bulk, n: 3.2, zone: Z.TROUSER },
  ];
  return loftKeys(keys, 14, { radial: 22, capStart: true, capEnd: true });
}

export function buildNeck() {
  const keys = [
    { p: V(0, 1.4, -0.004), rx: 0.072, rz: 0.076, n: 2.4, zone: SZ.NECK },
    { p: V(0, 1.46, -0.006), rx: 0.062, rz: 0.066, n: 2.4, zone: SZ.NECK },
    { p: V(0, 1.53, -0.01), rx: 0.056, rz: 0.06, n: 2.4, zone: SZ.NECK },
    { p: V(0, 1.585, -0.014), rx: 0.058, rz: 0.064, n: 2.4, zone: SZ.NECK },
  ];
  return loftKeys(keys, 8, { radial: 16, capStart: true, capEnd: false });
}

// -------------------------------------------------------------------------
// Head
// -------------------------------------------------------------------------

/**
 * Skull built by layering anatomical features onto an ellipsoid: jaw taper,
 * chin, brow ridge, eye sockets, nose, cheekbones, occiput, ears. A head is the
 * one part a viewer will always look at first, so the features are placed from
 * real proportions rather than eyeballed.
 */
export const HEAD_CENTRE = new THREE.Vector3(0, 1.678, -0.006);

/**
 * The skull as a displacement of the unit sphere. Exported because everything
 * worn on the head — hair, bandana, helmet liner — has to follow *this* surface.
 * A plain ellipsoid does not: the eye sockets and temples are recessed by up to
 * 17 mm, so a naive shell pops out through the face exactly where it is most
 * visible.
 */
export function headSurface(dir, out, o = {}) {
  {
    {
      const cx = 0;
      const cy = o.cy ?? 1.678;
      const cz = o.cz ?? -0.006;
      const w = o.width ?? 0.0825;
      const h = o.height ?? 0.104;
      const d = o.depth ?? 0.094;
      const jawW = o.jawWidth ?? 1;
      let x = dir.x * w;
      let y = dir.y * h;
      let z = dir.z * d; // -z is the face
      const front = Math.max(0, -z / d);

      // Jaw: narrows and shortens below the cheekbones, ending in a chin.
      const jt = THREE.MathUtils.smoothstep(-y, 0.005, 0.1);
      x *= 1 - 0.28 * jt * jt * (2 - jawW);
      z *= 1 - 0.22 * jt * jt;
      if (z > 0) z *= 1 - 0.3 * jt; // back of the jaw recedes under the ear
      const chin = gauss(x / 0.036, 1) * gauss((y + 0.078) / 0.03, 1) * front;
      z -= 0.014 * chin;
      y -= 0.004 * chin;

      // Cranium: flatten the temples, bulge the occiput, square the forehead.
      const up = THREE.MathUtils.smoothstep(y, 0.02, 0.09);
      x *= 1 - 0.06 * up;
      if (z > 0) z += 0.009 * gauss((y - 0.015) / 0.05, 1);
      const brow = gauss((y - 0.032) / 0.021, 1) * gauss(x / 0.058, 1) * front;
      z -= 0.014 * brow;
      // Temple/forehead plane above the brow pulls back — the shadow line that
      // reads as a browridge at any distance.
      z += 0.006 * gauss((y - 0.062) / 0.024, 1) * front;

      // Eye sockets sit under the brow and are pushed back — this is what
      // creates the dark eye shadow the AO bake then amplifies.
      const socket = gauss((Math.abs(x) - 0.032) / 0.019, 1) * gauss((y - 0.007) / 0.017, 1) * front;
      z += 0.017 * socket;

      // Nose: a bridge that grows into a tip, then nostril wings.
      const ny = THREE.MathUtils.clamp((0.036 - y) / 0.072, 0, 1);
      const noseProfile = Math.pow(ny, 1.5) * (1 - THREE.MathUtils.smoothstep(ny, 0.9, 1.0));
      const nose = gauss(x / 0.0165, 1) * noseProfile * front;
      z -= 0.036 * nose;
      const wing = gauss((Math.abs(x) - 0.016) / 0.009, 1) * gauss((y + 0.028) / 0.012, 1) * front;
      z -= 0.013 * wing;

      // Cheekbones and the mouth mass.
      const cheek = gauss((Math.abs(x) - 0.049) / 0.023, 1) * gauss((y + 0.002) / 0.024, 1);
      x += 0.009 * cheek * Math.sign(x || 1);
      z -= 0.009 * cheek * front;
      // Hollow under the cheekbone: the single most character-defining plane.
      const hollow = gauss((Math.abs(x) - 0.044) / 0.019, 1) * gauss((y + 0.036) / 0.018, 1) * front;
      z += 0.005 * hollow;
      const mouth = gauss(x / 0.028, 1) * gauss((y + 0.049) / 0.015, 1) * front;
      z -= 0.010 * mouth;
      // Mouth line itself, cut back between the lips.
      z += 0.004 * gauss(x / 0.03, 1) * gauss((y + 0.049) / 0.004, 1) * front;
      // Jawline: a hard edge from the ear to the chin.
      const jawEdge = gauss((Math.abs(x) - 0.045 + jt * 0.02) / 0.016, 1) * gauss((y + 0.062) / 0.018, 1);
      x += 0.006 * jawEdge * Math.sign(x || 1);

      // Ears.
      const ear = gauss((y + 0.004) / 0.024, 1) * gauss((z - 0.022) / 0.02, 1);
      x += 0.013 * ear * Math.sign(x || 1) * THREE.MathUtils.smoothstep(Math.abs(dir.x), 0.55, 0.9);

      out.set(cx + x, cy + y, cz + z);
    }
  }
  return out;
}

export function buildHead(o = {}) {
  return displacedSphere((dir, out) => headSurface(dir, out, o), 32, 24, SZ.FACE, 0.5);
}

/**
 * Eyeballs. Two 12 mm spheres seated in the sockets. They cost ~200 verts and
 * they are the difference between a face and a mannequin: a real specular
 * highlight in the eye is the cue a viewer reads first.
 */
export function buildEyes(o = {}) {
  const cy = o.cy ?? 1.661;
  const cz = o.cz ?? -0.0715;
  const s = new Surface();
  for (const sgn of [-1, 1]) {
    const e = displacedSphere(
      (dir, out) => {
        out.set(sgn * 0.0325 + dir.x * 0.0122, cy + dir.y * 0.0122, cz + dir.z * 0.0122);
      },
      14,
      10,
      SZ.EYE,
      0.08,
    );
    s.merge(e);
  }
  return s;
}

/** Short cropped hair as a thin shell over the skull — only where a hat isn't. */
export function buildHair(o = {}) {
  const back = o.backOnly ?? false;
  const c = HEAD_CENTRE;
  const tmp = new THREE.Vector3();
  return displacedSphere(
    (dir, out) => {
      headSurface(dir, tmp, o);
      // Hairline: high on the forehead, receding at the temples.
      let cover = THREE.MathUtils.smoothstep(dir.y * 1.0 + dir.z * 0.72, 0.28, 0.66);
      if (back) cover *= THREE.MathUtils.smoothstep(dir.y * 0.4 + dir.z, -0.1, 0.45);
      const clump = 1 + 0.55 * Math.sin(dir.x * 34) * Math.sin(dir.z * 29) * cover;
      // Offset ALONG the skull's own radius: negative where there is no hair, so
      // the shell is buried inside the head and the crossover is the hairline.
      const t = -0.009 + cover * (0.017 + 0.004 * clump);
      out.copy(tmp).sub(c);
      const len = out.length() || 1;
      out.multiplyScalar(1 + t / len).add(c);
    },
    30,
    22,
    Z.HAIR,
    0.4,
  );
}

// -------------------------------------------------------------------------
// Arms
// -------------------------------------------------------------------------

const ARM = {
  shoulder: V(0.176, 1.452, -0.014),
  elbow: V(0.336, 1.192, -0.02),
  wrist: V(0.471, 0.962, -0.014),
};

function armPoint(t) {
  // Piecewise along shoulder->elbow->wrist.
  if (t <= 0.5) return ARM.shoulder.clone().lerp(ARM.elbow, t / 0.5);
  return ARM.elbow.clone().lerp(ARM.wrist, (t - 0.5) / 0.5);
}

/**
 * The right arm. `sleeve` is where the fabric ends: 'wrist' for a full sleeve,
 * 'rolled' for a thick roll just below the elbow with bare forearm beyond.
 */
export function buildArm(o = {}) {
  const bulk = o.bulk ?? 1;
  const rolled = o.sleeve === 'rolled';
  const parts = [];

  // Deltoid + upper arm + forearm, one continuous loft. The sleeve/skin split
  // is a zone change mid-loft, so there is no gap at the cuff.
  const rollT = 0.62;
  const keys = [
    // Root buried inside the torso so the shoulder never shows a seam.
    { p: V(0.085, 1.478, -0.014), rx: 0.086, rz: 0.09, n: 2.6, zone: Z.SLEEVE },
    { p: V(0.135, 1.475, -0.014), rx: 0.081 * bulk, rz: 0.085 * bulk, n: 2.5, zone: Z.SLEEVE },
    // Deltoid cap: widest point of the arm, biased forward and up.
    { p: armPoint(0.06), rx: 0.075 * bulk, rz: 0.08 * bulk, n: 2.4, front: 1.08, zone: Z.SLEEVE },
    { p: armPoint(0.2), rx: 0.065 * bulk, rz: 0.069 * bulk, n: 2.3, zone: Z.SLEEVE },
    { p: armPoint(0.34), rx: 0.06 * bulk, rz: 0.064 * bulk, n: 2.3, zone: Z.SLEEVE },
    { p: armPoint(0.46), rx: 0.052 * bulk, rz: 0.056, n: 2.3, zone: Z.SLEEVE },
    { p: armPoint(0.52), rx: 0.051, rz: 0.057, n: 2.3, zone: Z.SLEEVE },
    rolled
      ? { p: armPoint(rollT), rx: 0.058, rz: 0.062, n: 2.3, zone: Z.SLEEVE }
      : { p: armPoint(0.62), rx: 0.054, rz: 0.057, n: 2.3, zone: Z.SLEEVE },
    rolled
      ? { p: armPoint(rollT + 0.03), rx: 0.049, rz: 0.051, n: 2.3, zone: SZ.ARM }
      : { p: armPoint(0.74), rx: 0.048, rz: 0.05, n: 2.3, zone: Z.SLEEVE },
    { p: armPoint(0.85), rx: 0.041, rz: 0.043, n: 2.3, zone: rolled ? SZ.ARM : Z.SLEEVE },
    { p: armPoint(0.95), rx: 0.033, rz: 0.037, n: 2.4, zone: rolled ? SZ.ARM : Z.SLEEVE },
    { p: ARM.wrist.clone(), rx: 0.028, rz: 0.033, n: 2.4, zone: rolled ? SZ.ARM : Z.SLEEVE },
  ];

  if (rolled) {
    // Split the loft so the sleeve half is cloth and the forearm half is skin.
    const upper = loftKeys(keys.slice(0, 9), 18, { radial: 16, capStart: true });
    const lower = loftKeys(keys.slice(7), 10, { radial: 16, capEnd: false });
    parts.push({ surface: upper, mat: 'cloth' });
    parts.push({ surface: lower, mat: 'skin' });
    // The roll itself: a fat torus-ish band of bunched fabric.
    const a = armPoint(rollT - 0.02);
    const b = armPoint(rollT + 0.045);
    parts.push({
      surface: loftKeys(
        [
          { p: a, rx: 0.05, rz: 0.054, n: 2.3, zone: Z.SLEEVE },
          { p: a.clone().lerp(b, 0.5), rx: 0.06, rz: 0.064, n: 2.2, zone: Z.SLEEVE },
          { p: b, rx: 0.049, rz: 0.053, n: 2.3, zone: Z.SLEEVE },
        ],
        7,
        { radial: 16 },
      ),
      mat: 'cloth',
    });
  } else {
    parts.push({ surface: loftKeys(keys, 24, { radial: 16, capStart: true }), mat: 'cloth' });
  }
  return parts;
}

/**
 * A hand closed around a grip. Both hands spend essentially all their time on
 * the weapon, so the fingers are authored curled — a relaxed open hand posed
 * onto a rifle looks far worse than a grip that is simply always right.
 */
export function buildHand(o = {}) {
  const zone = o.zone ?? Z.GLOVE;
  const mat = o.mat ?? 'cloth';
  const fingerZone = o.fingerZone ?? zone;
  const fingerMat = o.fingerMat ?? mat;
  const s = new Surface();
  const fs = new Surface();

  // Palm: a flattened wedge from wrist to knuckles.
  s.merge(
    loftKeys(
      [
        { p: V(0, -0.012, 0), rx: 0.026, rz: 0.03, n: 2.6, zone },
        { p: V(0, 0.012, 0.002), rx: 0.03, rz: 0.026, n: 2.8, zone },
        { p: V(0, 0.046, 0.006), rx: 0.036, rz: 0.026, n: 3.0, zone },
        { p: V(0, 0.075, 0.01), rx: 0.038, rz: 0.024, n: 3.0, zone },
        { p: V(0, 0.09, 0.014), rx: 0.035, rz: 0.021, n: 3.0, zone },
      ],
      10,
      { radial: 14, capStart: true, capEnd: true, forward: V(0, 0, 1) },
    ),
  );

  // Four fingers curled around a ~19 mm grip.
  const fingers = [
    { x: 0.0225, len: 1.0 },
    { x: 0.0078, len: 1.09 },
    { x: -0.0072, len: 1.02 },
    { x: -0.0218, len: 0.86 },
  ];
  for (const f of fingers) {
    const pts = [V(f.x, 0.083, 0.006)];
    const angles = [0.62, 1.55, 2.45];
    const lens = [0.034 * f.len, 0.026 * f.len, 0.02 * f.len];
    let cur = pts[0].clone();
    for (let i = 0; i < 3; i++) {
      cur = cur.clone().add(V(0, Math.cos(angles[i]) * lens[i], Math.sin(angles[i]) * lens[i]));
      pts.push(cur);
    }
    const r = 0.0092 * (0.85 + f.len * 0.16);
    fs.merge(
      loftKeys(
        [
          { p: pts[0], rx: r, rz: r * 0.95, n: 2.6, zone: fingerZone },
          { p: pts[1], rx: r * 0.97, rz: r * 0.94, n: 2.6, zone: fingerZone },
          { p: pts[2], rx: r * 0.88, rz: r * 0.86, n: 2.6, zone: fingerZone },
          { p: pts[3], rx: r * 0.7, rz: r * 0.7, n: 2.6, zone: fingerZone },
        ],
        11,
        { radial: 8, capStart: false, capEnd: true, forward: V(0, 0, 1) },
      ),
    );
  }

  // Thumb: wraps the other way across the grip.
  const tr = 0.011;
  fs.merge(
    loftKeys(
      [
        { p: V(0.03, 0.026, 0.004), rx: tr, rz: tr, n: 2.6, zone: fingerZone },
        { p: V(0.036, 0.05, 0.018), rx: tr * 0.95, rz: tr * 0.95, n: 2.6, zone: fingerZone },
        { p: V(0.03, 0.068, 0.036), rx: tr * 0.85, rz: tr * 0.85, n: 2.6, zone: fingerZone },
        { p: V(0.016, 0.076, 0.048), rx: tr * 0.68, rz: tr * 0.68, n: 2.6, zone: fingerZone },
      ],
      9,
      { radial: 8, capStart: true, capEnd: true, forward: V(0, 0, 1) },
    ),
  );

  const out = [{ surface: s, mat }];
  if (fingerMat === mat) {
    s.merge(fs);
  } else {
    out.push({ surface: fs, mat: fingerMat });
  }
  return out;
}

/** Place a hand built in local space onto the wrist of the right/left arm. */
export function handMatrix(wrist, tip) {
  return frameMatrix(wrist, tip.clone().sub(wrist), V(0, 0, -1));
}

// -------------------------------------------------------------------------
// Legs and boots
// -------------------------------------------------------------------------

const LEG = { hip: V(0.094, 0.942, -0.004), knee: V(0.099, 0.508, 0.008), ankle: V(0.102, 0.082, 0.026) };

export function buildLeg(o = {}) {
  const bulk = o.bulk ?? 1;
  const bloused = o.bloused ?? true;
  const kneeFront = (th) => 1 + 0.06 * gauss(th - Math.PI / 2, 0.5);
  const calfBack = (th) => 1 + 0.1 * gauss(th - (3 * Math.PI) / 2, 0.55);

  const keys = [
    { p: V(0.094, 1.0, -0.004), rx: 0.099 * bulk, rz: 0.11 * bulk, n: 2.6, zone: Z.TROUSER },
    { p: V(0.096, 0.925, -0.004), rx: 0.09 * bulk, rz: 0.1 * bulk, n: 2.5, zone: Z.TROUSER },
    { p: V(0.099, 0.83, -0.002), rx: 0.082 * bulk, rz: 0.091 * bulk, n: 2.5, zone: Z.TROUSER },
    { p: V(0.101, 0.72, 0.0), rx: 0.076 * bulk, rz: 0.085 * bulk, n: 2.5, zone: Z.TROUSER },
    { p: V(0.102, 0.61, 0.004), rx: 0.07 * bulk, rz: 0.078 * bulk, n: 2.5, zone: Z.TROUSER },
    { p: V(0.099, 0.535, 0.008), rx: 0.068, rz: 0.078, n: 2.5, mod: kneeFront, zone: Z.TROUSER },
    { p: V(0.1, 0.48, 0.01), rx: 0.069, rz: 0.079, n: 2.5, mod: kneeFront, zone: Z.TROUSER },
    { p: V(0.1, 0.41, 0.012), rx: 0.073, rz: 0.083, n: 2.5, mod: calfBack, zone: Z.TROUSER },
    { p: V(0.101, 0.33, 0.016), rx: 0.072, rz: 0.081, n: 2.5, mod: calfBack, zone: Z.TROUSER },
    // Bloused into the boot: the fabric balloons then cinches. Iconic.
    bloused
      ? { p: V(0.101, 0.265, 0.02), rx: 0.076, rz: 0.083, n: 2.6, zone: Z.TROUSER }
      : { p: V(0.101, 0.265, 0.02), rx: 0.06, rz: 0.066, n: 2.5, zone: Z.TROUSER },
    bloused
      ? { p: V(0.102, 0.225, 0.022), rx: 0.068, rz: 0.073, n: 2.7, zone: Z.TROUSER }
      : { p: V(0.102, 0.225, 0.022), rx: 0.055, rz: 0.06, n: 2.5, zone: Z.TROUSER },
    { p: V(0.102, 0.2, 0.024), rx: 0.055, rz: 0.06, n: 2.6, zone: Z.TROUSER },
  ];
  return loftKeys(keys, 26, { radial: 18, capStart: true, capEnd: true });
}

export function buildBoot() {
  const parts = [];
  const x = 0.102;
  // Shaft: mid-calf combat boot, laced, slightly conical.
  parts.push({
    surface: loftKeys(
      [
        { p: V(x, 0.245, 0.022), rx: 0.06, rz: 0.065, n: 2.6, zone: Z.LEATHER },
        { p: V(x, 0.2, 0.024), rx: 0.058, rz: 0.062, n: 2.6, zone: Z.LEATHER },
        { p: V(x, 0.15, 0.026), rx: 0.053, rz: 0.058, n: 2.6, zone: Z.LEATHER },
        { p: V(x, 0.105, 0.028), rx: 0.05, rz: 0.058, n: 2.7, zone: Z.LEATHER },
        { p: V(x, 0.075, 0.03), rx: 0.05, rz: 0.062, n: 2.8, zone: Z.LEATHER },
      ],
      11,
      { radial: 16, capStart: true },
    ),
    mat: 'cloth',
  });

  // Foot: heel -> instep -> ball -> toe. Spine runs forward (-Z).
  parts.push({
    surface: loftKeys(
      [
        { p: V(x, 0.05, 0.075), rx: 0.036, rz: 0.045, n: 2.8, zone: Z.LEATHER },
        { p: V(x, 0.048, 0.045), rx: 0.045, rz: 0.048, n: 2.9, zone: Z.LEATHER },
        { p: V(x, 0.05, 0.0), rx: 0.05, rz: 0.05, n: 3.0, zone: Z.LEATHER },
        { p: V(x, 0.048, -0.055), rx: 0.052, rz: 0.043, n: 3.2, zone: Z.LEATHER },
        { p: V(x, 0.044, -0.105), rx: 0.048, rz: 0.036, n: 3.2, zone: Z.LEATHER },
        { p: V(x, 0.04, -0.14), rx: 0.034, rz: 0.026, n: 3.0, zone: Z.LEATHER },
      ],
      13,
      { radial: 16, capStart: true, capEnd: true },
    ),
    mat: 'cloth',
  });

  // Lugged rubber sole + heel block — a boot with no visible sole reads as a sock.
  parts.push({
    surface: loftKeys(
      [
        { p: V(x, 0.019, 0.082), rx: 0.036, rz: 0.019, n: 4.5, zone: 0 },
        { p: V(x, 0.016, 0.045), rx: 0.047, rz: 0.021, n: 4.5, zone: 0 },
        { p: V(x, 0.015, 0.0), rx: 0.053, rz: 0.019, n: 4.5, zone: 0 },
        { p: V(x, 0.015, -0.06), rx: 0.055, rz: 0.019, n: 4.5, zone: 0 },
        { p: V(x, 0.016, -0.11), rx: 0.05, rz: 0.018, n: 4.5, zone: 0 },
        { p: V(x, 0.018, -0.146), rx: 0.034, rz: 0.015, n: 4.0, zone: 0 },
      ],
      13,
      { radial: 14, capStart: true, capEnd: true },
    ),
    mat: 'rubber',
  });
  parts.push({
    surface: loftKeys(
      [
        { p: V(x, 0.03, 0.082), rx: 0.037, rz: 0.03, n: 4.5, zone: 0 },
        { p: V(x, 0.028, 0.048), rx: 0.046, rz: 0.03, n: 4.5, zone: 0 },
        { p: V(x, 0.026, 0.028), rx: 0.048, rz: 0.026, n: 4.5, zone: 0 },
      ],
      6,
      { radial: 12, capStart: true, capEnd: true },
    ),
    mat: 'rubber',
  });

  // Laces: three visible bands across the instep.
  for (let i = 0; i < 4; i++) {
    const z = 0.02 - i * 0.03;
    parts.push({
      surface: strap([V(x - 0.04, 0.075 - i * 0.004, z), V(x, 0.083 - i * 0.005, z - 0.004), V(x + 0.04, 0.075 - i * 0.004, z)], 0.009, 0.006, Z.WEBBING, { stations: 7 }),
      mat: 'cloth',
    });
  }
  return parts;
}

export { ARM, LEG, armPoint };
