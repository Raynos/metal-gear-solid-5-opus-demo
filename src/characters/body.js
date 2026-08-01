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

  // Trapezius: the muscle that fills the corner between the neck and the point
  // of the shoulder. Round 4's torso went from rx 0.204 at y 1.435 to 0.098 at
  // 1.512 — a 10 cm collapse over 7.7 cm of height, i.e. a 52-degree cliff, and
  // that cliff read from the gameplay camera as the "90-degree box corner"
  // under the head. A real trapezius is a CONVEX ramp: widest at the base of
  // the neck, sloping out and down to the acromion. `traps` biases the section
  // toward the character's sides at the top of the loft so the ramp is a
  // shoulder rather than a cone.
  const traps = (th) => 1 + 0.13 * (gauss(th, 0.55) + gauss(th - Math.PI, 0.55) + gauss(th - Math.PI * 2, 0.55));

  const keys = [
    { p: V(0, 0.888, -0.004), rx: 0.152 * bulk, rz: 0.11 * bulk, n: 2.7, zone: Z.JACKET, mod: grooves },
    { p: V(0, 0.935, -0.006), rx: 0.151 * bulk, rz: 0.109 * bulk, n: 2.6, zone: Z.JACKET, mod: grooves },
    { p: V(0, 1.005, -0.008), rx: 0.147 * bulk, rz: 0.105 * bulk, n: 2.5, zone: Z.JACKET, mod: grooves },
    { p: V(0, 1.095, -0.012), rx: 0.152 * bulk, rz: 0.109 * bulk, n: 2.6, zone: Z.JACKET, mod: lats },
    { p: V(0, 1.19, -0.014), rx: 0.172 * bulk, rz: 0.117 * bulk, n: 2.8, zone: Z.JACKET, mod: lats },
    { p: V(0, 1.285, -0.014), rx: 0.19 * bulk, rz: 0.124 * bulk, n: 3.0, zone: Z.JACKET, mod: lats },
    { p: V(0, 1.352, -0.012), rx: 0.204 * bulk, rz: 0.121 * bulk, n: 3.2, zone: Z.JACKET, mod: lats },
    // Point of the shoulder. Above this the section keeps its WIDTH and loses
    // its depth, which is what turns the top of the torso into a yoke.
    { p: V(0, 1.402, -0.010), rx: 0.201 * bulk, rz: 0.113 * bulk, n: 3.0, zone: Z.JACKET, mod: traps },
    { p: V(0, 1.441, -0.007), rx: 0.176 * bulk, rz: 0.102 * bulk, n: 2.8, zone: Z.JACKET, mod: traps },
    { p: V(0, 1.458, -0.005), rx: 0.132 * bulk, rz: 0.090, n: 2.7, zone: Z.JACKET, mod: traps },
    // The jacket's neck opening. It has to close INSIDE the collar stand at
    // every height the two share — otherwise the jacket shell pokes out
    // through the collar — and below the point where the neck becomes visible.
    // ROUND 6 dropped it 17 mm to stay under the collar, which came down 15.
    { p: V(0, 1.470, -0.004), rx: 0.086, rz: 0.074, n: 2.5, zone: Z.COLLAR },
  ];
  return loftKeys(keys, 28, { radial: 26, capStart: true, capEnd: true });
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

/**
 * A standing jacket collar.
 *
 * Without one the neck rises straight out of the torso loft and the AO bake
 * buries the join, so the head reads as a ball balanced on a shaft — which was
 * exactly the round-3 note. A collar is a separate piece of cloth standing 12 mm
 * off the neck with a cut edge at the top, so it gets its own rim highlight, its
 * own stitched border and its own shadow onto the shoulders: three value steps
 * in the 60 px where the head meets the body.
 */
export function buildCollar(o = {}) {
  const bulk = o.bulk ?? 1;
  const parts = [];
  // Round 5. The round-4 collar was a 9 cm stand that closed at y = 1.542 with
  // rx 0.081 — wider than the neck at every height it covered, so it swallowed
  // the whole neck and the head sat straight on it. Measured on the shipped
  // frame there were 6 px of skin between the jaw and the collar. A BDU collar
  // is a 30 mm band that is FOLDED DOWN over the shoulders: the stand itself is
  // short, and what you see is the fold lying flat with a cut edge, a notch at
  // the front and a shadow underneath. That is three value steps in the same
  // place the old one gave zero, and it leaves 10 cm of neck above it.
  // ROUND 6: the stand tops out 15 mm lower (1.501 -> 1.486) and 8% tighter.
  // With the head lifted 19 mm that turns 40 mm of exposed neck into 74 mm —
  // a 43 px column at the gameplay camera's 579 px/m rather than 23 px, which
  // is the difference between a neck you can see and a neck that is a seam.
  parts.push({
    surface: loftKeys(
      [
        { p: V(0, 1.446, -0.006), rx: 0.114 * bulk, rz: 0.094 * bulk, n: 2.8, back: 1.04, zone: Z.COLLAR },
        { p: V(0, 1.468, -0.005), rx: 0.092, rz: 0.081, n: 2.6, back: 1.06, zone: Z.COLLAR },
        { p: V(0, 1.486, -0.004), rx: 0.077, rz: 0.072, n: 2.5, back: 1.09, zone: Z.COLLAR },
      ],
      8,
      { radial: 22, capStart: true, capEnd: true },
    ),
    mat: 'cloth',
  });
  // The fold: a second skin turning back DOWN and OUT from the top of the
  // stand, so its cut edge is a horizontal line across the base of the neck and
  // its underside is in contact shadow. `back` grows through the fold because a
  // BDU collar is deepest at the nape and notches away at the throat.
  parts.push({
    surface: loftKeys(
      [
        { p: V(0, 1.485, -0.004), rx: 0.079, rz: 0.074, n: 2.5, back: 1.10, zone: Z.COLLAR },
        { p: V(0, 1.477, -0.004), rx: 0.103, rz: 0.087, n: 2.7, back: 1.16, zone: Z.COLLAR },
        { p: V(0, 1.462, -0.005), rx: 0.126, rz: 0.099, n: 2.9, back: 1.22, zone: Z.COLLAR },
        { p: V(0, 1.446, -0.006), rx: 0.136, rz: 0.104, n: 3.0, back: 1.24, zone: Z.COLLAR },
      ],
      10,
      { radial: 22, capStart: false, capEnd: true },
    ),
    mat: 'cloth',
  });
  return parts;
}

/**
 * The neck.
 *
 * Round 4's was a 4-key cylinder from y 1.40 to 1.585 that never left the
 * collar. This is an anatomical neck and it is the single biggest silhouette
 * fix in this round: it flares hard into the trapezius at the base (so the neck
 * and the shoulders are one continuous form rather than a shaft plugged into a
 * box), carries the two sternocleidomastoid cords down the front-sides, tucks
 * in at the throat, and rises to 1.612 where the occiput overhangs it by 26 mm.
 * Visible above the folded collar: y 1.500 -> 1.600, which at the gameplay
 * camera's 470 px/m is a 47 px column of skin between the jaw and the jacket.
 */
export function buildNeck() {
  // Sternocleidomastoid: the two cords from behind the ear to the sternum. They
  // sit at ~55 degrees either side of the front, and they are what stops a neck
  // reading as a dowel.
  const cords = (th) =>
    1 + 0.075 * (gauss(th - 1.02, 0.36) + gauss(th - (Math.PI - 1.02), 0.36));
  // Trapezius ridge at the back-sides, where the neck merges into the shoulder.
  //
  // ROUND 6: 0.17 -> 0.11 on the side lobes. The yoke was doing its job too
  // well — it made the top of the neck loft as wide as the bottom of the skull
  // for the whole 60 mm the collar does not cover, so the "column" never
  // narrowed and head/neck/shoulder read as one continuous mass. The flare is
  // now concentrated in the bottom two stations, where a trapezius actually is.
  const yoke = (th) =>
    1 + 0.11 * (gauss(th - 0.35, 0.5) + gauss(th - (Math.PI - 0.35), 0.5)) + 0.07 * gauss(th - Math.PI * 1.5, 0.6);

  const keys = [
    { p: V(0, 1.352, -0.004), rx: 0.118, rz: 0.104, n: 2.5, mod: yoke, zone: SZ.NECK },
    { p: V(0, 1.412, -0.005), rx: 0.092, rz: 0.090, n: 2.4, mod: yoke, zone: SZ.NECK },
    // ROUND 6: the exposed column is 8-11% narrower and runs 22 mm higher, to
    // meet a jaw that `headTransform` lifted by 19 mm. A neck seen from behind
    // is about 0.62 of skull breadth; this lands at 0.60.
    // ROUND 6: narrowed 4.6% in step with HEAD_FIT.sx, so the exposed column
    // keeps the 0.60-of-skull-breadth relationship round 5 landed instead of
    // silently becoming 0.63 when the skull came in.
    { p: V(0, 1.462, -0.007), rx: 0.063, rz: 0.069, n: 2.4, mod: cords, zone: SZ.NECK },
    { p: V(0, 1.508, -0.010), rx: 0.053, rz: 0.060, n: 2.4, mod: cords, zone: SZ.NECK },
    { p: V(0, 1.552, -0.013), rx: 0.050, rz: 0.056, n: 2.4, mod: cords, zone: SZ.NECK },
    // Up under the jaw. The last station widens again: the mastoid process and
    // the base of the skull are wider than the middle of the neck, and without
    // that the head looks pinned on.
    { p: V(0, 1.596, -0.015), rx: 0.051, rz: 0.059, n: 2.4, zone: SZ.NECK },
    { p: V(0, 1.632, -0.017), rx: 0.057, rz: 0.065, n: 2.5, zone: SZ.NECK },
  ];
  return loftKeys(keys, 14, { radial: 20, capStart: true, capEnd: false });
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
 * ROUND 6 — one transform for everything worn on or made of the head.
 *
 * The skull was measurably too big. On a flat-mask silhouette render of the
 * shipped gameplay frame, taking the longest CONTIGUOUS RUN per row, the skull
 * was 152 px against a 250 px shoulder span — a ratio of 0.608 where a human
 * seen from behind is 0.37-0.40. (Row *extent* is not a valid width here: the
 * radio antenna crosses the head band 200 px out to the side and inflates the
 * reading to 205 px. That is the same class of mistake as measuring ambient
 * with a horizontal scan.)
 *
 * Half the error is size and half is the pose. A skull is near-spherical in
 * plan so it projects at full width from any angle, whereas a 0.51 m shoulder
 * span turned 63 degrees off the camera projects at 0.23 m. Both ends get
 * fixed: the head shrinks here, the turn comes down in index.js.
 *
 * It is applied as a MATRIX at assembly time rather than by editing
 * `headSurface`'s radii, because the helmet, cap, boonie, bandana, eyepatch,
 * goggle strap, ear-defender cups and hair shell are all authored against
 * absolute world-space y in `gear.js` — thirty-odd hard-coded stations that
 * would every one of them have to move in step. One matrix over the whole set
 * cannot desynchronise.
 *
 * Scale is about the head BONE at y 1.60, not the skull centre, so the jaw
 * rises further than the crown: breadth 165 -> 150 mm and length 188 -> 177 mm
 * against an anthropometric adult male 152 x 195, while the jaw underside lifts
 * 19 mm and the crown only 12. That 19 mm is neck, which is half of MAJOR 3.
 */
/**
 * ROUND 6 continues the shrink, but the interesting part is WHERE the width was.
 *
 * `probes/r7c/headwidth.js` decomposes the head's bounding half-width by part
 * instead of reporting one number, and on the round-5 build it came back:
 *
 *   char-skin  ear shell      0.0925   <- the widest thing on the head
 *   char-skin  skull          0.0910
 *   char-cloth bandana        0.0888
 *   char-cloth eyepatch strap 0.0793
 *
 * The SKULL was not the widest part of the head — the ear was, and the ear was
 * a 20 mm-thick shell whose outer face stood 14 mm proud of a skull that had
 * already been swollen 13 mm by `headSurface`'s attachment bump. A pinna is
 * 2-3 mm of cartilage that stands 8-15 mm off the skull; this one was modelled
 * at the thickness of a hand. Round 5 shrank the skull three times and the
 * measurement barely moved, because the skull was never what it was measuring.
 *
 * So: skull breadth to 150 mm (anthropometric adult male 152), attachment bump
 * more than halved now that there is real ear geometry to root, and the ear
 * shell down to 15 mm thick standing 9 mm proud. Depth comes down with it —
 * 224 mm was 15% longer than a human head (195-200 mm) and read as a muzzle
 * from every three-quarter angle.
 */
export const HEAD_FIT = { sx: 0.870, sy: 0.962, sz: 0.900, lift: 0.018, pivotY: 1.6 };

export function headTransform() {
  const { sx, sy, sz, lift, pivotY } = HEAD_FIT;
  return new THREE.Matrix4()
    .makeScale(sx, sy, sz)
    .setPosition(0, pivotY * (1 - sy) + lift, HEAD_CENTRE.z * (1 - sz));
}

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

      // The bulge where the ear is ATTACHED. Round 5 halved it: the ear itself
      // is now real geometry (`buildEar`), and a 13 mm swelling under a 20 mm
      // shell reads as a swollen skull rather than as an ear root.
      // ROUND 6: 0.0065 -> 0.0032. See HEAD_FIT — this bump plus a 20 mm ear
      // shell was making the ear, not the skull, the widest part of the head.
      const ear = gauss((y + 0.004) / 0.024, 1) * gauss((z - 0.022) / 0.02, 1);
      x += 0.0032 * ear * Math.sign(x || 1) * THREE.MathUtils.smoothstep(Math.abs(dir.x), 0.55, 0.9);

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
  // Seated 6 mm deeper than round 1, which left the front of each sphere
  // standing proud of the socket — the classic googly-eye read.
  const cz = o.cz ?? -0.0655;
  const s = new Surface();
  for (const sgn of [-1, 1]) {
    const e = displacedSphere(
      (dir, out) => {
        out.set(sgn * 0.0325 + dir.x * 0.0115, cy + dir.y * 0.0115, cz + dir.z * 0.0115);
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

/**
 * An ear.
 *
 * `headSurface` grows a 13 mm bump where the ear belongs, which at the gameplay
 * camera's 470 px/m is a 6 px swelling on a dark mass — i.e. nothing. A real ear
 * is 60 mm tall and stands 12 mm off the skull with a rolled helix around it, so
 * it is a 28 px silhouette break with a bright rim and a shadow behind it,
 * exactly where the eye goes to find the profile of a head seen from behind.
 */
export function buildEar(sgn = 1) {
  // The skull surface at the ear latitude sits at |x| ~ 0.0857 (0.0825 base
  // half-width plus the attachment swelling in `headSurface`), so the shell is
  // centred at 0.0888: its inner face is buried 4.4 mm inside the skull and its
  // outer face stands 9.6 mm proud — a pinna, rather than the 14 mm slab that
  // made the ear the widest part of the head. See HEAD_FIT.
  const cx = sgn * 0.0888;
  const cy = 1.6765;
  const cz = 0.0205;
  return displacedSphere(
    (dir, out) => {
      const v = dir.y; // up the ear
      const w = dir.z; // fore (-) / aft (+)
      const r = Math.hypot(v, w);
      // Concha: the bowl scooped out of the middle. The helix keeps its full
      // thickness, so the RIM of the ear catches light and the middle does not
      // — which is the only part of an ear that is legible at 28 px.
      const bowl = Math.exp(-((r / 0.46) ** 2));
      const thick = 0.0076 * (1 - 0.55 * bowl);
      // 60 mm tall, 33 mm fore-aft, tapering into the lobe and raked back at
      // the top the way a real ear sits against the skull.
      const lobe = 1 - 0.28 * Math.max(0, -v);
      out.set(cx + dir.x * thick, cy + v * 0.0300, cz + w * 0.0165 * lobe + v * 0.0055);
    },
    14,
    10,
    SZ.FACE,
    0.1,
  );
}

/** Short cropped hair as a thin shell over the skull — only where a hat isn't. */
export function buildHair(o = {}) {
  const back = o.backOnly ?? false;
  const c = HEAD_CENTRE;
  const tmp = new THREE.Vector3();
  return displacedSphere(
    (dir, out) => {
      headSurface(dir, tmp, o);
      // The hairline is TWO boundaries, not one, and collapsing them into a
      // single band on (y + 0.72z) is what produced both failures this round:
      // at 0.28..0.66 the hair ran down over the jaw and the head was one dark
      // bowl; at 0.40..0.72 it retreated to a skullcap and left a bald ring
      // around the temples and the ear.
      //   `front` — the frontal hairline, crossing the forehead high and
      //     dropping behind the temple. Weighted 0.62/1.0 on y/z so it is
      //     mostly a *depth* test: the face is the front of the head, not the
      //     bottom of it.
      //   `above` — hair stops above the jawline. Separate, because the ear sits
      //     at y = -0.2 and the jaw at y = -0.6, and no single plane splits them.
      const front = THREE.MathUtils.smoothstep(dir.y * 0.62 + dir.z * 1.0, -0.42, 0.04);
      // ROUND 6 — the nape. `above` was one latitude band for the whole skull,
      // so hair stopped at the same height at the BACK of the head as it does
      // in front of the ear. On a real head those are nowhere near each other:
      // the frontal hairline is above the brow, but the posterior hairline runs
      // down to the base of the occiput, a good 60 mm lower.
      //
      // Measured on the shipped build that left 87 mm of bare scalp between the
      // occiput and the collar — a 34 px pink column at the gameplay camera,
      // continuous with the neck, which is why the character reads as
      // bald-and-long-necked from the one angle the game actually frames him
      // from. It is the same class of bug as round 5's buried hair shell: the
      // hair is authored, it is simply not where a head has hair.
      const nape = 0.75 * THREE.MathUtils.smoothstep(dir.z, 0.05, 0.55);
      let cover = front * THREE.MathUtils.smoothstep(dir.y + nape, -0.46, -0.16);
      if (back) cover *= THREE.MathUtils.smoothstep(dir.y * 0.4 + dir.z, -0.1, 0.45);
      const clump = 1 + 0.26 * Math.sin(dir.x * 34) * Math.sin(dir.z * 29) * cover;
      // Offset ALONG the skull's own radius: negative where there is no hair, so
      // the shell is buried inside the head and the crossover is the hairline.
      //
      // ROUND 5. Round 4 set this to `-0.030 + cover * (0.0128 + 0.0022*clump)`,
      // whose MAXIMUM is -0.0150 — the shell never once reached the skull
      // surface, so the character has been completely bald since round 4 and the
      // dark mass every critic read as "hair" was the inside-out skull (see
      // geometry.js). Burial where there is no hair is 24 mm, which clears the
      // 14 mm brow; the nose does not matter because `cover` is zero across the
      // whole face. At full cover the shell stands 12 mm proud, a regulation
      // crop.
      // ROUND 6: 0.0345 -> 0.0305. At full cover the shell stood 13.5 mm proud
      // of the skull, which made the HAIR the widest thing on the head
      // (`probes/r7c/headwidth.js`: 0.0858 half, ahead of the bandana at 0.0843
      // and the skull itself at 0.0820) and forced the bandana out to a 17 mm
      // stand-off to clear it. A No.2 crop is 6-10 mm; this lands at 9.5.
      const t = -0.024 + cover * (0.0305 + 0.0030 * clump);
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

// Must track rig.js' armR / forearmR / handR exactly — the loft is the skin over
// those bones. ROUND 6 moved the whole limb out 14 mm; see rig.js.
const ARM = {
  shoulder: V(0.190, 1.452, -0.014),
  elbow: V(0.350, 1.192, -0.02),
  wrist: V(0.485, 0.962, -0.014),
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
    { p: V(0.085, 1.478, -0.014), rx: 0.082, rz: 0.086, n: 2.6, zone: Z.SLEEVE },
    { p: V(0.135, 1.475, -0.014), rx: 0.0755 * bulk, rz: 0.0795 * bulk, n: 2.5, zone: Z.SLEEVE },
    // Deltoid: three heads over a ball joint, so it is the one place on a limb
    // where the profile BULGES before it tapers. Round 4 ran a single cap
    // straight into the taper and the shoulder read as the corner of the plate
    // carrier rather than as an arm.
    // ROUND 6: the whole limb is 11% slimmer through the shaft. Round 5's
    // upper arm was 0.081 * 1.04 * 2 = 168 mm across inside the sleeve, against
    // an adult male mid-biceps circumference of ~330 mm, i.e. a 105 mm
    // diameter; even a loose BDU sleeve only adds about 20. Once the arm was
    // posed clear of the ribs (see _POLE_R) that extra 40 mm stopped being
    // hidden against the torso and started reading as a bolster strapped to the
    // shoulder. The deltoid keeps most of its width — that bulge is real and it
    // is the top of the silhouette.
    // ROUND 6b, and this is a second 8% off the shaft on top of round 6a's 11%.
    // Round 6a took the upper arm from 168 mm to 148 mm across the sleeve; an
    // adult male mid-biceps is ~330 mm circumference, i.e. 105 mm of arm, and a
    // loose BDU sleeve adds about 20, so the target is 125 and 148 was still
    // 18% over. It shows: on every close-up the upper arm and the FOREARM both
    // read as one continuous padded bolster with no taper between them, and a
    // limb that does not taper is the single loudest inflated-mannequin cue
    // there is. The forearm came down hardest — it was 0.048 against an upper
    // arm of 0.053, a 90% ratio where a real forearm is about 72% of a biceps.
    { p: armPoint(0.05), rx: 0.0745 * bulk, rz: 0.0795 * bulk, n: 2.5, front: 1.1, zone: Z.SLEEVE },
    { p: armPoint(0.13), rx: 0.0645 * bulk, rz: 0.0685 * bulk, n: 2.4, front: 1.08, zone: Z.SLEEVE },
    { p: armPoint(0.22), rx: 0.0525 * bulk, rz: 0.0560 * bulk, n: 2.3, zone: Z.SLEEVE },
    { p: armPoint(0.34), rx: 0.0487 * bulk, rz: 0.0523 * bulk, n: 2.3, zone: Z.SLEEVE },
    { p: armPoint(0.46), rx: 0.0420 * bulk, rz: 0.0455, n: 2.3, zone: Z.SLEEVE },
    { p: armPoint(0.52), rx: 0.0405, rz: 0.0460, n: 2.3, zone: Z.SLEEVE },
    rolled
      ? { p: armPoint(rollT), rx: 0.0455, rz: 0.0490, n: 2.3, zone: Z.SLEEVE }
      : { p: armPoint(0.62), rx: 0.0420, rz: 0.0450, n: 2.3, zone: Z.SLEEVE },
    rolled
      ? { p: armPoint(rollT + 0.03), rx: 0.0385, rz: 0.0405, n: 2.3, zone: SZ.ARM }
      : { p: armPoint(0.74), rx: 0.0372, rz: 0.0392, n: 2.3, zone: Z.SLEEVE },
    { p: armPoint(0.85), rx: 0.0322, rz: 0.0341, n: 2.3, zone: rolled ? SZ.ARM : Z.SLEEVE },
    { p: armPoint(0.95), rx: 0.0272, rz: 0.0306, n: 2.4, zone: rolled ? SZ.ARM : Z.SLEEVE },
    { p: ARM.wrist.clone(), rx: 0.0245, rz: 0.0288, n: 2.4, zone: rolled ? SZ.ARM : Z.SLEEVE },
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
          { p: a, rx: 0.0455, rz: 0.0490, n: 2.3, zone: Z.SLEEVE },
          { p: a.clone().lerp(b, 0.5), rx: 0.0545, rz: 0.0582, n: 2.2, zone: Z.SLEEVE },
          { p: b, rx: 0.0445, rz: 0.0482, n: 2.3, zone: Z.SLEEVE },
        ],
        7,
        { radial: 16 },
      ),
      mat: 'cloth',
    });
  } else {
    parts.push({ surface: loftKeys(keys, 24, { radial: 16, capStart: true }), mat: 'cloth' });
  }

  // --- sleeve furniture ---------------------------------------------------
  // The upper arm is the biggest unbroken surface on a soldier and it points
  // straight at the third-person camera. Round 3 shipped it as a bare tapered
  // tube: measured on the gameplay frame it was the brightest thing on the
  // character and carried no value break at all over 100 px, which is the
  // definition of a mannequin limb. A combat shirt has three things on it and
  // all three are horizontal, i.e. across the taper where they read hardest.

  // Bicep bellows pocket with its own flap — the pen/velcro pocket every set of
  // fatigues has, standing 12 mm proud on the outboard face.
  const pocketAt = (t, h, r, zone) => {
    const a = armPoint(t - h);
    const b = armPoint(t + h);
    return loftKeys(
      [
        { p: a, rx: r * 0.92, rz: r * 0.96, n: 4.6, zone },
        { p: a.clone().lerp(b, 0.35), rx: r, rz: r * 1.04, n: 4.8, zone },
        { p: a.clone().lerp(b, 0.65), rx: r, rz: r * 1.04, n: 4.8, zone },
        { p: b, rx: r * 0.9, rz: r * 0.94, n: 4.6, zone },
      ],
      9,
      { radial: 14, capStart: true, capEnd: true },
    );
  };
  // Radii track the slimmed shaft: these are 8-11 mm of pocket standing proud
  // of the sleeve, and if they are left at the old absolute values on a shaft
  // that is 8% narrower they become 15-20 mm collars round the limb.
  parts.push({ surface: pocketAt(0.235, 0.075, 0.0565 * bulk, Z.POUCH), mat: 'cloth' });
  parts.push({ surface: pocketAt(0.163, 0.018, 0.0625 * bulk, Z.WEBBING), mat: 'cloth' });

  // Elbow reinforcement patch: a second layer of cloth over the joint, which is
  // where the eye looks to decide whether an arm has a joint in it at all.
    // ROUND 6: 0.058 -> 0.052 -> 0.0475. `pocketAt` lofts a full 360-degree ring,
  // so a patch standing 8.5 mm proud of a 45 mm-radius arm does not read as a
  // reinforcement on the point of the elbow — it reads as a machined collar
  // clamped round the limb, which on a foreshortened arm is the single loudest
  // robot-arm cue in the frame. At 2 mm it is a value step, not a step in the
  // silhouette, which is what a second layer of cloth actually is.
  parts.push({ surface: pocketAt(0.50, 0.055, 0.0432 * bulk, Z.POUCH), mat: 'cloth' });

  // Shoulder seam where the sleeve head is set into the body, and the cuff.
  parts.push({
    surface: strap(
      [
        // ROUND 6: 0.062/0.064 sat INSIDE the deltoid (rx 0.081) and drew
        // nothing at all — a set-in sleeve seam that has been invisible since
        // it was written. It now rides the surface of the slimmed shaft.
        armPoint(0.055).add(V(0, 0.077, 0.0)),
        armPoint(0.05).add(V(0, 0.0, -0.082)),
        armPoint(0.048).add(V(0, -0.077, 0.0)),
        armPoint(0.05).add(V(0, 0.0, 0.082)),
        armPoint(0.055).add(V(0, 0.077, 0.0)),
      ],
      0.014,
      0.005,
      Z.WEBBING,
      { stations: 16 },
    ),
    mat: 'cloth',
  });
  if (!rolled) {
    parts.push({
      surface: loftKeys(
        [
          { p: armPoint(0.905), rx: 0.0325, rz: 0.0352, n: 3.0, zone: Z.WEBBING },
          { p: armPoint(0.945), rx: 0.0298, rz: 0.0334, n: 3.0, zone: Z.WEBBING },
          { p: armPoint(0.985), rx: 0.0253, rz: 0.0298, n: 3.0, zone: Z.WEBBING },
        ],
        7,
        { radial: 14, capStart: true, capEnd: true },
      ),
      mat: 'cloth',
    });
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

  // Knuckle row: four bumps across the back of the hand. Without them the hand
  // is a paddle, and the knuckles are exactly where the eye checks.
  for (const kx of [0.0225, 0.0078, -0.0072, -0.0218]) {
    s.merge(
      displacedSphere(
        (dir, out) => out.set(kx + dir.x * 0.0088, 0.0805 + dir.y * 0.0068, 0.0105 + dir.z * 0.0088),
        10,
        7,
        zone,
        0.06,
      ),
    );
  }

  // Four fingers curled around a ~19 mm grip. Each phalanx is authored as a
  // narrow shaft between two wider joints — a smooth taper reads as a sausage,
  // and "no visible fingers" was the round-1 note.
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
    // Fingers are wider than they are deep, and each joint swells ~12%.
    const joint = (p, k) => ({ p, rx: r * k, rz: r * k * 0.88, n: 2.8, zone: fingerZone });
    const mid = (a, b, k) => joint(a.clone().lerp(b, 0.5), k);
    fs.merge(
      loftKeys(
        [
          joint(pts[0], 1.06),
          mid(pts[0], pts[1], 0.88),
          joint(pts[1], 1.0),
          mid(pts[1], pts[2], 0.8),
          joint(pts[2], 0.9),
          mid(pts[2], pts[3], 0.74),
          joint(pts[3], 0.6),
        ],
        15,
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

  // Cuff: a band at the wrist so the hand terminates in a hem rather than
  // dissolving into the sleeve.
  s.merge(
    loftKeys(
      [
        { p: V(0, -0.026, -0.002), rx: 0.028, rz: 0.031, n: 2.6, zone },
        { p: V(0, -0.012, 0.0), rx: 0.032, rz: 0.035, n: 2.6, zone },
        { p: V(0, 0.002, 0.001), rx: 0.031, rz: 0.032, n: 2.7, zone },
      ],
      7,
      { radial: 12, capStart: true, capEnd: true, forward: V(0, 0, 1) },
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

/**
 * A desert combat boot.
 *
 * Round 1 shipped a shaft, a foot and a sole in one near-black leather zone, and
 * every critic called it out as a black blob. What actually makes a boot read at
 * 8 m is not resolution, it is the horizontal banding: a tan upper, a PALE
 * midsole rand, a dark lugged outsole, and a padded collar that widens the
 * ankle. Those four values stacked are legible even when the whole boot is
 * 20 px tall. The laces, tongue, eyelet rows, toe cap and heel counter are for
 * the critic who zooms in.
 */
export function buildBoot() {
  // ROUND 6 — this is where the silhouette furniture in `gear.js` (canteen,
  // knife, holster suspender) is PAID FOR. That kit costs +1516 triangles on
  // the player and +1388 on each guard, i.e. +12,748 over the nine characters
  // in the frame; retessellating the boot gives back about 2,400 per character,
  // ~21,600 in total, so the trade nets roughly -8,900.
  //
  // The boot is the right place to take it from. Its FORMS are all kept — shaft,
  // padded collar, foot, toe cap, heel counter, the pale midsole rand, the
  // lugged outsole, tongue, eyelet rows and laces are every one of them still
  // there, because the horizontal value banding is what makes a boot legible.
  // Only the tessellation drops (13 stations x 16 radial -> 9 x 12 and so on),
  // and that resolution buys nothing: on the gameplay camera the boots are
  // BELOW THE BOTTOM OF THE FRAME (the silhouette bbox clips at y = 1079), and
  // on vista/outpost the whole soldier is 20-60 px tall, so a boot is under
  // 6 px and every one of these cross-sections is sub-pixel.
  const parts = [];
  const x = 0.102;
  const cloth = (surface) => parts.push({ surface, mat: 'cloth' });
  const rubber = (surface) => parts.push({ surface, mat: 'rubber' });

  // Shaft: mid-calf, slightly conical, flaring into a padded collar at the top.
  cloth(
    loftKeys(
      [
        { p: V(x, 0.248, 0.022), rx: 0.062, rz: 0.067, n: 2.6, zone: Z.BOOT },
        { p: V(x, 0.226, 0.023), rx: 0.058, rz: 0.063, n: 2.6, zone: Z.BOOT },
        { p: V(x, 0.19, 0.025), rx: 0.055, rz: 0.06, n: 2.6, zone: Z.BOOT },
        { p: V(x, 0.15, 0.026), rx: 0.053, rz: 0.058, n: 2.6, zone: Z.BOOT },
        { p: V(x, 0.105, 0.028), rx: 0.05, rz: 0.058, n: 2.7, zone: Z.BOOT },
        { p: V(x, 0.075, 0.03), rx: 0.05, rz: 0.062, n: 2.8, zone: Z.BOOT },
      ],
      9,
      { radial: 12, capStart: true },
    ),
  );
  // Padded collar rolled over the top of the shaft — the ankle needs a width
  // step or the leg just tapers into the ground.
  cloth(
    loftKeys(
      [
        { p: V(x, 0.256, 0.021), rx: 0.062, rz: 0.067, n: 2.6, zone: Z.BOOT },
        { p: V(x, 0.243, 0.022), rx: 0.069, rz: 0.074, n: 2.5, zone: Z.BOOT },
        { p: V(x, 0.228, 0.023), rx: 0.063, rz: 0.068, n: 2.6, zone: Z.BOOT },
      ],
      5,
      { radial: 10, capStart: true, capEnd: true },
    ),
  );

  // Foot: heel -> instep -> ball -> toe. Spine runs forward (-Z).
  cloth(
    loftKeys(
      [
        { p: V(x, 0.05, 0.075), rx: 0.036, rz: 0.045, n: 2.8, zone: Z.BOOT },
        { p: V(x, 0.048, 0.045), rx: 0.045, rz: 0.048, n: 2.9, zone: Z.BOOT },
        { p: V(x, 0.05, 0.0), rx: 0.05, rz: 0.05, n: 3.0, zone: Z.BOOT },
        { p: V(x, 0.048, -0.055), rx: 0.052, rz: 0.043, n: 3.2, zone: Z.BOOT },
        { p: V(x, 0.044, -0.105), rx: 0.048, rz: 0.036, n: 3.2, zone: Z.BOOT },
        { p: V(x, 0.04, -0.14), rx: 0.034, rz: 0.026, n: 3.0, zone: Z.BOOT },
      ],
      10,
      { radial: 12, capStart: true, capEnd: true },
    ),
  );
  // Toe cap, standing 2 mm proud with its own stitched border.
  cloth(
    loftKeys(
      [
        { p: V(x, 0.047, -0.062), rx: 0.0535, rz: 0.045, n: 3.2, zone: Z.BOOT },
        { p: V(x, 0.045, -0.1), rx: 0.0498, rz: 0.038, n: 3.2, zone: Z.BOOT },
        { p: V(x, 0.041, -0.138), rx: 0.036, rz: 0.028, n: 3.0, zone: Z.BOOT },
      ],
      5,
      { radial: 10, capStart: true, capEnd: true },
    ),
  );
  // Heel counter wrapping the back of the foot.
  cloth(
    loftKeys(
      [
        { p: V(x, 0.052, 0.078), rx: 0.0375, rz: 0.047, n: 2.8, zone: Z.BOOT },
        { p: V(x, 0.05, 0.05), rx: 0.0468, rz: 0.05, n: 2.9, zone: Z.BOOT },
        { p: V(x, 0.052, 0.028), rx: 0.0505, rz: 0.05, n: 3.0, zone: Z.BOOT },
      ],
      5,
      { radial: 10, capStart: true, capEnd: true },
    ),
  );

  // Midsole rand: a PALE band between the tan upper and the dark outsole. This
  // one 12 mm stripe is what stops the whole boot merging into the ground.
  cloth(
    loftKeys(
      [
        { p: V(x, 0.031, 0.084), rx: 0.0378, rz: 0.0135, n: 4.2, zone: Z.BOOT },
        { p: V(x, 0.03, 0.045), rx: 0.0482, rz: 0.014, n: 4.4, zone: Z.BOOT },
        { p: V(x, 0.03, 0.0), rx: 0.0542, rz: 0.0135, n: 4.4, zone: Z.BOOT },
        { p: V(x, 0.03, -0.06), rx: 0.0562, rz: 0.0135, n: 4.4, zone: Z.BOOT },
        { p: V(x, 0.031, -0.11), rx: 0.051, rz: 0.013, n: 4.4, zone: Z.BOOT },
        { p: V(x, 0.033, -0.147), rx: 0.035, rz: 0.011, n: 4.0, zone: Z.BOOT },
      ],
      9,
      { radial: 10, capStart: true, capEnd: true },
    ),
  );

  // Lugged rubber outsole + heel block.
  rubber(
    loftKeys(
      [
        { p: V(x, 0.017, 0.082), rx: 0.036, rz: 0.017, n: 4.5, zone: 0 },
        { p: V(x, 0.015, 0.045), rx: 0.047, rz: 0.019, n: 4.5, zone: 0 },
        { p: V(x, 0.014, 0.0), rx: 0.053, rz: 0.018, n: 4.5, zone: 0 },
        { p: V(x, 0.014, -0.06), rx: 0.055, rz: 0.018, n: 4.5, zone: 0 },
        { p: V(x, 0.015, -0.11), rx: 0.05, rz: 0.017, n: 4.5, zone: 0 },
        { p: V(x, 0.017, -0.146), rx: 0.034, rz: 0.014, n: 4.0, zone: 0 },
      ],
      9,
      { radial: 10, capStart: true, capEnd: true },
    ),
  );
  rubber(
    loftKeys(
      [
        { p: V(x, 0.028, 0.082), rx: 0.037, rz: 0.028, n: 4.5, zone: 0 },
        { p: V(x, 0.026, 0.048), rx: 0.046, rz: 0.028, n: 4.5, zone: 0 },
        { p: V(x, 0.025, 0.028), rx: 0.048, rz: 0.024, n: 4.5, zone: 0 },
      ],
      5,
      { radial: 10, capStart: true, capEnd: true },
    ),
  );

  // Tongue under the laces, plus the two eyelet/speed-hook rows either side of
  // it. Without a tongue the lace bands float on a smooth dome.
  cloth(
    loftKeys(
      [
        { p: V(x, 0.098, 0.006), rx: 0.031, rz: 0.012, n: 3.4, zone: Z.BOOT },
        { p: V(x, 0.093, -0.03), rx: 0.032, rz: 0.012, n: 3.4, zone: Z.BOOT },
        { p: V(x, 0.083, -0.062), rx: 0.031, rz: 0.011, n: 3.4, zone: Z.BOOT },
      ],
      5,
      { radial: 8, capStart: true, capEnd: true, forward: V(0, 1, 0) },
    ),
  );
  for (const sgn of [-1, 1]) {
    cloth(
      strap(
        [
          V(x + sgn * 0.036, 0.096, 0.012),
          V(x + sgn * 0.038, 0.09, -0.024),
          V(x + sgn * 0.036, 0.079, -0.062),
          V(x + sgn * 0.03, 0.066, -0.09),
        ],
        0.013,
        0.007,
        Z.BOOT,
        { stations: 6 },
      ),
    );
  }
  // Laces: five bands across the instep, tightening toward the toe.
  for (let i = 0; i < 5; i++) {
    const z = 0.014 - i * 0.026;
    const w = 0.038 - i * 0.002;
    const y = 0.094 - i * 0.007;
    cloth(
      strap(
        [V(x - w, y, z), V(x, y + 0.008, z - 0.004), V(x + w, y, z)],
        0.008,
        0.0055,
        Z.WEBBING,
        { stations: 5 },
      ),
    );
  }
  return parts;
}

export { ARM, LEG, armPoint };
